/**
 * M15 (ADR-0031) eval scoring + multi-criteria threshold gate.
 *
 * Pure functions; no I/O. The `run.mts` entry point collects samples
 * then calls `scoreFixtureRun()` → `aggregateScores()` → `checkThreshold()`
 * to produce the final verdict.
 *
 * The threshold encodes ADR-0031's five gates:
 *   (a) catches ≥2 documented issues in the M14-close-out real-PR fixture
 *       (≥66% of its 3 labels)
 *   (b) catches ≥4 of the synthetic plants (one per worker concern)
 *   (c) emits 0 comments on the clean-control fixtures
 *   (d) total cost across the fixture run stays <$3
 *   (e) dispatches ≥1 worker on every substantive (non-empty) fixture
 *
 * Sampling: each (fixture × config) ran N=3 times by default. The scorer
 * takes the median catch count + median cost + median dispatch count so
 * one bad LLM sample doesn't flip a recall verdict. Known false-positive
 * traps intentionally use max/any-sample semantics: a recurrence in any
 * sample fails the precision gate.
 */

import type {
  AggregateScore,
  Fixture,
  FixtureSample,
  FixtureScore,
  ThresholdVerdict,
} from "./types.js";

const M14_CLOSEOUT_PREFIX = "m14-closeout";

const COST_BUDGET_USD = 3;
const SYNTHETIC_PLANTS_MIN_CATCH = 4;
const REAL_PR_M14_MIN_CATCH = 2;
const DISPATCH_MIN_ON_SUBSTANTIVE = 1;

// ---------------------------------------------------------------------------
// Per-fixture scoring
// ---------------------------------------------------------------------------

export function scoreFixtureRun(
  fixture: Fixture,
  samples: FixtureSample[],
  configName: string,
): FixtureScore {
  const totalLabels = fixture.labels.filter((l) => labelExpectation(l) === "present").length;
  const totalForbiddenLabels = fixture.labels.filter(
    (l) => labelExpectation(l) === "absent",
  ).length;
  const caughtCounts = samples.map((s) => s.caughtLabels.length);
  const forbiddenCounts = samples.map((s) => s.forbiddenLabels.length);
  const unlabeledCounts = samples.map((s) => s.unlabeledComments);
  const costs = samples.map((s) => s.costUsd);
  const dispatches = samples.map((s) => s.dispatchCount);
  const durations = samples.map((s) => s.durationMs);
  const errors = samples.filter((s) => s.error !== null).length;

  return {
    fixture: fixture.name,
    config: configName,
    category: fixture.category,
    expectsEmpty: fixture.expectsEmpty,
    samples: samples.length,
    caughtCount: median(caughtCounts),
    totalLabels,
    totalForbiddenLabels,
    maxForbidden: max(forbiddenCounts),
    medianUnlabeled: median(unlabeledCounts),
    medianCost: median(costs),
    medianDispatches: median(dispatches),
    medianDurationMs: median(durations),
    hadError: errors >= Math.ceil(samples.length / 2),
    rawSamples: samples,
  };
}

// ---------------------------------------------------------------------------
// Aggregate across the whole fixture set
// ---------------------------------------------------------------------------

export function aggregateScores(rows: FixtureScore[], configName: string): AggregateScore {
  let syntheticCaught = 0;
  let syntheticPlants = 0;
  let realCaught = 0;
  let realPlants = 0;
  let falsePositiveTraps = 0;
  let falsePositiveTrapHits = 0;
  let cleanFixtureUnlabeled = 0;
  let totalCost = 0;
  const substantiveDispatches: number[] = [];

  for (const row of rows) {
    totalCost += row.medianCost;
    falsePositiveTraps += row.totalForbiddenLabels;
    falsePositiveTrapHits += row.maxForbidden;

    if (row.category === "synthetic" && !row.expectsEmpty && row.totalLabels > 0) {
      syntheticPlants += row.totalLabels;
      syntheticCaught += row.caughtCount;
    } else if (row.category === "real-prs" && row.totalLabels > 0) {
      realPlants += row.totalLabels;
      realCaught += row.caughtCount;
    } else if (row.expectsEmpty) {
      cleanFixtureUnlabeled += row.medianUnlabeled;
    }

    if (!row.expectsEmpty) {
      substantiveDispatches.push(row.medianDispatches);
    }
  }

  return {
    config: configName,
    syntheticCaught,
    syntheticPlants,
    realCaught,
    realPlants,
    falsePositiveTraps,
    falsePositiveTrapHits,
    cleanFixtureUnlabeled,
    totalCost: round4(totalCost),
    medianDispatchesOnSubstantive: median(substantiveDispatches),
    rows,
  };
}

// ---------------------------------------------------------------------------
// Multi-criteria threshold gate
// ---------------------------------------------------------------------------

export function checkThreshold(agg: AggregateScore, rows: FixtureScore[]): ThresholdVerdict {
  const failed: string[] = [];
  const details: string[] = [];

  // (a) M14 close-out real-PR ≥ 2/3 of its 3 labels.
  const m14Rows = rows.filter(
    (r) => r.category === "real-prs" && r.fixture.startsWith(M14_CLOSEOUT_PREFIX),
  );
  if (m14Rows.length > 0) {
    const m14Caught = m14Rows.reduce((acc, r) => acc + r.caughtCount, 0);
    const m14Total = m14Rows.reduce((acc, r) => acc + r.totalLabels, 0);
    const passA = m14Caught >= REAL_PR_M14_MIN_CATCH;
    details.push(
      `(a) M14-close-out catch: ${m14Caught}/${m14Total} ` +
        `(threshold ≥${REAL_PR_M14_MIN_CATCH}) — ${passA ? "PASS" : "FAIL"}`,
    );
    if (!passA) failed.push("a-m14-closeout-catch");
  } else {
    details.push(`(a) M14-close-out catch: no fixture present — SKIPPED`);
  }

  // (b) ≥ 4 of the synthetic plants caught.
  if (agg.syntheticPlants > 0) {
    const passB = agg.syntheticCaught >= SYNTHETIC_PLANTS_MIN_CATCH;
    details.push(
      `(b) Synthetic plants caught: ${agg.syntheticCaught}/${agg.syntheticPlants} ` +
        `(threshold ≥${SYNTHETIC_PLANTS_MIN_CATCH}) — ${passB ? "PASS" : "FAIL"}`,
    );
    if (!passB) failed.push("b-synthetic-plants");
  } else {
    details.push(`(b) Synthetic plants caught: no fixture present — SKIPPED`);
  }

  // (c) 0 unlabeled comments on clean fixtures.
  const passC = agg.cleanFixtureUnlabeled === 0;
  details.push(
    `(c) Clean-fixture comments: ${agg.cleanFixtureUnlabeled} ` +
      `(threshold 0) — ${passC ? "PASS" : "FAIL"}`,
  );
  if (!passC) failed.push("c-clean-fixture-comments");

  // (d) Total cost < $3.
  const passD = agg.totalCost < COST_BUDGET_USD;
  details.push(
    `(d) Total cost: $${agg.totalCost.toFixed(4)} ` +
      `(threshold <$${COST_BUDGET_USD}) — ${passD ? "PASS" : "FAIL"}`,
  );
  if (!passD) failed.push("d-cost-budget");

  // (e) ≥ 1 dispatch on every substantive (non-empty) fixture.
  // Use the per-row minimum, not the median across fixtures — a config that
  // dispatches 0 on one substantive fixture and 4 on another shouldn't pass
  // by averaging out.
  const substantiveRows = rows.filter((r) => !r.expectsEmpty);
  const minDispatch = substantiveRows.length
    ? Math.min(...substantiveRows.map((r) => r.medianDispatches))
    : 0;
  const passE = substantiveRows.length === 0 || minDispatch >= DISPATCH_MIN_ON_SUBSTANTIVE;
  details.push(
    `(e) Min dispatches on substantive fixtures: ${minDispatch} ` +
      `(threshold ≥${DISPATCH_MIN_ON_SUBSTANTIVE}) — ${passE ? "PASS" : "FAIL"}`,
  );
  if (!passE) failed.push("e-min-dispatch");

  // (f) Known false-positive traps must not reappear.
  if (agg.falsePositiveTraps > 0) {
    const passF = agg.falsePositiveTrapHits === 0;
    details.push(
      `(f) False-positive trap hits: ${agg.falsePositiveTrapHits}/${agg.falsePositiveTraps} ` +
        `(threshold 0) — ${passF ? "PASS" : "FAIL"}`,
    );
    if (!passF) failed.push("f-false-positive-traps");
  } else {
    details.push(`(f) False-positive trap hits: no fixture present — SKIPPED`);
  }

  return {
    cleared: failed.length === 0,
    failed,
    details,
  };
}

// ---------------------------------------------------------------------------
// Markdown table renderer
// ---------------------------------------------------------------------------

export function renderMarkdownTable(agg: AggregateScore): string {
  const header = [
    `| fixture | category | caught | total | forbidden max | unlabeled | dispatches | cost $ | duration ms |`,
    `|---------|----------|--------|-------|-----------|-----------|------------|--------|-------------|`,
  ];
  const rows = agg.rows.map((r) => {
    const expectsEmpty = r.expectsEmpty ? ` (expects 0)` : "";
    return (
      `| \`${r.fixture}\`${expectsEmpty} | ${r.category} | ` +
      `${r.caughtCount} | ${r.totalLabels} | ${r.maxForbidden}/${r.totalForbiddenLabels} | ${r.medianUnlabeled} | ` +
      `${r.medianDispatches} | ${r.medianCost.toFixed(4)} | ${r.medianDurationMs} |`
    );
  });
  const summary = [
    ``,
    `**Aggregate for \`${agg.config}\`:**`,
    `- Synthetic catch: ${agg.syntheticCaught}/${agg.syntheticPlants}`,
    `- Real-PR catch: ${agg.realCaught}/${agg.realPlants}`,
    `- False-positive trap hits: ${agg.falsePositiveTrapHits}/${agg.falsePositiveTraps}`,
    `- Clean-fixture unlabeled: ${agg.cleanFixtureUnlabeled}`,
    `- Total cost: $${agg.totalCost.toFixed(4)}`,
    `- Min substantive dispatches: ${agg.medianDispatchesOnSubstantive}`,
  ];
  return [...header, ...rows, ...summary].join("\n");
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid] ?? 0;
  }
  const a = sorted[mid - 1];
  const b = sorted[mid];
  if (a === undefined || b === undefined) return 0;
  return (a + b) / 2;
}

function max(values: number[]): number {
  return values.length === 0 ? 0 : Math.max(...values);
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

function labelExpectation(label: Fixture["labels"][number]): "present" | "absent" {
  return label.expect ?? "present";
}

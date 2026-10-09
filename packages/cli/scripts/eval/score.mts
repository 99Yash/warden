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

import type { SessionUsage } from "../../src/opencode/drive.js";
import type {
  AggregateScore,
  Fixture,
  FixtureSample,
  FixtureScore,
  ParityVerdict,
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
// Parity gate (slice #43)
// ---------------------------------------------------------------------------

/**
 * Whether an OpenCode sample's spend is measured. No spawned `opencode run`
 * (fixture build failure, empty scope, MCP warmup failure) is a known $0.
 * A spawned run is measured only when the session usage was read AND
 * (`costUsd > 0` or all token counts are 0 — no model work, so no spend).
 * A free or unpriced model that did work reports `cost 0` with tokens > 0:
 * unmeasured, so the run fails closed (a free-model tracer stops after one
 * sample).
 */
export function isOpencodeCostMeasured(
  runSpawned: boolean,
  usage: SessionUsage | undefined,
): boolean {
  if (!runSpawned) return true;
  if (usage === undefined) return false;
  if (usage.costUsd > 0) return true;
  const t = usage.tokens;
  return (
    t.input === 0 && t.output === 0 && t.reasoning === 0 && t.cacheRead === 0 && t.cacheWrite === 0
  );
}

/** The run facts the parity verdict needs beyond the two aggregates. */
export interface ParityRun {
  /** Requested sample count per (fixture × config). */
  samples: number;
  /** True when `--fixture` or `--fixture-regex` narrowed the fixture set. */
  fixtureFilter: boolean;
  stoppedAtCostCeiling: boolean;
}

/** A gate decision needs N ≥ 3; an N=1 tracer is evidence, not a gate. */
const PARITY_MIN_SAMPLES = 3;
const PARITY_MAX_TRAP_HITS = 0;
const PARITY_MAX_CLEAN_UNLABELED = 0;

/**
 * Compare an OpenCode candidate against a harness reference on the same
 * fixture set in the same invocation. Ties pass (parity, not superiority).
 * P4 and P6 read every raw sample (any-sample semantics, like P3), not the
 * medians. P8 makes a tracer (N<3, filtered, or stopped) always NOT MET,
 * while P0–P7 still report their own PASS/FAIL as evidence.
 * `checkThreshold` is unchanged.
 */
export function checkParity(
  reference: AggregateScore,
  candidate: AggregateScore,
  run: ParityRun,
): ParityVerdict {
  const failed: string[] = [];
  const details: string[] = [];

  // P0 same fixtures — equal row fixture-name sets, and every row of both
  // aggregates holds the requested sample count (a stopped run leaves a
  // short row).
  const refNames = new Set(reference.rows.map((r) => r.fixture));
  const candNames = new Set(candidate.rows.map((r) => r.fixture));
  const sameNames =
    refNames.size === candNames.size && [...refNames].every((n) => candNames.has(n));
  const shortRows = [...reference.rows, ...candidate.rows].filter(
    (r) => r.rawSamples.length !== run.samples,
  ).length;
  const passP0 = sameNames && shortRows === 0;
  details.push(
    `(P0) Same fixtures: reference ${refNames.size}, candidate ${candNames.size}, ` +
      `${shortRows} row(s) without ${run.samples} sample(s) — ${passP0 ? "PASS" : "FAIL"}`,
  );
  if (!passP0) failed.push("P0-same-fixtures");

  // P1 real-PR recall.
  const passP1 = candidate.realCaught >= reference.realCaught;
  details.push(
    `(P1) Real-PR recall: candidate ${candidate.realCaught}/${candidate.realPlants} ` +
      `vs reference ${reference.realCaught}/${reference.realPlants} — ${passP1 ? "PASS" : "FAIL"}`,
  );
  if (!passP1) failed.push("P1-real-recall");

  // P2 synthetic recall.
  const passP2 = candidate.syntheticCaught >= reference.syntheticCaught;
  details.push(
    `(P2) Synthetic recall: candidate ${candidate.syntheticCaught}/${candidate.syntheticPlants} ` +
      `vs reference ${reference.syntheticCaught}/${reference.syntheticPlants} — ${passP2 ? "PASS" : "FAIL"}`,
  );
  if (!passP2) failed.push("P2-synthetic-recall");

  // P3 precision traps.
  const passP3 = candidate.falsePositiveTrapHits <= PARITY_MAX_TRAP_HITS;
  details.push(
    `(P3) Precision traps: ${candidate.falsePositiveTrapHits}/${candidate.falsePositiveTraps} ` +
      `(threshold ${PARITY_MAX_TRAP_HITS}) — ${passP3 ? "PASS" : "FAIL"}`,
  );
  if (!passP3) failed.push("P3-precision-traps");

  // P4 clean zero-hit — every sample of every clean candidate row.
  const cleanSamples = candidate.rows.filter((r) => r.expectsEmpty).flatMap((r) => r.rawSamples);
  const cleanHits = cleanSamples.filter(
    (s) => s.unlabeledComments > PARITY_MAX_CLEAN_UNLABELED,
  ).length;
  const passP4 = cleanHits === 0;
  details.push(
    `(P4) Clean zero-hit: ${cleanHits}/${cleanSamples.length} clean sample(s) with comments ` +
      `(threshold ${PARITY_MAX_CLEAN_UNLABELED}) — ${passP4 ? "PASS" : "FAIL"}`,
  );
  if (!passP4) failed.push("P4-clean-zero-hit");

  // P5 cost — criterion (d) plus every candidate sample measured.
  const passP5cost = candidate.totalCost < COST_BUDGET_USD;
  const unmeasured = candidate.rows.filter((r) =>
    r.rawSamples.some((s) => s.costMeasured !== true),
  ).length;
  const passP5 = passP5cost && unmeasured === 0;
  details.push(
    `(P5) Cost: $${candidate.totalCost.toFixed(4)} ` +
      `(threshold <$${COST_BUDGET_USD}) + ${unmeasured} row(s) with unmeasured spend — ${passP5 ? "PASS" : "FAIL"}`,
  );
  if (!passP5) failed.push("P5-cost");

  // P6 lane health — every sample of every candidate row (clean rows
  // included: a failed lane on a clean fixture publishes `comments: []`)
  // ran the lane and has no error.
  const candSamples = candidate.rows.flatMap((r) => r.rawSamples);
  const unhealthy = candSamples.filter(
    (s) => s.dispatchCount < DISPATCH_MIN_ON_SUBSTANTIVE || s.error !== null,
  ).length;
  const passP6 = unhealthy === 0;
  details.push(
    `(P6) Lane health: ${candSamples.length - unhealthy}/${candSamples.length} ` +
      `candidate sample(s) with the lane run and no error — ${passP6 ? "PASS" : "FAIL"}`,
  );
  if (!passP6) failed.push("P6-lane-health");

  // P7 reference health — a failed reference makes P1/P2 vacuous.
  const refErrors = reference.rows
    .flatMap((r) => r.rawSamples)
    .filter((s) => s.error !== null).length;
  const refSubstantive = reference.rows.filter((r) => !r.expectsEmpty);
  const refNoDispatch = refSubstantive.filter(
    (r) => r.medianDispatches < DISPATCH_MIN_ON_SUBSTANTIVE,
  ).length;
  const passP7 = refErrors === 0 && refNoDispatch === 0;
  details.push(
    `(P7) Reference health: ${refErrors} reference sample error(s), ` +
      `${refNoDispatch}/${refSubstantive.length} substantive row(s) without a dispatch — ${passP7 ? "PASS" : "FAIL"}`,
  );
  if (!passP7) failed.push("P7-reference-health");

  // P8 gate run — N ≥ 3, the full fixture set, and a complete run.
  const passP8 =
    run.samples >= PARITY_MIN_SAMPLES && !run.fixtureFilter && !run.stoppedAtCostCeiling;
  details.push(
    `(P8) Gate run: samples ${run.samples} (threshold ≥${PARITY_MIN_SAMPLES}), ` +
      `fixture filter ${run.fixtureFilter ? "set" : "none"}, ` +
      `stopped at cost ceiling ${run.stoppedAtCostCeiling} — ${passP8 ? "PASS" : "FAIL"}`,
  );
  if (!passP8) failed.push("P8-gate-run");

  return {
    cleared: failed.length === 0,
    failed,
    details,
    reference: reference.config,
    candidate: candidate.config,
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

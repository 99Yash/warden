/**
 * Shared type contracts for the M15 eval suite. Kept in its own file so
 * `configs/*.ts`, `run.mts`, and `score.mts` can share the same definitions
 * without a circular dep — each config file only depends on these types,
 * and `run.mts` reads each config's exported `config: EvalConfig` value.
 *
 * Intentionally non-circular and lightweight: no `@warden/core` import,
 * no `@warden/ai` import. The harness call site lives in `run.mts`.
 */

import type { BossLoopConfig } from "@warden/core";

/**
 * A candidate harness configuration the eval suite tests. `name` is used
 * for filenames + table headers + scorecard keys; `bossLoop` is threaded
 * directly into `ReviewConfig.bossLoop` (and `ReviewHarnessConfig.bossLoop`
 * downstream). Default behavior when `bossLoop` is `undefined` is M14
 * baseline (no programmatic dispatch, rules prompt).
 */
export interface EvalConfig {
  name: string;
  description: string;
  bossLoop?: BossLoopConfig;
}

/**
 * A label entry in a fixture's `labels.md`. `expected_line`, `category`,
 * `concern` are optional — synthetic fixtures pin specific (line, kind,
 * category), real-PR fixtures may only describe the issue narrative. The
 * scorer matches loosely: a comment is "caught" iff it cites the labeled
 * file AND its category matches (or `category` is undefined).
 */
export interface FixtureLabel {
  /** Free-form identifier (e.g. "missing-null-check"). Used in scorecards. */
  id: string;
  /**
   * Whether this label describes a finding the harness should catch or a known
   * false-positive trap it must avoid. Defaults to `present` for existing
   * recall fixtures.
   */
  expect?: "present" | "absent";
  /** Repo-relative path of the file the issue lives in. */
  path: string;
  /** Optional 1-indexed line; when present, comments must cite within ±5. */
  line?: number;
  /** Expected Comment.category if the boss catches this. */
  category?: string;
  /** Optional case-insensitive substring that must appear in the Comment claim. */
  claimIncludes?: string;
  /** Free-text reminder of what to look for. */
  description: string;
}

/**
 * Loaded fixture (synthetic plant or real PR). `diff` is the unified-diff
 * text the harness consumes; `labels` is parsed from `labels.md` per
 * fixture; `expectsEmpty: true` flips the scorer to "must emit 0 comments"
 * (clean-control fixtures only).
 */
export interface Fixture {
  name: string;
  category: "synthetic" | "real-prs";
  diff: string;
  labels: FixtureLabel[];
  expectsEmpty: boolean;
  /**
   * Optional real-repo backing (from the fixture's `meta.json`). When present,
   * `runOnce` checks out a detached git worktree at `commit` and uses it as the
   * harness `repoRoot`, so worker tools (`readFile`/`grepRepo`) read the full
   * post-PR tree instead of the sparse diff-only reconstruction. The fixture's
   * `commit` is the PR's head, so its tree IS the post-image ground truth.
   */
  realRepo?: { repoPath: string; commit: string };
}

/** Shape of a real-PR fixture's optional `meta.json`. */
export interface FixtureMeta {
  /** Logical repo name resolved to a path by `run.mts` (e.g. "warden", "alfred"). */
  repo: string;
  /** Commit-ish to check out (the PR head; its tree is the post-PR ground truth). */
  commit: string;
}

/**
 * One sample of running one config against one fixture. The eval suite
 * runs N=3 samples per (fixture, config) pair and takes medians.
 */
export interface FixtureSample {
  fixture: string;
  config: string;
  sample: number;
  commentCount: number;
  comments: EvalCommentSummary[];
  caughtLabels: string[];
  missedLabels: string[];
  /** Known false-positive labels that matched at least one emitted comment. */
  forbiddenLabels: string[];
  /** Total Comments minus the ones that matched labels — proxy for false-positive count. */
  unlabeledComments: number;
  /** Number of dispatch_worker tool-calls observed during the run (proxy for boss work). */
  dispatchCount: number;
  costUsd: number;
  durationMs: number;
  /** Any error during the run; null when clean. */
  error: string | null;
}

export interface EvalCommentSummary {
  id: string;
  file: string;
  lineStart: number;
  lineEnd: number;
  category: string;
  kind: string;
  tier: number;
  confidence: number;
  claim: string;
  sourcesCount: number;
}

/**
 * Aggregated across N samples of one (fixture, config) pair. Medians for
 * recall, cost, and dispatch suppress LLM variance; forbidden traps use
 * max/any-sample semantics so intermittent false positives still fail.
 */
export interface FixtureScore {
  fixture: string;
  config: string;
  category: "synthetic" | "real-prs";
  expectsEmpty: boolean;
  samples: number;
  /** Median of `caughtLabels.length` across samples. */
  caughtCount: number;
  totalLabels: number;
  totalForbiddenLabels: number;
  /** Maximum `forbiddenLabels.length` across samples; any recurrence is a failure. */
  maxForbidden: number;
  /** Median of `unlabeledComments` — used for false-positive gauge on clean fixtures. */
  medianUnlabeled: number;
  medianCost: number;
  medianDispatches: number;
  medianDurationMs: number;
  /** True when ≥⌈samples/2⌉ samples produced an error. */
  hadError: boolean;
  /** Per-sample raw rows for debugging. */
  rawSamples: FixtureSample[];
}

/**
 * Roll-up across the whole fixture set for one config. Drives the
 * multi-criteria threshold check.
 */
export interface AggregateScore {
  config: string;
  /** Total synthetic plants caught / total synthetic plants tracked. */
  syntheticCaught: number;
  syntheticPlants: number;
  /** Total real-PR labels caught across all real-PR fixtures. */
  realCaught: number;
  realPlants: number;
  /** Total known false-positive traps across fixtures. */
  falsePositiveTraps: number;
  /** Max-summed known false-positive hits across fixtures. Threshold: zero. */
  falsePositiveTrapHits: number;
  /** Total unlabeled comments across BOTH clean-control fixtures (proxy: false-positive count). */
  cleanFixtureUnlabeled: number;
  /** Total cost summed across all (fixture × samples). */
  totalCost: number;
  /** Median dispatch count across fixtures expected to have ≥1 substantive file. */
  medianDispatchesOnSubstantive: number;
  /** Per-fixture rows in stable display order. */
  rows: FixtureScore[];
}

/**
 * Verdict from `checkThreshold()`. Multi-criteria gate per ADR-0031 §3.
 */
export interface ThresholdVerdict {
  cleared: boolean;
  /** Names of the criteria that failed. Empty when `cleared`. */
  failed: string[];
  /** Human-readable summary of every criterion's pass/fail with the numbers. */
  details: string[];
}

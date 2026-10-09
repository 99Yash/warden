/**
 * M15 (ADR-0031) eval suite entry point. Runs each candidate config in
 * `configs/` against every fixture under `fixtures/synthetic/` and
 * `fixtures/real-prs/`, scores each (fixture × config) pair with N=3
 * samples, and emits a JSON scorecard + markdown table + verdict line per
 * the multi-criteria threshold defined in `score.mts`.
 *
 * Slice #43 adds the `opencode-down` runtime (`--parity`), which scores
 * the OpenCode down lane through `driveOpencodeLane` on two-commit
 * fixture repos, plus a `--max-cost` ceiling that fails closed.
 *
 * Usage:
 *   pnpm eval                            # all configs × all fixtures, N=3
 *   pnpm eval --config <name>            # one config × all fixtures
 *   pnpm eval --fixture <name>           # all configs × one fixture
 *   pnpm eval --fixture-regex misses     # all configs × matching fixture names
 *   pnpm eval --samples <n>              # override sample count
 *   pnpm eval --compare <cfgA> <cfgB>    # side-by-side scorecard diff
 *   pnpm eval --parity <ref> <cand>      # parity gate + opencode-parity scorecard
 *   pnpm eval --max-cost <usd>            # cumulative spend ceiling (default 4)
 *
 * Requires at least one configured review LLM provider key; emits a skip
 * notice and exits 0 when unset. Each run takes ~$0.20–$1.00 per fixture per sample per
 * `feedback_milestone_closeout.md`; full-suite cycle (~10 fixtures × 3
 * configs × 3 samples) ≈ $20–90.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  runReviewHarness,
  type CommentSet,
  type LaneOutput,
  type ReviewHarnessInput,
} from "@warden/core";
import { configuredReviewLlmProviders, loadWardenRuntime, providerApiKey } from "@warden/env";
import { DOWN_LANE_SPEC } from "../../src/opencode/materialize.js";
import { driveOpencodeLane, type SessionUsage } from "../../src/opencode/drive.js";
import { ALL_CONFIGS, OPENCODE_CONFIGS } from "./configs/index.js";
import {
  buildFixtureRepo,
  cleanupMaterialized,
  materializePatchPostImages,
  removeFixtureRepo,
} from "./fixture-repo.mjs";
import {
  aggregateScores,
  checkParity,
  checkThreshold,
  renderMarkdownTable,
  scoreFixtureRun,
} from "./score.mjs";
import type {
  AggregateScore,
  EvalConfig,
  Fixture,
  FixtureLabel,
  FixtureMeta,
  FixtureSample,
  FixtureScore,
} from "./types.js";

// ---------------------------------------------------------------------------
// CLI argv
// ---------------------------------------------------------------------------

interface Args {
  configFilter?: string;
  fixtureFilter?: string;
  fixtureRegex?: RegExp;
  samples: number;
  compare?: [string, string];
  parity?: [string, string];
  maxCost: number;
}

const DEFAULT_MAX_COST_USD = 4;

function parseArgs(argv: string[]): Args {
  const args: Args = { samples: 3, maxCost: DEFAULT_MAX_COST_USD };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--config" && argv[i + 1]) {
      args.configFilter = argv[++i];
    } else if (arg === "--fixture" && argv[i + 1]) {
      args.fixtureFilter = argv[++i];
    } else if (arg === "--fixture-regex" && argv[i + 1]) {
      const pattern = argv[++i];
      if (pattern) args.fixtureRegex = new RegExp(pattern);
    } else if (arg === "--samples" && argv[i + 1]) {
      const n = Number(argv[++i]);
      if (Number.isFinite(n) && n > 0) args.samples = Math.trunc(n);
    } else if (arg === "--compare" && argv[i + 1] && argv[i + 2]) {
      const a = argv[++i];
      const b = argv[++i];
      if (a && b) args.compare = [a, b];
    } else if (arg === "--parity" && argv[i + 1] && argv[i + 2]) {
      const a = argv[++i];
      const b = argv[++i];
      if (a && b) args.parity = [a, b];
    } else if (arg === "--max-cost" && argv[i + 1]) {
      const n = Number(argv[++i]);
      if (Number.isFinite(n) && n >= 0) args.maxCost = n;
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// Filesystem layout
// ---------------------------------------------------------------------------

const EVAL_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = resolve(EVAL_DIR, "fixtures");
const RESULTS_DIR = resolve(EVAL_DIR, "results");
// EVAL_DIR = <warden>/packages/cli/scripts/eval → up four to the warden root.
const WARDEN_ROOT = resolve(EVAL_DIR, "..", "..", "..", "..");
const WORKTREES_DIR = resolve(EVAL_DIR, ".eval-worktrees");

/**
 * Logical repo name → local checkout. Real-PR fixtures live in sibling repos;
 * `WARDEN_EVAL_<NAME>_REPO` env vars override the default path so the eval is
 * not wedded to a fixed sibling layout on other machines.
 */
function resolveRepoPath(repo: string): string | null {
  const envOverride = process.env[`WARDEN_EVAL_${repo.toUpperCase()}_REPO`];
  if (envOverride) return resolve(envOverride);
  const defaults: Record<string, string> = {
    warden: WARDEN_ROOT,
    alfred: resolve(WARDEN_ROOT, "..", "alfred"),
  };
  return defaults[repo] ?? null;
}

function loadConfigs(filter: string | undefined): EvalConfig[] {
  if (!filter) return ALL_CONFIGS;
  return [...ALL_CONFIGS, ...OPENCODE_CONFIGS].filter((c) => c.name === filter);
}

function loadFixtures(filter: string | undefined, regex: RegExp | undefined): Fixture[] {
  const out: Fixture[] = [];
  for (const category of ["synthetic", "real-prs"] as const) {
    const dir = resolve(FIXTURES_DIR, category);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (filter && name !== filter) continue;
      if (regex && !regex.test(name)) continue;
      const fixtureDir = resolve(dir, name);
      const patchPath = resolve(fixtureDir, "diff.patch");
      const labelsPath = resolve(fixtureDir, "labels.md");
      if (!existsSync(patchPath) || !existsSync(labelsPath)) continue;
      const diff = readFileSync(patchPath, "utf8");
      const labelsRaw = readFileSync(labelsPath, "utf8");
      const { labels, expectsEmpty } = parseLabels(labelsRaw);
      out.push({ name, category, diff, labels, expectsEmpty, ...resolveRealRepo(fixtureDir) });
    }
  }
  return out;
}

/**
 * Read a real-PR fixture's optional `meta.json` and resolve its logical repo
 * name to a local checkout. Returns `{}` (no real-repo backing) when the file
 * is absent, malformed, the repo is unknown, the checkout is missing, or the
 * commit is unreachable — the fixture then falls back to sparse materialization.
 */
function resolveRealRepo(fixtureDir: string): Pick<Fixture, "realRepo"> {
  const metaPath = resolve(fixtureDir, "meta.json");
  if (!existsSync(metaPath)) return {};
  let meta: FixtureMeta;
  try {
    meta = JSON.parse(readFileSync(metaPath, "utf8")) as FixtureMeta;
  } catch {
    process.stdout.write(`[eval] ${fixtureDir}: malformed meta.json — sparse fallback.\n`);
    return {};
  }
  const repoPath = resolveRepoPath(meta.repo);
  if (!repoPath || !existsSync(resolve(repoPath, ".git"))) {
    process.stdout.write(
      `[eval] ${meta.repo} repo not found (set WARDEN_EVAL_${meta.repo.toUpperCase()}_REPO) — sparse fallback.\n`,
    );
    return {};
  }
  try {
    execFileSync("git", ["-C", repoPath, "cat-file", "-e", `${meta.commit}^{commit}`], {
      stdio: "ignore",
    });
  } catch {
    process.stdout.write(
      `[eval] commit ${meta.commit} unreachable in ${meta.repo} — sparse fallback.\n`,
    );
    return {};
  }
  return { realRepo: { repoPath, commit: meta.commit } };
}

let worktreeSeq = 0;

/**
 * Check out a detached worktree at `commit` so the harness sees the full
 * post-PR tree. The caller MUST `removeWorktree()` in a finally block.
 */
function addWorktree(repoPath: string, commit: string): string {
  if (!existsSync(WORKTREES_DIR)) mkdirSync(WORKTREES_DIR, { recursive: true });
  const dest = resolve(WORKTREES_DIR, `wt-${worktreeSeq++}`);
  rmSync(dest, { recursive: true, force: true });
  // `worktreeSeq` resets to 0 each process, so `wt-<n>` paths are reused across
  // runs. If a prior run was interrupted between `add` and `removeWorktree`,
  // git keeps `wt-<n>` registered while the dir is gone — a bare `add` then
  // fails with `fatal: ... missing but already registered worktree`. Prune the
  // stale admin entry first and force the add so reruns self-heal instead of
  // wedging the whole suite.
  try {
    execFileSync("git", ["-C", repoPath, "worktree", "prune"], { stdio: "ignore" });
  } catch {
    // Best-effort — a prune failure must not abort the run.
  }
  execFileSync("git", ["-C", repoPath, "worktree", "add", "-f", "--detach", dest, commit], {
    stdio: "ignore",
  });
  return dest;
}

function removeWorktree(repoPath: string, dest: string): void {
  try {
    execFileSync("git", ["-C", repoPath, "worktree", "remove", "--force", dest], {
      stdio: "ignore",
    });
  } catch {
    // `remove` failed — delete the dir and prune so the reused `wt-<n>` path is
    // not left registered-but-missing for the next run.
    rmSync(dest, { recursive: true, force: true });
    try {
      execFileSync("git", ["-C", repoPath, "worktree", "prune"], { stdio: "ignore" });
    } catch {
      // Best-effort.
    }
  }
}

/**
 * Parse `labels.md`. Two shapes:
 *   1. `expected: zero comments` (clean-control). Returns `expectsEmpty: true`.
 *   2. List of `- id: <id>` blocks with `path`, `line` (optional),
 *      `category` (optional), `description` properties. `expect: absent`
 *      marks a known false-positive trap. We accept a lightweight YAML-ish
 *      key:value format inside fenced ```yaml``` blocks to keep authoring
 *      trivial.
 */
function parseLabels(raw: string): { labels: FixtureLabel[]; expectsEmpty: boolean } {
  if (/expected:\s*(zero|no)\s+comments/i.test(raw)) {
    return { labels: [], expectsEmpty: true };
  }
  const labels: FixtureLabel[] = [];
  // Find fenced ```yaml``` blocks and parse each as a label.
  const blockRe = /```(?:yaml|yml)?\s*\n([\s\S]*?)\n```/g;
  let match: RegExpExecArray | null;
  while ((match = blockRe.exec(raw)) !== null) {
    const body = match[1] ?? "";
    const label = parseLabelBlock(body);
    if (label) labels.push(label);
  }
  return { labels, expectsEmpty: false };
}

function parseLabelBlock(text: string): FixtureLabel | null {
  const lines = text.split("\n");
  const kv: Record<string, string> = {};
  for (const line of lines) {
    const m = line.match(/^\s*([a-z_]+):\s*(.+)\s*$/i);
    if (!m) continue;
    const key = m[1];
    const val = m[2];
    if (key && val) kv[key.toLowerCase()] = val.trim();
  }
  if (!kv["id"] || !kv["path"]) return null;
  const label: FixtureLabel = {
    id: kv["id"],
    expect: parseLabelExpectation(kv["expect"] ?? kv["expected"]),
    path: kv["path"],
    description: kv["description"] ?? "",
  };
  if (kv["line"]) {
    const n = Number(kv["line"]);
    if (Number.isFinite(n)) label.line = n;
  }
  if (kv["category"]) label.category = kv["category"];
  if (kv["claim_includes"]) label.claimIncludes = kv["claim_includes"];
  return label;
}

function parseLabelExpectation(raw: string | undefined): "present" | "absent" {
  if (!raw) return "present";
  const normalized = raw.toLowerCase().trim();
  if (
    normalized === "absent" ||
    normalized === "forbidden" ||
    normalized === "false-positive" ||
    normalized === "false_positive" ||
    normalized === "no-comment"
  ) {
    return "absent";
  }
  return "present";
}

// ---------------------------------------------------------------------------
// Harness invocation
// ---------------------------------------------------------------------------

interface OnceResult {
  result: CommentSet | null;
  error: string | null;
  wallMs: number;
  usage?: SessionUsage;
  lanes?: LaneOutput[];
  excludedBinary?: number;
}

/** Extra scoring inputs for the OpenCode runtime (absent = harness). */
interface OpencodeScoreExtra {
  usage?: SessionUsage;
  lanes?: LaneOutput[];
  excludedBinary: number;
}

/**
 * Measured only when the session usage was read AND (`costUsd > 0` or all
 * token counts are 0 — a free or unpriced model that did work).
 */
function isUsageMeasured(usage: SessionUsage | undefined): boolean {
  if (usage === undefined) return false;
  if (usage.costUsd > 0) return true;
  const t = usage.tokens;
  return (
    t.input === 0 && t.output === 0 && t.reasoning === 0 && t.cacheRead === 0 && t.cacheWrite === 0
  );
}

async function runOnce(
  fixture: Fixture,
  config: EvalConfig,
  repoRoot: string,
): Promise<OnceResult> {
  if (config.runtime === "opencode") return await runOnceOpencode(fixture, config);
  return await runOnceHarness(fixture, config, repoRoot);
}

/**
 * Run the OpenCode down lane on a two-commit fixture repo through the
 * same driver code as `warden opencode-review`: the scored output is the
 * published `CommentSet` from `runPostPass`, not eval-only logic.
 */
async function runOnceOpencode(fixture: Fixture, config: EvalConfig): Promise<OnceResult> {
  const startedAt = Date.now();
  let repo;
  try {
    repo = buildFixtureRepo(fixture);
  } catch (err) {
    return {
      result: null,
      error: err instanceof Error ? err.message : String(err),
      wallMs: Date.now() - startedAt,
      excludedBinary: 0,
    };
  }
  try {
    const driven = await driveOpencodeLane({
      repoRoot: repo.root,
      baseRef: repo.baseSha,
      ...(config.opencodeModel !== undefined ? { model: config.opencodeModel } : {}),
    });
    return {
      result: driven.result,
      error: null,
      wallMs: Date.now() - startedAt,
      ...(driven.usage !== undefined ? { usage: driven.usage } : {}),
      lanes: driven.lanes,
      excludedBinary: repo.excludedBinary,
    };
  } catch (err) {
    return {
      result: null,
      error: err instanceof Error ? err.message : String(err),
      wallMs: Date.now() - startedAt,
      excludedBinary: repo.excludedBinary,
    };
  } finally {
    removeFixtureRepo(repo);
  }
}

/**
 * Run one harness invocation against a fixture. Two steps:
 *
 *   1. **Materialize sparse post-image files to disk.** Workers'
 *      `buildFileSnippet()` reads file content from disk via `readFile`;
 *      if the file isn't there, the snippet is empty, the worker has
 *      nothing to send to the LLM, and `runWorker` short-circuits with
 *      zero tokens — bypassing the calibration entirely. We parse each
 *      unified-diff hunk and write the post-change hunk lines at their
 *      real line numbers, padding gaps with blank lines. This is not a
 *      full patch apply, but it is enough for diff-scoped snippets and
 *      citation verification on the labeled changed lines.
 *
 *   2. **Invoke the harness** with the fixture's diff text and the temp
 *      repoRoot (the diff itself is what det-priors parses; the disk
 *      content is only consulted by workers).
 *
 *   3. **Clean up** the materialized files between runs so fixtures don't
 *      leak state into each other.
 */
async function runOnceHarness(
  fixture: Fixture,
  config: EvalConfig,
  repoRoot: string,
): Promise<OnceResult> {
  const startedAt = Date.now();
  const materializedPaths: string[] = [];
  // Real-PR fixtures check out the PR's head commit as a detached worktree so
  // worker tools read the full post-PR tree. Synthetic (and any real fixture
  // whose repo/commit didn't resolve) fall back to sparse diff materialization
  // on the shared temp repoRoot. `worktree` is resolved inside the try so a
  // failed `git worktree add` degrades to sparse materialization rather than
  // aborting the whole suite (consistent with resolveRealRepo's fallbacks).
  let worktree: string | null = null;
  try {
    if (fixture.realRepo) {
      try {
        worktree = addWorktree(fixture.realRepo.repoPath, fixture.realRepo.commit);
      } catch (err) {
        process.stdout.write(
          `[eval] ${fixture.name}: worktree add failed ` +
            `(${err instanceof Error ? err.message : String(err)}) — sparse fallback.\n`,
        );
        worktree = null;
      }
    }
    const effectiveRoot = worktree ?? repoRoot;
    if (!worktree) {
      materializedPaths.push(...materializePatchPostImages(fixture.diff, repoRoot));
    }
    const input: ReviewHarnessInput = {
      diff: fixture.diff,
      repoRoot: effectiveRoot,
      config: {
        mode: "review",
        ...(config.bossLoop !== undefined ? { bossLoop: config.bossLoop } : {}),
      },
      // Selector skipped — fixtures are isolated; we don't want the selector
      // chasing context outside the diff.
      selector: null,
    };
    const result = await runReviewHarness(input);
    return { result, error: null, wallMs: Date.now() - startedAt };
  } catch (err) {
    return {
      result: null,
      error: err instanceof Error ? err.message : String(err),
      wallMs: Date.now() - startedAt,
    };
  } finally {
    cleanupMaterialized(materializedPaths);
    if (worktree && fixture.realRepo) removeWorktree(fixture.realRepo.repoPath, worktree);
  }
}

/**
 * Score a single harness result against the fixture's labels.
 *
 * A `present` label is "caught" iff at least one Comment cites its `path` AND
 * (when the label has a `line`) cites within ±5 lines of it AND (when the
 * label has a `category`) matches Comment.category. An `absent` label is a
 * known false-positive trap; any matching comment records a forbidden hit.
 * Unmatched comments increment `unlabeledComments` — used as the
 * false-positive gauge for clean fixtures.
 */
function scoreOne(
  fixture: Fixture,
  result: CommentSet | null,
  sample: number,
  configName: string,
  opencodeExtra?: OpencodeScoreExtra,
): FixtureSample {
  const base: FixtureSample = {
    fixture: fixture.name,
    config: configName,
    sample,
    commentCount: 0,
    comments: [],
    caughtLabels: [],
    missedLabels: fixture.labels.filter((l) => labelExpectation(l) === "present").map((l) => l.id),
    forbiddenLabels: [],
    unlabeledComments: 0,
    dispatchCount: 0,
    costUsd: 0,
    durationMs: 0,
    error: null,
    costMeasured: opencodeExtra === undefined ? true : isUsageMeasured(opencodeExtra.usage),
    ...(opencodeExtra !== undefined ? { excludedBinary: opencodeExtra.excludedBinary } : {}),
  };
  if (!result) {
    base.error = "harness threw";
    return base;
  }

  base.commentCount = result.comments.length;
  base.comments = result.comments.map((c) => ({
    id: c.id,
    file: c.file,
    lineStart: c.lineStart,
    lineEnd: c.lineEnd,
    category: c.category,
    kind: c.kind,
    tier: c.tier,
    confidence: c.confidence,
    claim: c.claim,
    sourcesCount: c.sources.length,
  }));
  base.durationMs = result.metadata.durationMs;
  if (opencodeExtra !== undefined) {
    base.costUsd = opencodeExtra.usage?.costUsd ?? 0;
    // The lane envelope's status reads "the lane ran" for criterion (e):
    // 1 when the lane completed, 0 when it failed or threw.
    const laneOk =
      opencodeExtra.lanes !== undefined
        ? opencodeExtra.lanes.some((l) => l.status === "ok")
        : false;
    base.dispatchCount = laneOk ? 1 : 0;
  } else {
    base.costUsd = result.metadata.costUsd ?? 0;
    base.dispatchCount = approximateDispatchCount(result);
  }

  const presentLabels = fixture.labels.filter((l) => labelExpectation(l) === "present");
  const absentLabels = fixture.labels.filter((l) => labelExpectation(l) === "absent");
  const labelHits = new Set<string>();
  const forbiddenHits = new Set<string>();
  const matchedCommentIds = new Set<string>();
  for (const label of presentLabels) {
    for (const comment of result.comments) {
      if (matchedCommentIds.has(comment.id)) continue;
      if (matchesLabel(comment, label)) {
        labelHits.add(label.id);
        matchedCommentIds.add(comment.id);
        break;
      }
    }
  }
  for (const label of absentLabels) {
    for (const comment of result.comments) {
      if (matchesLabel(comment, label)) {
        forbiddenHits.add(label.id);
        break;
      }
    }
  }
  base.caughtLabels = [...labelHits];
  base.missedLabels = presentLabels.filter((l) => !labelHits.has(l.id)).map((l) => l.id);
  base.forbiddenLabels = [...forbiddenHits];
  base.unlabeledComments = result.comments.filter((c) => !matchedCommentIds.has(c.id)).length;
  return base;
}

function matchesLabel(
  comment: { file: string; lineStart: number; lineEnd: number; category: string; claim: string },
  label: FixtureLabel,
): boolean {
  if (comment.file !== label.path) return false;
  if (label.line !== undefined) {
    const drift = 5;
    const lo = comment.lineStart - drift;
    const hi = comment.lineEnd + drift;
    if (label.line < lo || label.line > hi) return false;
  }
  if (label.category !== undefined && comment.category !== label.category) return false;
  if (
    label.claimIncludes !== undefined &&
    !comment.claim.toLowerCase().includes(label.claimIncludes.toLowerCase())
  ) {
    return false;
  }
  return true;
}

function labelExpectation(label: FixtureLabel): "present" | "absent" {
  return label.expect ?? "present";
}

/**
 * Approximate dispatch count from the public CommentSet metadata. We treat
 * "any sonnet or haiku token usage" as ≥1 dispatch. Insufficient for fine-
 * grained dispatch metrics, but enough for the (e) threshold (≥1 dispatch
 * on substantive fixtures). The scratchpad's per-worker count isn't on the
 * public surface; exposing it for measurement-only is out of scope for M15.
 *
 * The OpenCode runtime does not use this: its samples set `dispatchCount`
 * from the lane envelope's status (1 when the lane ran `ok`, else 0), so
 * criterion (e) reads "the lane ran".
 */
function approximateDispatchCount(set: CommentSet): number {
  const usage = set.metadata.tokenUsage;
  if (!usage) return 0;
  let dispatches = 0;
  if (usage.sonnet && usage.sonnet.outputTokens + usage.sonnet.inputTokens > 0) dispatches += 1;
  if (usage.haiku && usage.haiku.outputTokens + usage.haiku.inputTokens > 0) dispatches += 1;
  return dispatches;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // Bootstrap the Warden runtime the same way the CLI does (index.ts:66) so the
  // repo-root `.env` is loaded into process.env — the eval runs from
  // packages/cli, so without this the project `.env` (which holds the keys) is
  // never picked up and every run self-skips.
  loadWardenRuntime({ repoRoot: WARDEN_ROOT });

  const configuredProviders = configuredReviewLlmProviders().filter(
    (providerId) => providerApiKey(providerId) !== undefined,
  );

  // `--compare a b` without an explicit `--config` runs just those two
  // configs (not all of ALL_CONFIGS) — the comparison table only needs the
  // named pair, so running the rest just burns tokens. `--parity` resolves
  // against both lists so the opencode candidate is reachable.
  let configs = loadConfigs(args.configFilter);
  if (!args.configFilter && args.compare) {
    const [a, b] = args.compare;
    configs = configs.filter((c) => c.name === a || c.name === b);
  }
  if (!args.configFilter && args.parity) {
    const [a, b] = args.parity;
    configs = [...ALL_CONFIGS, ...OPENCODE_CONFIGS].filter((c) => c.name === a || c.name === b);
  }
  const fixtures = loadFixtures(args.fixtureFilter, args.fixtureRegex);

  if (configs.length === 0) {
    process.stdout.write("[eval] no configs matched.\n");
    process.exit(1);
  }
  if (fixtures.length === 0) {
    process.stdout.write("[eval] no fixtures found — add fixtures under scripts/eval/fixtures/.\n");
    process.exit(1);
  }

  // Provider-key preflight runs only when a selected config is a harness
  // config. The OpenCode runtime needs no warden provider key.
  const needsHarness = configs.some((c) => c.runtime !== "opencode");
  const needsOpencode = configs.some((c) => c.runtime === "opencode");
  if (needsHarness && configuredProviders.length === 0) {
    process.stdout.write(
      "[eval] no review LLM provider key set — skipping (set ANTHROPIC_API_KEY or OPENAI_API_KEY).\n",
    );
    process.exit(0);
  }
  // OpenCode preflight: the binary must exist. When absent, print a skip
  // notice and exit 0, mirroring the missing-key skip.
  if (needsOpencode) {
    try {
      execFileSync("opencode", ["--version"], { stdio: "ignore" });
    } catch {
      process.stdout.write("[eval] opencode binary not found — skipping (install opencode).\n");
      process.exit(0);
    }
  }

  // Minimal repoRoot with a package.json so the harness's ecosystem
  // detector doesn't short-circuit. Reuses the same temp dir across runs.
  const repoRoot = await ensureRepoRoot();

  // Cumulative measured spend across every sample of every config. Checked
  // before each sample; the run stops before it spends past the ceiling.
  let spentUsd = 0;
  let stoppedAtCostCeiling = false;
  const aggregates: AggregateScore[] = [];
  for (const config of configs) {
    process.stdout.write(`\n## Config: ${config.name}\n${config.description}\n\n`);
    const rows: FixtureScore[] = [];
    let configStopped = false;
    for (const fixture of fixtures) {
      process.stdout.write(`  → ${fixture.category}/${fixture.name} ×${args.samples}\n`);
      const samples: FixtureSample[] = [];
      for (let i = 0; i < args.samples; i++) {
        if (spentUsd >= args.maxCost) {
          stoppedAtCostCeiling = true;
          process.stdout.write(
            `[eval] cost ceiling $${args.maxCost} reached ($${spentUsd.toFixed(4)} spent) — stopping\n`,
          );
          configStopped = true;
          break;
        }
        const { result, error, usage, lanes, excludedBinary } = await runOnce(
          fixture,
          config,
          repoRoot,
        );
        const score = scoreOne(
          fixture,
          result,
          i + 1,
          config.name,
          config.runtime === "opencode"
            ? {
                ...(usage !== undefined ? { usage } : {}),
                ...(lanes !== undefined ? { lanes } : {}),
                excludedBinary: excludedBinary ?? 0,
              }
            : undefined,
        );
        if (error !== null) score.error = error;
        samples.push(score);
        if (!score.costMeasured) {
          // Fail closed: the ceiling cannot bound unmeasured spend.
          stoppedAtCostCeiling = true;
          process.stdout.write(
            `[eval] unmeasured spend on ${config.name}/${fixture.name} sample ${i + 1} — stopping\n`,
          );
          configStopped = true;
          break;
        }
        spentUsd += score.costUsd;
        const presentLabelCount = fixture.labels.filter(
          (l) => labelExpectation(l) === "present",
        ).length;
        process.stdout.write(
          `      sample ${i + 1}/${args.samples}: ` +
            `caught ${score.caughtLabels.length}/${presentLabelCount}, ` +
            `forbidden ${score.forbiddenLabels.length}, ` +
            `comments ${score.commentCount}, ` +
            `cost $${score.costUsd.toFixed(4)}, ` +
            `${score.durationMs}ms` +
            (error ? ` [error: ${error}]` : "") +
            "\n",
        );
      }
      if (samples.length > 0) rows.push(scoreFixtureRun(fixture, samples, config.name));
      if (configStopped) break;
    }
    if (rows.length > 0) {
      const agg = aggregateScores(rows, config.name);
      aggregates.push(agg);
      process.stdout.write(`\n${renderMarkdownTable(agg)}\n`);

      const verdict = checkThreshold(agg, rows);
      process.stdout.write(`\nThreshold details:\n`);
      for (const d of verdict.details) process.stdout.write(`  ${d}\n`);
      process.stdout.write(
        `\nM15 threshold: ${verdict.cleared ? "CLEARED" : `NOT MET (criteria failed: ${verdict.failed.join(", ")})`}\n`,
      );
    }
    if (configStopped) break;
  }

  if (args.parity) {
    await writeParityScorecard(args, configs, aggregates, stoppedAtCostCeiling);
    const [refName, candName] = args.parity;
    const reference = aggregates.find((x) => x.config === refName);
    const candidate = aggregates.find((x) => x.config === candName);
    if (reference && candidate) {
      process.stdout.write(`\n## Compare: ${reference.config} vs ${candidate.config}\n\n`);
      process.stdout.write(renderCompareTable(reference, candidate) + "\n");
      const parity = checkParity(reference, candidate);
      process.stdout.write(`\nParity details:\n`);
      for (const d of parity.details) process.stdout.write(`  ${d}\n`);
      process.stdout.write(
        `\nPARITY: ${parity.cleared ? "MET" : `NOT MET (criteria failed: ${parity.failed.join(", ")})`}\n`,
      );
      process.exit(parity.cleared && !stoppedAtCostCeiling ? 0 : 1);
    }
    process.stdout.write(`[eval] --parity needs both configs in the run.\n`);
    process.exit(1);
  }

  // Write the JSON scorecard
  if (!existsSync(RESULTS_DIR)) mkdirSync(RESULTS_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const out = resolve(RESULTS_DIR, `${ts}.json`);
  writeFileSync(
    out,
    JSON.stringify({ samples: args.samples, aggregates, stoppedAtCostCeiling }, null, 2),
  );
  process.stdout.write(`\nWrote ${out}\n`);

  if (args.compare && aggregates.length >= 2) {
    const a = aggregates.find((x) => x.config === args.compare?.[0]);
    const b = aggregates.find((x) => x.config === args.compare?.[1]);
    if (a && b) {
      process.stdout.write(`\n## Compare: ${a.config} vs ${b.config}\n\n`);
      process.stdout.write(renderCompareTable(a, b) + "\n");
    }
  }

  const anyFailed = aggregates.some((agg) => {
    const verdict = checkThreshold(agg, agg.rows);
    return !verdict.cleared;
  });
  process.exit(anyFailed || stoppedAtCostCeiling ? 1 : 0);
}

function opencodeVersion(): string {
  try {
    return (execFileSync("opencode", ["--version"], { encoding: "utf8" }) as string).trim();
  } catch {
    return "unknown";
  }
}

function wardenHead(): string {
  try {
    return (
      execFileSync("git", ["-C", WARDEN_ROOT, "rev-parse", "HEAD"], {
        encoding: "utf8",
      }) as string
    ).trim();
  } catch {
    return "unknown";
  }
}

/**
 * Parity scorecard: JSON + rendered markdown under
 * `results/opencode-parity/<ts>.(json|md)` — the rendered tables plus
 * threshold details plus parity details plus run metadata.
 */
async function writeParityScorecard(
  args: Args,
  configs: EvalConfig[],
  aggregates: AggregateScore[],
  stoppedAtCostCeiling: boolean,
): Promise<void> {
  const [refName, candName] = args.parity ?? ["", ""];
  const reference = aggregates.find((x) => x.config === refName);
  const candidate = aggregates.find((x) => x.config === candName);
  const parity =
    reference && candidate
      ? checkParity(reference, candidate)
      : { cleared: false, failed: ["missing-config"], details: [] as string[] };
  const candidateConfig = configs.find((c) => c.name === candName);
  const meta = {
    samples: args.samples,
    fixtureFilter: args.fixtureFilter ?? args.fixtureRegex?.source ?? null,
    maxCost: args.maxCost,
    candidateModel: candidateConfig?.opencodeModel ?? DOWN_LANE_SPEC.defaultModel,
    opencodeVersion: opencodeVersion(),
    wardenHead: wardenHead(),
    stoppedAtCostCeiling,
  };
  const dir = resolve(RESULTS_DIR, "opencode-parity");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  writeFileSync(
    resolve(dir, `${ts}.json`),
    JSON.stringify({ ...meta, aggregates, parity }, null, 2),
  );
  const lines: string[] = [
    `# OpenCode parity — ${ts}`,
    ``,
    `- samples: ${meta.samples}`,
    `- fixture filter: ${meta.fixtureFilter ?? "(all)"}`,
    `- --max-cost: $${meta.maxCost}`,
    `- candidate model: ${meta.candidateModel}`,
    `- opencode --version: ${meta.opencodeVersion}`,
    `- warden HEAD: ${meta.wardenHead}`,
    `- stoppedAtCostCeiling: ${meta.stoppedAtCostCeiling}`,
    ``,
  ];
  for (const agg of aggregates) {
    lines.push(`## Config: ${agg.config}`, ``, renderMarkdownTable(agg), ``);
    const verdict = checkThreshold(agg, agg.rows);
    lines.push(`Threshold details:`, ...verdict.details.map((d) => `- ${d}`), ``);
  }
  if (reference && candidate) {
    lines.push(
      `## Compare: ${reference.config} vs ${candidate.config}`,
      ``,
      renderCompareTable(reference, candidate),
      ``,
      `Parity details:`,
      ...parity.details.map((d) => `- ${d}`),
      ``,
      `PARITY: ${parity.cleared ? "MET" : `NOT MET (criteria failed: ${parity.failed.join(", ")})`}`,
    );
  }
  const mdPath = resolve(dir, `${ts}.md`);
  writeFileSync(mdPath, lines.join("\n") + "\n");
  process.stdout.write(`\nWrote ${mdPath}\n`);
}

function renderCompareTable(a: AggregateScore, b: AggregateScore): string {
  const lines = [
    `| metric | ${a.config} | ${b.config} | Δ |`,
    `|--------|-------------|-------------|---|`,
    `| synthetic caught | ${a.syntheticCaught}/${a.syntheticPlants} | ${b.syntheticCaught}/${b.syntheticPlants} | ${b.syntheticCaught - a.syntheticCaught} |`,
    `| real-PR caught | ${a.realCaught}/${a.realPlants} | ${b.realCaught}/${b.realPlants} | ${b.realCaught - a.realCaught} |`,
    `| false-positive trap hits | ${a.falsePositiveTrapHits}/${a.falsePositiveTraps} | ${b.falsePositiveTrapHits}/${b.falsePositiveTraps} | ${b.falsePositiveTrapHits - a.falsePositiveTrapHits} |`,
    `| clean unlabeled | ${a.cleanFixtureUnlabeled} | ${b.cleanFixtureUnlabeled} | ${b.cleanFixtureUnlabeled - a.cleanFixtureUnlabeled} |`,
    `| total cost | $${a.totalCost.toFixed(4)} | $${b.totalCost.toFixed(4)} | $${(b.totalCost - a.totalCost).toFixed(4)} |`,
  ];
  return lines.join("\n");
}

async function ensureRepoRoot(): Promise<string> {
  const root = resolve(EVAL_DIR, ".eval-tmp-repo");
  if (!existsSync(root)) mkdirSync(root, { recursive: true });
  const pkgPath = resolve(root, "package.json");
  if (!existsSync(pkgPath)) {
    writeFileSync(
      pkgPath,
      JSON.stringify({ name: "warden-eval-fixture", version: "0.0.0", private: true }, null, 2),
    );
  }
  return root;
}

main().catch((err) => {
  process.stderr.write(
    `[eval] fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});

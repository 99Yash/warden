/**
 * M15 (ADR-0031) eval suite entry point. Runs each candidate config in
 * `configs/` against every fixture under `fixtures/synthetic/` and
 * `fixtures/real-prs/`, scores each (fixture × config) pair with N=3
 * samples, and emits a JSON scorecard + markdown table + verdict line per
 * the multi-criteria threshold defined in `score.mts`.
 *
 * Usage:
 *   pnpm eval                            # all configs × all fixtures, N=3
 *   pnpm eval --config <name>            # one config × all fixtures
 *   pnpm eval --fixture <name>           # all configs × one fixture
 *   pnpm eval --samples <n>              # override sample count
 *   pnpm eval --compare <cfgA> <cfgB>    # side-by-side scorecard diff
 *
 * Requires `ANTHROPIC_API_KEY`; emits a skip notice and exits 0 when
 * unset. Each run takes ~$0.20–$1.00 per fixture per sample per
 * `feedback_milestone_closeout.md`; full-suite cycle (~10 fixtures × 3
 * configs × 3 samples) ≈ $20–90.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  runReviewHarness,
  type CommentSet,
  type ReviewHarnessInput,
} from "@warden/core";
import { ALL_CONFIGS } from "./configs/index.js";
import {
  aggregateScores,
  checkThreshold,
  renderMarkdownTable,
  scoreFixtureRun,
} from "./score.mjs";
import type {
  AggregateScore,
  EvalConfig,
  Fixture,
  FixtureLabel,
  FixtureSample,
  FixtureScore,
} from "./types.js";

// ---------------------------------------------------------------------------
// CLI argv
// ---------------------------------------------------------------------------

interface Args {
  configFilter?: string;
  fixtureFilter?: string;
  samples: number;
  compare?: [string, string];
}

function parseArgs(argv: string[]): Args {
  const args: Args = { samples: 3 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--config" && argv[i + 1]) {
      args.configFilter = argv[++i];
    } else if (arg === "--fixture" && argv[i + 1]) {
      args.fixtureFilter = argv[++i];
    } else if (arg === "--samples" && argv[i + 1]) {
      const n = Number(argv[++i]);
      if (Number.isFinite(n) && n > 0) args.samples = Math.trunc(n);
    } else if (arg === "--compare" && argv[i + 1] && argv[i + 2]) {
      const a = argv[++i];
      const b = argv[++i];
      if (a && b) args.compare = [a, b];
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

function loadConfigs(filter: string | undefined): EvalConfig[] {
  if (!filter) return ALL_CONFIGS;
  return ALL_CONFIGS.filter((c) => c.name === filter);
}

function loadFixtures(filter: string | undefined): Fixture[] {
  const out: Fixture[] = [];
  for (const category of ["synthetic", "real-prs"] as const) {
    const dir = resolve(FIXTURES_DIR, category);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (filter && name !== filter) continue;
      const fixtureDir = resolve(dir, name);
      const patchPath = resolve(fixtureDir, "diff.patch");
      const labelsPath = resolve(fixtureDir, "labels.md");
      if (!existsSync(patchPath) || !existsSync(labelsPath)) continue;
      const diff = readFileSync(patchPath, "utf8");
      const labelsRaw = readFileSync(labelsPath, "utf8");
      const { labels, expectsEmpty } = parseLabels(labelsRaw);
      out.push({ name, category, diff, labels, expectsEmpty });
    }
  }
  return out;
}

/**
 * Parse `labels.md`. Two shapes:
 *   1. `expected: zero comments` (clean-control). Returns `expectsEmpty: true`.
 *   2. List of `- id: <id>` blocks with `path`, `line` (optional),
 *      `category` (optional), `description` properties. We accept a
 *      lightweight YAML-ish key:value format inside fenced ```yaml``` blocks
 *      to keep authoring trivial.
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
    path: kv["path"],
    description: kv["description"] ?? "",
  };
  if (kv["line"]) {
    const n = Number(kv["line"]);
    if (Number.isFinite(n)) label.line = n;
  }
  if (kv["category"]) label.category = kv["category"];
  return label;
}

// ---------------------------------------------------------------------------
// Harness invocation
// ---------------------------------------------------------------------------

/**
 * Run one harness invocation against a fixture. Two steps:
 *
 *   1. **Materialize new-file diffs to disk.** Workers' `buildFileSnippet()`
 *      reads file content from disk via `readFile`; if the file isn't
 *      there, the snippet is empty, the worker has nothing to send to the
 *      LLM, and `runWorker` short-circuits with zero tokens — bypassing
 *      the calibration entirely. For new-file hunks (`--- /dev/null`) we
 *      extract every `+` line and write the file. Modified-file hunks
 *      and the m14-closeout real-PR fixture stay un-materialized (those
 *      need pre-state + patch apply, out of scope for v0); the synthetic
 *      plants — which exercise the calibration signal — are all new
 *      files and work.
 *
 *   2. **Invoke the harness** with the fixture's diff text and the temp
 *      repoRoot (the diff itself is what det-priors parses; the disk
 *      content is only consulted by workers).
 *
 *   3. **Clean up** the materialized files between runs so fixtures don't
 *      leak state into each other.
 */
async function runOnce(fixture: Fixture, config: EvalConfig, repoRoot: string): Promise<{
  result: CommentSet | null;
  error: string | null;
  wallMs: number;
}> {
  const startedAt = Date.now();
  const materializedPaths: string[] = [];
  try {
    materializedPaths.push(...materializeNewFiles(fixture.diff, repoRoot));
    const input: ReviewHarnessInput = {
      diff: fixture.diff,
      repoRoot,
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
  }
}

/**
 * Parse a unified diff and write any new-file (`--- /dev/null`) content
 * to disk under `repoRoot`. Returns the list of paths written so the
 * caller can clean them up after the harness invocation.
 *
 * v0 only handles new-file hunks. Modified-file hunks require the pre-
 * state on disk (which we don't have in `.eval-tmp-repo/`); applying a
 * patch in reverse + forward is out of scope. Synthetic plant fixtures
 * are all new files, which is what calibration cares about.
 */
function materializeNewFiles(diff: string, repoRoot: string): string[] {
  const written: string[] = [];
  const lines = diff.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.startsWith("--- /dev/null")) {
      // Next line MUST be `+++ b/<path>`.
      const next = lines[i + 1] ?? "";
      if (next.startsWith("+++ ")) {
        const target = next.slice(4).trim();
        const path = target.startsWith("b/") ? target.slice(2) : target;
        // Collect all subsequent `+` lines until the next `diff --git` /
        // `--- ` block, ignoring `@@` hunk headers.
        const contentLines: string[] = [];
        let j = i + 2;
        while (j < lines.length) {
          const c = lines[j] ?? "";
          if (c.startsWith("diff --git ") || c.startsWith("--- ")) break;
          if (c.startsWith("+") && !c.startsWith("+++")) {
            contentLines.push(c.slice(1));
          }
          j++;
        }
        const fullPath = resolve(repoRoot, path);
        mkdirSync(dirname(fullPath), { recursive: true });
        writeFileSync(fullPath, contentLines.join("\n") + (contentLines.length > 0 ? "\n" : ""));
        written.push(fullPath);
        i = j;
        continue;
      }
    }
    i++;
  }
  return written;
}

function cleanupMaterialized(paths: string[]): void {
  for (const p of paths) {
    try {
      unlinkSync(p);
    } catch {
      // Ignore — best-effort cleanup.
    }
  }
}

/**
 * Score a single harness result against the fixture's labels.
 *
 * A label is "caught" iff at least one Comment cites its `path` AND (when
 * the label has a `line`) cites within ±5 lines of it AND (when the label
 * has a `category`) matches Comment.category. Unmatched comments increment
 * `unlabeledComments` — used as the false-positive gauge for clean fixtures.
 */
function scoreOne(fixture: Fixture, result: CommentSet | null, sample: number, configName: string): FixtureSample {
  const base: FixtureSample = {
    fixture: fixture.name,
    config: configName,
    sample,
    commentCount: 0,
    caughtLabels: [],
    missedLabels: fixture.labels.map((l) => l.id),
    unlabeledComments: 0,
    dispatchCount: 0,
    costUsd: 0,
    durationMs: 0,
    error: null,
  };
  if (!result) {
    base.error = "harness threw";
    return base;
  }

  base.commentCount = result.comments.length;
  base.durationMs = result.metadata.durationMs;
  base.costUsd = result.metadata.costUsd ?? 0;
  base.dispatchCount = approximateDispatchCount(result);

  const labelHits = new Set<string>();
  const matchedCommentIds = new Set<string>();
  for (const label of fixture.labels) {
    for (const comment of result.comments) {
      if (matchesLabel(comment, label)) {
        labelHits.add(label.id);
        matchedCommentIds.add(comment.id);
        break;
      }
    }
  }
  base.caughtLabels = [...labelHits];
  base.missedLabels = fixture.labels.filter((l) => !labelHits.has(l.id)).map((l) => l.id);
  base.unlabeledComments = result.comments.filter((c) => !matchedCommentIds.has(c.id)).length;
  return base;
}

function matchesLabel(
  comment: { file: string; lineStart: number; lineEnd: number; category: string },
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
  return true;
}

/**
 * Approximate dispatch count from the public CommentSet metadata. We treat
 * "any sonnet or haiku token usage" as ≥1 dispatch. Insufficient for fine-
 * grained dispatch metrics, but enough for the (e) threshold (≥1 dispatch
 * on substantive fixtures). The scratchpad's per-worker count isn't on the
 * public surface; exposing it for measurement-only is out of scope for M15.
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

  if (!process.env["ANTHROPIC_API_KEY"]) {
    process.stdout.write("[eval] ANTHROPIC_API_KEY not set — skipping.\n");
    process.exit(0);
  }

  const configs = loadConfigs(args.configFilter);
  const fixtures = loadFixtures(args.fixtureFilter);

  if (configs.length === 0) {
    process.stdout.write("[eval] no configs matched.\n");
    process.exit(1);
  }
  if (fixtures.length === 0) {
    process.stdout.write("[eval] no fixtures found — add fixtures under scripts/eval/fixtures/.\n");
    process.exit(1);
  }

  // Minimal repoRoot with a package.json so the harness's ecosystem
  // detector doesn't short-circuit. Reuses the same temp dir across runs.
  const repoRoot = await ensureRepoRoot();

  const aggregates: AggregateScore[] = [];
  for (const config of configs) {
    process.stdout.write(`\n## Config: ${config.name}\n${config.description}\n\n`);
    const rows: FixtureScore[] = [];
    for (const fixture of fixtures) {
      process.stdout.write(`  → ${fixture.category}/${fixture.name} ×${args.samples}\n`);
      const samples: FixtureSample[] = [];
      for (let i = 0; i < args.samples; i++) {
        const { result, error } = await runOnce(fixture, config, repoRoot);
        const score = scoreOne(fixture, result, i + 1, config.name);
        if (error !== null) score.error = error;
        samples.push(score);
        process.stdout.write(
          `      sample ${i + 1}/${args.samples}: ` +
            `caught ${score.caughtLabels.length}/${fixture.labels.length}, ` +
            `comments ${score.commentCount}, ` +
            `cost $${score.costUsd.toFixed(4)}, ` +
            `${score.durationMs}ms` +
            (error ? ` [error: ${error}]` : "") +
            "\n",
        );
      }
      rows.push(scoreFixtureRun(fixture, samples, config.name));
    }
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

  // Write the JSON scorecard
  if (!existsSync(RESULTS_DIR)) mkdirSync(RESULTS_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const out = resolve(RESULTS_DIR, `${ts}.json`);
  writeFileSync(out, JSON.stringify({ samples: args.samples, aggregates }, null, 2));
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
  process.exit(anyFailed ? 1 : 0);
}

function renderCompareTable(a: AggregateScore, b: AggregateScore): string {
  const lines = [
    `| metric | ${a.config} | ${b.config} | Δ |`,
    `|--------|-------------|-------------|---|`,
    `| synthetic caught | ${a.syntheticCaught}/${a.syntheticPlants} | ${b.syntheticCaught}/${b.syntheticPlants} | ${b.syntheticCaught - a.syntheticCaught} |`,
    `| real-PR caught | ${a.realCaught}/${a.realPlants} | ${b.realCaught}/${b.realPlants} | ${b.realCaught - a.realCaught} |`,
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
  process.stderr.write(`[eval] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});

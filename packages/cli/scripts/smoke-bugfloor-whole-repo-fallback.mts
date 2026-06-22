/**
 * Bugfloor smoke for repo-audit 2026-05-18 follow-ups (#2 + #3).
 *
 *   [1] `--base <empty-tree-SHA>` (tree ref) resolves correctly via two-dot
 *       diff. Pre-fix this took the three-dot path which git rejects for
 *       <tree>...<commit> and `runGitDiff` silently swallowed into "" —
 *       review proceeded against an empty diff with no degraded signal.
 *
 *   [2] `--base <commit>` preserves three-dot (PR merge-base) semantic.
 *       When main diverges after the feature branch was cut, the diff
 *       must NOT include reverse-applied main commits as deletions —
 *       that's what three-dot guarantees. Regression guard for Devon's
 *       PR review (#20) on the initial two-dot-everywhere implementation.
 *
 *   [3] `--base` pointing at a bogus ref produces an empty diff plus a
 *       `degraded: actionable / topic=diff-source` entry instead of silently
 *       returning "".
 *
 *   [4] `semanticSignal` drops hits whose attributed file no longer exists on
 *       disk when `repoRoot` is supplied — protects jscpd's lstat from
 *       ENOENT on M14-deleted files retained in `chunks.file_path` under
 *       first-writer-wins. Backward compat: omitting `repoRoot` skips the
 *       filter.
 *
 * Usage: pnpm --filter @warden/cli smoke:bugfloor-whole-repo-fallback
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const TMP_ROOT = resolve(tmpdir(), `warden-bugfloor-whole-repo-${process.pid}-${Date.now()}`);

if (existsSync(TMP_ROOT)) rmSync(TMP_ROOT, { recursive: true, force: true });
mkdirSync(TMP_ROOT, { recursive: true });

const { resolveDiff } = await import("@warden/core");
const { semanticSignal } = await import("@warden/core/context/signals/semantic");

let failed = 0;
function assert(cond: unknown, msg: string): void {
  if (cond) {
    process.stdout.write(`  ✓ ${msg}\n`);
  } else {
    process.stdout.write(`  ✗ ${msg}\n`);
    failed++;
  }
}

function git(args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync("git", args, { cwd: TMP_ROOT, encoding: "utf8" });
  return { ok: r.status === 0, stdout: r.stdout, stderr: r.stderr };
}

process.stdout.write(`\n[1] resolveDiff with --base = empty-tree SHA succeeds (two-dot)\n`);

git(["init", "-q"]);
git(["config", "user.email", "smoke@warden.local"]);
git(["config", "user.name", "warden-smoke"]);
git(["config", "commit.gpgsign", "false"]);

writeFileSync(resolve(TMP_ROOT, "alpha.ts"), `export const alpha = 1;\n`);
writeFileSync(resolve(TMP_ROOT, "bravo.ts"), `export const bravo = 2;\n`);
git(["add", "."]);
const commitResult = git(["commit", "-q", "-m", "seed", "--no-gpg-sign"]);
if (!commitResult.ok) {
  process.stdout.write(`  ✗ failed to seed temp repo: ${commitResult.stderr}\n`);
  process.exit(1);
}

const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

const wholeRepoDiff = await resolveDiff({
  repoRoot: TMP_ROOT,
  mode: "review",
  baseRef: EMPTY_TREE_SHA,
});
assert(
  wholeRepoDiff.diff.length > 0,
  `whole-repo diff is non-empty (got ${wholeRepoDiff.diff.length} chars)`,
);
assert(
  wholeRepoDiff.diff.includes("alpha.ts") && wholeRepoDiff.diff.includes("bravo.ts"),
  "diff includes both seeded files",
);
assert(wholeRepoDiff.degraded === undefined, "no degraded entry surfaced on the happy path");

process.stdout.write(`\n[2] resolveDiff with --base = commit ref preserves three-dot semantic\n`);

// Build the diverged-history scenario:
//   main:  seed → main-advance        (one extra commit on main)
//                 \
//   feature:       feature-only       (one extra commit on feature, off seed)
//
// Three-dot `main...HEAD` from feature must show ONLY `feature-only.ts`.
// Two-dot would also reverse-apply `main-advance.ts` as a deletion.

git(["checkout", "-q", "-b", "main-branch"]);
writeFileSync(resolve(TMP_ROOT, "main-advance.ts"), `export const onMain = 99;\n`);
git(["add", "main-advance.ts"]);
git(["commit", "-q", "-m", "main: advance", "--no-gpg-sign"]);

git(["checkout", "-q", "-b", "feature-branch", "main-branch~1"]);
writeFileSync(resolve(TMP_ROOT, "feature-only.ts"), `export const onFeature = 42;\n`);
git(["add", "feature-only.ts"]);
git(["commit", "-q", "-m", "feature: add", "--no-gpg-sign"]);

const featureDiff = await resolveDiff({
  repoRoot: TMP_ROOT,
  mode: "review",
  baseRef: "main-branch",
});
assert(
  featureDiff.diff.includes("feature-only.ts"),
  "diff includes the feature branch's own addition",
);
assert(
  !featureDiff.diff.includes("main-advance.ts"),
  "diff does NOT include main's post-divergence commit (three-dot, not two-dot)",
);
assert(featureDiff.degraded === undefined, "no degraded entry for commit-ref --base happy path");

// Restore initial branch context for subsequent steps.
git(["checkout", "-q", "main-branch"]);

process.stdout.write(`\n[3] resolveDiff with bogus --base surfaces a degraded entry\n`);

const bogusDiff = await resolveDiff({
  repoRoot: TMP_ROOT,
  mode: "review",
  baseRef: "deadbeefcafe1234567890abcdef1234567890ab",
});
assert(bogusDiff.diff === "", "diff is empty on git failure");
assert(
  bogusDiff.degraded !== undefined && bogusDiff.degraded.length === 1,
  "exactly one degraded entry emitted",
);
const entry = bogusDiff.degraded?.[0];
assert(
  entry?.kind === "actionable" && entry?.topic === "diff-source",
  `degraded entry has kind=actionable and topic=diff-source (got ${entry?.kind}/${entry?.topic})`,
);
assert(
  typeof entry?.message === "string" && entry.message.includes("git diff"),
  "degraded message mentions git diff",
);

process.stdout.write(`\n[4] semanticSignal drops hits attributed to deleted files\n`);

const EXISTING_PATH = "alive.ts";
const DELETED_PATH = "ghost.ts";
writeFileSync(resolve(TMP_ROOT, EXISTING_PATH), `export const alive = true;\n`);
// DELETED_PATH is intentionally never written — simulates a chunk whose
// authoritative attribution points at a path the working tree no longer
// contains (the exact M14-formatter.ts shape the audit caught).

const HASH_DELETED = "h_ghost";
const HASH_EXISTING = "h_alive";

const stubProvider = {
  modelId: () => "voyage-code-3",
  modelVersion: (_inputType: "document" | "query") => "dim=4;type=query",
  maxBatchSize: () => 16,
  maxInputTokens: () => 1024,
  async embed(req: { inputs: string[]; inputType: "document" | "query" }) {
    return {
      vectors: req.inputs.map(() => new Float32Array([1, 0, 0, 0])),
      modelId: "voyage-code-3",
      modelVersion: `dim=4;type=${req.inputType}`,
      promptTokens: 0,
    };
  },
};

const stubEmbeddingStore = {
  upsert: async () => undefined,
  upsertMany: async () => undefined,
  getByHash: async () => null,
  search: async () => [
    { chunkHash: HASH_DELETED, similarity: 0.95 },
    { chunkHash: HASH_EXISTING, similarity: 0.9 },
  ],
  whichExist: async () => new Set<string>(),
  count: async () => 2,
  deleteByModel: async () => 0,
};

const stubChunkStore = {
  upsert: async () => undefined,
  upsertMany: async () => undefined,
  getByHash: async () => null,
  getManyByHash: async (hashes: string[]) => {
    const out = new Map<
      string,
      {
        chunkHash: string;
        filePath: string;
        fileSha: string;
        language: "typescript";
        symbolPath: string[];
        startLine: number;
        endLine: number;
        content: string;
      }
    >();
    for (const h of hashes) {
      out.set(h, {
        chunkHash: h,
        filePath: h === HASH_DELETED ? DELETED_PATH : EXISTING_PATH,
        fileSha: "0".repeat(64),
        language: "typescript" as const,
        symbolPath: [],
        startLine: 1,
        endLine: 1,
        content: "stub",
      });
    }
    return out;
  },
  getByFile: async () => [],
  count: async () => 2,
};

const stubFileChunksStore = {
  replaceForFile: async () => undefined,
  deleteForFile: async () => undefined,
  getFilesForHashes: async (hashes: string[]) => {
    const out = new Map<string, string[]>();
    for (const h of hashes) {
      out.set(h, [h === HASH_DELETED ? DELETED_PATH : EXISTING_PATH]);
    }
    return out;
  },
  getHashesForFile: async () => [],
  count: async () => 2,
  pruneOrphans: async () => ({ chunksPruned: 0, embeddingsPruned: 0 }),
  backfillFromChunksIfNeeded: async () => 0,
};

const filteredOut = await semanticSignal({
  diff: "diff --git a/x b/x\n+++ b/x\n@@\n+a\n",
  embeddingProvider: stubProvider,
  embeddingStore: stubEmbeddingStore,
  chunkStore: stubChunkStore,
  fileChunksStore: stubFileChunksStore,
  repoRoot: TMP_ROOT,
  lockedModelId: "voyage-code-3",
  lockedModelVersionForDocument: "dim=4;type=document",
});
assert(filteredOut.hitsByFile.has(EXISTING_PATH), `existing file '${EXISTING_PATH}' is retained`);
assert(
  !filteredOut.hitsByFile.has(DELETED_PATH),
  `deleted file '${DELETED_PATH}' is filtered out (no ENOENT path to jscpd)`,
);

process.stdout.write(`\n[4b] omitting repoRoot leaves both hits in place (backward compat)\n`);

const backcompatOut = await semanticSignal({
  diff: "diff --git a/x b/x\n+++ b/x\n@@\n+a\n",
  embeddingProvider: stubProvider,
  embeddingStore: stubEmbeddingStore,
  chunkStore: stubChunkStore,
  fileChunksStore: stubFileChunksStore,
  lockedModelId: "voyage-code-3",
  lockedModelVersionForDocument: "dim=4;type=document",
});
assert(
  backcompatOut.hitsByFile.has(EXISTING_PATH) && backcompatOut.hitsByFile.has(DELETED_PATH),
  "without repoRoot, both hits pass through (filter is opt-in)",
);

if (existsSync(TMP_ROOT)) rmSync(TMP_ROOT, { recursive: true, force: true });

if (failed > 0) {
  process.stdout.write(`\n${failed} assertion(s) failed\n`);
  process.exit(1);
}
process.stdout.write(`\nall assertions passed\n`);

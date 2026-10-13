/**
 * Issue #62: the import graph used by review must match the working tree being
 * reviewed — including after commits, checkouts, and resets on a clean tree.
 *
 * Before the fix, `CheapSignalsSelector` re-hashed only git-modified and
 * untracked files and reused the stored `file_state` hash for every other
 * tracked file. A clean file whose content changed through a commit or
 * checkout kept pointing at its old `import_graph` row, so reverse links
 * described the previous snapshot.
 *
 * Every scenario here runs the normal `runDetPriors` review path with one
 * shared cache and no `warden init`, against a fixture repo with no embedding
 * index and semantic refresh disabled:
 *
 *  [1] warm the cache, commit an import swap, review the clean tree
 *  [2] checkout / reset between the two clean commits, both directions
 *  [3] add, delete, and rename files
 *  [4] repeated review of unchanged source reuses parsed records
 *  [5] an unreadable file is reported by path and never served from cache
 *  [6] a deletion in the working tree leaves the snapshot without an error
 *  [7] an unchanged importer's edge follows its target when another file
 *      shadows or renames it (resolution is not cached with the row)
 *  [8] graph key order follows tracked order, so the deadcode finding
 *      message (and its comment id) is the same on every run
 *
 * Usage: pnpm --filter @warden/cli smoke:import-graph-freshness
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { relative, resolve } from "node:path";

const TMP_ROOT = mkdtempSync(resolve(tmpdir(), "warden-import-graph-"));
const REPO = resolve(TMP_ROOT, "repo");
process.env["WARDEN_CACHE_PATH"] = resolve(TMP_ROOT, "cache.sqlite");
process.env["WARDEN_REVIEW_REFRESH_MAX_USD"] = "0";

const { CheapSignalsSelector, TsCompilerParser, runDetPriors } = await import("@warden/core");
const { loadImportGraph } = await import("@warden/core/context/import-graph");
const { runDeadcode } = await import("@warden/core/runners/deadcode");
type SourceParser = import("@warden/core/context/parser").SourceParser;

let failed = 0;
function assert(cond: unknown, msg: string): void {
  if (cond) {
    process.stdout.write(`  ✓ ${msg}\n`);
  } else {
    process.stdout.write(`  ✗ ${msg}\n`);
    failed++;
  }
}

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: REPO, encoding: "utf8" }).trim();
}

function write(rel: string, content: string): void {
  writeFileSync(resolve(REPO, rel), content);
}

function commit(message: string): string {
  git("add", "-A");
  git("commit", "-q", "-m", message);
  return git("rev-parse", "HEAD");
}

function assertClean(label: string): void {
  assert(git("status", "--porcelain") === "", `${label}: working tree is clean`);
}

/** The review target: a one-line change to `src/lib.ts`. */
const DIFF = `diff --git a/src/lib.ts b/src/lib.ts
--- a/src/lib.ts
+++ b/src/lib.ts
@@ -1,1 +1,1 @@
+export function add(a: number, b: number): number {
`;

interface ReviewView {
  /** Files with an `imports` reason targeting `src/lib.ts` — the reverse links. */
  importersOfLib: string[];
  candidatePaths: string[];
  degradedMessages: string[];
  bannerKind: string;
  semanticReasons: number;
}

async function review(selectorParser?: SourceParser): Promise<ReviewView> {
  const out = await runDetPriors({
    diff: DIFF,
    repoRoot: REPO,
    mode: "review",
    ...(selectorParser ? { selector: new CheapSignalsSelector({ parser: selectorParser }) } : {}),
  });
  const candidates = out.selectorOutput.candidates;
  return {
    importersOfLib: candidates
      .filter((c) => c.reasons.some((r) => r.kind === "imports" && r.target === "src/lib.ts"))
      .map((c) => c.path)
      .sort(),
    candidatePaths: candidates.map((c) => c.path).sort(),
    degradedMessages: out.degraded.map((d) => d.message),
    bannerKind: out.bannerState.kind,
    semanticReasons: candidates.flatMap((c) => c.reasons).filter((r) => r.kind === "semantic")
      .length,
  };
}

/** Wraps the default parser and counts parse calls. */
function countingParser(): SourceParser & { calls: number } {
  const inner = new TsCompilerParser({ repoRoot: REPO });
  const counter = {
    calls: 0,
    async imports(abs: string, content: string) {
      counter.calls++;
      return inner.imports(abs, content);
    },
    async exports(abs: string, content: string) {
      return inner.exports(abs, content);
    },
    resolve(moduleName: string, containingFile: string) {
      return inner.resolve(moduleName, containingFile);
    },
  };
  return counter;
}

async function activeFiles(): Promise<string[]> {
  const snapshot = await loadImportGraph({
    repoRoot: REPO,
    parser: new TsCompilerParser({ repoRoot: REPO }),
    topic: "context",
  });
  return snapshot.files;
}

/** Loads the graph and returns the resolved target of `from`'s import of `module`, repo-relative. */
async function resolvedImport(
  parser: SourceParser,
  from: string,
  module: string,
): Promise<string | undefined> {
  const snapshot = await loadImportGraph({ repoRoot: REPO, parser, topic: "context" });
  const entry = snapshot.graph.get(resolve(REPO, from));
  const target = entry?.imports.find((i) => i.module === module)?.resolved;
  return target ? relative(REPO, target) : undefined;
}

const same = (a: string[], b: string[]) => JSON.stringify(a) === JSON.stringify(b);

try {
  mkdirSync(resolve(REPO, "src"), { recursive: true });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "smoke@warden.local");
  git("config", "user.name", "warden smoke");
  git("config", "commit.gpgsign", "false");

  write("package.json", `{ "name": "fixture", "private": true }\n`);
  write(".gitignore", ".warden/\n");
  write("src/lib.ts", "export function add(a: number, b: number): number {\n  return a + b;\n}\n");
  write(
    "src/other.ts",
    "export function mul(a: number, b: number): number {\n  return a * b;\n}\n",
  );
  // Commit A: a.ts → lib, b.ts → other.
  write("src/a.ts", 'import { add } from "./lib";\nexport const one = add(1, 0);\n');
  write("src/b.ts", 'import { mul } from "./other";\nexport const two = mul(2, 1);\n');
  const shaA = commit("A: a imports lib");

  // ── [1] commit an import swap, review the clean tree ──────────────────
  process.stdout.write(`\n[1] warm on A, commit B (import swap), review clean B\n`);
  const warm = await review();
  assert(warm.bannerKind === "no-index", `no embedding index (banner=${warm.bannerKind})`);
  assert(
    same(warm.importersOfLib, ["src/a.ts"]),
    `A: lib importers = [a] (got ${warm.importersOfLib})`,
  );

  // Commit B: a.ts → other, b.ts → lib.
  write("src/a.ts", 'import { mul } from "./other";\nexport const one = mul(1, 1);\n');
  write("src/b.ts", 'import { add } from "./lib";\nexport const two = add(1, 1);\n');
  const shaB = commit("B: b imports lib");
  assertClean("B");
  const afterCommit = await review();
  assert(
    same(afterCommit.importersOfLib, ["src/b.ts"]),
    `B: lib importers = [b], old a→lib link gone (got ${afterCommit.importersOfLib})`,
  );
  assert(afterCommit.semanticReasons === 0, "B: no semantic reasons (graph needs no embeddings)");

  // ── [2] checkout / reset between the two clean commits ────────────────
  process.stdout.write(`\n[2] checkout A, then reset back to B\n`);
  git("checkout", "-q", shaA);
  assertClean("checkout A");
  const backToA = await review();
  assert(
    same(backToA.importersOfLib, ["src/a.ts"]),
    `checkout A: lib importers = [a] (got ${backToA.importersOfLib})`,
  );
  git("checkout", "-q", "main");
  git("reset", "-q", "--hard", shaA);
  git("reset", "-q", "--hard", shaB);
  assertClean("reset B");
  const forwardToB = await review();
  assert(
    same(forwardToB.importersOfLib, ["src/b.ts"]),
    `reset B: lib importers = [b] (got ${forwardToB.importersOfLib})`,
  );

  // ── [3] add, delete, rename ──────────────────────────────────────────
  process.stdout.write(`\n[3] commit C: add c.ts, delete b.ts, rename a.ts → renamed.ts\n`);
  write("src/c.ts", 'import { add } from "./lib";\nexport const three = add(1, 2);\n');
  git("rm", "-q", "src/b.ts");
  git("mv", "src/a.ts", "src/renamed.ts");
  write("src/renamed.ts", 'import { add } from "./lib";\nexport const one = add(1, 0);\n');
  commit("C: add, delete, rename");
  assertClean("C");
  const files = await activeFiles();
  const expected = ["src/c.ts", "src/lib.ts", "src/other.ts", "src/renamed.ts"];
  assert(same(files, expected), `C: active file set = ${expected} (got ${files})`);
  const afterC = await review();
  assert(
    same(afterC.importersOfLib, ["src/c.ts", "src/renamed.ts"]),
    `C: lib importers = [c, renamed] (got ${afterC.importersOfLib})`,
  );
  assert(
    !afterC.candidatePaths.includes("src/a.ts") && !afterC.candidatePaths.includes("src/b.ts"),
    `C: deleted/renamed-away paths are not candidates (got ${afterC.candidatePaths})`,
  );

  // ── [4] reuse on repeated review of unchanged source ──────────────────
  process.stdout.write(`\n[4] repeated review of unchanged source\n`);
  const first = countingParser();
  await review(first);
  const second = countingParser();
  const repeat = await review(second);
  assert(second.calls === 0, `second review parsed 0 files (got ${second.calls})`);
  assert(
    !repeat.degradedMessages.some((m) => m.includes("cold import-graph build")),
    "second review reports no cold build",
  );
  write("src/c.ts", 'import { mul } from "./other";\nexport const three = mul(1, 3);\n');
  commit("D: c imports other");
  const third = countingParser();
  const afterD = await review(third);
  assert(third.calls === 1, `one changed file → one parse (got ${third.calls})`);
  assert(
    same(afterD.importersOfLib, ["src/renamed.ts"]),
    `D: lib importers = [renamed] (got ${afterD.importersOfLib})`,
  );

  // ── [5] unreadable file ──────────────────────────────────────────────
  process.stdout.write(`\n[5] unreadable tracked file\n`);
  if (process.getuid?.() === 0) {
    process.stdout.write(`  - skipped: running as root, chmod 000 does not block reads\n`);
  } else {
    chmodSync(resolve(REPO, "src/renamed.ts"), 0o000);
    try {
      const unreadable = await review();
      const warning = unreadable.degradedMessages.find((m) => m.includes("could not read"));
      assert(
        warning?.includes("src/renamed.ts"),
        `degraded entry names the path (got ${warning ?? "none"})`,
      );
      assert(
        !unreadable.importersOfLib.includes("src/renamed.ts"),
        `cached row for the unreadable file is not used (got ${unreadable.importersOfLib})`,
      );
    } finally {
      chmodSync(resolve(REPO, "src/renamed.ts"), 0o644);
    }
  }

  // ── [6] deletion in the working tree ─────────────────────────────────
  process.stdout.write(`\n[6] tracked file deleted in the working tree (not staged)\n`);
  unlinkSync(resolve(REPO, "src/renamed.ts"));
  const deleted = await review();
  assert(
    !deleted.candidatePaths.includes("src/renamed.ts"),
    `deleted file is not a candidate (got ${deleted.candidatePaths})`,
  );
  assert(
    !deleted.degradedMessages.some((m) => m.includes("could not read")),
    "a deletion is not reported as a read failure",
  );
  assert(
    same(await activeFiles(), ["src/c.ts", "src/lib.ts", "src/other.ts"]),
    "deleted file is not in the active file set",
  );

  // ── [7] resolution changes while the importer's bytes do not ─────────
  process.stdout.write(`\n[7] shadow and rename an import target, importer unchanged\n`);
  git("checkout", "--", "src/renamed.ts");
  mkdirSync(resolve(REPO, "src/util"), { recursive: true });
  write("src/util/index.ts", "export const u = 1;\n");
  write("src/d.ts", 'import { u } from "./util";\nexport const dd = u;\n');
  commit("E: d imports util/index");
  assert(
    (await resolvedImport(countingParser(), "src/d.ts", "./util")) === "src/util/index.ts",
    "E: d → src/util/index.ts",
  );
  write("src/util.ts", "export const u = 2;\n");
  commit("F: util.ts shadows util/index.ts");
  const shadowParser = countingParser();
  const shadowed = await resolvedImport(shadowParser, "src/d.ts", "./util");
  assert(shadowParser.calls === 1, `F: only util.ts is parsed (got ${shadowParser.calls})`);
  assert(shadowed === "src/util.ts", `F: cached d row → src/util.ts (got ${shadowed})`);
  git("mv", "src/util.ts", "src/util.tsx");
  commit("G: util.ts renamed to util.tsx");
  const renamed = await resolvedImport(countingParser(), "src/d.ts", "./util");
  assert(renamed === "src/util.tsx", `G: cached d row → src/util.tsx (got ${renamed})`);

  // ── [8] deterministic order on identical input ───────────────────────
  // Reads run in parallel batches; if the graph took readFile completion
  // order, the deadcode example callsite (hashed into the comment id) would
  // change between runs of the same tree.
  process.stdout.write(`\n[8] many callers: graph order and deadcode message are stable\n`);
  const CALLERS = 25;
  mkdirSync(resolve(REPO, "src/fan"), { recursive: true });
  const target = [
    "export function pick(a: number, opt?: string): string {",
    "  if (opt) {",
    "    return opt;",
    "  }",
    "  return String(a);",
    "}",
    "",
  ].join("\n");
  write("src/fan/target.ts", target);
  for (let i = 0; i < CALLERS; i++) {
    const n = String(i).padStart(2, "0");
    // Vary the size so reads do not all finish in submission order.
    const pad = "// pad\n".repeat((i * 7919) % 400);
    write(
      `src/fan/caller-${n}.ts`,
      `import { pick } from "./target";\n${pad}export const v${n} = pick(${i});\n`,
    );
  }
  commit("H: 25 callers of pick, none pass opt");
  const graphOrders = new Set<string>();
  for (let i = 0; i < 5; i++) {
    const snapshot = await loadImportGraph({
      repoRoot: REPO,
      parser: new TsCompilerParser({ repoRoot: REPO }),
      topic: "context",
    });
    const keys = [...snapshot.graph.keys()].map((k) => relative(REPO, k));
    graphOrders.add(JSON.stringify(keys));
    if (i === 0) {
      assert(
        same(keys, [...snapshot.files].sort()),
        `graph keys follow sorted tracked order (got ${keys.slice(0, 4)}…)`,
      );
    }
  }
  assert(graphOrders.size === 1, `5 loads → 1 graph key order (got ${graphOrders.size})`);
  const messages = new Set<string>();
  for (let i = 0; i < 30; i++) {
    const out = await runDeadcode({
      repoRoot: REPO,
      changed: [{ path: "src/fan/target.ts", addedLines: [1, 2, 3, 4, 5, 6] }],
    });
    for (const f of out.findings) messages.add(f.message);
  }
  const [message] = messages;
  assert(
    messages.size === 1,
    `30 deadcode runs → 1 distinct message (got ${messages.size}: ${[...messages].join(" | ")})`,
  );
  assert(
    message?.includes(`any of ${CALLERS} callsite(s)`) &&
      message.endsWith("Example callsite: src/fan/caller-00.ts:2"),
    `example callsite is the first caller in path order (got ${message ?? "none"})`,
  );
} finally {
  rmSync(TMP_ROOT, { recursive: true, force: true });
}

if (failed > 0) {
  process.stdout.write(`\n${failed} assertion(s) failed\n`);
  process.exit(1);
}
process.stdout.write(`\nall assertions passed\n`);

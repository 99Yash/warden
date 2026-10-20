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
 *  [9] deadcode fails closed on an incomplete graph: when the only caller
 *      that passes the optional param is unreadable (left out of the graph,
 *      or unreadable when callsites are collected), no "never passed"
 *      finding is emitted and an info entry names the skip
 * [10] non-ASCII paths: `git ls-files -z` output spans many pipe chunks of
 *      multi-byte characters, and no path is corrupted at a chunk boundary
 * [11] a dangling tracked symlink is reported by path as unreadable, not
 *      dropped as a deletion
 * [12] a sparse checkout: files outside it are counted in one info entry,
 *      deadcode holds back a finding whose only passing caller is outside
 *      it, and a working-tree deletion in the same tree stays silent
 * [13] degraded messages say "1 file" and "2 files"
 * [14] check mode, cold cache: the cold-build note reaches the output
 * [15] deadcode follows the reviewed commit in review and check mode: commit
 *      B adds the caller that passes the optional param
 * [16] one review loads the graph once, parses each changed file once with
 *      the shared parser, and reports each snapshot warning once
 *
 * Usage: pnpm --filter @warden/cli smoke:import-graph-freshness
 */
import childProcess, { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { mock } from "node:test";
import { tmpdir } from "node:os";
import { relative, resolve } from "node:path";

const TMP_ROOT = mkdtempSync(resolve(tmpdir(), "warden-import-graph-"));
const REPO = resolve(TMP_ROOT, "repo");
process.env["WARDEN_CACHE_PATH"] = resolve(TMP_ROOT, "cache.sqlite");
process.env["WARDEN_REVIEW_REFRESH_MAX_USD"] = "0";

const { TsCompilerParser, runDetPriors } = await import("@warden/core");
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

async function review(parser?: SourceParser): Promise<ReviewView> {
  const out = await runDetPriors({
    diff: DIFF,
    repoRoot: REPO,
    mode: "review",
    ...(parser ? { parser } : {}),
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

/**
 * Wraps the default parser and counts parse calls: `calls` counts `imports`,
 * `perFile` counts `imports` + `exports` by absolute path.
 */
function countingParser(
  repoRoot = REPO,
): SourceParser & { calls: number; perFile: Map<string, number> } {
  const inner = new TsCompilerParser({ repoRoot });
  const bump = (abs: string) => counter.perFile.set(abs, (counter.perFile.get(abs) ?? 0) + 1);
  const counter = {
    calls: 0,
    perFile: new Map<string, number>(),
    async imports(abs: string, content: string) {
      counter.calls++;
      bump(abs);
      return inner.imports(abs, content);
    },
    async exports(abs: string, content: string) {
      bump(abs);
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

/**
 * Counts `git ls-files -z` spawns with no other argument: one per graph load.
 * Builtin ESM exports follow the CommonJS object after a sync.
 */
async function countGraphLoads<T>(fn: () => Promise<T>): Promise<{ result: T; loads: number }> {
  // The spy calls the real `spawn` and records each call's arguments.
  const spawnSpy = mock.method(childProcess, "spawn");
  syncBuiltinESMExports();
  try {
    const result = await fn();
    const loads = spawnSpy.mock.calls.filter(({ arguments: [cmd, args] }) => {
      if (cmd !== "git" || !Array.isArray(args)) return false;
      return args.length === 2 && args[0] === "ls-files" && args[1] === "-z";
    }).length;
    return { result, loads };
  } finally {
    spawnSpy.mock.restore();
    syncBuiltinESMExports();
  }
}

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
    `A: lib importers = [a] (got ${warm.importersOfLib.join(",")})`,
  );

  // Commit B: a.ts → other, b.ts → lib.
  write("src/a.ts", 'import { mul } from "./other";\nexport const one = mul(1, 1);\n');
  write("src/b.ts", 'import { add } from "./lib";\nexport const two = add(1, 1);\n');
  const shaB = commit("B: b imports lib");
  assertClean("B");
  const afterCommit = await review();
  assert(
    same(afterCommit.importersOfLib, ["src/b.ts"]),
    `B: lib importers = [b], old a→lib link gone (got ${afterCommit.importersOfLib.join(",")})`,
  );
  assert(afterCommit.semanticReasons === 0, "B: no semantic reasons (graph needs no embeddings)");

  // ── [2] checkout / reset between the two clean commits ────────────────
  process.stdout.write(`\n[2] checkout A, then reset back to B\n`);
  git("checkout", "-q", shaA);
  assertClean("checkout A");
  const backToA = await review();
  assert(
    same(backToA.importersOfLib, ["src/a.ts"]),
    `checkout A: lib importers = [a] (got ${backToA.importersOfLib.join(",")})`,
  );
  git("checkout", "-q", "main");
  git("reset", "-q", "--hard", shaA);
  git("reset", "-q", "--hard", shaB);
  assertClean("reset B");
  const forwardToB = await review();
  assert(
    same(forwardToB.importersOfLib, ["src/b.ts"]),
    `reset B: lib importers = [b] (got ${forwardToB.importersOfLib.join(",")})`,
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
  assert(
    same(files, expected),
    `C: active file set = ${expected.join(",")} (got ${files.join(",")})`,
  );
  const afterC = await review();
  assert(
    same(afterC.importersOfLib, ["src/c.ts", "src/renamed.ts"]),
    `C: lib importers = [c, renamed] (got ${afterC.importersOfLib.join(",")})`,
  );
  assert(
    !afterC.candidatePaths.includes("src/a.ts") && !afterC.candidatePaths.includes("src/b.ts"),
    `C: deleted/renamed-away paths are not candidates (got ${afterC.candidatePaths.join(",")})`,
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
    `D: lib importers = [renamed] (got ${afterD.importersOfLib.join(",")})`,
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
        `cached row for the unreadable file is not used (got ${unreadable.importersOfLib.join(",")})`,
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
    `deleted file is not a candidate (got ${deleted.candidatePaths.join(",")})`,
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
        same(keys, snapshot.files),
        `graph keys follow snapshot.files order (got ${keys.slice(0, 4).join(",")}…)`,
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
  const complete = await runDeadcode({
    repoRoot: REPO,
    changed: [{ path: "src/fan/target.ts", addedLines: [1, 2, 3, 4, 5, 6] }],
  });
  assert(
    !complete.degraded.some((d) => d.message.includes("skipped")),
    `complete graph: no deadcode skip entry (got ${complete.degraded.map((d) => d.message).join(",")})`,
  );

  // ── [9] unknown reach is not reported as zero reach ──────────────────
  // One more caller passes `opt`. If deadcode cannot see it, it must not
  // claim `opt` is never passed.
  process.stdout.write(`\n[9] the only caller that passes opt is unreadable\n`);
  const PASSER = "src/fan/passer.ts";
  const passerAbs = resolve(REPO, PASSER);
  write(PASSER, 'import { pick } from "./target";\nexport const p = pick(1, "x");\n');
  commit("I: passer.ts passes opt");
  const TARGET_DIFF = `diff --git a/src/fan/target.ts b/src/fan/target.ts
--- a/src/fan/target.ts
+++ b/src/fan/target.ts
@@ -1,6 +1,6 @@
${target
  .split("\n")
  .slice(0, 6)
  .map((l) => `+${l}`)
  .join("\n")}
`;
  const unreachable = (findings: { ruleId?: string; file: string }[]) =>
    findings.filter(
      (f) => f.ruleId === "unreachable-optional-param" && f.file === "src/fan/target.ts",
    );
  const skipEntry = (degraded: { kind: string; topic: string; message: string }[]) =>
    degraded.find(
      (d) => d.kind === "info" && d.topic === "deadcode" && d.message.includes("skipped"),
    );

  const readable = await runDeadcode({
    repoRoot: REPO,
    changed: [{ path: "src/fan/target.ts", addedLines: [1, 2, 3, 4, 5, 6] }],
  });
  assert(
    unreachable(readable.findings).length === 0 && !skipEntry(readable.degraded),
    `readable passer: no finding and no skip entry (got ${readable.findings.length} findings)`,
  );

  if (process.getuid?.() === 0) {
    process.stdout.write(`  - skipped: running as root, chmod 000 does not block reads\n`);
  } else {
    chmodSync(passerAbs, 0o000);
    try {
      const check = await runDeadcode({
        repoRoot: REPO,
        changed: [{ path: "src/fan/target.ts", addedLines: [1, 2, 3, 4, 5, 6] }],
      });
      assert(
        unreachable(check.findings).length === 0,
        `check: no unreachable-optional-param finding (got ${check.findings.map((f) => f.message).join(",")})`,
      );
      const checkSkip = skipEntry(check.degraded);
      assert(
        checkSkip?.message ===
          "deadcode: 1 candidate skipped; import graph incomplete (1 unreadable file)",
        `check: info entry names the skip (got ${checkSkip?.message ?? "none"})`,
      );
      const reviewed = await runDetPriors({ diff: TARGET_DIFF, repoRoot: REPO, mode: "review" });
      assert(
        unreachable(reviewed.findings).length === 0,
        `review: no unreachable-optional-param finding (got ${reviewed.findings.map((f) => f.message).join(",")})`,
      );
      assert(
        skipEntry(reviewed.degraded) !== undefined,
        `review: deadcode skip entry reaches the output (got ${reviewed.degraded.map((d) => d.message).join(",")})`,
      );
    } finally {
      chmodSync(passerAbs, 0o644);
    }
  }

  // The graph sees the passer, but the read in `collectCallsites` fails.
  // Builtin ESM exports follow the CommonJS object after a sync, so the
  // runner's `readFile` import picks up this wrapper: the first read of the
  // passer (graph load) succeeds, and later reads fail.
  const realReadFile = fsPromises.readFile;
  let passerReads = 0;
  const readFileSpy = mock.method(
    fsPromises,
    "readFile",
    (path: Parameters<typeof realReadFile>[0], options?: Parameters<typeof realReadFile>[1]) => {
      if (typeof path === "string" && resolve(path) === passerAbs && ++passerReads > 1) {
        return Promise.reject(Object.assign(new Error("EACCES: simulated"), { code: "EACCES" }));
      }
      return realReadFile(path, options);
    },
  );
  syncBuiltinESMExports();
  try {
    const failedRead = await runDeadcode({
      repoRoot: REPO,
      changed: [{ path: "src/fan/target.ts", addedLines: [1, 2, 3, 4, 5, 6] }],
    });
    assert(passerReads >= 2, `caller read was failed after graph load (reads=${passerReads})`);
    assert(
      unreachable(failedRead.findings).length === 0,
      `caller read failure: no finding (got ${failedRead.findings.map((f) => f.message).join(",")})`,
    );
    const readSkip = skipEntry(failedRead.degraded);
    assert(
      readSkip?.message ===
        `deadcode: 1 candidate skipped; could not read 1 caller file: ${PASSER}`,
      `caller read failure: info entry names the skip (got ${readSkip?.message ?? "none"})`,
    );
  } finally {
    readFileSpy.mock.restore();
    syncBuiltinESMExports();
  }

  // ── [10] multi-byte paths across stdout chunk boundaries ──────────────
  // Long paths of 3-byte characters (CJK, no Unicode decomposition) fill
  // many 64 KiB pipe chunks with few files. A character split across two
  // chunks must not decode to U+FFFD: the corrupted path would fail to read
  // with ENOENT and leave the snapshot as a "deletion", with no report.
  process.stdout.write(`\n[10] non-ASCII tracked paths across stdout chunks\n`);
  const WIDE = 800;
  const wideDir = `src/${"日本語の道".repeat(12)}/${"漢字目録".repeat(15)}`;
  mkdirSync(resolve(REPO, wideDir), { recursive: true });
  const widePaths: string[] = [];
  for (let i = 0; i < WIDE; i++) {
    const rel = `${wideDir}/${"字".repeat(60)}-${String(i).padStart(3, "0")}.ts`;
    write(rel, `export const w${i} = ${i};\n`);
    widePaths.push(rel);
  }
  // U+FF71 sorts before U+1F600 in git's byte order but after it in UTF-16
  // code units (JS `.sort()`), so `files` and the graph must not each pick
  // their own order.
  for (const rel of ["src/order-\uFF71.ts", "src/order-\u{1F600}.ts"]) {
    write(rel, "export const o = 1;\n");
    widePaths.push(rel);
  }
  commit("J: 800 files under multi-byte paths");
  const lsBytes = execFileSync("git", ["ls-files", "-z"], { cwd: REPO }).length;
  assert(lsBytes > 4 * 65536, `ls-files output spans more than 4 chunks (${lsBytes} bytes)`);
  const wideSnapshot = await loadImportGraph({
    repoRoot: REPO,
    parser: new TsCompilerParser({ repoRoot: REPO }),
    topic: "context",
  });
  const corrupted = wideSnapshot.files.filter((f) => f.includes("\uFFFD"));
  assert(corrupted.length === 0, `no path holds U+FFFD (got ${corrupted.slice(0, 2).join(",")})`);
  const fileSet = new Set(wideSnapshot.files);
  const missingFiles = widePaths.filter((p) => !fileSet.has(p));
  assert(
    missingFiles.length === 0,
    `all ${widePaths.length} paths are in snapshot.files (missing ${missingFiles.length})`,
  );
  const missingGraph = widePaths.filter((p) => !wideSnapshot.graph.has(resolve(REPO, p)));
  assert(
    missingGraph.length === 0,
    `all ${widePaths.length} paths are in the graph (missing ${missingGraph.length})`,
  );
  const wideKeys = [...wideSnapshot.graph.keys()].map((k) => relative(REPO, k));
  assert(same(wideKeys, wideSnapshot.files), "graph keys and snapshot.files share one order");

  // ── [11] dangling tracked symlink ────────────────────────────────────
  // readFile follows the link and fails with ENOENT, but git lists the link
  // as present, not deleted. It must not pass as a deletion.
  process.stdout.write(`\n[11] tracked symlink whose target is missing\n`);
  symlinkSync("missing-target.ts", resolve(REPO, "src/dangling.ts"));
  commit("K: dangling symlink");
  const dangling = await loadImportGraph({
    repoRoot: REPO,
    parser: new TsCompilerParser({ repoRoot: REPO }),
    topic: "context",
  });
  assert(
    same(dangling.unreadable, ["src/dangling.ts"]),
    `dangling link is unreadable (got ${dangling.unreadable.join(",")})`,
  );
  const danglingWarning = dangling.degraded.find(
    (d) => d.kind === "warning" && d.message.includes("could not read"),
  );
  assert(
    danglingWarning?.message ===
      "context: could not read 1 source file; left out of the import graph: src/dangling.ts",
    `warning names the link (got ${danglingWarning?.message ?? "none"})`,
  );
  git("rm", "-q", "src/dangling.ts");
  commit("L: drop dangling symlink");

  // ── [12] sparse checkout ─────────────────────────────────────────────
  // A skip-worktree entry is tracked but absent on disk. It is not a
  // deletion: the graph is incomplete, and the absent file may be the one
  // caller that passes the param.
  process.stdout.write(`\n[12] sparse checkout leaves the passer out of the working tree\n`);
  git("sparse-checkout", "set", "--no-cone", "/*", `!/${PASSER}`);
  unlinkSync(resolve(REPO, "src/c.ts"));
  try {
    assert(!existsSync(passerAbs), "passer is absent from the working tree");
    assert(
      git("ls-files", "-t", "--", PASSER) === `S ${PASSER}`,
      "passer is a skip-worktree entry",
    );
    const sparse = await loadImportGraph({
      repoRoot: REPO,
      parser: new TsCompilerParser({ repoRoot: REPO }),
      topic: "context",
    });
    assert(
      same(sparse.outsideSparse, [PASSER]),
      `snapshot lists the passer outside the sparse checkout (got ${sparse.outsideSparse.join(",")})`,
    );
    assert(
      sparse.unreadable.length === 0,
      `no unreadable files (got ${sparse.unreadable.join(",")})`,
    );
    assert(
      !sparse.files.includes("src/c.ts") && !sparse.files.includes(PASSER),
      "absent files are not in the active file set",
    );
    const sparseInfo = sparse.degraded.find((d) => d.message.includes("sparse checkout"));
    assert(
      sparseInfo?.kind === "info" &&
        sparseInfo.message ===
          "context: 1 tracked source file outside the sparse checkout; left out of the import graph",
      `info entry counts the sparse file (got ${sparseInfo?.message ?? "none"})`,
    );
    assert(
      !sparse.degraded.some((d) => d.message.includes("could not read")),
      "the working-tree deletion stays silent",
    );
    const sparseCheck = await runDeadcode({
      repoRoot: REPO,
      changed: [{ path: "src/fan/target.ts", addedLines: [1, 2, 3, 4, 5, 6] }],
    });
    assert(
      unreachable(sparseCheck.findings).length === 0,
      `check: no unreachable-optional-param finding (got ${sparseCheck.findings.map((f) => f.message).join(",")})`,
    );
    const sparseSkip = skipEntry(sparseCheck.degraded);
    assert(
      sparseSkip?.message ===
        "deadcode: 1 candidate skipped; import graph incomplete (1 file outside the sparse checkout)",
      `check: info entry names the skip (got ${sparseSkip?.message ?? "none"})`,
    );
    const sparseReview = await runDetPriors({ diff: TARGET_DIFF, repoRoot: REPO, mode: "review" });
    assert(
      unreachable(sparseReview.findings).length === 0,
      `review: no unreachable-optional-param finding (got ${sparseReview.findings.map((f) => f.message).join(",")})`,
    );
    assert(
      skipEntry(sparseReview.degraded) !== undefined,
      `review: deadcode skip entry reaches the output (got ${sparseReview.degraded.map((d) => d.message).join(",")})`,
    );
  } finally {
    git("sparse-checkout", "disable");
    git("checkout", "--", "src/c.ts");
  }

  // ── [13] message plurals for counts of 1 and 2 ───────────────────────
  // Each case gets its own repo with fresh content, so no row is reused and
  // the cold-build note is emitted.
  process.stdout.write(`\n[13] degraded messages use singular and plural\n`);
  let fresh = 0;
  const nonce = `${process.pid}-${Date.now()}`;
  async function freshMessages(input: {
    files: string[];
    broken?: string[];
    links?: string[];
    sparseOut?: string[];
  }): Promise<string[]> {
    const dir = resolve(TMP_ROOT, `plural-${++fresh}`);
    const run = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
    const all = [...input.files, ...(input.broken ?? []), ...(input.sparseOut ?? [])];
    for (const rel of all) {
      mkdirSync(resolve(dir, rel, ".."), { recursive: true });
      writeFileSync(resolve(dir, rel), `// ${nonce} ${dir} ${rel}\nexport const x = 1;\n`);
    }
    for (const rel of input.links ?? []) symlinkSync("missing-target.ts", resolve(dir, rel));
    run("init", "-q", "-b", "main");
    run("add", "-A");
    run(
      "-c",
      "user.email=s@w",
      "-c",
      "user.name=s",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "x",
    );
    if (input.sparseOut) {
      run("sparse-checkout", "set", "--no-cone", "/*", ...input.sparseOut.map((p) => `!/${p}`));
    }
    const inner = new TsCompilerParser({ repoRoot: dir });
    const broken = new Set((input.broken ?? []).map((p) => resolve(dir, p)));
    const parser: SourceParser = {
      async imports(abs, content) {
        if (broken.has(abs)) throw new Error("simulated parse failure");
        return inner.imports(abs, content);
      },
      exports: (abs, content) => inner.exports(abs, content),
      resolve: (moduleName, containingFile) => inner.resolve(moduleName, containingFile),
    };
    const snapshot = await loadImportGraph({ repoRoot: dir, parser, topic: "context" });
    return snapshot.degraded.map((d) => d.message);
  }
  const expectMessage = (messages: string[], expected: string) =>
    assert(messages.includes(expected), `"${expected}" (got ${JSON.stringify(messages)})`);
  expectMessage(
    await freshMessages({ files: ["a.ts"] }),
    "context: cold import-graph build (parsed 1 file)",
  );
  expectMessage(
    await freshMessages({ files: ["a.ts", "b.ts"] }),
    "context: cold import-graph build (parsed 2 files)",
  );
  expectMessage(
    await freshMessages({ files: ["a.ts"], broken: ["x.ts"] }),
    "context: 1 file failed to parse",
  );
  expectMessage(
    await freshMessages({ files: ["a.ts"], broken: ["x.ts", "y.ts"] }),
    "context: 2 files failed to parse",
  );
  expectMessage(
    await freshMessages({ files: ["a.ts"], links: ["l1.ts"] }),
    "context: could not read 1 source file; left out of the import graph: l1.ts",
  );
  expectMessage(
    await freshMessages({ files: ["a.ts"], links: ["l1.ts", "l2.ts"] }),
    "context: could not read 2 source files; left out of the import graph: l1.ts, l2.ts",
  );
  expectMessage(
    await freshMessages({ files: ["a.ts"], sparseOut: ["out/x.ts"] }),
    "context: 1 tracked source file outside the sparse checkout; left out of the import graph",
  );
  expectMessage(
    await freshMessages({ files: ["a.ts"], sparseOut: ["out/x.ts", "out/y.ts"] }),
    "context: 2 tracked source files outside the sparse checkout; left out of the import graph",
  );

  // A second repo with fresh content, so the first load is cold. `target.ts`
  // has an optional param that is checked in the body; the diff touches it,
  // so deadcode loads the graph in both modes.
  const SHARED = resolve(TMP_ROOT, "shared");
  const sgit = (...args: string[]) =>
    execFileSync("git", args, { cwd: SHARED, encoding: "utf8" }).trim();
  const swrite = (rel: string, content: string) => writeFileSync(resolve(SHARED, rel), content);
  const scommit = (message: string) => {
    sgit("add", "-A");
    sgit("commit", "-q", "-m", message);
  };
  mkdirSync(resolve(SHARED, "src"), { recursive: true });
  sgit("init", "-q", "-b", "main");
  sgit("config", "user.email", "smoke@warden.local");
  sgit("config", "user.name", "warden smoke");
  sgit("config", "commit.gpgsign", "false");
  swrite("package.json", `{ "name": "shared-fixture", "private": true }\n`);
  swrite(".gitignore", ".warden/\n");
  swrite("src/target.ts", `${target}// ${nonce}\n`);
  swrite("src/x.ts", `import { pick } from "./target";\nexport const x = pick(1);\n// ${nonce}\n`);
  swrite("src/y.ts", `export const y = 1;\n// ${nonce}\n`);
  scommit("A: x calls pick without opt");
  const PICK_DIFF = TARGET_DIFF.replaceAll("src/fan/target.ts", "src/target.ts");
  const pickFindings = (out: { findings: { ruleId?: string; file: string }[] }) =>
    out.findings.filter(
      (f) => f.ruleId === "unreachable-optional-param" && f.file === "src/target.ts",
    ).length;
  const detPriors = (mode: "check" | "review", parser?: SourceParser) =>
    runDetPriors({ diff: PICK_DIFF, repoRoot: SHARED, mode, ...(parser ? { parser } : {}) });

  // ── [14] check mode reports the cold build ───────────────────────────
  // Check mode runs no selector; deadcode's load is the only one.
  process.stdout.write(`\n[14] check mode on a cold cache reports the cold build\n`);
  const coldCheck = await detPriors("check");
  const coldNotes = coldCheck.degraded.filter((d) => d.message.includes("cold import-graph build"));
  assert(
    coldNotes.length === 1 &&
      coldNotes[0]?.kind === "info" &&
      coldNotes[0].message === "context: cold import-graph build (parsed 3 files)",
    `one cold-build info entry (got ${JSON.stringify(coldNotes.map((d) => d.message))})`,
  );
  assert(
    pickFindings(coldCheck) === 1,
    `A, check: opt is never passed (got ${pickFindings(coldCheck)})`,
  );

  // ── [15] deadcode follows the reviewed commit ────────────────────────
  // Commit B adds an import of `target.ts` to y.ts, and y passes opt. A
  // graph from commit A has no y → target edge and would keep the finding.
  process.stdout.write(`\n[15] warm on A, commit B (new caller passes opt), review and check B\n`);
  const warmA = await detPriors("review");
  assert(pickFindings(warmA) === 1, `A, review: opt is never passed (got ${pickFindings(warmA)})`);
  swrite(
    "src/y.ts",
    `import { pick } from "./target";\nexport const y = pick(2, "y");\n// ${nonce}\n`,
  );
  scommit("B: y passes opt");
  assert(sgit("status", "--porcelain") === "", "B: working tree is clean");
  const reviewB = await detPriors("review");
  assert(pickFindings(reviewB) === 0, `B, review: no finding (got ${pickFindings(reviewB)})`);
  const checkB = await detPriors("check");
  assert(pickFindings(checkB) === 0, `B, check: no finding (got ${pickFindings(checkB)})`);

  // ── [16] one load, one parse per changed file, one warning ───────────
  process.stdout.write(`\n[16] one review: one graph load, one parse per changed file\n`);
  swrite("src/x.ts", `import { pick } from "./target";\nexport const x = pick(3);\n// ${nonce}\n`);
  swrite("src/z.ts", `export const z = 1;\n// ${nonce}\n`);
  scommit("C: x changes, z added");
  const zAbs = resolve(SHARED, "src/z.ts");
  const blockZ = process.getuid?.() !== 0;
  if (blockZ) chmodSync(zAbs, 0o000);
  try {
    const parser = countingParser(SHARED);
    const { result: oneReview, loads } = await countGraphLoads(() => detPriors("review", parser));
    assert(loads === 1, `one review → one graph load (got ${loads})`);
    // `imports` + `exports` once each per new file; an unreadable z is not parsed.
    const parsed = [...parser.perFile].map(([abs, n]) => `${relative(SHARED, abs)}×${n}`).sort();
    const expectedParsed = blockZ ? ["src/x.ts×2"] : ["src/x.ts×2", "src/z.ts×2"];
    assert(
      same(parsed, expectedParsed),
      `the shared parser parses each new file once (got ${parsed.join(",")})`,
    );
    if (blockZ) {
      const warnings = oneReview.degraded.filter((d) => d.message.includes("could not read"));
      assert(
        warnings.length === 1 &&
          warnings[0]?.message ===
            "context: could not read 1 source file; left out of the import graph: src/z.ts",
        `the read warning appears once (got ${JSON.stringify(warnings.map((d) => d.message))})`,
      );
    } else {
      process.stdout.write(`  - skipped read warning: running as root\n`);
    }
  } finally {
    if (blockZ) chmodSync(zAbs, 0o644);
  }
} finally {
  rmSync(TMP_ROOT, { recursive: true, force: true });
}

if (failed > 0) {
  process.stdout.write(`\n${failed} assertion(s) failed\n`);
  process.exit(1);
}
process.stdout.write(`\nall assertions passed\n`);

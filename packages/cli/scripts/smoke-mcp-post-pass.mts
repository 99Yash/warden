/**
 * Slice #41 / ADR-0053 §4: the mandatory post-pass outside model discretion.
 * No LLM, no network. Builds a temp repo dir with real files (and a fake
 * `node_modules/fakepkg/index.d.ts` for an `api_def` source), a unified
 * diff, and crafted lanes. Each numbered case asserts one contract clause.
 *
 * Usage: pnpm --filter @warden/cli smoke:mcp-post-pass
 */
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { CommentSetSchema, runPostPass, type Comment, type LaneOutput } from "@warden/core";

const CLI_ROOT = fileURLToPath(new URL("..", import.meta.url));
const TMP_ROOT = mkdtempSync(resolve(tmpdir(), "warden-mcp-post-pass-"));

let failed = 0;
function assert(cond: unknown, msg: string): void {
  if (cond) {
    process.stdout.write(`  ✓ ${msg}\n`);
  } else {
    process.stdout.write(`  ✗ ${msg}\n`);
    failed++;
  }
}

const nowIso = "2026-10-08T00:00:00.000Z";

// ---------------------------------------------------------------------------
// Fixture: real files on disk (the verifier reads them).
// ---------------------------------------------------------------------------

const SRC = "src/a.ts";
const SRC_LINES = [
  "export function add(a: number, b: number): number {",
  "  return a + b;",
  "}",
  "export function sub(a: number, b: number): number {",
  "  return a - b;",
  "}",
  'export const version = "1.0.0";',
];
const DTS = "node_modules/fakepkg/index.d.ts";
const DTS_LINES = [
  "export declare const fakeVersion: string;",
  "export declare function greet(name: string): string;",
];
mkdirSync(resolve(TMP_ROOT, "src"), { recursive: true });
mkdirSync(resolve(TMP_ROOT, "node_modules/fakepkg"), { recursive: true });
writeFileSync(resolve(TMP_ROOT, SRC), SRC_LINES.join("\n") + "\n");
writeFileSync(resolve(TMP_ROOT, DTS), DTS_LINES.join("\n") + "\n");

// The diff adds only lines 1-3 of src/a.ts: line 6 is a real file line
// (the verifier passes it) but not an added line (anchoring drops it).
const DIFF = [
  `diff --git a/${SRC} b/${SRC}`,
  `--- /dev/null`,
  `+++ b/${SRC}`,
  "@@ -0,0 +1,3 @@",
  `+${SRC_LINES[0]}`,
  `+${SRC_LINES[1]}`,
  `+${SRC_LINES[2]}`,
  "",
].join("\n");
const DIFF_PATH = resolve(TMP_ROOT, "review.diff");
writeFileSync(DIFF_PATH, DIFF);

let claimSeq = 0;
function mkFinding(overrides: Partial<Comment> = {}): Record<string, unknown> {
  claimSeq += 1;
  return {
    file: SRC,
    lineStart: 2,
    lineEnd: 2,
    tier: 2,
    category: "correctness",
    kind: "assertion",
    claim: `smoke claim ${claimSeq}`,
    explanation: "smoke explanation",
    sources: [],
    confidence: 0.9,
    ...overrides,
  };
}

function mkLane(
  lane: LaneOutput["lane"],
  findings: unknown[],
  opts: Partial<LaneOutput> = {},
): LaneOutput {
  return { lane, status: "ok", scope: [SRC], findings, ...opts };
}

try {
  // ---------------------------------------------------------------------------
  // [1] malformed findings drop + count per lane; missing id minted + stable.
  // ---------------------------------------------------------------------------
  process.stdout.write("\n[1] schema validation — malformed drops, id minted\n");
  const noId = mkFinding();
  delete (noId as Record<string, unknown>)["id"];
  const lanes1: LaneOutput[] = [mkLane("up", [42, "nope", {}, noId])];
  const r1 = await runPostPass({ repoRoot: TMP_ROOT, diff: DIFF, lanes: lanes1 });
  assert(r1.comments.length === 1, `one valid finding survives (got ${r1.comments.length})`);
  const minted = r1.comments[0]?.id ?? "";
  assert(minted.startsWith("W-"), `missing id is minted stable (${minted})`);
  const r1b = await runPostPass({ repoRoot: TMP_ROOT, diff: DIFF, lanes: lanes1 });
  assert(r1b.comments[0]?.id === minted, "minted id is stable across runs");
  assert(
    r1.metadata.degradedWorkers.some(
      (d) =>
        d.topic === "post-pass" && d.message.includes("3 invalid") && d.message.includes("up: 3"),
    ),
    "invalid findings counted per lane in a post-pass entry",
  );

  // ---------------------------------------------------------------------------
  // [2] lane scope membership.
  // ---------------------------------------------------------------------------
  process.stdout.write("\n[2] scope — out-of-scope drops, in-scope + no-path kept\n");
  const inScope = {
    ...mkFinding({ id: "W-scope-in" }),
    sources: [
      {
        type: "tool",
        id: "t",
        title: "t",
        retrievedAt: nowIso,
        path: SRC,
        line: 2,
        snippet: SRC_LINES[1],
      },
    ],
  };
  const outOfScope = {
    ...mkFinding({ id: "W-scope-out" }),
    sources: [
      {
        type: "tool",
        id: "t",
        title: "t",
        retrievedAt: nowIso,
        path: "src/other.ts",
        line: 2,
        snippet: "x",
      },
    ],
  };
  const noPath = { ...mkFinding({ id: "W-scope-nopath" }), sources: [] };
  const r2 = await runPostPass({
    repoRoot: TMP_ROOT,
    diff: DIFF,
    lanes: [mkLane("up", [inScope, outOfScope, noPath])],
  });
  const ids2 = r2.comments
    .map((c) => c.id)
    .sort()
    .join(",");
  assert(ids2 === "W-scope-in,W-scope-nopath", `in-scope + no-path kept, other dropped (${ids2})`);
  assert(
    r2.metadata.degradedWorkers.some(
      (d) => d.topic === "post-pass" && d.message.includes("outside the lane scope"),
    ),
    "scope drop counted in a post-pass entry",
  );

  // ---------------------------------------------------------------------------
  // [3] citation verification.
  // ---------------------------------------------------------------------------
  process.stdout.write("\n[3] verifier — fabricated snippet drops, real snippet kept\n");
  const fabricated = {
    ...mkFinding({ id: "W-verify-bad" }),
    sources: [
      {
        type: "tool",
        id: "t",
        title: "t",
        retrievedAt: nowIso,
        path: SRC,
        line: 2,
        snippet: "return a * b; // fabricated",
      },
    ],
  };
  const real = {
    ...mkFinding({ id: "W-verify-good" }),
    sources: [
      {
        type: "tool",
        id: "t",
        title: "t",
        retrievedAt: nowIso,
        path: SRC,
        line: 2,
        snippet: SRC_LINES[1],
      },
    ],
  };
  const r3 = await runPostPass({
    repoRoot: TMP_ROOT,
    diff: DIFF,
    lanes: [mkLane("up", [fabricated, real])],
  });
  assert(
    r3.comments.length === 1 && r3.comments[0]?.id === "W-verify-good",
    "fabricated-snippet comment drops, real-snippet comment kept",
  );
  assert(
    r3.metadata.degradedWorkers.some((d) => d.topic === "llm"),
    "verifier drops surface as llm-topic degraded entries",
  );

  // ---------------------------------------------------------------------------
  // [4] added-line anchoring.
  // ---------------------------------------------------------------------------
  process.stdout.write("\n[4] anchoring — unchanged line drops, added + 0:0 kept\n");
  const added = mkFinding({ id: "W-anchor-added", lineStart: 2, lineEnd: 2 });
  const unchanged = {
    ...mkFinding({ id: "W-anchor-unchanged", lineStart: 6, lineEnd: 6 }),
    sources: [
      {
        type: "tool",
        id: "t",
        title: "t",
        retrievedAt: nowIso,
        path: SRC,
        line: 6,
        snippet: SRC_LINES[5],
      },
    ],
  };
  const fileLevel = mkFinding({ id: "W-anchor-file", lineStart: 0, lineEnd: 0 });
  const r4 = await runPostPass({
    repoRoot: TMP_ROOT,
    diff: DIFF,
    lanes: [mkLane("up", [added, unchanged, fileLevel])],
  });
  const ids4 = r4.comments
    .map((c) => c.id)
    .sort()
    .join(",");
  assert(ids4 === "W-anchor-added,W-anchor-file", `added + file-level kept (${ids4})`);

  // ---------------------------------------------------------------------------
  // [5] confidence→kind demotion.
  // ---------------------------------------------------------------------------
  process.stdout.write("\n[5] demotion — below threshold asks, authority exempts\n");
  const lowReasoned = mkFinding({ id: "W-demote-low", confidence: 0.6 });
  const atThreshold = mkFinding({ id: "W-demote-at", confidence: 0.7 });
  const above = mkFinding({ id: "W-demote-high", confidence: 0.9 });
  const lowSecurity = mkFinding({ id: "W-demote-sec", category: "security", confidence: 0.75 });
  const tier1Low = mkFinding({ id: "W-demote-t1", tier: 1, confidence: 0.1 });
  const apiDefLow = {
    ...mkFinding({ id: "W-demote-apidef", confidence: 0.1 }),
    sources: [
      {
        type: "api_def",
        id: "fakepkg@1.0.0#greet",
        title: "function greet",
        retrievedAt: nowIso,
        path: DTS,
        line: 2,
        snippet: DTS_LINES[1],
      },
    ],
  };
  const cveLow = {
    ...mkFinding({ id: "W-demote-cve", confidence: 0.5 }),
    sources: [{ type: "cve", id: "CVE-2026-0001", title: "t", retrievedAt: nowIso }],
  };
  const r5 = await runPostPass({
    repoRoot: TMP_ROOT,
    diff: DIFF,
    lanes: [
      {
        lane: "up",
        status: "ok",
        scope: [SRC, DTS],
        findings: [lowReasoned, atThreshold, above, lowSecurity, tier1Low, apiDefLow, cveLow],
      },
    ],
    // 7 findings, all gated through — the default cap of 5 would clip two.
    config: { volumeCap: Infinity },
  });
  const kindOf = (id: string): string | undefined => r5.comments.find((c) => c.id === id)?.kind;
  assert(kindOf("W-demote-low") === "question", "reasoned assertion below 0.7 demotes to question");
  assert(kindOf("W-demote-at") === "assertion", "assertion at the threshold stays");
  assert(kindOf("W-demote-high") === "assertion", "assertion above the threshold stays");
  assert(kindOf("W-demote-sec") === "question", "security 0.75 demotes under the 0.8 floor");
  assert(
    r5.comments.some((c) => c.id === "W-demote-t1" && c.kind === "question"),
    "Tier-1 low-confidence demotes to question instead of dropping",
  );
  assert(
    kindOf("W-demote-apidef") === "assertion",
    "verified api_def low-confidence stays an assertion",
  );
  assert(
    kindOf("W-demote-cve") === "question",
    "model-labelled cve low-confidence demotes — the label is not authority",
  );

  // ---------------------------------------------------------------------------
  // [6] Tier-3 gate.
  // ---------------------------------------------------------------------------
  process.stdout.write("\n[6] tier-3 gate — gated by default, kept verbose\n");
  const t3 = mkFinding({
    id: "W-t3",
    tier: 3,
    category: "clarity",
    kind: "question",
    confidence: 0.9,
  });
  const r6a = await runPostPass({ repoRoot: TMP_ROOT, diff: DIFF, lanes: [mkLane("up", [t3])] });
  assert(r6a.comments.length === 0, "tier-3 gated without verbose");
  const r6b = await runPostPass({
    repoRoot: TMP_ROOT,
    diff: DIFF,
    lanes: [mkLane("up", [t3])],
    config: { verbose: true },
  });
  assert(r6b.comments.length === 1, "tier-3 kept with verbose");

  // ---------------------------------------------------------------------------
  // [7] priority order.
  // ---------------------------------------------------------------------------
  process.stdout.write("\n[7] priority order — category, then tier, then confidence\n");
  const styleHi = mkFinding({
    id: "W-ord-style",
    category: "style",
    kind: "question",
    confidence: 0.95,
  });
  const corrT2 = mkFinding({ id: "W-ord-corr2", kind: "question", confidence: 0.9 });
  const corrT1 = mkFinding({ id: "W-ord-corr1", tier: 1, kind: "question", confidence: 0.1 });
  const r7 = await runPostPass({
    repoRoot: TMP_ROOT,
    diff: DIFF,
    lanes: [mkLane("up", [styleHi, corrT2, corrT1])],
  });
  assert(
    r7.comments.map((c) => c.id).join(",") === "W-ord-corr1,W-ord-corr2,W-ord-style",
    `correctness before style, tier before confidence (${r7.comments.map((c) => c.id).join(",")})`,
  );

  // ---------------------------------------------------------------------------
  // [8] cross-lane id dedupe.
  // ---------------------------------------------------------------------------
  process.stdout.write("\n[8] dedupe — same id across two lanes posts once\n");
  const dupe = mkFinding({ id: "W-dupe" });
  const dupeCopy = { ...mkFinding(), id: "W-dupe" };
  const r8 = await runPostPass({
    repoRoot: TMP_ROOT,
    diff: DIFF,
    lanes: [mkLane("up", [dupe]), mkLane("down", [dupeCopy])],
  });
  assert(r8.comments.length === 1, `duplicate id dedupes (${r8.comments.length})`);

  // ---------------------------------------------------------------------------
  // [9] volume cap.
  // ---------------------------------------------------------------------------
  process.stdout.write("\n[9] volume cap — Tier-1 always kept\n");
  const ten: Record<string, unknown>[] = [];
  for (let i = 0; i < 8; i++) ten.push(mkFinding({ kind: "question", confidence: 0.9 }));
  const t1a = mkFinding({ tier: 1, kind: "question", confidence: 0.9 });
  const t1b = mkFinding({ tier: 1, kind: "question", confidence: 0.9 });
  ten.push(t1a, t1b);
  const r9 = await runPostPass({
    repoRoot: TMP_ROOT,
    diff: DIFF,
    lanes: [mkLane("up", ten)],
    config: { volumeCap: 5 },
  });
  assert(r9.comments.length === 5, `cap 5 of 10 emits 5 (got ${r9.comments.length})`);
  assert(
    r9.comments.filter((c) => c.tier === 1).length === 2,
    "both Tier-1 comments survive the cap",
  );
  const r9b = await runPostPass({
    repoRoot: TMP_ROOT,
    diff: DIFF,
    lanes: [mkLane("up", [t1a, t1b])],
    config: { volumeCap: 1 },
  });
  assert(r9b.comments.length === 2, "cap 1 with 2 Tier-1 keeps both Tier-1");

  // ---------------------------------------------------------------------------
  // [10] lane health.
  // ---------------------------------------------------------------------------
  process.stdout.write("\n[10] lane health — the no-findings contract\n");
  const r10a = await runPostPass({ repoRoot: TMP_ROOT, diff: DIFF, lanes: [] });
  assert(
    r10a.comments.length === 0 &&
      r10a.metadata.degradedWorkers.some(
        (d) =>
          d.kind === "actionable" &&
          d.topic === "lane-health" &&
          d.message.includes("no review lanes reported"),
      ),
    "no lanes → actionable lane-health, not a clean result",
  );
  const r10b = await runPostPass({
    repoRoot: TMP_ROOT,
    diff: DIFF,
    lanes: [
      mkLane("up", [], { status: "failed", reason: "boom" }),
      mkLane("down", [], { status: "failed", reason: "bust" }),
    ],
  });
  const allFailed = r10b.metadata.degradedWorkers.find((d) => d.topic === "lane-health");
  assert(
    allFailed?.kind === "actionable" &&
      allFailed.message.includes("all 2") &&
      allFailed.message.includes("boom") &&
      allFailed.message.includes("bust"),
    "all lanes failed → actionable lane-health listing reasons",
  );
  const r10c = await runPostPass({
    repoRoot: TMP_ROOT,
    diff: DIFF,
    lanes: [mkLane("up", []), mkLane("down", [], { status: "failed", reason: "bust" })],
  });
  const someFailed = r10c.metadata.degradedWorkers.find((d) => d.topic === "lane-health");
  assert(someFailed?.kind === "warning", "one lane failed → warning lane-health");
  const r10d = await runPostPass({
    repoRoot: TMP_ROOT,
    diff: DIFF,
    lanes: [mkLane("up", [])],
  });
  assert(
    r10d.comments.length === 0 &&
      r10d.metadata.degradedWorkers.every((d) => d.topic !== "lane-health"),
    "ok + empty is a clean contribution — no lane-health entry",
  );

  // ---------------------------------------------------------------------------
  // [11] volumeCap validation.
  // ---------------------------------------------------------------------------
  process.stdout.write("\n[11] volumeCap validation — RangeError\n");
  let threw: unknown = null;
  try {
    await runPostPass({
      repoRoot: TMP_ROOT,
      diff: DIFF,
      lanes: [mkLane("up", [])],
      config: { volumeCap: 0 },
    });
  } catch (err) {
    threw = err;
  }
  assert(threw instanceof RangeError, `volumeCap 0 throws RangeError (got ${String(threw)})`);

  // ---------------------------------------------------------------------------
  // [12] independence from the harness.
  // ---------------------------------------------------------------------------
  process.stdout.write("\n[12a] import scan — post-pass reaches no harness/LLM code\n");
  const CORE_SRC = resolve(CLI_ROOT, "..", "core", "src");
  const reached = new Set<string>();
  const stack = [resolve(CORE_SRC, "post-pass.ts")];
  while (stack.length > 0) {
    const file = stack.pop() as string;
    if (reached.has(file)) continue;
    reached.add(file);
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/from\s+["'](\.[^"']+)["']/g)) {
      const rel = m[1] as string;
      const abs = resolve(dirname(file), rel.replace(/\.js$/, ".ts"));
      if (abs.startsWith(CORE_SRC)) stack.push(abs);
    }
    if (/from\s+["']@warden\/ai["']|require\(["']@warden\/ai["']/.test(src)) {
      assert(false, `post-pass tree imports @warden/ai (${file})`);
    }
  }
  const badHarness = [...reached].filter(
    (f) => f.includes("review-harness/") && !f.endsWith("review-harness/comment-scope.ts"),
  );
  const badLlm = [...reached].filter(
    (f) => f.includes("/llm/") && !f.endsWith("llm/verify-citations.ts"),
  );
  assert(
    badHarness.length === 0,
    `no review-harness/ except comment-scope (${badHarness.join(",") || "clean"})`,
  );
  assert(badLlm.length === 0, `no llm/ except verify-citations (${badLlm.join(",") || "clean"})`);

  process.stdout.write("\n[12b] CLI runs with no provider keys\n");
  const lanesJson = JSON.stringify({
    version: 1,
    lanes: [mkLane("up", [mkFinding({ id: "W-cli" })])],
  });
  const stripKeys = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
    const next = { ...env };
    for (const k of [
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "GOOGLE_GENERATIVE_AI_API_KEY",
      "GEMINI_API_KEY",
      "VOYAGE_API_KEY",
    ]) {
      delete next[k];
    }
    next["WARDEN_CACHE_PATH"] = resolve(TMP_ROOT, ".warden/cache.sqlite");
    return next;
  };
  const cliOut = execFileSync(
    process.execPath,
    [
      "--import",
      import.meta.resolve("tsx/esm"),
      resolve(CLI_ROOT, "src/index.ts"),
      "post-pass",
      "--json",
      "--diff-file",
      DIFF_PATH,
      "--lanes",
      "-",
    ],
    { cwd: TMP_ROOT, env: stripKeys(process.env), input: lanesJson, encoding: "utf8" },
  );
  const cliParsed = CommentSetSchema.safeParse(JSON.parse(cliOut as string));
  assert(cliParsed.success, "keyless CLI run exits 0 with a schema-valid CommentSet");
  if (cliParsed.success) {
    assert(
      cliParsed.data.comments.some((c) => c.id === "W-cli"),
      "keyless CLI run emits the finding",
    );
  }

  process.stdout.write("\n[12c] CLI exits 1 on empty lanes\n");
  let exit1 = -1;
  try {
    execFileSync(
      process.execPath,
      [
        "--import",
        import.meta.resolve("tsx/esm"),
        resolve(CLI_ROOT, "src/index.ts"),
        "post-pass",
        "--json",
        "--diff-file",
        DIFF_PATH,
        "--lanes",
        "-",
      ],
      {
        cwd: TMP_ROOT,
        env: stripKeys(process.env),
        input: JSON.stringify({ version: 1, lanes: [] }),
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
  } catch (err) {
    exit1 = (err as { status?: number }).status ?? -1;
  }
  assert(exit1 === 1, `empty lanes exits 1 (got ${exit1})`);

  // ---------------------------------------------------------------------------
  // [13] not an MCP tool.
  // ---------------------------------------------------------------------------
  process.stdout.write("\n[13] MCP server exposes no post-pass tool\n");
  const client = new Client({ name: "warden-post-pass-smoke", version: "0.0.1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", import.meta.resolve("tsx/esm"), resolve(CLI_ROOT, "src/index.ts"), "mcp"],
    cwd: TMP_ROOT,
    env: {
      ...getDefaultEnvironment(),
      WARDEN_CACHE_PATH: resolve(TMP_ROOT, ".warden/cache.sqlite"),
    },
    stderr: "pipe",
  });
  await client.connect(transport, { timeout: 15_000 });
  const { tools } = await client.listTools();
  await client.close();
  const names = tools
    .map((t) => t.name)
    .sort()
    .join(",");
  assert(
    names === "lookup_type_def,run_det_priors",
    `tool names are exactly lookup + det-priors (${names})`,
  );
} catch (err) {
  assert(false, `smoke threw: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  rmSync(TMP_ROOT, { recursive: true, force: true });
}

if (failed > 0) {
  process.stdout.write(`\n${failed} assertion(s) failed\n`);
  process.exit(1);
}
process.stdout.write("\nall assertions passed\n");

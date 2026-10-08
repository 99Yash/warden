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
const TRAVERSE_DECL = "src/traverse.d.ts";
const TRAVERSE_LINES = ["export declare const traverseFlag: boolean;"];
mkdirSync(resolve(TMP_ROOT, "src"), { recursive: true });
mkdirSync(resolve(TMP_ROOT, "node_modules/fakepkg"), { recursive: true });
writeFileSync(resolve(TMP_ROOT, SRC), SRC_LINES.join("\n") + "\n");
writeFileSync(resolve(TMP_ROOT, DTS), DTS_LINES.join("\n") + "\n");
writeFileSync(resolve(TMP_ROOT, TRAVERSE_DECL), TRAVERSE_LINES.join("\n") + "\n");

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

/**
 * Model-supplied `id` keys are stripped by `LaneFindingSchema`, so cases
 * track findings by their unique `claim` (or the minted id), never by a
 * supplied id.
 */
function claimOf(f: Record<string, unknown>): string {
  return f["claim"] as string;
}

try {
  // ---------------------------------------------------------------------------
  // [1] malformed findings drop + count per lane; missing id minted + stable.
  // ---------------------------------------------------------------------------
  process.stdout.write("\n[1] schema validation — malformed drops, id minted\n");
  const noId = mkFinding();
  delete noId["id"];
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
    ...mkFinding(),
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
    ...mkFinding(),
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
  const noPath = { ...mkFinding(), sources: [] };
  const sourcelessOutOfScope = { ...mkFinding(), file: "src/other.ts", sources: [] };
  const inScopeSourceOutOfScopeAnchor = {
    ...mkFinding(),
    file: "src/other.ts",
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
  const r2 = await runPostPass({
    repoRoot: TMP_ROOT,
    diff: DIFF,
    lanes: [
      mkLane("up", [
        inScope,
        outOfScope,
        noPath,
        sourcelessOutOfScope,
        inScopeSourceOutOfScopeAnchor,
      ]),
    ],
  });
  const kept2 = r2.comments
    .map((c) => c.claim)
    .sort()
    .join(",");
  const want2 = [claimOf(inScope), claimOf(noPath)].sort().join(",");
  assert(kept2 === want2, `in-scope + no-path kept, others dropped (${kept2})`);
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
    ...mkFinding(),
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
    ...mkFinding(),
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
    r3.comments.length === 1 && r3.comments[0]?.claim === claimOf(real),
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
  const added = mkFinding({ lineStart: 2, lineEnd: 2 });
  const unchanged = {
    ...mkFinding({ lineStart: 6, lineEnd: 6 }),
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
  const fileLevel = mkFinding({ lineStart: 0, lineEnd: 0 });
  const r4 = await runPostPass({
    repoRoot: TMP_ROOT,
    diff: DIFF,
    lanes: [mkLane("up", [added, unchanged, fileLevel])],
  });
  const kept4 = r4.comments
    .map((c) => c.claim)
    .sort()
    .join(",");
  const want4 = [claimOf(added), claimOf(fileLevel)].sort().join(",");
  assert(kept4 === want4, `added + file-level kept (${kept4})`);

  // ---------------------------------------------------------------------------
  // [5] confidence→kind demotion.
  // ---------------------------------------------------------------------------
  process.stdout.write("\n[5] demotion — below threshold asks, authority exempts\n");
  const lowReasoned = mkFinding({ confidence: 0.6 });
  const atThreshold = mkFinding({ confidence: 0.7 });
  const above = mkFinding({ confidence: 0.9 });
  const lowSecurity = mkFinding({ category: "security", confidence: 0.75 });
  const tier1Low = mkFinding({ tier: 1, confidence: 0.1 });
  const inScopeCompanion = {
    type: "tool",
    id: "t",
    title: "t",
    retrievedAt: nowIso,
    path: SRC,
    line: 2,
    snippet: SRC_LINES[1],
  };
  const apiDefLow = {
    ...mkFinding({ confidence: 0.1 }),
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
      // A bare `api_def` path in `node_modules/` is outside every lane
      // scope, so the verified finding needs an in-scope companion source
      // or gate 2 drops it (see `bareApiDef` below).
      { ...inScopeCompanion },
    ],
  };
  const bareApiDef = {
    ...mkFinding({ confidence: 0.9 }),
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
  const traversalApiDef = {
    ...mkFinding({ confidence: 0.2 }),
    sources: [
      {
        type: "api_def",
        id: "traverse#flag",
        title: "const traverseFlag",
        retrievedAt: nowIso,
        path: `node_modules/../${TRAVERSE_DECL}`,
        line: 1,
        snippet: TRAVERSE_LINES[0],
      },
      { ...inScopeCompanion },
    ],
  };
  const apiDefSrc = {
    ...mkFinding({ confidence: 0.2 }),
    sources: [
      {
        type: "api_def",
        id: "selfcite",
        title: "function add",
        retrievedAt: nowIso,
        path: SRC,
        line: 2,
        snippet: SRC_LINES[1],
      },
    ],
  };
  const cveLow = {
    ...mkFinding({ confidence: 0.5 }),
    sources: [{ type: "cve", id: "CVE-2026-0001", title: "t", retrievedAt: nowIso }],
  };
  const r5 = await runPostPass({
    repoRoot: TMP_ROOT,
    diff: DIFF,
    lanes: [
      {
        lane: "up",
        status: "ok",
        scope: [SRC],
        findings: [
          lowReasoned,
          atThreshold,
          above,
          lowSecurity,
          tier1Low,
          apiDefLow,
          bareApiDef,
          traversalApiDef,
          apiDefSrc,
          cveLow,
        ],
      },
    ],
    // 10 findings, all gated through — the default cap of 5 would clip half.
    config: { volumeCap: Infinity },
  });
  const kindOf = (claim: string): string | undefined =>
    r5.comments.find((c) => c.claim === claim)?.kind;
  assert(
    kindOf(claimOf(lowReasoned)) === "question",
    "reasoned assertion below 0.7 demotes to question",
  );
  assert(kindOf(claimOf(atThreshold)) === "assertion", "assertion at the threshold stays");
  assert(kindOf(claimOf(above)) === "assertion", "assertion above the threshold stays");
  assert(kindOf(claimOf(lowSecurity)) === "question", "security 0.75 demotes under the 0.8 floor");
  assert(
    r5.comments.some((c) => c.claim === claimOf(tier1Low) && c.kind === "question"),
    "Tier-1 low-confidence demotes to question instead of dropping",
  );
  assert(
    kindOf(claimOf(apiDefLow)) === "assertion",
    "verified api_def with an in-scope companion stays an assertion",
  );
  assert(
    !r5.comments.some((c) => c.claim === claimOf(bareApiDef)),
    "bare api_def with scope [SRC] drops at gate 2 — node_modules/ is outside every lane scope",
  );
  assert(
    kindOf(claimOf(traversalApiDef)) === "question",
    "api_def at node_modules/../src/*.d.ts demotes — traversal escapes node_modules/",
  );
  assert(
    kindOf(claimOf(apiDefSrc)) === "question",
    "api_def on a reviewed source file is not authority — demotes",
  );
  assert(
    kindOf(claimOf(cveLow)) === "question",
    "model-labelled cve low-confidence demotes — the label is not authority",
  );

  // ---------------------------------------------------------------------------
  // [6] Tier-3 gate.
  // ---------------------------------------------------------------------------
  process.stdout.write("\n[6] tier-3 gate — gated by default, kept verbose\n");
  const t3 = mkFinding({
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
    category: "style",
    kind: "question",
    confidence: 0.95,
  });
  const corrT2 = mkFinding({ kind: "question", confidence: 0.9 });
  const corrT1 = mkFinding({ tier: 1, kind: "question", confidence: 0.1 });
  const r7 = await runPostPass({
    repoRoot: TMP_ROOT,
    diff: DIFF,
    lanes: [mkLane("up", [styleHi, corrT2, corrT1])],
  });
  const order7 = r7.comments.map((c) => c.claim).join(",");
  const want7 = [claimOf(corrT1), claimOf(corrT2), claimOf(styleHi)].join(",");
  assert(order7 === want7, `correctness before style, tier before confidence (${order7})`);

  // ---------------------------------------------------------------------------
  // [8] dedupe — identical content across lanes posts once, model ids stripped.
  // ---------------------------------------------------------------------------
  process.stdout.write("\n[8] dedupe — identical content posts once, model ids stripped\n");
  const sharedClaim = "shared cross-lane claim";
  const dupA = mkFinding({ claim: sharedClaim });
  const dupB = mkFinding({ claim: sharedClaim });
  const r8 = await runPostPass({
    repoRoot: TMP_ROOT,
    diff: DIFF,
    lanes: [mkLane("up", [dupA]), mkLane("down", [dupB])],
  });
  assert(r8.comments.length === 1, `byte-identical findings dedupe (${r8.comments.length})`);
  const sameIdA = { ...mkFinding({ claim: "distinct finding A" }), id: "1" };
  const sameIdB = { ...mkFinding({ claim: "distinct finding B" }), id: "1" };
  const r8b = await runPostPass({
    repoRoot: TMP_ROOT,
    diff: DIFF,
    lanes: [mkLane("up", [sameIdA]), mkLane("down", [sameIdB])],
  });
  assert(
    r8b.comments.length === 2,
    `model-supplied ids are stripped — distinct findings both survive (${r8b.comments.length})`,
  );

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
  const r10e = await runPostPass({
    repoRoot: TMP_ROOT,
    diff: DIFF,
    lanes: [mkLane("up", [mkFinding()]), mkLane("down", [42, "nope"])],
  });
  const unhealthyOne = r10e.metadata.degradedWorkers.find((d) => d.topic === "lane-health");
  assert(
    unhealthyOne?.kind === "warning" && unhealthyOne.message.includes("down"),
    "ok lane losing all findings to validation/scope is unhealthy — warning naming the lane",
  );
  const r10f = await runPostPass({
    repoRoot: TMP_ROOT,
    diff: DIFF,
    lanes: [mkLane("up", [42, "nope"])],
  });
  const unhealthyAll = r10f.metadata.degradedWorkers.find((d) => d.topic === "lane-health");
  assert(
    unhealthyAll?.kind === "actionable",
    "every lane unhealthy → actionable, not a clean result",
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
  const cliFinding = mkFinding();
  const lanesJson = JSON.stringify({
    version: 1,
    lanes: [mkLane("up", [cliFinding])],
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
    // The global warden env file must not re-inject keys into the child.
    next["XDG_CONFIG_HOME"] = resolve(TMP_ROOT, ".config");
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
  const cliParsed = CommentSetSchema.safeParse(JSON.parse(cliOut));
  assert(cliParsed.success, "keyless CLI run exits 0 with a schema-valid CommentSet");
  if (cliParsed.success) {
    assert(
      cliParsed.data.comments.some((c) => c.claim === claimOf(cliFinding)),
      "keyless CLI run emits the finding",
    );
  }

  process.stdout.write("\n[12c] CLI exits 1 on empty lanes\n");
  let exit1 = -1;
  let out12c = "";
  try {
    out12c = execFileSync(
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
    out12c = (err as { stdout?: string }).stdout ?? "";
  }
  assert(exit1 === 1, `empty lanes exits 1 (got ${exit1})`);
  const parsed12c = CommentSetSchema.safeParse(JSON.parse(out12c));
  assert(
    parsed12c.success &&
      parsed12c.data.metadata.degradedWorkers.some(
        (d) =>
          d.kind === "actionable" &&
          d.topic === "lane-health" &&
          d.message.includes("no review lanes reported"),
      ),
    "empty lanes stdout carries the actionable lane-health entry",
  );

  process.stdout.write("\n[12d] CLI exits 1 on bad --base and empty --diff-file\n");
  // A real git repo, so the bad ref — not a missing repo — is the cause.
  const GIT_ROOT = mkdtempSync(resolve(tmpdir(), "warden-mcp-post-pass-git-"));
  execFileSync("git", ["init"], { cwd: GIT_ROOT, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "smoke@example.com"], {
    cwd: GIT_ROOT,
    stdio: "ignore",
  });
  execFileSync("git", ["config", "user.name", "smoke"], { cwd: GIT_ROOT, stdio: "ignore" });
  writeFileSync(resolve(GIT_ROOT, "README.md"), "smoke\n");
  execFileSync("git", ["add", "-A"], { cwd: GIT_ROOT, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "smoke"], { cwd: GIT_ROOT, stdio: "ignore" });
  let badBaseExit = -1;
  let out12dBase = "";
  try {
    out12dBase = execFileSync(
      process.execPath,
      [
        "--import",
        import.meta.resolve("tsx/esm"),
        resolve(CLI_ROOT, "src/index.ts"),
        "post-pass",
        "--json",
        "--base",
        "warden-smoke-nonexistent-ref",
        "--lanes",
        "-",
      ],
      {
        cwd: GIT_ROOT,
        env: stripKeys(process.env),
        input: lanesJson,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
  } catch (err) {
    badBaseExit = (err as { status?: number }).status ?? -1;
    out12dBase = (err as { stdout?: string }).stdout ?? "";
  }
  assert(badBaseExit === 1, `bad --base exits 1 (got ${badBaseExit})`);
  const parsed12dBase = CommentSetSchema.safeParse(JSON.parse(out12dBase));
  assert(
    parsed12dBase.success &&
      parsed12dBase.data.metadata.degradedWorkers.some(
        (d) => d.kind === "actionable" && d.topic === "diff-source",
      ),
    "bad --base stdout carries the actionable diff-source entry",
  );
  rmSync(GIT_ROOT, { recursive: true, force: true });
  const EMPTY_DIFF_PATH = resolve(TMP_ROOT, "empty.diff");
  writeFileSync(EMPTY_DIFF_PATH, "");
  let emptyDiffExit = -1;
  let out12dEmpty = "";
  try {
    out12dEmpty = execFileSync(
      process.execPath,
      [
        "--import",
        import.meta.resolve("tsx/esm"),
        resolve(CLI_ROOT, "src/index.ts"),
        "post-pass",
        "--json",
        "--diff-file",
        EMPTY_DIFF_PATH,
        "--lanes",
        "-",
      ],
      {
        cwd: TMP_ROOT,
        env: stripKeys(process.env),
        input: lanesJson,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
  } catch (err) {
    emptyDiffExit = (err as { status?: number }).status ?? -1;
    out12dEmpty = (err as { stdout?: string }).stdout ?? "";
  }
  assert(emptyDiffExit === 1, `empty --diff-file exits 1 (got ${emptyDiffExit})`);
  const parsed12dEmpty = CommentSetSchema.safeParse(JSON.parse(out12dEmpty));
  assert(
    parsed12dEmpty.success &&
      parsed12dEmpty.data.metadata.degradedWorkers.some(
        (d) => d.kind === "actionable" && d.topic === "diff-source",
      ),
    "empty --diff-file stdout carries the actionable diff-source entry",
  );

  // ---------------------------------------------------------------------------
  // [14] pruned-not-empty diff — no false "empty diff", noise-filter forwarded.
  // ---------------------------------------------------------------------------
  process.stdout.write("\n[14] pruned diff — noise-filter forwarded, no diff-source entry\n");
  // A diff that parses to files but prunes to nothing (generated noise) is
  // not an empty diff: the large generated drop is loud (info
  // noise-filter), so the silence is visible without a false-clean entry.
  const MIN_LINES = Array.from({ length: 600 }, (_, i) => `+var bundle${i} = ${i};`).join("\n");
  const MIN_DIFF = [
    "diff --git a/dist/x.min.js b/dist/x.min.js",
    "--- /dev/null",
    "+++ b/dist/x.min.js",
    "@@ -0,0 +1,600 @@",
    MIN_LINES,
    "",
  ].join("\n");
  const MIN_DIFF_PATH = resolve(TMP_ROOT, "noise.diff");
  writeFileSync(MIN_DIFF_PATH, MIN_DIFF);
  const r14 = await runPostPass({ repoRoot: TMP_ROOT, diff: MIN_DIFF, lanes: [mkLane("up", [])] });
  assert(
    r14.metadata.degradedWorkers.every((d) => d.topic !== "diff-source"),
    "pruned-to-nothing diff emits no diff-source entry",
  );
  assert(
    r14.metadata.degradedWorkers.some((d) => d.topic === "noise-filter"),
    "prune degraded is forwarded into the CommentSet",
  );
  let exit14 = -1;
  let out14 = "";
  try {
    out14 = execFileSync(
      process.execPath,
      [
        "--import",
        import.meta.resolve("tsx/esm"),
        resolve(CLI_ROOT, "src/index.ts"),
        "post-pass",
        "--json",
        "--diff-file",
        MIN_DIFF_PATH,
        "--lanes",
        "-",
      ],
      {
        cwd: TMP_ROOT,
        env: stripKeys(process.env),
        input: JSON.stringify({ version: 1, lanes: [mkLane("up", [])] }),
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    exit14 = 0;
  } catch (err) {
    exit14 = (err as { status?: number }).status ?? -1;
    out14 = (err as { stdout?: string }).stdout ?? "";
  }
  assert(exit14 === 0, `pruned diff with ok + empty exits 0 (got ${exit14})`);
  const parsed14 = CommentSetSchema.safeParse(JSON.parse(out14));
  assert(
    parsed14.success &&
      parsed14.data.metadata.degradedWorkers.some((d) => d.topic === "noise-filter") &&
      parsed14.data.metadata.degradedWorkers.every((d) => d.topic !== "diff-source"),
    "pruned-diff CLI stdout forwards noise-filter with no diff-source entry",
  );

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

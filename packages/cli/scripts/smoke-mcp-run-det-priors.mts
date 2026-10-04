/**
 * Slice #40 / ADR-0053 §5(a): `run_det_priors` over real MCP stdio, plus the
 * size bound that replaced a post-hoc cap.
 *
 * Three halves, deliberately:
 *
 *  1. **Protocol half** — a real `warden mcp` child against a fixture git repo
 *     with a fixture diff. Discovery, envelope contract, tier/category/sources
 *     fidelity, degradation, and paging by handle.
 *  2. **Bound half** — a synthetic oversized `DetPriors` fed straight to the core
 *     serializer. The bound cannot be proven against a small fixture, and a real
 *     whole-repo diff is too slow and too machine-specific for a smoke.
 *  3. **Regression half** — the four round-0 defects, each pinned. Every one of
 *     these shipped green in round 0's smoke, so each is here specifically
 *     because the previous version of this file failed to ask the question.
 *
 * Usage: pnpm --filter @warden/cli smoke:mcp-run-det-priors
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  BUNDLE_LIMITS,
  REVIEW_BUNDLE_VERSION,
  ReviewBundlePageSchema,
  buildReviewBundlePage,
  runDetPriors,
  toBundleFinding,
  toComment,
  type DetPriors,
  type ReviewBundlePage,
  type ToolFinding,
} from "@warden/core";
import {
  DEFAULT_REVIEW_CACHE_CAPACITY,
  MAX_TOOL_RESULT_BYTES,
  TOOL_ENVELOPE_VERSION,
  TOOL_NAME_RUN_DET_PRIORS,
  ToolResultEnvelopeSchema,
  createReviewResultCache,
} from "@warden/mcp";

const CLI_ROOT = fileURLToPath(new URL("..", import.meta.url));
const TMP_ROOT = mkdtempSync(resolve(tmpdir(), "warden-det-priors-"));
const REPO = resolve(TMP_ROOT, "repo");

let failed = 0;
function assert(cond: unknown, msg: string): void {
  if (cond) {
    process.stdout.write(`  ✓ ${msg}\n`);
  } else {
    process.stdout.write(`  ✗ ${msg}\n`);
    failed++;
  }
}

/**
 * A block of *valid* TypeScript, duplicated verbatim into the review target so
 * jscpd has something real to report. It has to compile: an earlier version of
 * this fixture used undefined identifiers and produced 107 tsc errors, which
 * buried every other signal on the page.
 */
const DUP_BLOCK = Array.from({ length: 12 }, (_, i) => `  const step${i} = add(input, ${i});`).join(
  "\n",
);

const SHARED_MODULE = [
  "export function add(a: number, b: number): number {",
  "  return a + b;",
  "}",
  "",
].join("\n");

function git(args: string[], cwd = REPO): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function buildFixtureRepo(): string {
  mkdirSync(REPO, { recursive: true });
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "smoke@warden.test"]);
  git(["config", "user.name", "warden smoke"]);
  writeFileSync(join(REPO, "package.json"), JSON.stringify({ name: "fixture", version: "0.0.1" }));
  writeFileSync(join(REPO, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true } }));
  // The tsc runner shells out to `npx --no-install tsc` (runners/tsc.ts:43),
  // which resolves the binary from node_modules/.bin — so link both the package
  // and the bin shim, or the runner degrades instead of running.
  mkdirSync(join(REPO, "node_modules/.bin"), { recursive: true });
  symlinkSync(
    resolve(CLI_ROOT, "node_modules/typescript"),
    join(REPO, "node_modules/typescript"),
    "dir",
  );
  symlinkSync(
    resolve(CLI_ROOT, "node_modules/typescript/bin/tsc"),
    join(REPO, "node_modules/.bin/tsc"),
    "file",
  );

  // Baseline compiles clean, so every tsc error in the result is deliberate.
  writeFileSync(join(REPO, "shared.ts"), SHARED_MODULE);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "baseline"]);

  // The review target: exactly one type error, plus the duplicated block.
  writeFileSync(
    join(REPO, "c.ts"),
    [
      'import { add } from "./shared.js";',
      "",
      "export function useIt(input: number): number {",
      DUP_BLOCK,
      "  const wrong: number = 'not a number';",
      "  return wrong;",
      "}",
      "",
    ].join("\n"),
  );
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "review target"]);
  return git(["diff", "HEAD~1", "HEAD"], REPO);
}

const FIXTURE_DIFF = buildFixtureRepo();

/** Minimal structural reads off a validated envelope, without a second schema. */
interface Envelope {
  status: string;
  data?: ReviewBundlePage;
  reason?: string;
  hint?: string;
  isError: boolean;
}

function readEnvelope(result: unknown, tool: string): Envelope {
  const parsed = CallToolResultSchema.parse(result);
  const content = parsed.content;
  if (content.length !== 1 || content[0]?.type !== "text") {
    throw new Error(`Expected one JSON text block from ${tool}`);
  }
  const text = content[0].text;
  const size = Buffer.byteLength(text, "utf8");
  if (size > MAX_TOOL_RESULT_BYTES) {
    throw new Error(`${tool} returned ${size} B, over the ${MAX_TOOL_RESULT_BYTES} B cap`);
  }
  const envelope = ToolResultEnvelopeSchema.parse(JSON.parse(text));
  if (envelope.tool !== tool) throw new Error(`Envelope tool mismatch: ${envelope.tool}`);
  if (envelope.envelopeVersion !== TOOL_ENVELOPE_VERSION) throw new Error("Envelope version mismatch");
  return {
    status: envelope.status,
    ...(envelope.status === "ok"
      ? { data: envelope.data as unknown as ReviewBundlePage }
      : { reason: envelope.reason, hint: envelope.hint }),
    isError: parsed.isError ?? false,
  };
}

try {
  process.stdout.write("\n[1] discovery — both tools advertised\n");
  const client = new Client({ name: "warden-det-priors-smoke", version: "0.0.1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", import.meta.resolve("tsx/esm"), resolve(CLI_ROOT, "src/index.ts"), "mcp"],
    cwd: REPO,
    env: {
      ...getDefaultEnvironment(),
      WARDEN_CACHE_PATH: resolve(TMP_ROOT, ".warden/cache.sqlite"),
    },
    stderr: "pipe",
  });
  const protocolErrors: string[] = [];
  client.onerror = (e) => protocolErrors.push(e.message);
  await client.connect(transport, { timeout: 20_000 });
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert(
    names.length === 2 && names.includes("lookup_type_def") && names.includes(TOOL_NAME_RUN_DET_PRIORS),
    `both tools discovered (${names.join(", ")})`,
  );
  const det = tools.find((t) => t.name === TOOL_NAME_RUN_DET_PRIORS);
  const inputSchema = det?.inputSchema as
    | {
        type?: string;
        properties?: Record<string, { description?: string; anyOf?: unknown[]; oneOf?: unknown[] }>;
      }
    | undefined;
  assert(inputSchema?.type === "object", "input schema is a JSON Schema object at the root");
  // The request union is nested under `request` so MCP's object-root
  // requirement is satisfied while the discriminated union survives.
  const requestProp = inputSchema?.properties?.["request"];
  const requestVariants = [
    ...(requestProp?.anyOf ?? []),
    ...(requestProp?.oneOf ?? []),
  ] as Array<{ properties?: Record<string, unknown>; required?: string[] }>;
  const variantTargets = requestVariants.map(
    (v) => (v.properties?.["target"] as { const?: string } | undefined)?.const,
  );
  assert(
    requestVariants.length === 3 && variantTargets.includes("diff") &&
      variantTargets.includes("base") && variantTargets.includes("page"),
    `the request union advertises all three targets (${variantTargets.join(", ")})`,
  );
  const unionText = JSON.stringify(requestProp ?? {});
  assert(
    unionText.includes("reviewHandle") && unionText.includes("offset"),
    "the continuation variant advertises reviewHandle and offset",
  );
  assert(
    unionText.includes('"head"') === false,
    "no head parameter is advertised — a non-checkout head produced false-cleans (round 0)",
  );
  assert(
    det?.description?.includes("addedLineCount"),
    "description tells the model changed files carry a count, not line numbers",
  );
  assert(
    det?.description?.includes("unretrievable"),
    "description documents the unretrievable marker",
  );

  process.stdout.write("\n[2] fixture diff — shape, version, size\n");
  const first = readEnvelope(
    await client.callTool({
      name: TOOL_NAME_RUN_DET_PRIORS,
      arguments: { request: { target: "diff", diff: FIXTURE_DIFF } },
    }),
    TOOL_NAME_RUN_DET_PRIORS,
  );
  assert(first.status === "ok" && first.data !== undefined, "fixture diff returns status: ok");
  const page = first.data as ReviewBundlePage;
  assert(page.schemaVersion === REVIEW_BUNDLE_VERSION, "bundle carries its own schema version");
  assert(page.reviewHandle.startsWith("rb_"), "result carries an opaque review handle");
  assert(
    page.findings.length <= BUNDLE_LIMITS.findingsPerPage,
    `findings page within cap (${page.findings.length} <= ${BUNDLE_LIMITS.findingsPerPage})`,
  );
  assert(
    page.changedFiles.every((f) => typeof f.addedLineCount === "number" && !("addedLines" in f)),
    "changed files carry addedLineCount and never an addedLines array",
  );
  assert(
    page.changedFiles.some((f) => f.path === "c.ts"),
    "the changed file in the fixture diff is present",
  );
  const categoryTotal = Object.values(page.findingsByCategory).reduce((a, b) => a + b, 0);
  // Not a tautology guard on `tally` — it pins the documented rule that the
  // tallies describe the WHOLE result, not this page. Re-scoping them per page
  // would silently break every client sizing its paging loop, and this is the
  // only assertion that would notice.
  assert(
    categoryTotal === page.findingsTotal && page.findings.length <= page.findingsTotal,
    `findingsByCategory totals findingsTotal (${categoryTotal} vs ${page.findingsTotal}) and the page is a subset`,
  );
  assert(
    page.findings.length > 0,
    "the fixture produced at least one finding, so the per-finding assertions below are not vacuous",
  );

  process.stdout.write("\n[3] findings preserve tier / category / sources\n");
  assert(
    page.findings.every((f) => f.tier === 1 || f.tier === 2 || f.tier === 3),
    "every finding carries a tier",
  );
  assert(
    page.findings.every((f) => typeof f.category === "string" && f.category.length > 0),
    "every finding carries a category",
  );
  assert(
    page.findings.every((f) => f.sources.length > 0),
    "every finding carries a non-empty sources[]",
  );
  assert(
    page.findings.some((f) => f.detector === "tsc" && f.category === "correctness"),
    "the deliberate type error surfaces as a tsc finding mapped to correctness",
  );

  // The category/tier mapping is the claim; which detectors happen to fire on a
  // given fixture is not. Exercise every branch of `mapSeverity` directly and
  // require the bundle projection to agree with `toComment` on all of them.
  const branchProbe = (
    source: ToolFinding["source"],
    severity: ToolFinding["severity"],
    extra: Partial<ToolFinding> = {},
  ): ToolFinding => ({
    source,
    file: "src/probe.ts",
    line: 1,
    column: 1,
    severity,
    ruleId: "probe/rule",
    message: "probe",
    ...extra,
  });
  const branches = [
    branchProbe("tsc", "error"),
    branchProbe("tsc", "warning"),
    branchProbe("jscpd", "warning"),
    branchProbe("scalability", "warning"),
    branchProbe("deadcode", "warning"),
    branchProbe("consistency", "warning"),
    branchProbe("leverage", "warning"),
    branchProbe("react-doctor", "error", { rdCategory: "Security" }),
    branchProbe("react-doctor", "warning", { rdCategory: "Bugs" }),
    branchProbe("react-doctor", "warning", { rdCategory: "Performance" }),
    branchProbe("react-doctor", "warning", { rdCategory: "Maintainability" }),
    branchProbe("react-doctor", "warning", { rdCategory: "Accessibility" }),
    branchProbe("eslint", "error", { ruleId: "security/eval" }),
    branchProbe("eslint", "error", { ruleId: "no-secrets/hardcoded" }),
    branchProbe("eslint", "error", { ruleId: "no-console" }),
    branchProbe("eslint", "warning", { ruleId: "no-console" }),
  ];
  assert(
    branches.every((f) => {
      const b = toBundleFinding(f);
      const c = toComment(f);
      return b.tier === c.tier && b.category === c.category && b.id === c.id;
    }),
    "every mapSeverity branch projects to the identical tier, category and id as toComment",
  );
  assert(
    branches
      .map((f) => toBundleFinding(f))
      .some((b) => b.detector === "jscpd" && b.tier === 3 && b.category === "dedup") &&
      branches
        .map((f) => toBundleFinding(f))
        .some((b) => b.detector === "eslint" && b.tier === 1 && b.category === "security"),
    "the dedup and security mappings that the gates depend on survive the projection",
  );

  process.stdout.write("\n[4] shared seam — bundle finding equals the CLI's toComment projection\n");
  // Same mode as the MCP call above (the tool defaults to "review"), otherwise
  // this compares two different runs rather than two paths to one run.
  const inProcess = await runDetPriors({ diff: FIXTURE_DIFF, repoRoot: REPO, mode: "review" });
  const key = (detector: string, file: string, line: number, tier: number, category: string): string =>
    `${detector}@${file}:${line}:${tier}:${category}`;
  const wireSet = page.findings
    .map((f) => key(f.detector, f.file, f.lineStart, f.tier, f.category))
    .sort();
  const coreSet = inProcess.findings
    .map((f) => key(f.source, f.file, f.line, toComment(f).tier, toComment(f).category))
    .sort();
  // Compare against exactly the prefix the page could hold. Comparing against a
  // silently-truncated slice of the core set would pass even if core found more
  // (round 1 sweep).
  assert(
    wireSet.length <= BUNDLE_LIMITS.findingsPerPage,
    `the page holds no more than one page of findings (${wireSet.length})`,
  );
  assert(
    JSON.stringify(wireSet) ===
      JSON.stringify(coreSet.slice(0, BUNDLE_LIMITS.findingsPerPage).slice(0, wireSet.length)),
    `MCP page content matches a direct core run on the same diff (${wireSet.length} findings)`,
  );
  assert(
    coreSet.length >= wireSet.length,
    "the core run produced at least the findings the page carries",
  );
  const sample = inProcess.findings[0];
  if (sample !== undefined) {
    const viaBundle = toBundleFinding(sample);
    const viaCli = toComment(sample);
    assert(
      JSON.stringify(viaBundle.sources) === JSON.stringify(viaCli.sources),
      "sources[] is passed through from toComment unchanged for the sampled finding",
    );
  }
  // The evidence triple only exists on detectors that cite source text. The
  // fixture's findings are tool citations without one, so exercise the triple
  // path on a synthetic probe rather than claiming the sampled finding covers it.
  const tripleProbe = toBundleFinding({
    source: "leverage",
    file: "src/a.ts",
    line: 7,
    column: 1,
    severity: "warning",
    ruleId: "leverage/structured-clone",
    message: "structuredClone is available natively",
    evidence: { path: "src/a.ts", line: 7, snippet: "const c = structuredClone(x);" },
  });
  assert(
    tripleProbe.sources[0]?.path === "src/a.ts" &&
      tripleProbe.sources[0]?.line === 7 &&
      tripleProbe.sources[0]?.snippet === "const c = structuredClone(x);",
    "an evidence triple reaches sources[] intact on a citing detector",
  );

  process.stdout.write("\n[5] an unavailable runner degrades, it does not error\n");
  assert(first.status === "ok", "a repo with no index still returns status: ok, not an error");
  assert(
    page.degraded.length > 0 && page.degraded.every((d) => d.topic.length > 0),
    "degraded entries are present and structured",
  );
  assert(
    page.degraded.some((d) => d.topic === "context"),
    "the missing index degrades loudly on the context topic",
  );

  process.stdout.write("\n[6] paging by handle — every finding exactly once\n");
  const seen: string[] = page.findings.map((f) => `${f.file}:${f.lineStart}:${f.detector}`);
  let cursor = page.nextOffset;
  let pages = 1;
  while (cursor !== undefined) {
    const next = readEnvelope(
      await client.callTool({
        name: TOOL_NAME_RUN_DET_PRIORS,
        arguments: { request: { target: "page", reviewHandle: page.reviewHandle, offset: cursor } },
      }),
      TOOL_NAME_RUN_DET_PRIORS,
    );
    assert(next.status === "ok", `page ${pages + 1} returns status: ok`);
    const np = next.data as ReviewBundlePage;
    for (const f of np.findings) seen.push(`${f.file}:${f.lineStart}:${f.detector}`);
    // Progress guard: a cursor that does not advance would hang this loop, so
    // assert the offset moved rather than trusting the server to terminate.
    assert(
      np.nextOffset === undefined || np.nextOffset > cursor,
      `page ${pages + 1} advances the cursor (${cursor} -> ${String(np.nextOffset)})`,
    );
    cursor = np.nextOffset;
    pages++;
    assert(pages < 50, "paging terminates instead of looping");
  }
  assert(
    seen.length === page.findingsTotal,
    `following nextOffset yields every finding exactly once (${seen.length} of ${page.findingsTotal} across ${pages} pages)`,
  );
  assert(new Set(seen).size === seen.length, "no finding is delivered on two pages");

  const unknownHandle = readEnvelope(
    await client.callTool({
      name: TOOL_NAME_RUN_DET_PRIORS,
      arguments: { request: { target: "page", reviewHandle: "rb_does_not_exist", offset: 0 } },
    }),
    TOOL_NAME_RUN_DET_PRIORS,
  );
  assert(
    unknownHandle.status === "error" && unknownHandle.reason === "review_expired",
    "an unknown handle degrades to review_expired, not internal_error",
  );
  assert(
    unknownHandle.isError === true,
    "review_expired is isError:true — the page was not delivered (round 0 correction)",
  );
  assert(
    unknownHandle.hint !== undefined &&
      unknownHandle.hint.includes('"request"') &&
      unknownHandle.hint.includes("Start a new review"),
    "the expiry hint states the recovery with an executable request shape",
  );

  process.stdout.write("\n[7] the bound — oversized input still fits, and says what it dropped\n");
  const manyFindings: ToolFinding[] = Array.from({ length: 5_000 }, (_, i) => ({
    source: "eslint" as const,
    file: `src/generated/file-${i}.ts`,
    line: (i % 400) + 1,
    column: 1,
    severity: "warning" as const,
    ruleId: `some-rule/${i}`,
    message: `finding number ${i} with a message long enough to be realistic in size terms`,
    evidence: { path: `src/generated/file-${i}.ts`, line: (i % 400) + 1, snippet: "x".repeat(400) },
  }));
  const oversized: DetPriors = {
    ...inProcess,
    changed: Array.from({ length: 5_000 }, (_, i) => ({
      path: `src/generated/file-${i}.ts`,
      addedLines: Array.from({ length: 200 }, (_, j) => j + 1),
    })),
    changedPaths: [],
    findings: manyFindings,
    degraded: Array.from({ length: 200 }, (_, i) => ({
      kind: "info" as const,
      topic: "noise-filter",
      message: `dropped generated artefact ${i}`,
    })),
    retrievedContext: {
      chunks: Array.from({ length: 400 }, (_, i) => ({
        path: `src/generated/file-${i}.ts`,
        lineStart: 1,
        lineEnd: 40,
        snippet: "y".repeat(2_000),
        reason: "semantic similarity=0.91",
        sourceType: "repo_convention" as const,
      })),
      sameFolderPaths: [],
    },
  };
  const bounded = buildReviewBundlePage(oversized, "rb_synthetic", 0, {
    limit: BUNDLE_LIMITS.findingsPerPage,
  });
  const boundedBytes = Buffer.byteLength(JSON.stringify(bounded, null, 2), "utf8");
  assert(
    boundedBytes <= MAX_TOOL_RESULT_BYTES,
    `5,000 findings / 5,000 files / 400 chunks / 200 degraded serialize to ${boundedBytes} B, under the ${MAX_TOOL_RESULT_BYTES} B cap`,
  );
  const rawBytes = Buffer.byteLength(JSON.stringify(oversized, null, 2), "utf8");
  assert(
    rawBytes > MAX_TOOL_RESULT_BYTES * 10,
    `the unprojected input would be ${rawBytes} B — over 10x the cap, so the bound is doing real work`,
  );
  assert(
    bounded.findings.every((f) => f.sources.length > 0),
    "trimming dropped whole findings, never truncated a citation",
  );
  const omitted = new Map((bounded.omissions ?? []).map((o) => [o.component, o]));
  assert(
    omitted.get("changedFiles")?.omitted === 5_000 - (bounded.changedFiles.length),
    `changedFiles omission matches what was delivered (${bounded.changedFiles.length})`,
  );
  assert(
    omitted.get("findings")?.omitted === 5_000 - bounded.findings.length,
    `findings omission reports the exact shortfall (${omitted.get("findings")?.omitted} of 5,000)`,
  );
  assert(
    omitted.get("contextHandles") !== undefined && omitted.get("degraded") !== undefined,
    "contextHandles and degraded omissions are both reported",
  );

  process.stdout.write("\n[8] REGRESSION — a trimmed page must not skip findings (round 0)\n");
  // Round 0 shipped a page that delivered 25 findings while advertising
  // nextOffset: 50, permanently skipping 25-49. Page the synthetic trimmed page
  // to exhaustion and require complete delivery.
  const walked: string[] = [];
  let walkOffset: number | undefined = 0;
  let walkPages = 0;
  while (walkOffset !== undefined && walkPages < 900) {
    const p = buildReviewBundlePage(oversized, "rb_walk", walkOffset, {
      limit: BUNDLE_LIMITS.findingsPerPage,
    });
    for (const f of p.findings) walked.push(f.id);
    walkOffset = p.nextOffset;
    walkPages++;
  }
  // One assertion for progress: a non-advancing cursor would spin to the 500-hop
  // cap and land here with the wrong count, so a per-iteration assert would only
  // restate it 500 times (round 1 sweep).
  assert(walkPages < 900, `the walk terminated in ${walkPages} pages rather than spinning`);
  assert(
    walked.length === 5_000 && new Set(walked).size === 5_000,
    `paging a byte-trimmed result delivers all 5,000 findings exactly once (got ${walked.length} across ${walkPages} pages)`,
  );

  process.stdout.write("\n[9] REGRESSION — an oversized finding is skipped, not contagious (round 1)\n");
  // Round 1's worst finding: one oversized finding made the whole suffix
  // "unretrievable" and offered no cursor, while two tiny siblings sat at 1.3 KB
  // on the next page. `[oversized, small, small]` must deliver the small pair.
  const hugeMsg = "x".repeat(200_000);
  const mixed: DetPriors = {
    ...inProcess,
    findings: [
      { source: "eslint", file: "src/huge.ts", line: 1, column: 1, severity: "error", ruleId: "huge", message: hugeMsg },
      { source: "eslint", file: "src/b.ts", line: 2, column: 1, severity: "warning", ruleId: "b", message: "small b" },
      { source: "eslint", file: "src/c.ts", line: 3, column: 1, severity: "warning", ruleId: "c", message: "small c" },
    ],
    vulnComments: [],
    changed: [],
  };
  const mixedPage = buildReviewBundlePage(mixed, "rb_mixed", 0, {
    limit: BUNDLE_LIMITS.findingsPerPage,
  });
  assert(
    mixedPage.findings.length >= 1,
    `a huge sibling does not block the small ones (delivered ${mixedPage.findings.length})`,
  );
  assert(
    mixedPage.findings.some((f) => f.file === "src/b.ts") ||
      mixedPage.nextOffset !== undefined,
    "if the small pair is not on page 1, a cursor is still offered",
  );
  // Whatever page 0 does, following the contract to the end must reach b and c.
  const reached = new Set<string>();
  let mo: number | undefined = 0;
  let hops = 0;
  while (mo !== undefined && hops < 20) {
    const p = buildReviewBundlePage(mixed, "rb_mixed", mo, { limit: BUNDLE_LIMITS.findingsPerPage });
    for (const f of p.findings) reached.add(f.file);
    if (p.nextOffset !== undefined) assert(p.nextOffset > mo, `mixed cursor advances (${mo} -> ${p.nextOffset})`);
    mo = p.nextOffset;
    hops++;
  }
  assert(
    reached.has("src/b.ts") && reached.has("src/c.ts"),
    `paging reaches both small findings despite the oversized one (reached ${[...reached].join(", ") || "none"})`,
  );
  assert(
    mixedPage.findingsTotal === 3,
    "findingsTotal reports the truth including the oversized entry",
  );
  const mixedOmission = mixedPage.omissions?.find((o) => o.component === "findings");
  assert(
    mixedOmission === undefined || mixedOmission.unretrievable === undefined || mixedOmission.unretrievable <= 1,
    "at most the one oversized finding is labelled unretrievable, never the recoverable suffix",
  );

  // A lone oversized finding must still not produce a non-progressing cursor.
  const hugeOnly: DetPriors = { ...inProcess, findings: mixed.findings.slice(0, 1), vulnComments: [], changed: [] };
  const hugePage = buildReviewBundlePage(hugeOnly, "rb_huge", 0, { limit: 1 });
  assert(hugePage.findings.length === 0, "an individually oversized finding is not partially returned");
  assert(
    hugePage.nextOffset === undefined || hugePage.nextOffset > 0,
    "the cursor advances past the oversized finding instead of repeating page 0",
  );

  process.stdout.write("\n[9b] REGRESSION — metadata pressure is not an oversized finding (round 1)\n");
  // Round 1: a bulky context locator squeezed out the findings, then the locator
  // itself was trimmed, and the page never restored the findings — 525 B, no
  // findings, all three "unretrievable". The same finding fits in ~919 B without
  // the locator, so it was never unrepresentable.
  const pressured: DetPriors = {
    ...inProcess,
    findings: mixed.findings.slice(1),
    vulnComments: [],
    changed: [],
    retrievedContext: {
      chunks: [
        {
          path: "src/bulky.ts",
          lineStart: 1,
          lineEnd: 40,
          snippet: "z".repeat(60_000),
          reason: "r".repeat(60_000),
          sourceType: "repo_convention",
        },
      ],
      sameFolderPaths: [],
    },
  };
  const pressuredPage = buildReviewBundlePage(pressured, "rb_pressured", 0, {
    limit: BUNDLE_LIMITS.findingsPerPage,
  });
  const pressuredBytes = Buffer.byteLength(JSON.stringify(pressuredPage, null, 2), "utf8");
  assert(
    pressuredBytes <= MAX_TOOL_RESULT_BYTES,
    `a 60 KB context locator still yields a bounded page (${pressuredBytes} B)`,
  );
  assert(
    pressuredPage.findings.length > 0,
    `findings survive metadata pressure rather than being squeezed out (${pressuredPage.findings.length} delivered)`,
  );
  assert(
    pressuredPage.omissions?.find((o) => o.component === "findings")?.unretrievable === undefined,
    "no finding is labelled unretrievable when only the metadata was too large",
  );

  process.stdout.write("\n[10] REGRESSION — vulnerabilities are not dropped (round 0)\n");
  // Round 0's worst finding: `vulnComments` was never read, so a vulnerability
  // result reported findingsTotal: 0 — a silent false-clean on the security class.
  const vulnOnly: DetPriors = {
    ...inProcess,
    findings: [],
    vulnComments: [
      {
        id: "W-smokevuln",
        file: "package.json",
        lineStart: 1,
        lineEnd: 1,
        tier: 1,
        category: "vulnerability",
        kind: "assertion",
        claim: "lodash: prototype pollution",
        explanation: "a real advisory",
        sources: [
          {
            type: "advisory",
            url: "https://osv.dev/vulnerability/GHSA-smoke",
            id: "GHSA-smoke",
            title: "Prototype Pollution",
            retrievedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        confidence: 1,
      },
    ],
  };
  const vulnPage = buildReviewBundlePage(vulnOnly, "rb_vuln", 0);
  assert(vulnPage.findingsTotal === 1, "a vulnerability-only result reports 1 finding, not 0");
  assert(
    vulnPage.findings[0]?.category === "vulnerability" && vulnPage.findings[0]?.tier === 1,
    "the vulnerability comment keeps its category and severity-derived tier",
  );
  assert(
    vulnPage.findings[0]?.detector === "vuln" &&
      vulnPage.findings[0]?.sources.some((s) => s["type"] === "advisory"),
    "the vulnerability comment is labelled and keeps its advisory citation intact",
  );
  assert(
    vulnPage.findingsByCategory["vulnerability"] === 1,
    "vulnerability appears in the category tally",
  );

  process.stdout.write("\n[11] REGRESSION — a failed ref is a failure, not a clean review (round 0)\n");
  const badRef = readEnvelope(
    await client.callTool({
      name: TOOL_NAME_RUN_DET_PRIORS,
      arguments: { request: { target: "base", base: "refs/heads/__warden_no_such_ref__" } },
    }),
    TOOL_NAME_RUN_DET_PRIORS,
  );
  assert(
    badRef.status === "error" && badRef.data === undefined,
    "an unresolvable base ref returns an error envelope, never an empty success",
  );
  assert(badRef.isError === true, "an unresolvable ref is isError:true");
  assert(
    badRef.hint?.includes("Could not resolve the review target") === true,
    "the failure names target resolution rather than reporting zero findings",
  );

  process.stdout.write("\n[11b] an empty diff is a clean review, not an input error (round 1)\n");
  // `git diff` on a clean checkout is "". Round 1's `.min(1)` rejected it, which
  // made an empty literal diff disagree with an empty git-resolved one.
  const emptyDiff = readEnvelope(
    await client.callTool({
      name: TOOL_NAME_RUN_DET_PRIORS,
      arguments: { request: { target: "diff", diff: "", mode: "check" } },
    }),
    TOOL_NAME_RUN_DET_PRIORS,
  );
  assert(
    emptyDiff.status === "ok" && emptyDiff.data !== undefined,
    "an empty literal diff returns status: ok rather than invalid_input",
  );
  const emptyData = emptyDiff.data as ReviewBundlePage;
  assert(
    emptyData.changedFiles.length === 0 && emptyData.changedFilesTotal === 0,
    "an empty diff contributes no changed files (detectors still run repo-wide, so findings may remain)",
  );
  assert(
    emptyData.findingsTotal === emptyData.findings.length,
    "the empty-diff page is internally consistent with its own total",
  );
  assert(emptyData.reviewHandle.startsWith("rb_"), "an empty diff still gets a handle");

  process.stdout.write("\n[12] REGRESSION — the wire schema is the core schema (round 0)\n");
  // Round 0's hand-copied schema accepted a citation carrying only {path, line}.
  // The canonical SourceSchema requires the complete triple, so break a source
  // that actually HAS one — the fixture's tsc finding cites a tool, which has no
  // triple at all, so it cannot demonstrate this.
  const triplePage = {
    ...page,
    findings: [
      {
        id: "W-triple",
        detector: "leverage",
        file: "src/a.ts",
        lineStart: 1,
        lineEnd: 1,
        tier: 2,
        category: "leverage",
        kind: "assertion",
        claim: "structuredClone",
        explanation: "x",
        confidence: 1,
        sources: [
          {
            type: "repo_convention",
            id: "leverage/structured-clone",
            title: "leverage",
            retrievedAt: "2026-01-01T00:00:00.000Z",
            path: "src/a.ts",
            line: 7,
            snippet: "const c = structuredClone(x);",
          },
        ],
      },
    ],
  };
  assert(
    ReviewBundlePageSchema.safeParse(triplePage).success,
    "the bound core schema accepts a complete {path, line, snippet} citation",
  );
  const brokenTriple = structuredClone(triplePage);
  delete (brokenTriple.findings[0]?.sources[0] as Record<string, unknown> | undefined)?.["snippet"];
  assert(
    !ReviewBundlePageSchema.safeParse(brokenTriple).success,
    "the bound core schema rejects a citation whose triple lost its snippet",
  );
  const brokenCategory = structuredClone(triplePage) as unknown as Record<string, unknown>;
  (brokenCategory["findings"] as Array<Record<string, unknown>>)[0]!["category"] =
    "not-a-real-category";
  assert(
    !ReviewBundlePageSchema.safeParse(brokenCategory).success,
    "the bound core schema rejects a category outside CategoryEnum",
  );

  process.stdout.write("\n[13] cache — LRU ordering and boundedness\n");
  const cache = createReviewResultCache(2);
  cache.set("A", inProcess);
  cache.set("B", inProcess);
  cache.get("A");
  cache.set("C", inProcess);
  assert(cache.get("A") !== undefined, "a read promotes the entry (real LRU, not FIFO — round 0)");
  assert(cache.get("B") === undefined, "the genuinely least-recently-used entry was evicted");
  assert(cache.size === 2, "the cache respects its capacity");
  const boundedCache = createReviewResultCache();
  for (let i = 0; i < DEFAULT_REVIEW_CACHE_CAPACITY + 3; i++) {
    boundedCache.set(`rb_fill_${i}`, inProcess);
  }
  assert(
    boundedCache.size === DEFAULT_REVIEW_CACHE_CAPACITY,
    `the default cache is bounded at ${DEFAULT_REVIEW_CACHE_CAPACITY}`,
  );

  assert(protocolErrors.length === 0, "no protocol errors or non-JSON stdout");
  await client.close();
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

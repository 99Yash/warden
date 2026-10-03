/**
 * Slice #40 / ADR-0053 §5(a): `run_det_priors` over real MCP stdio, plus the
 * size bound that the amendment replaced.
 *
 * Two halves, deliberately:
 *
 *  1. **Protocol half** — a real `warden mcp` child against a fixture git repo
 *     with a fixture diff. Asserts discovery, the envelope contract, that
 *     findings carry tier/category/sources, that an unavailable runner degrades
 *     instead of erroring, and that paging works and expires honestly.
 *  2. **Bound half** — a synthetic oversized `DetPriors` fed straight to the
 *     core serializer. The bound cannot be proven against a small fixture, and
 *     a real whole-repo diff is too slow and too machine-specific for a smoke.
 *     This asserts the property that actually matters: the page stays under the
 *     cap no matter how big the input is, and reports every omission.
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
  buildReviewBundlePage,
  computeReviewHandle,
  runDetPriors,
  toBundleFinding,
  toComment,
  type DetPriors,
  type ToolFinding,
} from "@warden/core";
import {
  DEFAULT_REVIEW_CACHE_CAPACITY,
  MAX_TOOL_RESULT_BYTES,
  TOOL_ENVELOPE_VERSION,
  TOOL_NAME_RUN_DET_PRIORS,
  ToolResultEnvelopeSchema,
  createReviewResultCache,
  runRunDetPriors,
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
const DUP_BLOCK = Array.from(
  { length: 12 },
  (_, i) => `  const step${i} = add(input, ${i});`,
).join("\n");

const SHARED_MODULE = ["export function add(a: number, b: number): number {", "  return a + b;", "}", ""].join("\n");

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

function checkEnvelope(result: unknown, tool: string): { status: string; data?: Record<string, unknown> } {
  const parsed = CallToolResultSchema.parse(result);
  const content = parsed.content;
  if (content.length !== 1 || content[0]?.type !== "text") {
    throw new Error(`Expected one JSON text block from ${tool}`);
  }
  const text = content[0].text;
  if (Buffer.byteLength(text, "utf8") > MAX_TOOL_RESULT_BYTES) {
    throw new Error(`${tool} exceeded MAX_TOOL_RESULT_BYTES`);
  }
  const envelope = ToolResultEnvelopeSchema.parse(JSON.parse(text));
  if (envelope.tool !== tool) throw new Error(`Envelope tool mismatch: ${envelope.tool}`);
  if (envelope.envelopeVersion !== TOOL_ENVELOPE_VERSION) throw new Error("Envelope version mismatch");
  return envelope.status === "ok"
    ? { status: envelope.status, data: envelope.data as Record<string, unknown> }
    : { status: envelope.status };
}

try {
  process.stdout.write("\n[1] discovery — both tools advertised\n");
  const client = new Client({ name: "warden-det-priors-smoke", version: "0.0.1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", import.meta.resolve("tsx/esm"), resolve(CLI_ROOT, "src/index.ts"), "mcp"],
    cwd: REPO,
    env: { ...getDefaultEnvironment(), WARDEN_CACHE_PATH: resolve(TMP_ROOT, ".warden/cache.sqlite") },
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
  const props = (det?.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
  assert(props?.["diff"] !== undefined && props?.["base"] !== undefined, "input advertises diff and base");
  assert(props?.["offset"] !== undefined, "input advertises the paging offset");
  assert(
    det?.description?.includes("addedLineCount"),
    "description tells the model changed files carry a count, not line numbers",
  );

  process.stdout.write("\n[2] fixture diff — shape, version, size\n");
  const first = checkEnvelope(
    await client.callTool({ name: TOOL_NAME_RUN_DET_PRIORS, arguments: { diff: FIXTURE_DIFF } }),
    TOOL_NAME_RUN_DET_PRIORS,
  );
  assert(first.status === "ok", "fixture diff returns status: ok");
  const page = first.data as {
    schemaVersion: number;
    reviewHandle: string;
    findings: Array<Record<string, unknown>>;
    findingsTotal: number;
    changedFiles: Array<{ path: string; addedLineCount: number }>;
    changedFilesTotal: number;
    contextHandles: unknown[];
    degraded: Array<{ kind: string; topic: string; message: string }>;
    findingsByCategory: Record<string, number>;
    findingsByTier: Record<string, number>;
    omissions?: Array<{ component: string; total: number; included: number; omitted: number }>;
  };
  assert(page.schemaVersion === REVIEW_BUNDLE_VERSION, "bundle carries its own schema version");
  assert(page.reviewHandle.startsWith("rb_"), "result carries an opaque review handle");
  assert(Array.isArray(page.findings) && Array.isArray(page.changedFiles), "findings and changedFiles present");
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
  const tierTotal = Object.values(page.findingsByTier).reduce((a, b) => a + b, 0);
  assert(
    categoryTotal === page.findingsTotal && tierTotal === page.findingsTotal,
    `findingsByCategory and findingsByTier both total findingsTotal (${categoryTotal}/${tierTotal} vs ${page.findingsTotal})`,
  );

  process.stdout.write("\n[3] findings preserve tier / category / sources\n");
  const tierOk = page.findings.every((f) => f["tier"] === 1 || f["tier"] === 2 || f["tier"] === 3);
  const catOk = page.findings.every((f) => typeof f["category"] === "string" && f["category"].length > 0);
  const srcOk = page.findings.every((f) => Array.isArray(f["sources"]) && (f["sources"] as unknown[]).length > 0);
  assert(page.findings.length === 0 || tierOk, "every finding carries a tier");
  assert(page.findings.length === 0 || catOk, "every finding carries a category");
  assert(page.findings.length === 0 || srcOk, "every finding carries a non-empty sources[]");
  assert(
    page.findings.some((f) => f["detector"] === "tsc" && f["category"] === "correctness"),
    "the deliberate type error surfaces as a tsc finding mapped to correctness",
  );

  // The category/tier mapping is the claim; which detectors happen to fire on a
  // given fixture is not. Exercise every branch of `mapSeverity` directly and
  // require the bundle projection to agree with `toComment` on all of them, so
  // this cannot rot when a detector's fixture behaviour changes.
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
  const mapped = branches.map((f) => {
    const b = toBundleFinding(f);
    return `${b.detector}:${b.tier}:${b.category}`;
  });
  assert(
    new Set(mapped).size === 14,
    `the probe covers all 14 distinct tier/category outcomes (got ${new Set(mapped).size}) — bump this if mapSeverity gains a branch`,
  );
  assert(
    branches.every((f) => {
      const b = toBundleFinding(f);
      const c = toComment(f);
      return b.tier === c.tier && b.category === c.category && b.id === c.id;
    }),
    "every mapSeverity branch projects to the identical tier, category and id as toComment",
  );
  assert(
    mapped.includes("jscpd:3:dedup") &&
      mapped.includes("react-doctor:1:security") &&
      mapped.includes("eslint:1:security"),
    "the security/dedup mappings that the gates depend on survive the projection",
  );

  process.stdout.write("\n[4] shared seam — bundle finding equals the CLI's toComment projection\n");
  // Same mode as the MCP call above (the tool defaults to "review"), otherwise
  // this compares two different runs rather than two paths to one run.
  const inProcess = await runDetPriors({ diff: FIXTURE_DIFF, repoRoot: REPO, mode: "review" });
  // Compared as sets, not sequences: the claim under test is that the two paths
  // agree on *content*, and cross-process ordering is not part of the contract.
  const wireSet = page.findings
    .map((f) => `${f["detector"]}@${f["file"]}:${f["lineStart"]}:${f["tier"]}:${f["category"]}`)
    .sort();
  const coreSet = inProcess.findings
    .map((f) => `${f.source}@${f.file}:${f.line}:${toComment(f).tier}:${toComment(f).category}`)
    .sort();
  assert(
    JSON.stringify(wireSet) === JSON.stringify(coreSet.slice(0, wireSet.length)),
    `MCP page content matches a direct core run on the same diff (${wireSet.length} findings)`,
  );
  const sample = inProcess.findings[0];
  if (sample !== undefined) {
    const viaBundle = toBundleFinding(sample);
    const viaCli = toComment(sample);
    assert(viaBundle.tier === viaCli.tier && viaBundle.category === viaCli.category, "tier and category come from toComment");
    assert(viaBundle.id === viaCli.id, "comment id is shared and content-addressed");
    assert(
      JSON.stringify(viaBundle.sources) === JSON.stringify(viaCli.sources),
      "sources[] is passed through from toComment, evidence triple included",
    );
  }

  process.stdout.write("\n[5] an unavailable runner degrades, it does not error\n");
  assert(first.status === "ok", "a repo with no toolchain still returns status: ok, not an error");
  assert(
    page.degraded.length > 0 && page.degraded.every((d) => typeof d.topic === "string" && d.topic.length > 0),
    "degraded entries are present and structured",
  );
  assert(
    page.degraded.some((d) => d.topic === "context"),
    "the missing index degrades loudly on the context topic",
  );

  process.stdout.write("\n[6] paging — and honest expiry\n");
  const handle = page.reviewHandle;
  // Walk the whole result by following nextOffset, rather than assuming a page
  // size: the fixture's finding count is a property of the detectors, not a
  // number this test should hard-code.
  const seen: string[] = page.findings.map((f) => `${f["file"]}:${f["lineStart"]}`);
  let cursor = (page as { nextOffset?: number }).nextOffset;
  let pages = 1;
  while (cursor !== undefined) {
    const next = checkEnvelope(
      await client.callTool({
        name: TOOL_NAME_RUN_DET_PRIORS,
        arguments: { diff: FIXTURE_DIFF, offset: cursor },
      }),
      TOOL_NAME_RUN_DET_PRIORS,
    );
    assert(next.status === "ok", `page ${pages + 1} returns status: ok`);
    const np = next.data as { findings: Array<Record<string, unknown>>; nextOffset?: number };
    for (const f of np.findings) seen.push(`${f["file"]}:${f["lineStart"]}`);
    cursor = np.nextOffset;
    pages++;
    assert(pages < 50, "paging terminates instead of looping");
  }
  assert(
    seen.length === page.findingsTotal,
    `following nextOffset yields every finding exactly once (${seen.length} of ${page.findingsTotal} across ${pages} pages)`,
  );
  assert(new Set(seen).size === seen.length, "no finding is delivered on two pages");
  const past = checkEnvelope(
    await client.callTool({
      name: TOOL_NAME_RUN_DET_PRIORS,
      arguments: { diff: FIXTURE_DIFF, offset: page.findingsTotal },
    }),
    TOOL_NAME_RUN_DET_PRIORS,
  );
  const pastData = past.data as { findings: unknown[]; nextOffset?: number };
  assert(past.status === "ok" && pastData.findings.length === 0, "an offset at the end is an empty page, not an error");
  assert(pastData.nextOffset === undefined, "the final page omits nextOffset");
  assert(handle === page.reviewHandle, "the handle is stable across pages of the same diff");

  // Eviction: fill the bounded cache past capacity, then ask for the old handle.
  const cache = createReviewResultCache();
  for (let i = 0; i < DEFAULT_REVIEW_CACHE_CAPACITY + 1; i++) {
    cache.set(`rb_filler_${i}`, inProcess);
  }
  cache.set(handle, inProcess);
  for (let i = 0; i < DEFAULT_REVIEW_CACHE_CAPACITY + 1; i++) {
    cache.set(`rb_evict_${i}`, inProcess);
  }
  assert(cache.size === DEFAULT_REVIEW_CACHE_CAPACITY, "the cache is bounded at its capacity");
  assert(cache.get(handle) === undefined, "the oldest handle was evicted");
  const expired = await runRunDetPriors(
    REPO,
    { diff: FIXTURE_DIFF, offset: 0 },
    { cache: createReviewResultCache() },
  );
  assert(
    expired.status === "error" && expired.reason === "review_expired",
    "an unknown handle degrades to review_expired, not internal_error",
  );
  assert(
    expired.hint?.includes("without `offset`"),
    "the expiry hint states the recovery — re-issue without a cursor",
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
      // The pathological case: every file has a long added-line list.
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
  const bounded = buildReviewBundlePage(oversized, "rb_synthetic", 0, { limit: BUNDLE_LIMITS.findingsPerPage });
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
    bounded.findings.length < BUNDLE_LIMITS.findingsPerPage,
    `the byte budget trimmed findings below the count cap (${bounded.findings.length} < ${BUNDLE_LIMITS.findingsPerPage}) — count caps alone were not enough`,
  );
  assert(
    bounded.findings.every((f) => f.sources.length > 0),
    "trimming dropped whole findings, never truncated a citation",
  );
  const omitted = new Map((bounded.omissions ?? []).map((o) => [o.component, o]));
  assert(omitted.get("changedFiles")?.omitted === 5_000 - BUNDLE_LIMITS.changedFiles, "changedFiles omission is reported exactly");
  assert(
    omitted.get("findings")?.omitted === 5_000 - bounded.findings.length,
    `findings omission reports the exact shortfall (${omitted.get("findings")?.omitted} of 5,000)`,
  );
  assert(omitted.get("contextHandles")?.omitted === 400 - BUNDLE_LIMITS.contextHandles, "contextHandles omission is reported exactly");
  assert(omitted.get("degraded")?.omitted === 200 - BUNDLE_LIMITS.degraded, "degraded omission is reported exactly");
  assert(omitted.get("findings")?.cursor !== undefined, "the findings omission carries a cursor to fetch the rest");
  assert(
    (bounded.omissions ?? []).every((o) => o.included + o.omitted === o.total),
    "every omission is internally consistent (included + omitted = total)",
  );

  process.stdout.write("\n[8] a fully-uncapped page reports no omissions; the handle is content-addressed\n");
  // Page size large enough to hold every finding, so nothing is capped and the
  // omissions key must be absent entirely rather than present-and-empty.
  const small = buildReviewBundlePage(
    inProcess,
    "rb_small",
    0,
    { limit: BUNDLE_LIMITS.findingsPerPage },
  );
  assert(
    small.findings.length === inProcess.findings.length && inProcess.findings.length <= BUNDLE_LIMITS.findingsPerPage,
    `the fixture's ${inProcess.findings.length} findings fit on one page, so the uncapped case is reachable`,
  );
  assert(small.omissions === undefined, "an uncapped page omits the omissions key entirely");
  assert(
    computeReviewHandle(REPO, FIXTURE_DIFF) === computeReviewHandle(REPO, FIXTURE_DIFF),
    "the same (repoRoot, diff) yields the same handle",
  );
  assert(
    computeReviewHandle(REPO, FIXTURE_DIFF) !== computeReviewHandle(REPO, `${FIXTURE_DIFF}x`),
    "a different diff yields a different handle",
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

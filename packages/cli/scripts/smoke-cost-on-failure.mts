/**
 * Offline smoke for the spend of a failed review (ADR-0048 amendment
 * 2026-10-20, the cost of a failed review reaches the caller).
 *
 * Before: when the boss loop threw, the harness wrote the known spend to
 * the `review_runs` row and rethrew the raw boss error. The CLI error and
 * the eval sample showed no cost. The eval reports also printed a cost
 * whose `usageUnknownRequests` was set (a lower bound) with no mark.
 *
 * Now `runReviewHarness()` throws `ReviewFailedError`: the boss message,
 * unchanged, with the boss error as `cause` and the known spend on `spend`.
 * The CLI prints the spend after the message, and the eval runner records
 * it as the sample cost. Each eval report place marks a lower bound as `≥`.
 *
 * The smoke runs the real harness against a local HTTP server that speaks
 * the OpenAI Responses API stream (`OPENAI_BASE_URL`). It checks that:
 *   [1] a boss that answers with text and no `submit_review` call fails
 *       the review with `ReviewFailedError`; the spend is exact (no
 *       unknown requests), and it is the same spend as the `review_runs` row;
 *   [2] a boss request that gets HTTP 400 fails the review through
 *       `review()`; the worker spend is known, the boss request is unknown,
 *       so the spend is a lower bound;
 *   [3] the CLI error text keeps `warden: <message>` first and adds the
 *       spend line, with `≥` only for the lower bound;
 *   [4] the eval sample cost, the fixture row, the aggregate, the markdown
 *       report, and the threshold details mark the lower bound, and the
 *       JSON keeps its old fields;
 *   [5] a failed usage read (`spend: undefined`) does not hide the failure.
 *
 * Offline: a local server only. Each other `fetch` (models.dev included)
 * is refused, so the pricing uses the fallback prices. No paid call.
 *
 * Usage: pnpm --filter @warden/cli smoke:cost-on-failure
 */

import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { isRecord } from "@warden/core/guards";
import { z } from "zod";

// ---------------------------------------------------------------------------
// The local OpenAI server.
// ---------------------------------------------------------------------------

const INPUT_TOKENS = 100_000;
const OUTPUT_TOKENS = 10_000;

/** `text`: every request gets a text answer. `boss-400`: a boss request gets HTTP 400. */
let serverMode: "text" | "boss-400" = "text";
let requests = 0;

/** True when the Responses API request body offers the `submit_review` tool. */
function isBossRequest(body: unknown): boolean {
  const tools = isRecord(body) ? body["tools"] : undefined;
  return Array.isArray(tools) && tools.some((t) => isRecord(t) && t["name"] === "submit_review");
}

function modelOf(body: unknown): string {
  return isRecord(body) ? String(body["model"]) : "unknown";
}

/** One finished Responses API stream: a text message and its usage. */
function writeTextStream(res: ServerResponse, model: string): void {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const events = [
    { type: "response.created", response: { id: `resp_${requests}`, created_at: 0, model } },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "message", id: `msg_${requests}` },
    },
    {
      type: "response.output_text.delta",
      item_id: `msg_${requests}`,
      delta: "offline smoke: no review",
    },
    {
      type: "response.completed",
      response: { usage: { input_tokens: INPUT_TOKENS, output_tokens: OUTPUT_TOKENS } },
    },
  ];
  for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`);
  res.end("data: [DONE]\n\n");
}

const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    requests++;
    let body: unknown;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      body = undefined;
    }
    if (serverMode === "boss-400" && isBossRequest(body)) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            message: "offline smoke: boss request refused",
            type: "invalid_request_error",
            param: null,
            code: null,
          },
        }),
      );
      return;
    }
    writeTextStream(res, modelOf(body));
  });
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const address: AddressInfo | string | null = server.address();
// oxlint-disable-next-line anti-slop/no-runtime-typeof -- `server.address()` gives `AddressInfo | string | null`, and a string is a pipe address: the check splits the Node API's own union
const port = typeof address === "object" && address !== null ? address.port : 0;
const LOCAL_ORIGIN = `http://127.0.0.1:${port}`;

// Refuse each fetch that does not go to the local server: no network.
const originalFetch = globalThis.fetch;
let refusedFetches = 0;
globalThis.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  if (!url.startsWith(LOCAL_ORIGIN)) {
    refusedFetches++;
    throw new Error(`offline smoke: fetch refused (${url})`);
  }
  return originalFetch(input, init);
};

// The OpenAI-only path. These must be set before `@warden/ai` reads them.
process.env["OPENAI_API_KEY"] = "offline-smoke";
process.env["OPENAI_BASE_URL"] = `${LOCAL_ORIGIN}/v1`;
delete process.env["ANTHROPIC_API_KEY"];
delete process.env["LANGFUSE_PUBLIC_KEY"];
delete process.env["LANGFUSE_SECRET_KEY"];
// One boss step: the boss gets one request, and it is the submit step.
process.env["WARDEN_REVIEW_BOSS_ROUNDS"] = "1";

const TMP_ROOT = resolve(tmpdir(), `warden-cost-on-failure-${process.pid}`);
const TMP_DB = resolve(tmpdir(), `warden-cost-on-failure-${process.pid}.sqlite`);
process.env["WARDEN_CACHE_PATH"] = TMP_DB;
if (existsSync(TMP_ROOT)) rmSync(TMP_ROOT, { recursive: true, force: true });
mkdirSync(resolve(TMP_ROOT, "src"), { recursive: true });
writeFileSync(
  resolve(TMP_ROOT, "package.json"),
  JSON.stringify({ name: "smoke-fixture", version: "0.0.0", private: true }, null, 2),
);
// More than 10 added lines, so Round 0 dispatches a worker on the file.
const FIXTURE_PATH = "src/totals.ts";
const FIXTURE = [
  "export interface Line {",
  "  price: number;",
  "  quantity: number;",
  "}",
  "",
  "export function total(lines: Line[]): number {",
  "  let sum = 0;",
  "  for (let i = 0; i <= lines.length; i++) {",
  "    const line = lines[i];",
  "    sum += line.price * line.quantity;",
  "  }",
  "  return sum;",
  "}",
  "",
].join("\n");
writeFileSync(resolve(TMP_ROOT, FIXTURE_PATH), FIXTURE);
const ADDED = FIXTURE.split("\n").slice(0, -1);
const DIFF = [
  `diff --git a/${FIXTURE_PATH} b/${FIXTURE_PATH}`,
  "--- /dev/null",
  `+++ b/${FIXTURE_PATH}`,
  `@@ -0,0 +1,${ADDED.length} @@`,
  ...ADDED.map((l) => `+${l}`),
  "",
].join("\n");

function cleanup(): void {
  server.close();
  globalThis.fetch = originalFetch;
  if (existsSync(TMP_DB)) unlinkSync(TMP_DB);
  if (existsSync(TMP_ROOT)) rmSync(TMP_ROOT, { recursive: true, force: true });
}

const { getBossModelInfo } = await import("@warden/ai");
const { db, eq, reviewRuns } = await import("@warden/db");
const { ReviewFailedError, review, runReviewHarness } = await import("@warden/core");
const { formatCliError } = await import("../src/format.js");
const { aggregateScores, checkThreshold, harnessSampleCost, renderMarkdownTable, scoreFixtureRun } =
  await import("./eval/score.mjs");

let failed = 0;
function assert(cond: unknown, msg: string): void {
  if (cond) {
    process.stdout.write(`  ✓ ${msg}\n`);
  } else {
    process.stdout.write(`  ✗ ${msg}\n`);
    failed++;
  }
}

/** The old cost fields of the JSON scorecard, and the new `usageUnknownRequests`. */
const ScorecardCostJsonSchema = z.looseObject({
  totalCost: z.number(),
  usageUnknownRequests: z.number(),
  rows: z
    .array(
      z.looseObject({
        medianCost: z.number(),
        rawSamples: z.array(z.looseObject({ costUsd: z.number() })).min(1),
      }),
    )
    .min(1),
});

/** Remove the ANSI color codes of `picocolors`. */
function plain(text: string): string {
  // oxlint-disable-next-line no-control-regex -- matches the ANSI escape character on purpose.
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

const bossInfo = getBossModelInfo();
process.stdout.write(`\n[0] boss model: ${bossInfo.provider} / ${bossInfo.modelId}\n`);
if (bossInfo.provider !== "openai") {
  process.stdout.write(
    `  ✗ boss provider is ${bossInfo.provider}, not openai. Does a warden env file set ANTHROPIC_API_KEY?\n`,
  );
  cleanup();
  process.exit(1);
}

// ---------------------------------------------------------------------------
// [1] The boss answers with text: the review fails, the spend is exact.
// ---------------------------------------------------------------------------

process.stdout.write("\n[1] the boss submits no review: ReviewFailedError, exact spend\n");
serverMode = "text";
let exactError: unknown;
try {
  await runReviewHarness({
    diff: DIFF,
    repoRoot: TMP_ROOT,
    config: { mode: "review" },
    selector: null,
  });
} catch (err) {
  exactError = err;
}
const exact = exactError instanceof ReviewFailedError ? exactError : undefined;
assert(exact !== undefined, "runReviewHarness() throws ReviewFailedError");
assert(
  exact?.message.startsWith("review-harness boss:") === true,
  `the message is the boss message (${exact?.message.slice(0, 90) ?? "none"})`,
);
assert(
  exact?.cause instanceof Error && exact.cause.message === exact.message,
  "cause is the boss error, with the same message",
);
assert(
  exact?.spend !== undefined && (exact.spend.costUsd ?? 0) > 0,
  `the spend is known and above $0 (got ${exact?.spend?.costUsd ?? "none"})`,
);
assert(
  exact?.spend?.usageUnknownRequests === undefined,
  "no request is unknown, so the spend is exact",
);
assert(
  (exact?.spend?.tokenUsage?.opus?.inputTokens ?? 0) === INPUT_TOKENS,
  "the boss tokens of the failed step are counted",
);
const exactRow =
  exact?.spend !== undefined
    ? db().select().from(reviewRuns).where(eq(reviewRuns.id, exact.spend.runId)).get()
    : undefined;
assert(
  exactRow !== undefined &&
    exactRow.costUsd === exact?.spend?.costUsd &&
    exactRow.usageUnknownRequests === 0 &&
    exactRow.commentsEmitted === 0,
  `the review_runs row holds the same spend (row $${exactRow?.costUsd ?? "none"})`,
);

// ---------------------------------------------------------------------------
// [2] The boss request gets HTTP 400: the spend is a lower bound.
// ---------------------------------------------------------------------------

process.stdout.write("\n[2] the boss request fails: review() throws, the spend is a lower bound\n");
serverMode = "boss-400";
let boundError: unknown;
// The AI SDK logs the HTTP 400 stream error to `console.error`. Keep the
// smoke output short: the assertions below check the error.
const consoleError = console.error;
console.error = () => {};
try {
  await review({ diff: DIFF, repoRoot: TMP_ROOT, config: { mode: "review" }, selector: null });
} catch (err) {
  boundError = err;
} finally {
  console.error = consoleError;
}
const bound = boundError instanceof ReviewFailedError ? boundError : undefined;
assert(bound !== undefined, "review() lets ReviewFailedError through");
assert(
  bound?.message.includes("Gemini fallback skipped (tools required)") === true,
  "the message keeps the text that smokes match on",
);
assert(
  (bound?.spend?.usageUnknownRequests ?? 0) >= 1,
  `the failed boss request is unknown (usageUnknownRequests ${bound?.spend?.usageUnknownRequests ?? "none"})`,
);
assert(
  (bound?.spend?.costUsd ?? 0) > 0 && (bound?.spend?.tokenUsage?.opus?.inputTokens ?? 0) === 0,
  "the worker spend is known, and no boss tokens are invented",
);
const boundRow =
  bound?.spend !== undefined
    ? db().select().from(reviewRuns).where(eq(reviewRuns.id, bound.spend.runId)).get()
    : undefined;
assert(
  boundRow !== undefined &&
    boundRow.usageUnknownRequests === bound?.spend?.usageUnknownRequests &&
    boundRow.costUsd === bound.spend.costUsd,
  "the review_runs row holds the same lower bound",
);

// ---------------------------------------------------------------------------
// [3] The CLI error text.
// ---------------------------------------------------------------------------

process.stdout.write("\n[3] the CLI error text\n");
const exactText = plain(formatCliError(exactError));
const boundText = plain(formatCliError(boundError));
process.stdout.write(`${exactText.replace(/^/gm, "    | ")}\n`);
process.stdout.write(`${boundText.replace(/^/gm, "    | ")}\n`);
const [exactFirst, exactSecond] = exactText.split("\n");
const [boundFirst, boundSecond] = boundText.split("\n");
assert(
  exactFirst === `warden: ${exact?.message ?? ""}`,
  "line 1 is `warden: <message>`, unchanged",
);
assert(
  exactSecond?.startsWith("warden: spent before the failure: $") === true,
  "line 2 gives the exact spend with no ≥",
);
assert(
  exactSecond?.includes(`review run ${exact?.spend?.runId ?? "?"}`) === true,
  "line 2 names the review run",
);
assert(boundFirst === `warden: ${bound?.message ?? ""}`, "lower bound: line 1 is unchanged");
assert(
  boundSecond?.startsWith("warden: spent before the failure: ≥ $") === true &&
    boundSecond.includes("reported no usage"),
  "lower bound: line 2 marks ≥ and counts the unknown requests",
);
assert(
  plain(formatCliError(new Error("plain failure"))) === "warden: plain failure",
  "another error prints one line, as before",
);

// ---------------------------------------------------------------------------
// [4] The eval sample, row, aggregate, and reports.
// ---------------------------------------------------------------------------

process.stdout.write("\n[4] the eval report\n");
const fixture = {
  name: "smoke-fixture",
  category: "synthetic" as const,
  diff: DIFF,
  labels: [],
  expectsEmpty: false,
};
function sample(n: number, cost: ReturnType<typeof harnessSampleCost>) {
  return {
    fixture: fixture.name,
    config: "smoke",
    sample: n,
    commentCount: 0,
    comments: [],
    caughtLabels: [],
    missedLabels: [],
    forbiddenLabels: [],
    unlabeledComments: 0,
    dispatchCount: 0,
    durationMs: 0,
    error: n === 1 ? (bound?.message ?? null) : null,
    costMeasured: true,
    ...cost,
  };
}
const failedCost = harnessSampleCost(bound?.spend);
assert(
  failedCost.costUsd === bound?.spend?.costUsd &&
    failedCost.usageUnknownRequests === bound.spend.usageUnknownRequests,
  `a failed sample records the known spend ($${failedCost.costUsd.toFixed(4)}, ${failedCost.usageUnknownRequests ?? 0} unknown)`,
);
const cleanCost = harnessSampleCost(exact?.spend);
assert(
  !("usageUnknownRequests" in cleanCost),
  "an exact cost adds no usageUnknownRequests key (old JSON shape)",
);
assert(harnessSampleCost(undefined).costUsd === 0, "a throw with no spend is $0, as before");

const row = scoreFixtureRun(fixture, [sample(1, failedCost), sample(2, cleanCost)], "smoke");
const agg = aggregateScores([row], "smoke");
assert(
  row.usageUnknownRequests === failedCost.usageUnknownRequests,
  "the fixture row sums the unknown requests",
);
assert(
  agg.usageUnknownRequests === failedCost.usageUnknownRequests,
  "the aggregate sums the unknown requests",
);
const table = renderMarkdownTable(agg);
process.stdout.write(
  `${table
    .split("\n")
    .filter((l) => l.includes("smoke-fixture") || l.includes("Total cost"))
    .map((l) => `    | ${l}`)
    .join("\n")}\n`,
);
assert(/\| ≥ \d+\.\d{4} \|/.test(table), "the markdown cost cell is marked ≥");
assert(
  table.includes("- Total cost: ≥ $") && table.includes("lower bound:"),
  "the aggregate total is marked ≥ and says why",
);
const verdict = checkThreshold(agg, agg.rows);
const dLine = verdict.details.find((d) => d.startsWith("(d)"));
process.stdout.write(`    | ${dLine ?? "(no (d) line)"}\n`);
assert(dLine?.startsWith("(d) Total cost: ≥ $") === true, "criterion (d) is marked ≥");

const exactAgg = aggregateScores(
  [scoreFixtureRun(fixture, [sample(2, cleanCost)], "smoke")],
  "smoke",
);
assert(
  !renderMarkdownTable(exactAgg).includes("≥"),
  "an exact cost report has no ≥ (the old output)",
);
assert(
  ScorecardCostJsonSchema.safeParse(JSON.parse(JSON.stringify(agg))).success,
  "the JSON keeps totalCost, medianCost, and costUsd, and adds usageUnknownRequests",
);
assert(
  !("usageUnknownRequests" in JSON.parse(JSON.stringify(exactAgg))),
  "an exact aggregate JSON has no new key",
);

// ---------------------------------------------------------------------------
// [5] A failed usage read does not hide the failure.
// ---------------------------------------------------------------------------

process.stdout.write("\n[5] spend: undefined\n");
const noSpend = new ReviewFailedError(new Error("review-harness boss: offline"), undefined);
const noSpendText = plain(formatCliError(noSpend));
assert(
  noSpendText.startsWith("warden: review-harness boss: offline\n") &&
    noSpendText.includes("unknown (the usage could not be read)"),
  "the message comes first, and the spend reads unknown",
);
assert(harnessSampleCost(noSpend.spend).costUsd === 0, "the eval sample cost is $0");

process.stdout.write(`\n  → ${requests} local request(s), ${refusedFetches} refused fetch(es)\n`);
cleanup();
if (failed > 0) {
  process.stdout.write(`\n${failed} assertion(s) failed\n`);
  process.exit(1);
}
process.stdout.write("\nall assertions passed\n");

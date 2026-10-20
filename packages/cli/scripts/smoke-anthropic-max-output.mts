/**
 * Offline smoke for the Anthropic output token limit (ADR-0030 amendment
 * 2026-10-20, Anthropic max output).
 *
 * The bug: `@ai-sdk/anthropic` 3.0.74 did not know `claude-opus-5-5` or
 * `claude-sonnet-5-5`. For an unknown model ID it sends `max_tokens: 4096`
 * and turns off native structured output. Opus 5.5 always uses adaptive
 * thinking, and the thinking tokens count toward `max_tokens`, so a long
 * `submit_review` call was cut off (finishReason `length`). The fix is the
 * SDK upgrade (3.0.134 knows both IDs, 128,000 max output tokens) and a
 * loud failure when a step is cut off.
 *
 * This smoke runs the real `runBossLoop()` and a real worker against a local
 * HTTP server (`ANTHROPIC_BASE_URL`). Nothing is paid. It checks that:
 *   [1] the boss request goes to `claude-opus-5-5` with
 *       `max_tokens: 128000` and `effort: "high"`;
 *   [2] the worker request goes to `claude-sonnet-5-5` with
 *       `max_tokens: 128000` and a native `json_schema` output format;
 *   [3] when the server cuts off the boss `submit_review` input
 *       (`stop_reason: "max_tokens"`), `runBossLoop()` throws, and the
 *       error names the cut-off;
 *   [4] when the server cuts off the worker output, the worker reports
 *       `failed`, and its warning entry names the cut-off.
 *
 * Offline: local server only, no network, no paid call.
 *
 * Usage: pnpm --filter @warden/cli smoke:anthropic-max-output
 */

import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { LlmJsonValue } from "@warden/ai";
import { z } from "zod";

/** `reject`: answer HTTP 400. `cutoff`: stream a response cut off at `max_tokens`. */
let mode: "reject" | "cutoff" = "reject";
const bodies: unknown[] = [];

/** The `model` of a recorded Messages API request body. */
const RequestModelSchema = z.looseObject({ model: z.string() });

/** One Messages API stream event, or a content block or delta in one. */
interface StreamPart {
  type: string;
  [key: string]: LlmJsonValue;
}

function sse(res: ServerResponse, events: readonly StreamPart[]): void {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const e of events) {
    res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  }
  res.end();
}

/**
 * A Messages API stream that stops at `max_tokens` in the middle of one
 * content block. The block has no `content_block_stop`, as in a real
 * cut-off.
 */
function cutoffEvents(model: string, block: StreamPart, delta: StreamPart): StreamPart[] {
  return [
    {
      type: "message_start",
      message: {
        id: "msg_offline",
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 1 },
      },
    },
    { type: "content_block_start", index: 0, content_block: block },
    { type: "content_block_delta", index: 0, delta },
    {
      type: "message_delta",
      delta: { stop_reason: "max_tokens", stop_sequence: null },
      usage: { output_tokens: 128_000 },
    },
    { type: "message_stop" },
  ];
}

const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    let body: unknown;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      body = undefined;
    }
    bodies.push(body);
    const model = RequestModelSchema.safeParse(body).data?.model ?? "unknown";
    if (mode === "reject") {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          type: "error",
          error: { type: "invalid_request_error", message: "offline smoke: request recorded" },
        }),
      );
      return;
    }
    if (model === "claude-opus-5-5") {
      sse(
        res,
        cutoffEvents(
          model,
          { type: "tool_use", id: "toolu_offline", name: "submit_review", input: {} },
          { type: "input_json_delta", partial_json: '{"comments": [{"file": "src/la' },
        ),
      );
      return;
    }
    sse(
      res,
      cutoffEvents(
        model,
        { type: "text", text: "" },
        { type: "text_delta", text: '{"findings": [{"file": "src/la' },
      ),
    );
  });
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const address: AddressInfo | string | null = server.address();
// oxlint-disable-next-line anti-slop/no-runtime-typeof -- `server.address()` gives `AddressInfo | string | null`, and a string is a pipe address: the check splits the Node API's own union
const port = typeof address === "object" && address !== null ? address.port : 0;

// The Anthropic-only path: workers resolve to Anthropic Sonnet only when no
// OpenAI key is set. These must be set before `@warden/ai` reads them.
process.env["ANTHROPIC_API_KEY"] = "offline-smoke";
process.env["ANTHROPIC_BASE_URL"] = `http://127.0.0.1:${port}/v1`;
delete process.env["OPENAI_API_KEY"];
delete process.env["OPENAI_BASE_URL"];
process.env["WARDEN_REVIEW_BOSS_ROUNDS"] = "2";

const TMP_ROOT = resolve(tmpdir(), `warden-anthropic-max-output-${process.pid}`);
const TMP_DB = resolve(tmpdir(), `warden-anthropic-max-output-${process.pid}.sqlite`);
process.env["WARDEN_CACHE_PATH"] = TMP_DB;
if (existsSync(TMP_ROOT)) rmSync(TMP_ROOT, { recursive: true, force: true });
mkdirSync(resolve(TMP_ROOT, "src"), { recursive: true });
writeFileSync(
  resolve(TMP_ROOT, "package.json"),
  JSON.stringify({ name: "smoke-fixture", version: "0.0.0", private: true }, null, 2),
);
const FIXTURE_PATH = "src/last-item.ts";
const FIXTURE = [
  "export function lastItem<T>(arr: T[]): T | undefined {",
  "  return arr[arr.length];",
  "}",
  "",
].join("\n");
writeFileSync(resolve(TMP_ROOT, FIXTURE_PATH), FIXTURE);
const DIFF = [
  `diff --git a/${FIXTURE_PATH} b/${FIXTURE_PATH}`,
  "--- /dev/null",
  `+++ b/${FIXTURE_PATH}`,
  "@@ -0,0 +1,3 @@",
  ...FIXTURE.split("\n")
    .slice(0, 3)
    .map((l) => `+${l}`),
  "",
].join("\n");

function cleanup(): void {
  server.close();
  if (existsSync(TMP_DB)) unlinkSync(TMP_DB);
  if (existsSync(TMP_ROOT)) rmSync(TMP_ROOT, { recursive: true, force: true });
}

const { getBossModelInfo, getWorkerStrongModelInfo } = await import("@warden/ai");
const { isRecord } = await import("@warden/core/guards");
const { runDetPriors } = await import("@warden/core/review-harness/det-priors");
const { runBossLoop } = await import("@warden/core/review-harness/boss-loop");
const { ReviewScratchpad } = await import("@warden/core/review-harness/scratchpad");
const { makeWorkerRoute } = await import("@warden/core/review-harness/workers/dispatch");

let failed = 0;
function assert(cond: unknown, msg: string): void {
  if (cond) {
    process.stdout.write(`  ✓ ${msg}\n`);
  } else {
    process.stdout.write(`  ✗ ${msg}\n`);
    failed++;
  }
}

const CUTOFF_TEXT = 'finishReason "length"';

const bossInfo = getBossModelInfo();
const workerInfo = getWorkerStrongModelInfo();
process.stdout.write(
  `\n[0] boss model: ${bossInfo.provider} / ${bossInfo.modelId}; strong worker: ${workerInfo.provider} / ${workerInfo.modelId}\n`,
);
if (bossInfo.provider !== "anthropic" || workerInfo.provider !== "anthropic") {
  process.stdout.write(
    "  ✗ a role does not resolve to Anthropic. Does a warden env file set OPENAI_API_KEY?\n",
  );
  cleanup();
  process.exit(1);
}

const detPriors = await runDetPriors({
  diff: DIFF,
  repoRoot: TMP_ROOT,
  mode: "review",
  selector: null,
});
const route = makeWorkerRoute({
  repoRoot: TMP_ROOT,
  changed: detPriors.changed,
  apiClaimDegraded: [],
});

async function runBoss(): Promise<Error | undefined> {
  try {
    await runBossLoop({
      repoRoot: TMP_ROOT,
      diff: DIFF,
      detPriors,
      scratchpad: new ReviewScratchpad(),
      route,
      // No Round 0: the first request to the server is the boss request.
      config: { programmaticDispatch: false },
    });
    return undefined;
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}

function runCorrectnessWorker() {
  return route({
    repoRoot: TMP_ROOT,
    files: [FIXTURE_PATH],
    concern: "correctness",
    phase: "plan",
  });
}

process.stdout.write("\n[1] boss request\n");
mode = "reject";
await runBoss();
const bossBody = bodies[0];
process.stdout.write(
  `  → boss: model=${String(isRecord(bossBody) ? bossBody["model"] : undefined)}, max_tokens=${String(isRecord(bossBody) ? bossBody["max_tokens"] : undefined)}\n`,
);
assert(
  isRecord(bossBody) && bossBody["model"] === "claude-opus-5-5",
  "boss request goes to claude-opus-5-5",
);
assert(
  isRecord(bossBody) && bossBody["max_tokens"] === 128_000,
  "boss request sends max_tokens: 128000 (not the unknown-model 4096)",
);
assert(
  isRecord(bossBody) &&
    isRecord(bossBody["output_config"]) &&
    bossBody["output_config"]["effort"] === "high",
  'boss request sends effort: "high"',
);

process.stdout.write("\n[2] worker request\n");
let before = bodies.length;
await runCorrectnessWorker();
const workerBody = bodies[before];
const outputConfig =
  isRecord(workerBody) && isRecord(workerBody["output_config"])
    ? workerBody["output_config"]
    : undefined;
const format = outputConfig !== undefined ? outputConfig["format"] : undefined;
process.stdout.write(
  `  → worker: model=${String(isRecord(workerBody) ? workerBody["model"] : undefined)}, max_tokens=${String(isRecord(workerBody) ? workerBody["max_tokens"] : undefined)}, format=${isRecord(format) ? String(format["type"]) : "none"}\n`,
);
assert(
  isRecord(workerBody) && workerBody["model"] === "claude-sonnet-5-5",
  "worker request goes to claude-sonnet-5-5",
);
assert(
  isRecord(workerBody) && workerBody["max_tokens"] === 128_000,
  "worker request sends max_tokens: 128000",
);
assert(
  isRecord(format) && format["type"] === "json_schema",
  "worker request uses native structured output (output_config.format json_schema)",
);
const toolChoice = isRecord(workerBody) ? workerBody["tool_choice"] : undefined;
assert(
  toolChoice === undefined || (isRecord(toolChoice) && toolChoice["type"] === "auto"),
  "worker request does not force a tool choice (Sonnet 5.5 rejects forced tool use)",
);

process.stdout.write("\n[3] a cut-off boss submit_review fails loudly\n");
mode = "cutoff";
const bossError = await runBoss();
const bossMessage = bossError?.message ?? "no error";
process.stdout.write(`  → ${bossMessage.slice(0, 200)}\n`);
assert(bossError !== undefined, "runBossLoop() throws");
assert(bossMessage.includes(CUTOFF_TEXT), "the boss error names the cut-off");

process.stdout.write("\n[4] a cut-off worker output fails loudly\n");
before = bodies.length;
const worker = await runCorrectnessWorker();
const warning = worker.degraded.find((d) => d.kind === "warning")?.message ?? "no warning";
process.stdout.write(`  → ${warning.slice(0, 200)}\n`);
assert(bodies.length > before, "the worker called the server");
assert(worker.failed === true, "the worker reports failed");
assert(worker.findings.length === 0, "the worker reports no findings");
assert(warning.includes(CUTOFF_TEXT), "the worker warning names the cut-off");

cleanup();
if (failed > 0) {
  process.stdout.write(`\n${failed} assertion(s) failed\n`);
  process.exit(1);
}
process.stdout.write("\nall assertions passed\n");

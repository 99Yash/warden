/**
 * Offline smoke for the OpenAI tool `strict` default (ADR-0030 amendment
 * 2026-10-20, OpenAI tool strict).
 *
 * The bug: on OpenAI the review boss (`gpt-6.1-sol`) called `submit_review`
 * with `url: ""` in each source, and `SourceSchema` rejected it. The cause is
 * the request, not the model: the AI SDK omits `strict` from a function tool
 * unless the tool sets it, and the OpenAI Responses API then makes the tool
 * strict. In strict mode the model must write every property, optional ones
 * too. Constrained decoding then makes the model write `""` again on each
 * retry, so the boss cannot recover. The fix is `OPENAI_NON_STRICT_TOOLS` in
 * `packages/ai/src/models.ts`: each OpenAI function tool is sent with
 * `strict: false`.
 *
 * This smoke runs the real `runBossLoop()` and a real worker against a local
 * HTTP server (`OPENAI_BASE_URL`). The server records each request body and
 * returns HTTP 400, so no model runs and nothing is paid. It checks that:
 *   [1] the boss request goes to the OpenAI boss model, and each tool whose
 *       input has an optional property is sent with `strict: false`;
 *   [2] the worker request does the same for its tools, and its response
 *       format stays non-strict (issue #29);
 *   [3] the failed provider call stays loud: `runBossLoop()` throws, and
 *       the worker reports `failed`.
 *
 * Offline: local server only, no network, no paid call.
 *
 * Usage: pnpm --filter @warden/cli smoke:openai-tool-strict
 */

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const bodies: unknown[] = [];
const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    try {
      bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    } catch {
      bodies.push(undefined);
    }
    res.writeHead(400, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        error: {
          message: "offline smoke: request recorded",
          type: "invalid_request_error",
          param: null,
          code: null,
        },
      }),
    );
  });
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const address: AddressInfo | string | null = server.address();
// oxlint-disable-next-line anti-slop/no-runtime-typeof -- `server.address()` gives `AddressInfo | string | null`, and a string is a pipe address: the check splits the Node API's own union
const port = typeof address === "object" && address !== null ? address.port : 0;

// The OpenAI-only path: the boss resolves to OpenAI only when no Anthropic
// key is set. These must be set before `@warden/ai` reads them.
process.env["OPENAI_API_KEY"] = "offline-smoke";
process.env["OPENAI_BASE_URL"] = `http://127.0.0.1:${port}/v1`;
delete process.env["ANTHROPIC_API_KEY"];
process.env["WARDEN_REVIEW_BOSS_ROUNDS"] = "2";

const TMP_ROOT = resolve(tmpdir(), `warden-openai-tool-strict-${process.pid}`);
const TMP_DB = resolve(tmpdir(), `warden-openai-tool-strict-${process.pid}.sqlite`);
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

const { getBossModelInfo } = await import("@warden/ai");
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

/** True when some object in the JSON schema has a property that is not in its `required`. */
function hasOptionalProperty(schema: unknown): boolean {
  if (Array.isArray(schema)) return schema.some(hasOptionalProperty);
  if (!isRecord(schema)) return false;
  const props = schema["properties"];
  if (isRecord(props)) {
    const required = Array.isArray(schema["required"]) ? schema["required"] : [];
    if (Object.keys(props).some((k) => !required.includes(k))) return true;
  }
  return Object.values(schema).some(hasOptionalProperty);
}

interface SentTool {
  name: string;
  strict: unknown;
  optional: boolean;
}

/** The function tools of one recorded Responses API request body. */
function sentTools(body: unknown): SentTool[] {
  if (!isRecord(body) || !Array.isArray(body["tools"])) return [];
  return body["tools"].filter(isRecord).map((t) => ({
    name: String(t["name"]),
    strict: t["strict"],
    optional: hasOptionalProperty(t["parameters"]),
  }));
}

function checkTools(label: string, body: unknown, expected: readonly string[]): void {
  const tools = sentTools(body);
  const names = tools.map((t) => t.name);
  process.stdout.write(
    `  → ${label} tools: ${tools.map((t) => `${t.name}(strict=${String(t.strict)}, optional=${t.optional})`).join(", ")}\n`,
  );
  for (const name of expected) {
    assert(names.includes(name), `${label} request offers ${name}`);
  }
  for (const t of tools) {
    if (t.optional) {
      assert(
        t.strict === false,
        `${label}: ${t.name} has an optional input field, so it is sent with strict: false`,
      );
    }
  }
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

process.stdout.write("\n[1] boss request\n");
let bossError: unknown;
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
} catch (err) {
  bossError = err;
}
const bossBody = bodies[0];
assert(
  isRecord(bossBody) && bossBody["model"] === "gpt-6.1-sol",
  "boss request goes to gpt-6.1-sol",
);
checkTools("boss", bossBody, ["submit_review", "dispatch_worker"]);

process.stdout.write("\n[2] worker request\n");
const before = bodies.length;
const worker = await route({
  repoRoot: TMP_ROOT,
  files: [FIXTURE_PATH],
  concern: "correctness",
  phase: "plan",
});
const workerBody = bodies[before];
checkTools("worker", workerBody, ["readFile", "grepRepo"]);
const format =
  isRecord(workerBody) && isRecord(workerBody["text"]) ? workerBody["text"]["format"] : undefined;
assert(
  isRecord(format) && format["strict"] === false,
  "worker response format stays strict: false (issue #29)",
);

process.stdout.write("\n[3] a failed provider call stays loud\n");
assert(
  bossError instanceof Error,
  `runBossLoop() throws (${bossError instanceof Error ? bossError.message.slice(0, 80) : "no error"})`,
);
assert(worker.failed === true, "the worker reports failed");

cleanup();
if (failed > 0) {
  process.stdout.write(`\n${failed} assertion(s) failed\n`);
  process.exit(1);
}
process.stdout.write("\nall assertions passed\n");

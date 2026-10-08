import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  deriveLaneScope,
  isNotClean,
  resolveDiff,
  runPostPass,
  type DegradedEntry,
  type LaneOutput,
} from "@warden/core";
import { DOWN_LANE_SPEC } from "./materialize.js";
import { formatCommentSet } from "../format.js";

/**
 * Slice #42 / ADR-0053 §4: the driver that enforces the publication rule.
 * Runs the down lane in OpenCode, reads its submission from the event
 * stream, builds the trusted lane envelope (lane/status/reason/scope are
 * driver-owned — never model text), and publishes only the `runPostPass`
 * `CommentSet`. Deterministic except for the spawned process; no warden
 * provider key needed.
 *
 * The parser and the command builder are exported pure functions so the
 * smoke can test them without OpenCode.
 */

export const OPENCODE_AGENT_ENV = "OPENCODE_CONFIG";
export const OPENCODE_PROJECT_DISABLE_ENV = "OPENCODE_DISABLE_PROJECT_CONFIG";
export const OPENCODE_CONTENT_ENV = "OPENCODE_CONFIG_CONTENT";
export const OPENCODE_PASSWORD_ENV = "OPENCODE_PASSWORD";
export const DEFAULT_LANE_TIMEOUT_SECS = 900;
/** Bounded wait for the warden MCP server to connect (covers serve boot). */
export const DEFAULT_MCP_TIMEOUT_SECS = 30;
export const MCP_POLL_INTERVAL_MS = 500;
/**
 * Settle delay after `connected` before spawning `run`: a late server fires
 * `mcp.tools.changed` and the tools register after short debounces, so the
 * session snapshot of an immediate run still misses them (operator
 * amendment 2026-10-08; `mcp.tools.changed` is visible in oc25.strings).
 */
export const MCP_SETTLE_MS = 1000;
/** Bounded stderr tail kept for failed-lane diagnostics. */
export const STDERR_TAIL_BYTES = 2048;
/** Grace between SIGTERM and SIGKILL when stopping the serve child. */
const SERVE_KILL_GRACE_MS = 2000;

export interface OpencodeCommand {
  /** Binary to spawn (`opencode` on PATH, or a fake in the smoke). */
  bin: string;
  argv: string[];
}

/**
 * `opencode run` never applies `agent.model` — the driver always passes
 * `--model`. No `--auto`: an unexpected ask must fail closed. No
 * `--standalone`: the run attaches to the driver's warmed `serve` instance
 * (see below) so the warden MCP tools are already connected.
 */
export function buildOpencodeCommand(opts: {
  bin?: string;
  serverUrl: string;
  model: string;
  message: string;
}): OpencodeCommand {
  return {
    bin: opts.bin ?? "opencode",
    argv: [
      "run",
      "--server",
      opts.serverUrl,
      "--agent",
      DOWN_LANE_SPEC.agentId,
      "--model",
      opts.model,
      "--format",
      "json",
      opts.message,
    ],
  };
}

/** The driver's private server. Flags verified against `opencode serve --help` (v2.0.25). */
export function buildOpencodeServeCommand(opts: { bin?: string; port: number }): OpencodeCommand {
  return {
    bin: opts.bin ?? "opencode",
    argv: ["serve", "--hostname", "127.0.0.1", "--port", String(opts.port)],
  };
}

/** A free loopback port from the OS (listen on 0, read, close). */
export function allocFreePort(): Promise<number> {
  return new Promise((resolveP, rejectP) => {
    const server = createServer();
    server.once("error", rejectP);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address !== null && typeof address === "object") resolveP(address.port);
        else rejectP(new Error("opencode-review: could not allocate a free port"));
      });
    });
  });
}

function randomPassword(): string {
  return randomBytes(32).toString("base64url");
}

/** The user message names the base ref and defers to the system prompt. */
export function buildLaneMessage(baseRef: string): string {
  return (
    `Review the changes against base ${baseRef} following your system prompt. ` +
    `Call warden_run_det_priors first with {request:{target:"base",base:"${baseRef}"}} and follow nextOffset pages. ` +
    `End your final message with exactly one fenced \`\`\`json block holding {"findings":[...]}.`
  );
}

const DIR = dirname(fileURLToPath(import.meta.url));

/** Absolute path of the lane's committed `opencode.json`, dev and dist aware. */
export function resolveLaneConfigPath(): string {
  const dev = resolve(DIR, "../../opencode/opencode.json");
  if (existsSync(dev)) return dev;
  // Bundled: tsdown copies `opencode/` to `dist/opencode/` (see
  // `packages/cli/tsdown.config.ts`), next to the bundled entry.
  return resolve(DIR, "opencode/opencode.json");
}

/** Absolute path of this warden install's CLI entry (dev source or bundled dist). */
export function resolveCliEntry(): string {
  const dev = resolve(DIR, "../index.ts");
  if (existsSync(dev)) return dev;
  const argvEntry = process.argv[1];
  if (argvEntry !== undefined) return resolve(argvEntry);
  throw new Error("opencode-review: cannot resolve the warden CLI entry");
}

/**
 * The dev workspace runs `node --import tsx/esm src/index.ts`, and a bare
 * `tsx/esm` specifier does not resolve from the reviewed repo's cwd — so
 * `--import` values are resolved to absolute paths here.
 */
export function resolveLoaderFlags(execArgv: string[] = process.execArgv): string[] {
  const out: string[] = [];
  for (let i = 0; i < execArgv.length; i++) {
    const arg = execArgv[i] as string;
    if (arg === "--import" && i + 1 < execArgv.length) {
      out.push("--import", resolveImportSpecifier(execArgv[i + 1] as string));
      i += 1;
    } else if (arg.startsWith("--import=")) {
      out.push(`--import=${resolveImportSpecifier(arg.slice("--import=".length))}`);
    } else {
      out.push(arg);
    }
  }
  return out;
}

function resolveImportSpecifier(spec: string): string {
  if (spec.startsWith(".") || spec.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(spec)) {
    return resolve(spec);
  }
  try {
    return fileURLToPath(import.meta.resolve(spec));
  } catch {
    return spec;
  }
}

/** Command that launches *this* warden install's MCP server from any cwd. */
export function resolveWardenMcpCommand(): string[] {
  return [process.execPath, ...resolveLoaderFlags(), resolveCliEntry(), "mcp"];
}

/**
 * `OPENCODE_CONFIG_CONTENT` carries the full warden server object, not just
 * the command/cwd delta: the host resolves config per top-level key (last
 * document defining the key wins the whole key — `latest()` in
 * `core/src/config.ts`), so a partial `{mcp:…}` override would replace the
 * committed `mcp` object and drop `type`/`codemode`, and the server entry
 * would fail validation and never register. Values mirror the committed
 * `opencode.json`; only command/cwd vary per install.
 */
export function buildMcpConfigContent(opts: { command: string[]; cwd: string }): string {
  return JSON.stringify({
    mcp: {
      servers: {
        warden: { type: "local", command: opts.command, cwd: opts.cwd, codemode: false },
      },
    },
  });
}

export interface LaneProcessResult {
  exitCode: number;
  stdout: string;
  timedOut: boolean;
  /** Bounded tail of stderr, for failed-lane diagnostics. */
  stderrTail?: string;
}

export interface ToolCallCount {
  name: string;
  completed: number;
}

export interface ParsedLane {
  /** Assistant `text` parts in stream order. */
  texts: string[];
  toolCalls: ToolCallCount[];
  errors: string[];
}

/** Parses `opencode run --format json` JSONL. Unknown lines are skipped — the stream is host-owned, not schema-bound. */
export function parseLaneEvents(stdout: string): ParsedLane {
  const texts: string[] = [];
  const completedByTool = new Map<string, number>();
  const seenByTool = new Map<string, number>();
  const errors: string[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof event !== "object" || event === null) continue;
    const record = event as Record<string, unknown>;
    if (record["type"] === "text") {
      const text = (record["part"] as Record<string, unknown> | undefined)?.["text"];
      if (typeof text === "string" && text.trim() !== "") texts.push(text);
    } else if (record["type"] === "tool_use") {
      const part = record["part"] as Record<string, unknown> | undefined;
      // Wire shape is `part.tool` (verified against a live `--format json`
      // stream); `part.name` is accepted as a fallback for forward tolerance.
      const name = part?.["tool"] ?? part?.["name"];
      if (typeof name !== "string" || name === "") continue;
      seenByTool.set(name, (seenByTool.get(name) ?? 0) + 1);
      const status = (part?.["state"] as Record<string, unknown> | undefined)?.["status"];
      if (status === "completed") {
        completedByTool.set(name, (completedByTool.get(name) ?? 0) + 1);
      }
    } else if (record["type"] === "error") {
      const message = (record["error"] as Record<string, unknown> | undefined)?.["message"];
      errors.push(typeof message === "string" && message !== "" ? message : "unknown error event");
    }
  }
  const toolCalls: ToolCallCount[] = [...seenByTool.keys()].map((name) => ({
    name,
    completed: completedByTool.get(name) ?? 0,
  }));
  toolCalls.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { texts, toolCalls, errors };
}

export interface LaneVerdict {
  status: "ok" | "failed";
  reason?: string;
  /** Model-owned; passed to `runPostPass` unvalidated beyond "is an array". */
  findings: unknown[];
  toolCalls: ToolCallCount[];
}

/** Last ` ```json ` fenced block wins. Anything unparseable fails with a distinct reason. */
export function evaluateLane(parsed: ParsedLane, process: LaneProcessResult): LaneVerdict {
  const toolCalls = parsed.toolCalls;
  const detPriorsCompleted =
    toolCalls.find((t) => t.name === "warden_run_det_priors")?.completed ?? 0;
  const fail = (reason: string, findings: unknown[] = []): LaneVerdict => ({
    status: "failed",
    reason,
    findings,
    toolCalls,
  });
  if (process.timedOut) return fail(withTail("opencode run timed out", process.stderrTail));
  if (process.exitCode !== 0)
    return fail(withTail(`opencode run exited ${process.exitCode}`, process.stderrTail));
  if (parsed.errors.length > 0)
    return fail(withTail(`opencode run error event: ${parsed.errors[0]}`, process.stderrTail));
  const text = parsed.texts.join("\n");
  const block = lastJsonBlock(text);
  if (block === undefined) return fail("no fenced json submission in the final message");
  let submission: unknown;
  try {
    submission = JSON.parse(block);
  } catch {
    return fail("submission is not valid JSON");
  }
  if (
    typeof submission !== "object" ||
    submission === null ||
    !Array.isArray((submission as Record<string, unknown>)["findings"])
  ) {
    return fail('submission has no "findings" array');
  }
  const findings = (submission as Record<string, unknown>)["findings"] as unknown[];
  // A lane that never saw the review target is not a clean lane — this is
  // what catches a broken MCP server command (the agent may still submit
  // `[]` and the run would otherwise look clean).
  if (detPriorsCompleted === 0) {
    return {
      status: "failed",
      reason: "no completed warden_run_det_priors call",
      findings,
      toolCalls,
    };
  }
  return { status: "ok", findings, toolCalls };
}

function lastJsonBlock(text: string): string | undefined {
  const matches = [...text.matchAll(/```json\s*\n([\s\S]*?)```/g)];
  if (matches.length === 0) return undefined;
  return matches[matches.length - 1]?.[1]?.trim();
}

function withTail(reason: string, tail: string | undefined): string {
  if (tail === undefined || tail === "") return reason;
  return `${reason} (stderr: ${tail})`;
}

export interface McpServerState {
  name: string;
  /** Raw `status.status` value (`connected`, `pending`, `failed`, …). */
  status: string;
  error?: string;
}

/**
 * The `/api/mcp` response is untrusted JSON: validate at this boundary.
 * Shape (verified live against v2.0.25): `{location:{…}, data:[{name,
 * status:{status, error?}}]}`. Returns `undefined` when the shape is wrong.
 */
export function parseMcpServers(body: unknown): McpServerState[] | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const data = (body as Record<string, unknown>)["data"];
  if (!Array.isArray(data)) return undefined;
  const out: McpServerState[] = [];
  for (const entry of data) {
    if (typeof entry !== "object" || entry === null) return undefined;
    const record = entry as Record<string, unknown>;
    if (typeof record["name"] !== "string") return undefined;
    const status = record["status"];
    if (typeof status !== "object" || status === null) return undefined;
    const state = (status as Record<string, unknown>)["status"];
    if (typeof state !== "string") return undefined;
    const error = (status as Record<string, unknown>)["error"];
    out.push({
      name: record["name"],
      status: state,
      ...(typeof error === "string" ? { error } : {}),
    });
  }
  return out;
}

export type WardenMcpReadiness =
  | { state: "connected" }
  | { state: "failed"; detail: string }
  | { state: "pending"; detail: string };

/** Only the warden server gates the lane; other servers (e.g. the user's global config) are ignored. */
export function wardenMcpReadiness(servers: McpServerState[] | undefined): WardenMcpReadiness {
  if (servers === undefined) return { state: "pending", detail: "unparseable /api/mcp response" };
  const warden = servers.find((s) => s.name === "warden");
  if (warden === undefined) return { state: "pending", detail: "warden server not listed yet" };
  if (warden.status === "connected") return { state: "connected" };
  if (warden.status === "failed") {
    return {
      state: "failed",
      detail: `warden MCP server failed${warden.error !== undefined ? `: ${warden.error}` : ""}`,
    };
  }
  return { state: "pending", detail: `warden MCP status: ${warden.status}` };
}

/**
 * Poll `GET <baseUrl>/api/mcp` until the warden server shows `connected`.
 * This call also boots the location, so a cold serve reports pending
 * entries first. Connection refusals mean the serve child is still
 * starting and are treated as pending until the timeout.
 *
 * Deviation from the item text: the query is `location[directory]=<dir>`
 * (deepObject `LocationQuery`), not `?directory=<dir>` — the binary
 * ignores a bare `directory` param and answers with the serve cwd
 * (verified live against v2.0.25).
 */
export async function waitForWardenMcp(opts: {
  baseUrl: string;
  password: string;
  directory: string;
  timeoutMs: number;
  pollMs?: number;
}): Promise<void> {
  const pollMs = opts.pollMs ?? MCP_POLL_INTERVAL_MS;
  const deadline = Date.now() + opts.timeoutMs;
  const url = new URL("/api/mcp", opts.baseUrl);
  // `URLSearchParams` percent-encodes the brackets; the host decodes them.
  url.searchParams.set("location[directory]", opts.directory);
  const auth = `Basic ${Buffer.from(`opencode:${opts.password}`, "utf8").toString("base64")}`;
  let lastDetail = "no poll completed yet";
  for (;;) {
    let readiness: WardenMcpReadiness;
    try {
      const res = await fetch(url, { headers: { Authorization: auth } });
      if (res.status === 401 || res.status === 403) {
        throw new Error(`MCP poll rejected (HTTP ${res.status}): password mismatch`);
      }
      if (!res.ok) {
        readiness = { state: "pending", detail: `HTTP ${res.status}` };
      } else {
        readiness = wardenMcpReadiness(parseMcpServers(await res.json()));
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("MCP poll rejected")) throw err;
      readiness = { state: "pending", detail: "serve not reachable yet" };
    }
    if (readiness.state === "connected") return;
    if (readiness.state === "failed") throw new Error(readiness.detail);
    lastDetail = readiness.state === "pending" ? readiness.detail : lastDetail;
    if (Date.now() >= deadline) {
      const secs = Math.round(opts.timeoutMs / 1000);
      throw new Error(`warden MCP server not connected within ${secs}s (last: ${lastDetail})`);
    }
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveP) => setTimeout(resolveP, ms));
}

export interface DriveOptions {
  repoRoot: string;
  baseRef?: string;
  model?: string;
  json?: boolean;
  verbose?: boolean;
  volumeCap?: number;
  lanesOut?: string;
  timeoutSecs?: number;
  /** Bounded wait for the warden MCP server (default 30 s). */
  mcpTimeoutSecs?: number;
  /** Settle delay after `connected` (default 1 s). */
  mcpSettleMs?: number;
  /** Override for the smoke's fake executable. */
  opencodeBin?: string;
}

/**
 * The driven path: resolve the diff exactly like `warden post-pass`,
 * spawn the lane, build the trusted envelope, and publish only the
 * post-pass `CommentSet`.
 */
export async function runOpencodeReview(opts: DriveOptions): Promise<void> {
  const resolved = await resolveDiff({
    repoRoot: opts.repoRoot,
    mode: "review",
    baseRef: opts.baseRef,
  });
  const scope = deriveLaneScope(resolved.diff);
  const verbose = opts.verbose === true;
  const timeoutSecs = opts.timeoutSecs ?? DEFAULT_LANE_TIMEOUT_SECS;

  const publish = async (lanes: LaneOutput[], extraDegraded: DegradedEntry[]): Promise<void> => {
    const result = await runPostPass({
      repoRoot: opts.repoRoot,
      diff: resolved.diff,
      lanes,
      config: {
        verbose,
        ...(opts.volumeCap !== undefined ? { volumeCap: opts.volumeCap } : {}),
      },
      ...(extraDegraded.length > 0 ? { extraDegraded } : {}),
    });
    if (isNotClean(result)) process.exitCode = 1;
    if (opts.json === true) {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      return;
    }
    process.stdout.write("\n" + formatCommentSet(result, "review", verbose) + "\n");
  };

  // Empty scope: do not spawn OpenCode — the lane is failed so the
  // existing fail-closed entries fire (plus the post-pass diff-source
  // entry on the empty diff).
  if (scope.length === 0) {
    const lanes: LaneOutput[] = [
      {
        lane: DOWN_LANE_SPEC.lane,
        status: "failed",
        reason: "empty review target",
        scope,
        findings: [],
      },
    ];
    if (opts.lanesOut !== undefined) {
      writeFileSync(
        resolve(opts.repoRoot, opts.lanesOut),
        JSON.stringify({ version: 1, lanes }, null, 2) + "\n",
      );
    }
    await publish(lanes, [...(resolved.degraded ?? [])]);
    return;
  }

  const baseRef = resolved.baseRef ?? opts.baseRef ?? "HEAD";
  const model = opts.model ?? DOWN_LANE_SPEC.defaultModel;
  const mcpTimeoutMs = (opts.mcpTimeoutSecs ?? DEFAULT_MCP_TIMEOUT_SECS) * 1000;
  const settleMs = opts.mcpSettleMs ?? MCP_SETTLE_MS;
  const configPath = resolveLaneConfigPath();
  // The serve child reads this env password for its API auth
  // (`server-process.ts`: `Env.password`, else a random fallback the run
  // client could never know); the run client sends it back as Basic
  // `opencode:<password>` (`server-connection.ts`), so both children share
  // it. It never leaves loopback.
  const password = randomPassword();
  const childEnv: Record<string, string | undefined> = {
    ...process.env,
    [OPENCODE_AGENT_ENV]: configPath,
    [OPENCODE_PROJECT_DISABLE_ENV]: "1",
    [OPENCODE_CONTENT_ENV]: buildMcpConfigContent({
      command: resolveWardenMcpCommand(),
      cwd: opts.repoRoot,
    }),
    [OPENCODE_PASSWORD_ENV]: password,
  };

  // Warm-server sequence (operator amendment 2026-10-08): the shipped
  // binary snapshots session tools before slow MCP servers connect, so a
  // cold `run --standalone` never sees `warden_run_det_priors`. Serve
  // first, wait for the warden server to connect, settle past the
  // `mcp.tools.changed` debounces, then run against the warm server.
  const port = await allocFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const serveCommand = buildOpencodeServeCommand({
    port,
    ...(opts.opencodeBin !== undefined ? { bin: opts.opencodeBin } : {}),
  });
  const serve = spawn(serveCommand.bin, serveCommand.argv, {
    cwd: opts.repoRoot,
    env: childEnv,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let serveStderr = "";
  serve.stderr?.on("data", (d: Buffer) => {
    serveStderr += d.toString();
    if (serveStderr.length > STDERR_TAIL_BYTES) serveStderr = serveStderr.slice(-STDERR_TAIL_BYTES);
  });
  // A leaked `opencode serve` is a bug: the child dies on every path below.
  try {
    try {
      await waitForWardenMcp({
        baseUrl,
        password,
        directory: opts.repoRoot,
        timeoutMs: mcpTimeoutMs,
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return await publishFailed(
        `mcp not ready: ${detail}${tailSuffix(serveStderr)}`,
        opts,
        resolved,
        scope,
        verbose,
      );
    }
    await sleep(settleMs);

    const command = buildOpencodeCommand({
      serverUrl: baseUrl,
      model,
      message: buildLaneMessage(baseRef),
      ...(opts.opencodeBin !== undefined ? { bin: opts.opencodeBin } : {}),
    });
    const processResult = await spawnLane(command, opts.repoRoot, childEnv, timeoutSecs);
    await publishVerdict(processResult, opts, resolved, scope, verbose);
  } finally {
    await killServe(serve);
  }
}

type ResolvedDiff = Awaited<ReturnType<typeof resolveDiff>>;

async function publishLanes(
  opts: DriveOptions,
  resolved: ResolvedDiff,
  verbose: boolean,
  lanes: LaneOutput[],
  extraDegraded: DegradedEntry[],
): Promise<void> {
  const result = await runPostPass({
    repoRoot: opts.repoRoot,
    diff: resolved.diff,
    lanes,
    config: {
      verbose,
      ...(opts.volumeCap !== undefined ? { volumeCap: opts.volumeCap } : {}),
    },
    ...(extraDegraded.length > 0 ? { extraDegraded } : {}),
  });
  if (isNotClean(result)) process.exitCode = 1;
  if (opts.json === true) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }
  process.stdout.write("\n" + formatCommentSet(result, "review", verbose) + "\n");
}

function writeLanesOut(opts: DriveOptions, lanes: LaneOutput[]): void {
  if (opts.lanesOut !== undefined) {
    writeFileSync(
      resolve(opts.repoRoot, opts.lanesOut),
      JSON.stringify({ version: 1, lanes }, null, 2) + "\n",
    );
  }
}

function laneTraceEntry(
  status: string,
  reason: string | undefined,
  toolCalls: string,
): DegradedEntry {
  return {
    kind: "info",
    topic: "lane-trace",
    message: `lane-trace: down ${status}${reason !== undefined ? ` (${reason})` : ""} — ${toolCalls === "" ? "no tool calls" : toolCalls}`,
  };
}

/** MCP-warmup failure: no run happened, so there are no tool calls to trace. */
async function publishFailed(
  reason: string,
  opts: DriveOptions,
  resolved: ResolvedDiff,
  scope: string[],
  verbose: boolean,
): Promise<void> {
  const lanes: LaneOutput[] = [
    { lane: DOWN_LANE_SPEC.lane, status: "failed", reason, scope, findings: [] },
  ];
  writeLanesOut(opts, lanes);
  await publishLanes(opts, resolved, verbose, lanes, [
    ...(resolved.degraded ?? []),
    laneTraceEntry("failed", reason, ""),
  ]);
}

async function publishVerdict(
  processResult: LaneProcessResult,
  opts: DriveOptions,
  resolved: ResolvedDiff,
  scope: string[],
  verbose: boolean,
): Promise<void> {
  const verdict = evaluateLane(parseLaneEvents(processResult.stdout), processResult);
  const traceCounts = verdict.toolCalls.map((t) => `${t.name}×${t.completed}`).join(", ");
  const lanes: LaneOutput[] = [
    {
      lane: DOWN_LANE_SPEC.lane,
      status: verdict.status,
      ...(verdict.reason !== undefined ? { reason: verdict.reason } : {}),
      scope,
      findings: verdict.findings,
    },
  ];
  writeLanesOut(opts, lanes);
  await publishLanes(opts, resolved, verbose, lanes, [
    ...(resolved.degraded ?? []),
    laneTraceEntry(verdict.status, verdict.reason, traceCounts),
  ]);
}

function tailSuffix(tail: string): string {
  return tail === "" ? "" : ` (serve stderr: ${tail})`;
}

/** SIGTERM, then SIGKILL after a grace period; always awaited, never throws. */
async function killServe(serve: ChildProcess): Promise<void> {
  if (serve.exitCode !== null || serve.signalCode !== null) return;
  await new Promise<void>((resolveP) => {
    const timer = setTimeout(() => {
      try {
        serve.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    }, SERVE_KILL_GRACE_MS);
    timer.unref?.();
    serve.once("exit", () => {
      clearTimeout(timer);
      resolveP();
    });
    try {
      serve.kill("SIGTERM");
    } catch {
      clearTimeout(timer);
      resolveP();
    }
  });
}

function spawnLane(
  command: OpencodeCommand,
  cwd: string,
  env: Record<string, string | undefined>,
  timeoutSecs: number,
): Promise<LaneProcessResult> {
  return new Promise((resolveP) => {
    const child = spawn(command.bin, command.argv, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderrTail = "";
    let settled = false;
    const finish = (partial: Omit<LaneProcessResult, "stderrTail">): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveP({ ...partial, ...(stderrTail === "" ? {} : { stderrTail }) });
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ exitCode: -1, stdout, timedOut: true });
    }, timeoutSecs * 1000);
    // Unref'd so the timer never holds the loop open on its own.
    timer.unref?.();
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      stderrTail += d.toString();
      if (stderrTail.length > STDERR_TAIL_BYTES) stderrTail = stderrTail.slice(-STDERR_TAIL_BYTES);
    });
    child.on("error", () => {
      finish({ exitCode: -1, stdout, timedOut: false });
    });
    child.on("close", (code) => {
      finish({ exitCode: code ?? -1, stdout, timedOut: false });
    });
  });
}

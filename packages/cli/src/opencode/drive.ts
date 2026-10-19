import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deterministicProcessEnv } from "@warden/env";
import {
  deriveLaneScope,
  isNotClean,
  resolveDiff,
  decodeGitPath,
  runPostPass,
  screenFinding,
  type CommentSet,
  type DegradedEntry,
  type LaneOutput,
} from "@warden/core";
import { laneSymlinkGate } from "./symlink-gate.js";
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

const OPENCODE_AGENT_ENV = "OPENCODE_CONFIG";
const OPENCODE_PROJECT_DISABLE_ENV = "OPENCODE_DISABLE_PROJECT_CONFIG";
const OPENCODE_PROJECT_DISABLE_NEW_ENV = "OPENCODE_CONFIG_PROJECT_DISABLE";
const OPENCODE_CONFIG_DIR_ENV = "OPENCODE_CONFIG_DIR";
const OPENCODE_DISCOVERY_HOME_ENV = "OPENCODE_TEST_HOME";
const OPENCODE_CONTENT_ENV = "OPENCODE_CONFIG_CONTENT";
const OPENCODE_PASSWORD_ENV = "OPENCODE_PASSWORD";
export const DEFAULT_LANE_TIMEOUT_SECS = 900;
/** Bounded wait for the warden MCP server to connect (covers serve boot). */
const DEFAULT_MCP_TIMEOUT_SECS = 30;
const MCP_POLL_INTERVAL_MS = 500;
/**
 * Settle delay after `connected` before spawning `run`: a late server fires
 * `mcp.tools.changed` and the tools register after short debounces
 * (`state.ts:42`) — so the first step's snapshot is taken before the
 * registration lands, while each later step re-runs the tool snapshot
 * (`session/runner/llm.ts:164`) and sees them (verified against the
 * shipped binary v2.0.25; the `v2` source checkout still waits, so the
 * source does not match the binary here — trust the binary).
 */
const MCP_SETTLE_MS = 1000;
/** Bounded stderr tail kept for failed-lane diagnostics. */
export const STDERR_TAIL_BYTES = 2048;
/**
 * Issue #57: the most changed files the down lane can cover. OpenCode
 * starts the step counter at 1 and forces a text-only step at
 * `step >= steps` (`session/runner/llm.ts`; the same check is in the
 * shipped binary v2.0.25), so `steps` leaves `steps - 1` steps that can
 * call tools. The charter spends the first on `warden_run_det_priors`
 * (its result pages cost more, but their count is unknown before the run,
 * so they are left out), and each changed file needs at least one
 * whole-file read. At one read per step — the rate in the recorded
 * down-lane streams — a larger scope cannot get one read per file before
 * any trace starts, so the run would only spend its timeout.
 *
 * Not a hard limit: a model can batch reads in one step (recorded up to
 * 4). The timeout is left out because its rate depends on the model; on
 * the issue #57 run (`opencode/space-bunny-free`), the lane made 54 tool
 * calls in 900 s, which is also below this ceiling.
 */
export const DOWN_LANE_MAX_SCOPE_FILES = DOWN_LANE_SPEC.steps - 2;
/** Grace between SIGTERM and SIGKILL when stopping the serve child. */
const SERVE_KILL_GRACE_MS = 2000;
/** Rejection reason when the MCP wait stops because the serve child failed to start. */
const MCP_WAIT_ABORTED = "MCP wait aborted: opencode serve failed to start";

/** Isolate config and home discovery without changing saved provider auth paths. */
export function createOpencodeIsolation(): {
  env: Record<string, string>;
  cleanup: () => void;
} {
  const root = mkdtempSync(resolve(tmpdir(), "warden-opencode-"));
  const cleanup = () => rmSync(root, { recursive: true, force: true });
  try {
    const config = resolve(root, "config");
    const home = resolve(root, "home");
    mkdirSync(config);
    mkdirSync(home);
    return {
      env: {
        [OPENCODE_PROJECT_DISABLE_ENV]: "1",
        [OPENCODE_PROJECT_DISABLE_NEW_ENV]: "1",
        [OPENCODE_CONFIG_DIR_ENV]: config,
        [OPENCODE_DISCOVERY_HOME_ENV]: home,
      },
      cleanup,
    };
  } catch (err) {
    cleanup();
    throw err;
  }
}

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
function resolveCliEntry(): string {
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
 * `opencode.json`. The command is wrapped with a fixed environment allowlist
 * before Node starts, so the MCP server does not inherit OpenCode's credentials.
 *
 * `anthropicBaseUrl` forwards `ANTHROPIC_BASE_URL`. The AI SDK in warden's
 * own harness reads that env var, but the v2.0.25 binary ignores it and
 * needs `provider.anthropic.options.baseURL`. Without the forward, a
 * gateway run sends the reference and the lane to different hosts.
 */
export function buildMcpConfigContent(opts: {
  command: string[];
  cwd: string;
  anthropicBaseUrl?: string;
}): string {
  return JSON.stringify({
    mcp: {
      servers: {
        warden: {
          type: "local",
          command: [
            "/usr/bin/env",
            "-i",
            ...Object.entries(deterministicProcessEnv()).map(([key, value]) => `${key}=${value}`),
            ...opts.command,
          ],
          cwd: opts.cwd,
          codemode: false,
        },
      },
    },
    ...(opts.anthropicBaseUrl
      ? { provider: { anthropic: { options: { baseURL: opts.anthropicBaseUrl } } } }
      : {}),
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
  /**
   * Sum of `state.time.end - state.time.start` over the completed parts
   * that carry both (the v2.0.25 binary sets them on each completed
   * `tool_use` part; the start is when the model begins the tool input,
   * so the sum includes argument generation). Telemetry only; absent
   * when no part has a time.
   */
  durationMs?: number;
}

export interface SessionUsage {
  costUsd: number;
  tokens: {
    input: number;
    output: number;
    reasoning: number;
    cacheRead: number;
    cacheWrite: number;
  };
  /** `<providerID>/<id>#<variant>`, or `<providerID>/<id>` without a variant. */
  model?: string;
}

export interface ParsedLane {
  /**
   * Assistant `text` parts of the last assistant message only — the
   * `messageID` of the last `step_start` event — in stream order. Empty
   * when the stream is unusable; see `parseError`.
   */
  texts: string[];
  toolCalls: ToolCallCount[];
  errors: string[];
  /**
   * Fail-closed stream defect, reported by `evaluateLane` before any
   * submission parsing: a `text` part without a `messageID`, a `text`
   * part whose ID no `step_start` announced (so the final message has no
   * trustworthy identity), a `step_start` without a `messageID`, or no
   * `step_start` at all.
   */
  parseError?: string;
  /**
   * Top-level `sessionID` of the first event that carries a non-empty
   * string one. It does not affect `parseError` or the verdict — it only
   * lets the driver read the session total from the serve API.
   */
  sessionId?: string;
}

/** Parses `opencode run --format json` JSONL. Unknown lines are skipped — the stream is host-owned, not schema-bound. */
export function parseLaneEvents(stdout: string): ParsedLane {
  // The submission is the last assistant message *by identity*: the
  // `messageID` of the last `step_start` event (each step gets a new
  // assistant message ID — `core/src/session/runner/llm.ts` — and the wire
  // shape carries it on every part: `cli/src/run/noninteractive.ts`).
  // Only `text` parts with that ID are kept, in any stream position, so a
  // late `reconcile()` re-emission of an earlier draft is ignored. But the
  // recovery channel (`reconcile()`) re-emits missed `text` parts with
  // their `messageID` and never emits `step_start` — after `session.wait`
  // resolves the client drops every non-`session.execution.*` event, which
  // includes the final step's `step_start`. So a `text` part whose ID no
  // `step_start` announced fails closed via `parseError` instead of letting
  // the previous step's draft become the submission. A `text` part without
  // an ID, a `step_start` without an ID, or a stream with no `step_start`
  // fails closed the same way.
  const textsById = new Map<string, string[]>();
  const announcedStepIds = new Set<string>();
  let lastStepId: string | undefined;
  let parseError: string | undefined;
  const completedByTool = new Map<string, number>();
  const seenByTool = new Map<string, number>();
  const durationByTool = new Map<string, number>();
  const errors: string[] = [];
  let sessionId: string | undefined;
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
    if (sessionId === undefined) {
      const sid = record["sessionID"];
      if (typeof sid === "string" && sid !== "") sessionId = sid;
    }
    if (record["type"] === "step_start") {
      const part = record["part"] as Record<string, unknown> | undefined;
      const id = part?.["messageID"];
      if (typeof id !== "string" || id === "") {
        parseError ??= "step_start without messageID in the event stream";
        continue;
      }
      announcedStepIds.add(id);
      lastStepId = id;
    } else if (record["type"] === "text") {
      const part = record["part"] as Record<string, unknown> | undefined;
      const id = part?.["messageID"];
      if (typeof id !== "string" || id === "") {
        parseError ??= "text part without messageID in the event stream";
        continue;
      }
      const text = part?.["text"];
      if (typeof text !== "string" || text.trim() === "") continue;
      const list = textsById.get(id);
      if (list !== undefined) list.push(text);
      else textsById.set(id, [text]);
    } else if (record["type"] === "tool_use") {
      const part = record["part"] as Record<string, unknown> | undefined;
      // Wire shape is `part.tool` (verified against a live `--format json`
      // stream); `part.name` is accepted as a fallback for forward tolerance.
      const name = part?.["tool"] ?? part?.["name"];
      if (typeof name !== "string" || name === "") continue;
      seenByTool.set(name, (seenByTool.get(name) ?? 0) + 1);
      const state = part?.["state"] as Record<string, unknown> | undefined;
      if (state?.["status"] === "completed") {
        completedByTool.set(name, (completedByTool.get(name) ?? 0) + 1);
        const time = state["time"] as Record<string, unknown> | undefined;
        const start = time?.["start"];
        const end = time?.["end"];
        if (typeof start === "number" && typeof end === "number" && end >= start) {
          durationByTool.set(name, (durationByTool.get(name) ?? 0) + (end - start));
        }
      }
    } else if (record["type"] === "error") {
      const message = (record["error"] as Record<string, unknown> | undefined)?.["message"];
      errors.push(typeof message === "string" && message !== "" ? message : "unknown error event");
    }
  }
  const toolCalls: ToolCallCount[] = [...seenByTool.keys()].map((name) => {
    const durationMs = durationByTool.get(name);
    return {
      name,
      completed: completedByTool.get(name) ?? 0,
      ...(durationMs !== undefined ? { durationMs } : {}),
    };
  });
  toolCalls.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (parseError === undefined) {
    for (const id of textsById.keys()) {
      if (!announcedStepIds.has(id)) {
        parseError = "text from a message with no step_start (final message identity unknown)";
        break;
      }
    }
  }
  if (parseError === undefined && lastStepId === undefined) {
    parseError = "no step_start in the event stream";
  }
  const texts =
    parseError !== undefined || lastStepId === undefined ? [] : (textsById.get(lastStepId) ?? []);
  return {
    texts,
    toolCalls,
    errors,
    ...(parseError !== undefined ? { parseError } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
  };
}

export interface LaneVerdict {
  status: "ok" | "failed";
  reason?: string;
  /** Model-owned; passed to `runPostPass` unvalidated beyond "is an array". */
  findings: unknown[];
  toolCalls: ToolCallCount[];
}

/** The submission is the last assistant message's single ` ```json ` block. Anything else fails with a distinct reason. */
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
  if (parsed.parseError !== undefined) return fail(parsed.parseError);
  const text = parsed.texts.join("\n");
  const blocks = [...text.matchAll(/```json[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/gm)];
  if (blocks.length === 0) return fail("no fenced json submission in the final message");
  if (blocks.length > 1) return fail("multiple fenced json submissions in the final message");
  const block = blocks[0]?.[1]?.trim();
  if (block === undefined || block === "")
    return fail("no fenced json submission in the final message");
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

/**
 * The lane failure reason for a scope too large to cover, or `undefined`
 * when the scope fits. The reason names the numbers and the derivation of
 * `DOWN_LANE_MAX_SCOPE_FILES`.
 */
export function laneScopeOverCeiling(scope: string[]): string | undefined {
  if (scope.length <= DOWN_LANE_MAX_SCOPE_FILES) return undefined;
  return (
    `review target too large: ${scope.length} changed files exceed the down lane ceiling of ` +
    `${DOWN_LANE_MAX_SCOPE_FILES} (DOWN_LANE_SPEC.steps ${DOWN_LANE_SPEC.steps} - 1 text-only final step ` +
    `- 1 warden_run_det_priors call, at one read per changed file)`
  );
}

/**
 * ADR-0054 §2(d): the `read` tool loads each `AGENTS.md` between a read
 * file and the location root into the session as instructions, and no
 * flag stops it (verified in the shipped binary v2.0.25: `uL="AGENTS.md"`,
 * `u.up({targets:[uL],…})`; `OPENCODE_DISABLE_PROJECT_CONFIG` covers only
 * the root file). So a nested `AGENTS.md` that the diff adds or changes is
 * PR text with instruction authority. Reads the diff headers, not
 * `parseUnifiedDiff`: a pure rename or a binary file has no `+++` line.
 * Decode Git C/octal UTF-8 paths before case comparison. Uppercasing
 * also catches the APFS long-s alias (AGENTſ.md); this is not a complete
 * filesystem name-equivalence check.
 */
export function nestedAgentsMdChanges(diff: string): string[] {
  const targets = new Set<string>();
  let inHeaders = true;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      inHeaders = true;
      continue;
    }
    if (line.startsWith("@@ ") || line === "GIT binary patch") inHeaders = false;
    if (!inHeaders) continue;
    let path: string | undefined;
    if (line.startsWith("+++ ")) path = line.slice(4);
    else if (line.startsWith("rename to ")) path = line.slice("rename to ".length);
    else if (line.startsWith("copy to ")) path = line.slice("copy to ".length);
    else {
      const binary = /^Binary files .* and (.+) differ$/.exec(line);
      if (binary !== null) path = binary[1];
    }
    if (path === undefined) continue;
    let target = decodeGitPath(path);
    if (target === undefined) continue;
    if (target.startsWith("b/") && !line.startsWith("rename to ") && !line.startsWith("copy to ")) {
      target = target.slice(2);
    }
    const slash = target.lastIndexOf("/");
    if (slash > 0 && target.slice(slash + 1).toUpperCase() === "AGENTS.MD") targets.add(target);
  }
  return [...targets].sort();
}

/** The lane failure reason when the diff changes a nested `AGENTS.md`, else `undefined`. */
export function laneInstructionFileGate(diff: string): string | undefined {
  const changed = nestedAgentsMdChanges(diff);
  if (changed.length === 0) return undefined;
  return (
    `untrusted instruction file: this diff changes ${changed.join(", ")}; OpenCode loads a nested ` +
    `AGENTS.md as lane instructions when the lane reads a file below it, so the lane does not run (ADR-0054 §2(d))`
  );
}

function screenLaneReason(reason: string): string {
  const rule = screenFinding(reason);
  return rule === undefined ? reason : `secret guard: dropped lane reason (rule ${rule})`;
}

function withTail(reason: string, tail: string | undefined): string {
  return screenLaneReason(
    tail === undefined || tail === "" ? reason : `${reason} (stderr: ${tail})`,
  );
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
 * The `GET /api/session/<id>` response is untrusted JSON: validate at this
 * boundary. Shape (verified live against v2.0.25):
 * `{data:{id, model:{id,providerID,variant}, cost, tokens:{input, output,
 * reasoning, cache:{read,write}}, outcome}}`. Returns `undefined` when the
 * shape is wrong, the cost is negative, or (when `expectedId` is given)
 * `data.id` is not the requested session. `model` is
 * `<providerID>/<id>#<variant>` (the same form as the requested `--model`,
 * so the two compare as strings), or `<providerID>/<id>` when the session
 * has no variant.
 */
export function parseSessionUsage(body: unknown, expectedId?: string): SessionUsage | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const data = (body as Record<string, unknown>)["data"];
  if (typeof data !== "object" || data === null) return undefined;
  const d = data as Record<string, unknown>;
  if (expectedId !== undefined && d["id"] !== expectedId) return undefined;
  if (typeof d["cost"] !== "number" || d["cost"] < 0) return undefined;
  const tokens = d["tokens"];
  if (typeof tokens !== "object" || tokens === null) return undefined;
  const t = tokens as Record<string, unknown>;
  if (
    typeof t["input"] !== "number" ||
    typeof t["output"] !== "number" ||
    typeof t["reasoning"] !== "number"
  ) {
    return undefined;
  }
  const cache = t["cache"];
  if (typeof cache !== "object" || cache === null) return undefined;
  const c = cache as Record<string, unknown>;
  if (typeof c["read"] !== "number" || typeof c["write"] !== "number") return undefined;
  const usage: SessionUsage = {
    costUsd: d["cost"],
    tokens: {
      input: t["input"],
      output: t["output"],
      reasoning: t["reasoning"],
      cacheRead: c["read"],
      cacheWrite: c["write"],
    },
  };
  const model = d["model"];
  if (typeof model === "object" && model !== null) {
    const m = model as Record<string, unknown>;
    if (typeof m["id"] === "string" && typeof m["providerID"] === "string") {
      const variant = m["variant"];
      usage.model =
        typeof variant === "string" && variant !== ""
          ? `${m["providerID"]}/${m["id"]}#${variant}`
          : `${m["providerID"]}/${m["id"]}`;
    }
  }
  return usage;
}

/**
 * Read one session total from the serve API. Usage is telemetry — any
 * failure returns `undefined` and never fails the lane.
 */
async function fetchSessionUsage(opts: {
  baseUrl: string;
  password: string;
  directory: string;
  sessionId: string;
  timeoutMs: number;
}): Promise<SessionUsage | undefined> {
  try {
    const url = new URL(`/api/session/${encodeURIComponent(opts.sessionId)}`, opts.baseUrl);
    url.searchParams.set("location[directory]", opts.directory);
    const res = await fetch(url, {
      headers: {
        Authorization: `Basic ${Buffer.from(`opencode:${opts.password}`, "utf8").toString("base64")}`,
      },
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
    if (!res.ok) return undefined;
    return parseSessionUsage(await res.json(), opts.sessionId);
  } catch {
    return undefined;
  }
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
  /** Aborts the wait at once (the serve child failed to start). */
  signal?: AbortSignal;
}): Promise<void> {
  const pollMs = opts.pollMs ?? MCP_POLL_INTERVAL_MS;
  const deadline = Date.now() + opts.timeoutMs;
  const url = new URL("/api/mcp", opts.baseUrl);
  // `URLSearchParams` percent-encodes the brackets; the host decodes them.
  url.searchParams.set("location[directory]", opts.directory);
  const auth = `Basic ${Buffer.from(`opencode:${opts.password}`, "utf8").toString("base64")}`;
  let lastDetail = "no poll completed yet";
  for (;;) {
    // The serve child failed to start (the spawn-error race below): stop
    // the loop and its timers at once instead of waiting out the timeout.
    if (opts.signal?.aborted === true) {
      throw new Error(MCP_WAIT_ABORTED);
    }
    let readiness: WardenMcpReadiness;
    try {
      // Bounded per request, so a hung response cannot outlive the wait.
      const remaining = Math.max(1, deadline - Date.now());
      const res = await fetch(url, {
        headers: { Authorization: auth },
        signal: AbortSignal.timeout(Math.min(pollMs * 4, remaining)),
      });
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
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())), opts.signal);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolveP, rejectP) => {
    if (signal?.aborted === true) {
      rejectP(new Error(MCP_WAIT_ABORTED));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolveP();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      rejectP(new Error(MCP_WAIT_ABORTED));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
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
  /** Write the phase timings JSON here (CI step timings, #48). */
  timingsOut?: string;
}

/** Driver phases, in run order. A phase that did not run has no entry. */
type DrivePhase = "resolveDiff" | "gates" | "mcpReady" | "settle" | "lane" | "usage" | "postPass";

interface DriveTimings {
  /** Wall-clock milliseconds per phase that ran. */
  phases: Partial<Record<DrivePhase, number>>;
  /**
   * Per-tool time inside the lane, from the event stream. Phase 1 is the
   * `warden_run_det_priors` entry (its first call runs the detectors).
   */
  tools: { name: string; completed: number; durationMs?: number }[];
  /** From the driver start to the end of the post-pass; excludes the serve shutdown. */
  totalMs: number;
}

/** Wall-clock phase timer for one driver run. Telemetry only. */
class PhaseTimer {
  private readonly start = performance.now();
  private readonly phases: Partial<Record<DrivePhase, number>> = {};

  /** Records the phase even when `fn` throws. */
  async time<T>(phase: DrivePhase, fn: () => Promise<T>): Promise<T> {
    const t0 = performance.now();
    try {
      return await fn();
    } finally {
      this.phases[phase] = Math.round(performance.now() - t0);
    }
  }

  timeSync<T>(phase: DrivePhase, fn: () => T): T {
    const t0 = performance.now();
    try {
      return fn();
    } finally {
      this.phases[phase] = Math.round(performance.now() - t0);
    }
  }

  finish(toolCalls: ToolCallCount[]): DriveTimings {
    return {
      phases: { ...this.phases },
      tools: toolCalls.map((t) => ({ ...t })),
      totalMs: Math.round(performance.now() - this.start),
    };
  }
}

function writeTimingsOut(
  path: string,
  repoRoot: string,
  record: { timings: DriveTimings; runSpawned: boolean; model: string; usage?: SessionUsage },
): void {
  writeFileSync(resolve(repoRoot, path), JSON.stringify({ version: 1, ...record }, null, 2) + "\n");
}

export interface DriveLaneResult {
  result: CommentSet;
  lanes: LaneOutput[];
  usage?: SessionUsage;
  /**
   * Whether `opencode run` was spawned. False on the empty-scope,
   * scope-over-ceiling, and MCP-warmup-failure paths: no model call
   * happened, so the spend is a
   * known $0 (the eval does not infer this from `usage`).
   */
  runSpawned: boolean;
  /** The requested model: `opts.model`, else `DOWN_LANE_SPEC.defaultModel`. */
  model: string;
  /** Phase timings. Optional so other lane drivers (the eval Claude Code lane) can omit them. */
  timings?: DriveTimings;
}

/**
 * Printing wrapper: the `warden opencode-review` entry. Output and exit
 * codes are exactly as before the split.
 */
export async function runOpencodeReview(opts: DriveOptions): Promise<void> {
  const { result } = await driveOpencodeLane(opts);
  const verbose = opts.verbose === true;
  if (isNotClean(result)) process.exitCode = 1;
  if (opts.json === true) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }
  process.stdout.write("\n" + formatCommentSet(result, "review", verbose) + "\n");
}

export async function driveOpencodeLane(opts: DriveOptions): Promise<DriveLaneResult> {
  // Returning core: everything the printing wrapper does except writing
  // stdout and setting `process.exitCode`. It still writes `--lanes-out`
  // (part of the driver contract). The eval runner calls this directly so
  // the scored output is the same published `CommentSet` a user gets.
  const timer = new PhaseTimer();
  const resolved = await timer.time("resolveDiff", () =>
    resolveDiff({
      repoRoot: opts.repoRoot,
      mode: "review",
      ...(opts.baseRef !== undefined ? { baseRef: opts.baseRef } : {}),
    }),
  );
  const scope = deriveLaneScope(resolved.diff);
  const timeoutSecs = opts.timeoutSecs ?? DEFAULT_LANE_TIMEOUT_SECS;

  // A preflight gate fails the lane before spawn, at a known $0.
  const gateReason = timer.timeSync("gates", () => {
    // Empty scope: the lane is failed so the existing fail-closed entries
    // fire (plus the post-pass diff-source entry on the empty diff).
    if (scope.length === 0) return "empty review target";
    // Scope over the ceiling: the step cap cannot fund one read per
    // changed file, so a run would only spend its timeout. The reason
    // names the numbers.
    // A nested AGENTS.md the diff changes would reach the lane as
    // instructions.
    return (
      laneScopeOverCeiling(scope) ??
      laneInstructionFileGate(resolved.diff) ??
      laneSymlinkGate(resolved.diff, opts.repoRoot)
    );
  });
  if (gateReason !== undefined) {
    const lanes: LaneOutput[] = [
      { lane: DOWN_LANE_SPEC.lane, status: "failed", reason: gateReason, scope, findings: [] },
    ];
    writeLanesOut(opts, lanes);
    return await buildLaneResult(opts, resolved, lanes, [...(resolved.degraded ?? [])], {
      runSpawned: false,
      timer,
    });
  }

  const baseRef = resolved.baseRef ?? opts.baseRef ?? "HEAD";
  const model = requestedModel(opts);
  const mcpTimeoutMs = (opts.mcpTimeoutSecs ?? DEFAULT_MCP_TIMEOUT_SECS) * 1000;
  const settleMs = opts.mcpSettleMs ?? MCP_SETTLE_MS;
  const configPath = resolveLaneConfigPath();
  // The serve child reads this env password for its API auth
  // (`server-process.ts`: `Env.password`, else a random fallback the run
  // client could never know); the run client sends it back as Basic
  // `opencode:<password>` (`server-connection.ts`), so both children share
  // it. It never leaves loopback.
  const password = randomPassword();
  // Global config and home skill discovery are separate sources in
  // OpenCode v2.0.25. Redirect both, but retain provider credentials and
  // the normal data path (saved auth) for the model. Remove after serve
  // stops, including warmup, spawn, and lane failure paths.
  const isolation = createOpencodeIsolation();
  try {
    // oxlint-disable-next-line node/no-process-env -- the OpenCode binary ignores ANTHROPIC_BASE_URL, so it is forwarded as provider config (see buildMcpConfigContent)
    const anthropicBaseUrl = process.env["ANTHROPIC_BASE_URL"];
    const childEnv: Record<string, string | undefined> = {
      // oxlint-disable-next-line node/no-process-env -- the OpenCode child keeps the full parent env on purpose: provider credentials and saved auth (see the comment above)
      ...process.env,
      ...isolation.env,
      [OPENCODE_AGENT_ENV]: configPath,
      [OPENCODE_CONTENT_ENV]: buildMcpConfigContent({
        command: resolveWardenMcpCommand(),
        cwd: opts.repoRoot,
        ...(anthropicBaseUrl ? { anthropicBaseUrl } : {}),
      }),
      [OPENCODE_PASSWORD_ENV]: password,
      // opencode resolves its location from PWD, not the process cwd. Under
      // `pnpm --filter` PWD is the package dir, so `run` opened a second,
      // cold location: the MCP race again, and the wrong directory.
      PWD: opts.repoRoot,
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
      if (serveStderr.length > STDERR_TAIL_BYTES)
        serveStderr = serveStderr.slice(-STDERR_TAIL_BYTES);
    });
    // A missing `opencode` binary throws an unhandled 'error' event without
    // this listener — and the poll below would wait out the full MCP timeout
    // on a serve that never started. Reject at once with a lane reason.
    const serveSpawnFailed = new Promise<never>((_resolve, reject) => {
      serve.once("error", (err) => {
        reject(
          new Error(`opencode not runnable: ${err instanceof Error ? err.message : String(err)}`),
        );
      });
    });
    // A leaked `opencode serve` is a bug: the child dies on every path below.
    // The abort stops a still-pending MCP wait at once (a spawn error would
    // otherwise leave its loop and timers alive for the full MCP timeout).
    const mcpAbort = new AbortController();
    try {
      try {
        // Includes the serve boot: the poll starts before serve listens.
        await timer.time("mcpReady", () =>
          Promise.race([
            waitForWardenMcp({
              baseUrl,
              password,
              directory: opts.repoRoot,
              timeoutMs: mcpTimeoutMs,
              signal: mcpAbort.signal,
            }),
            serveSpawnFailed,
          ]),
        );
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        return await buildFailed(
          `mcp not ready: ${detail}${tailSuffix(serveStderr)}`,
          opts,
          resolved,
          scope,
          timer,
        );
      }
      await timer.time("settle", () => sleep(settleMs));

      const command = buildOpencodeCommand({
        serverUrl: baseUrl,
        model,
        message: buildLaneMessage(baseRef),
        ...(opts.opencodeBin !== undefined ? { bin: opts.opencodeBin } : {}),
      });
      const processResult = await timer.time("lane", () =>
        spawnLane(command, opts.repoRoot, childEnv, timeoutSecs),
      );
      // The serve child is still alive here (killed in `finally` below),
      // so the session total can be read before it goes away.
      let usage: SessionUsage | undefined;
      const sessionId = parseLaneEvents(processResult.stdout).sessionId;
      if (sessionId !== undefined) {
        usage = await timer.time("usage", () =>
          fetchSessionUsage({
            baseUrl,
            password,
            directory: opts.repoRoot,
            sessionId,
            timeoutMs: Math.min(mcpTimeoutMs, 10000),
          }),
        );
      }
      return await buildVerdict(processResult, opts, resolved, scope, timer, usage);
    } finally {
      mcpAbort.abort();
      await killServe(serve);
    }
  } finally {
    isolation.cleanup();
  }
}

type ResolvedDiff = Awaited<ReturnType<typeof resolveDiff>>;

/**
 * `--lanes-out` holds raw lane findings from before the post-pass, so it
 * gets the same secret guard (ADR-0054 §4): a matched finding is written
 * as `{ secretGuard: <rule> }`, which keeps the count and drops the value.
 */
function writeLanesOut(opts: DriveOptions, lanes: LaneOutput[]): void {
  if (opts.lanesOut !== undefined) {
    const screened = lanes.map((lane) => ({
      ...lane,
      ...(lane.reason !== undefined ? { reason: screenLaneReason(lane.reason) } : {}),
      findings: lane.findings.map((finding) => {
        const secret = screenFinding(finding);
        return secret === undefined ? finding : { secretGuard: secret };
      }),
    }));
    writeFileSync(
      resolve(opts.repoRoot, opts.lanesOut),
      JSON.stringify({ version: 1, lanes: screened }, null, 2) + "\n",
    );
  }
}

function laneTraceEntry(
  status: string,
  reason: string | undefined,
  toolCalls: string,
  usage?: SessionUsage,
): DegradedEntry {
  const base = `lane-trace: down ${status}${reason !== undefined ? ` (${reason})` : ""} — ${toolCalls === "" ? "no tool calls" : toolCalls}`;
  if (usage === undefined) {
    return { kind: "info", topic: "lane-trace", message: base };
  }
  const input = usage.tokens.input + usage.tokens.cacheRead + usage.tokens.cacheWrite;
  return {
    kind: "info",
    topic: "lane-trace",
    message: `${base} · cost $${usage.costUsd.toFixed(4)} · tokens ${input}/${usage.tokens.output}`,
  };
}

function requestedModel(opts: DriveOptions): string {
  return opts.model ?? DOWN_LANE_SPEC.defaultModel;
}

/**
 * Shared returning helper: every path builds the post-pass CommentSet
 * through this. `runSpawned` has no default: each path states whether it
 * spawned `opencode run`, so a new path cannot report a known $0 by
 * omission.
 */
async function buildLaneResult(
  opts: DriveOptions,
  resolved: ResolvedDiff,
  lanes: LaneOutput[],
  extraDegraded: DegradedEntry[],
  facts: {
    runSpawned: boolean;
    timer: PhaseTimer;
    usage?: SessionUsage;
    toolCalls?: ToolCallCount[];
  },
): Promise<DriveLaneResult> {
  const verbose = opts.verbose === true;
  const result = await facts.timer.time("postPass", () =>
    runPostPass({
      repoRoot: opts.repoRoot,
      diff: resolved.diff,
      lanes,
      config: {
        verbose,
        ...(opts.volumeCap !== undefined ? { volumeCap: opts.volumeCap } : {}),
      },
      ...(extraDegraded.length > 0 ? { extraDegraded } : {}),
    }),
  );
  const timings = facts.timer.finish(facts.toolCalls ?? []);
  if (opts.timingsOut !== undefined) {
    writeTimingsOut(opts.timingsOut, opts.repoRoot, {
      timings,
      runSpawned: facts.runSpawned,
      model: requestedModel(opts),
      ...(facts.usage !== undefined ? { usage: facts.usage } : {}),
    });
  }
  return {
    result,
    lanes,
    runSpawned: facts.runSpawned,
    model: requestedModel(opts),
    timings,
    ...(facts.usage !== undefined ? { usage: facts.usage } : {}),
  };
}

/** MCP-warmup failure: no run happened, so there are no tool calls to trace. */
async function buildFailed(
  reason: string,
  opts: DriveOptions,
  resolved: ResolvedDiff,
  scope: string[],
  timer: PhaseTimer,
): Promise<DriveLaneResult> {
  const screenedReason = screenLaneReason(reason);
  const lanes: LaneOutput[] = [
    { lane: DOWN_LANE_SPEC.lane, status: "failed", reason: screenedReason, scope, findings: [] },
  ];
  writeLanesOut(opts, lanes);
  return await buildLaneResult(
    opts,
    resolved,
    lanes,
    [...(resolved.degraded ?? []), laneTraceEntry("failed", screenedReason, "")],
    { runSpawned: false, timer },
  );
}

async function buildVerdict(
  processResult: LaneProcessResult,
  opts: DriveOptions,
  resolved: ResolvedDiff,
  scope: string[],
  timer: PhaseTimer,
  usage?: SessionUsage,
): Promise<DriveLaneResult> {
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
  return await buildLaneResult(
    opts,
    resolved,
    lanes,
    [
      ...(resolved.degraded ?? []),
      laneTraceEntry(verdict.status, verdict.reason, traceCounts, usage),
    ],
    {
      runSpawned: true,
      timer,
      toolCalls: verdict.toolCalls,
      ...(usage !== undefined ? { usage } : {}),
    },
  );
}

function tailSuffix(tail: string): string {
  return tail === "" ? "" : ` (serve stderr: ${tail})`;
}

/** SIGTERM, then SIGKILL after a grace period; always awaited, never throws. */
async function killServe(serve: ChildProcess): Promise<void> {
  // The child never spawned (e.g. ENOENT): no 'exit' will ever arrive.
  if (serve.pid === undefined) return;
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

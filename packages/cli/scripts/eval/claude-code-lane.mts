import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { deriveLaneScope, resolveDiff, runPostPass, type LaneOutput } from "@warden/core";
import {
  buildLaneMessage,
  DEFAULT_LANE_TIMEOUT_SECS,
  evaluateLane,
  resolveLaneConfigPath,
  resolveWardenMcpCommand,
  STDERR_TAIL_BYTES,
  type DriveLaneResult,
  type LaneProcessResult,
  type ParsedLane,
  type SessionUsage,
  type ToolCallCount,
} from "../../src/opencode/drive.js";
import { DOWN_LANE_SPEC, PROMPT_FILENAME } from "../../src/opencode/materialize.js";

/**
 * Eval-only: the down lane run by Claude Code (`claude -p`) instead of
 * OpenCode. Same system prompt (`warden-down.md`), same warden MCP tools,
 * same submission contract (`evaluateLane`), same `runPostPass`. The
 * difference is the runtime and its auth: the child runs on the operator's
 * Claude subscription login, so every `ANTHROPIC_*` variable is stripped
 * from its env (warden's `.env` loader puts an API key there, and
 * `claude` prefers a key over the login when one is set).
 *
 * Isolation: `--setting-sources ""` skips user/project settings, hooks,
 * and CLAUDE.md; `--strict-mcp-config` loads only the warden server;
 * `--tools` limits built-ins to read/grep/glob; `--restricted` confines
 * them to the repo; `dontAsk` denies anything not pre-approved;
 * `--max-turns` matches the OpenCode lane's step cap. Not a product surface — ADR-0053 names OpenCode as
 * the engine; this lane only measures the same method on another client.
 */

export const CLAUDE_CODE_DEFAULT_MODEL = "claude-opus-5-5";
export const CLAUDE_CODE_DEFAULT_EFFORT = "high";
/** Claude Code names MCP tools `mcp__<server>__<tool>`; OpenCode names them `<server>_<tool>`. */
const MCP_PREFIX = "mcp__warden__";
const MCP_TOOLS = ["run_det_priors", "lookup_type_def"] as const;
const MAX_TURNS = 60;

/** Variables the child must not inherit: API auth, and the parent session's own Claude Code state. */
function isStrippedEnv(name: string): boolean {
  return name.startsWith("ANTHROPIC_") || name.startsWith("CLAUDE_CODE_") || name === "CLAUDECODE";
}

export function buildClaudeCodeEnv(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(env)) {
    if (!isStrippedEnv(name)) out[name] = value;
  }
  return out;
}

export function buildClaudeCodeArgv(opts: {
  model: string;
  effort: string;
  systemPromptFile: string;
  mcpCommand: string[];
  message: string;
}): string[] {
  const [command, ...args] = opts.mcpCommand;
  const mcpConfig = JSON.stringify({ mcpServers: { warden: { command, args } } });
  // Read deny rules also cover Grep and Glob, but only inside the cwd:
  // `--restricted` confines the file tools to it, so an absolute path
  // outside the repo cannot reach a `.env`. `.env.example` is denied too
  // (stricter than the OpenCode lane's allow): a deny rule wins over an allow.
  const settings = JSON.stringify({
    permissions: { deny: ["Read(**/.env)", "Read(**/.env.*)", "Read(**/*.env)"] },
  });
  return [
    "-p",
    opts.message,
    "--model",
    opts.model,
    "--effort",
    opts.effort,
    "--system-prompt-file",
    opts.systemPromptFile,
    "--setting-sources",
    "",
    "--restricted",
    "--settings",
    settings,
    "--strict-mcp-config",
    "--mcp-config",
    mcpConfig,
    "--tools",
    "Read,Grep,Glob",
    "--allowedTools",
    ["Read", "Grep", "Glob", ...MCP_TOOLS.map((t) => `${MCP_PREFIX}${t}`)].join(","),
    "--permission-mode",
    "dontAsk",
    // The OpenCode lane's `steps: 60`. A capped run ends `error_max_turns`,
    // which fails the lane.
    "--max-turns",
    String(MAX_TURNS),
    "--disable-slash-commands",
    "--no-session-persistence",
    "--output-format",
    "stream-json",
    "--verbose",
  ];
}

/** The OpenCode message plus the tool-name mapping the shared prompt needs on this client. */
export function buildClaudeCodeMessage(baseRef: string): string {
  const mapping = MCP_TOOLS.map((t) => `\`warden_${t}\` is \`${MCP_PREFIX}${t}\``).join(", ");
  return `${buildLaneMessage(baseRef)} Tool names on this client: ${mapping}.`;
}

export interface ParsedClaudeCodeLane {
  parsed: ParsedLane;
  usage?: SessionUsage;
}

/**
 * Parses `claude -p --output-format stream-json` JSONL into the shape
 * `evaluateLane` takes. The submission is the `result` event's `result`
 * text (the final assistant message). A stream with no `result` event,
 * an error result, or a warden MCP server that did not connect fails
 * closed through `parseError` / `errors`. Tool names are normalized to
 * the OpenCode form so the det-priors check and the trace read the same.
 */
export function parseClaudeCodeEvents(stdout: string): ParsedClaudeCodeLane {
  const toolNameById = new Map<string, string>();
  const seen = new Map<string, number>();
  const completed = new Map<string, number>();
  const errors: string[] = [];
  let parseError: string | undefined;
  let resultText: string | undefined;
  let usage: SessionUsage | undefined;
  let initModel: string | undefined;
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
    const type = record["type"];
    if (type === "system" && record["subtype"] === "init") {
      if (typeof record["model"] === "string") initModel = record["model"];
      const servers = Array.isArray(record["mcp_servers"]) ? record["mcp_servers"] : [];
      const warden = servers.find(
        (s): s is Record<string, unknown> =>
          typeof s === "object" &&
          s !== null &&
          (s as Record<string, unknown>)["name"] === "warden",
      );
      if (warden?.["status"] !== "connected") {
        errors.push(`warden MCP server not connected (status: ${String(warden?.["status"])})`);
      }
    } else if (type === "assistant" || type === "user") {
      const message = record["message"] as Record<string, unknown> | undefined;
      const content = Array.isArray(message?.["content"]) ? message["content"] : [];
      for (const block of content) {
        if (typeof block !== "object" || block === null) continue;
        const b = block as Record<string, unknown>;
        if (b["type"] === "tool_use" && typeof b["name"] === "string") {
          const name = normalizeToolName(b["name"]);
          if (typeof b["id"] === "string") toolNameById.set(b["id"], name);
          seen.set(name, (seen.get(name) ?? 0) + 1);
        } else if (b["type"] === "tool_result" && typeof b["tool_use_id"] === "string") {
          const name = toolNameById.get(b["tool_use_id"]);
          if (name !== undefined && b["is_error"] !== true) {
            completed.set(name, (completed.get(name) ?? 0) + 1);
          }
        }
      }
    } else if (type === "result") {
      if (record["is_error"] === true || record["subtype"] !== "success") {
        errors.push(`result ${String(record["subtype"])}`);
      }
      if (typeof record["result"] === "string") resultText = record["result"];
      usage = parseResultUsage(record, initModel);
    }
  }
  if (resultText === undefined) parseError = "no result event in the claude stream";
  const toolCalls: ToolCallCount[] = [...seen.keys()]
    .map((name) => ({ name, completed: completed.get(name) ?? 0 }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return {
    parsed: {
      texts: resultText !== undefined ? [resultText] : [],
      toolCalls,
      errors,
      ...(parseError !== undefined ? { parseError } : {}),
    },
    ...(usage !== undefined ? { usage } : {}),
  };
}

function normalizeToolName(name: string): string {
  return name.startsWith(MCP_PREFIX) ? `warden_${name.slice(MCP_PREFIX.length)}` : name;
}

/**
 * `total_cost_usd` is the API-price equivalent even on a subscription
 * login (no money moves), which is the number the gate compares. The
 * model is every `modelUsage` key, so a background call on another model
 * shows up instead of hiding behind the init model.
 *
 * As strict as `parseSessionUsage`: a negative cost or a missing token
 * count is unmeasured (`undefined`), never a measured $0. Only the
 * reasoning count may be absent (a run with no thinking).
 */
function parseResultUsage(
  record: Record<string, unknown>,
  initModel: string | undefined,
): SessionUsage | undefined {
  const cost = record["total_cost_usd"];
  const u = record["usage"];
  if (typeof cost !== "number" || cost < 0 || typeof u !== "object" || u === null) {
    return undefined;
  }
  const usage = u as Record<string, unknown>;
  const input = usage["input_tokens"];
  const output = usage["output_tokens"];
  const cacheRead = usage["cache_read_input_tokens"];
  const cacheWrite = usage["cache_creation_input_tokens"];
  if (
    typeof input !== "number" ||
    typeof output !== "number" ||
    typeof cacheRead !== "number" ||
    typeof cacheWrite !== "number"
  ) {
    return undefined;
  }
  const details = usage["output_tokens_details"];
  const thinking =
    typeof details === "object" && details !== null
      ? (details as Record<string, unknown>)["thinking_tokens"]
      : undefined;
  const modelUsage = record["modelUsage"];
  const models =
    typeof modelUsage === "object" && modelUsage !== null ? Object.keys(modelUsage) : [];
  const model = models.length > 0 ? models.join(",") : initModel;
  return {
    costUsd: cost,
    tokens: {
      input,
      output,
      reasoning: typeof thinking === "number" ? thinking : 0,
      cacheRead,
      cacheWrite,
    },
    ...(model !== undefined ? { model } : {}),
  };
}

export interface ClaudeCodeDriveOptions {
  repoRoot: string;
  baseRef?: string;
  model?: string;
  effort?: string;
  timeoutSecs?: number;
}

/**
 * Mirrors `driveOpencodeLane`: resolve the diff, derive the trusted
 * scope, run the lane, build the driver-owned envelope, and return the
 * `runPostPass` CommentSet. No MCP warmup step: `claude -p` connects MCP
 * servers before the first turn, and the init event reports the status.
 */
export async function driveClaudeCodeLane(opts: ClaudeCodeDriveOptions): Promise<DriveLaneResult> {
  const resolved = await resolveDiff({
    repoRoot: opts.repoRoot,
    mode: "review",
    baseRef: opts.baseRef,
  });
  const scope = deriveLaneScope(resolved.diff);
  const model = `${opts.model ?? CLAUDE_CODE_DEFAULT_MODEL}#${opts.effort ?? CLAUDE_CODE_DEFAULT_EFFORT}`;
  const publish = async (
    lane: LaneOutput,
    runSpawned: boolean,
    usage?: SessionUsage,
  ): Promise<DriveLaneResult> => {
    const result = await runPostPass({
      repoRoot: opts.repoRoot,
      diff: resolved.diff,
      lanes: [lane],
      config: { verbose: false },
      ...(resolved.degraded !== undefined && resolved.degraded.length > 0
        ? { extraDegraded: [...resolved.degraded] }
        : {}),
    });
    return {
      result,
      lanes: [lane],
      runSpawned,
      model,
      ...(usage !== undefined ? { usage } : {}),
    };
  };

  if (scope.length === 0) {
    return await publish(
      {
        lane: DOWN_LANE_SPEC.lane,
        status: "failed",
        reason: "empty review target",
        scope,
        findings: [],
      },
      false,
    );
  }

  const baseRef = resolved.baseRef ?? opts.baseRef ?? "HEAD";
  const argv = buildClaudeCodeArgv({
    model: opts.model ?? CLAUDE_CODE_DEFAULT_MODEL,
    effort: opts.effort ?? CLAUDE_CODE_DEFAULT_EFFORT,
    systemPromptFile: resolve(dirname(resolveLaneConfigPath()), PROMPT_FILENAME),
    mcpCommand: resolveWardenMcpCommand(),
    message: buildClaudeCodeMessage(baseRef),
  });
  const processResult = await spawnClaude(
    argv,
    opts.repoRoot,
    buildClaudeCodeEnv(process.env),
    opts.timeoutSecs ?? DEFAULT_LANE_TIMEOUT_SECS,
  );
  const { parsed, usage } = parseClaudeCodeEvents(processResult.stdout);
  const verdict = evaluateLane(parsed, processResult);
  return await publish(
    {
      lane: DOWN_LANE_SPEC.lane,
      status: verdict.status,
      // `evaluateLane` names its process "opencode run"; name the real one.
      ...(verdict.reason !== undefined
        ? { reason: verdict.reason.replace(/^opencode run/, "claude -p") }
        : {}),
      scope,
      findings: verdict.findings,
    },
    true,
    usage,
  );
}

function spawnClaude(
  argv: string[],
  cwd: string,
  env: Record<string, string | undefined>,
  timeoutSecs: number,
): Promise<LaneProcessResult> {
  return new Promise((resolveP) => {
    // stdin is closed: `claude -p` waits on an open stdin before it starts.
    const child = spawn("claude", argv, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
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
    timer.unref?.();
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      stderrTail += d.toString();
      if (stderrTail.length > STDERR_TAIL_BYTES) stderrTail = stderrTail.slice(-STDERR_TAIL_BYTES);
    });
    child.on("error", () => finish({ exitCode: -1, stdout, timedOut: false }));
    child.on("close", (code) => finish({ exitCode: code ?? -1, stdout, timedOut: false }));
  });
}

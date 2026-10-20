import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { deriveLaneScope, resolveDiff, runPostPass, type LaneOutput } from "@warden/core";
import { isRecord } from "@warden/core/guards";
import { z } from "zod";
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
import { DOWN_LANE_SPEC, type LaneSpec } from "../../src/opencode/materialize.js";

/**
 * Eval-only: a lane (down by default, or up) run by Claude Code
 * (`claude -p`) instead of OpenCode. The lane spec gives the system prompt
 * (`warden-down.md` or `warden-up.md`), the envelope lane name, the
 * built-in tools, and the turn cap. Same warden MCP tools, same
 * submission contract (`evaluateLane`), same `runPostPass`. The
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

const CLAUDE_CODE_DEFAULT_MODEL = "claude-opus-5-5";
const CLAUDE_CODE_DEFAULT_EFFORT = "high";
/** Claude Code names MCP tools `mcp__<server>__<tool>`; OpenCode names them `<server>_<tool>`. */
const MCP_PREFIX = "mcp__warden__";
const MCP_TOOLS = ["run_det_priors", "lookup_type_def"] as const;

/**
 * The OpenCode v2 read-only tool names that a lane spec allows
 * (`LaneSpec.allowedTools`), mapped to the Claude Code built-in tool names.
 */
const CLAUDE_CODE_TOOL_NAMES = new Map([
  ["read", "Read"],
  ["grep", "Grep"],
  ["glob", "Glob"],
]);

/**
 * The Claude Code built-ins for a lane spec's `allowedTools`, in spec
 * order. A tool with no Claude Code name throws, so a new lane tool
 * cannot drop out of the allow list without notice.
 */
export function claudeCodeBuiltinTools(spec: LaneSpec): string[] {
  return spec.allowedTools.map((tool) => {
    const name = CLAUDE_CODE_TOOL_NAMES.get(tool);
    if (name === undefined) {
      throw new Error(`claude-code lane: ${spec.lane} lane tool "${tool}" has no Claude Code name`);
    }
    return name;
  });
}

/** Variables the child must not inherit: API auth, and the parent session's own Claude Code state. */
function isStrippedEnv(name: string): boolean {
  return name.startsWith("ANTHROPIC_") || name.startsWith("CLAUDE_CODE_") || name === "CLAUDECODE";
}

/**
 * The child env: the parent env without any `ANTHROPIC_*` variable (so
 * `claude` uses the subscription login, not an API key or a gateway) and
 * without the parent session's Claude Code state.
 */
export function buildClaudeCodeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (!isStrippedEnv(name)) out[name] = value;
  }
  return out;
}

/** The `claude -p` argv for one lane run. Everything lane-specific comes from `spec`. */
export function buildClaudeCodeArgv(opts: {
  spec: LaneSpec;
  model: string;
  effort: string;
  mcpCommand: string[];
  message: string;
}): string[] {
  const { spec } = opts;
  const builtins = claudeCodeBuiltinTools(spec);
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
    claudeCodeSystemPromptFile(spec),
    "--setting-sources",
    "",
    "--restricted",
    "--settings",
    settings,
    "--strict-mcp-config",
    "--mcp-config",
    mcpConfig,
    "--tools",
    builtins.join(","),
    "--allowedTools",
    [...builtins, ...MCP_TOOLS.map((t) => `${MCP_PREFIX}${t}`)].join(","),
    "--permission-mode",
    "dontAsk",
    // The OpenCode lane's step cap (`spec.steps`). A capped run ends
    // `error_max_turns`, which fails the lane.
    "--max-turns",
    String(spec.steps),
    "--disable-slash-commands",
    "--no-session-persistence",
    "--output-format",
    "stream-json",
    "--verbose",
  ];
}

/** The lane's generated system prompt, next to its OpenCode config. */
export function claudeCodeSystemPromptFile(spec: LaneSpec): string {
  return resolve(dirname(resolveLaneConfigPath(spec)), spec.promptFilename);
}

/** The OpenCode message plus the tool-name mapping the shared prompt needs on this client. */
function buildClaudeCodeMessage(baseRef: string): string {
  const mapping = MCP_TOOLS.map((t) => `\`warden_${t}\` is \`${MCP_PREFIX}${t}\``).join(", ");
  return `${buildLaneMessage(baseRef)} Tool names on this client: ${mapping}.`;
}

interface ParsedClaudeCodeLane {
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
function parseClaudeCodeEvents(stdout: string): ParsedClaudeCodeLane {
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
    if (!isRecord(event)) continue;
    const record = event;
    const type = record["type"];
    if (type === "system" && record["subtype"] === "init") {
      const model = z.string().safeParse(record["model"]);
      if (model.success) initModel = model.data;
      const servers = Array.isArray(record["mcp_servers"]) ? record["mcp_servers"] : [];
      const warden = servers.filter(isRecord).find((s) => s["name"] === "warden");
      if (warden?.["status"] !== "connected") {
        errors.push(`warden MCP server not connected (status: ${String(warden?.["status"])})`);
      }
    } else if (type === "assistant" || type === "user") {
      const message = record["message"];
      const content =
        isRecord(message) && Array.isArray(message["content"]) ? message["content"] : [];
      for (const b of content) {
        const block = ContentBlockSchema.safeParse(b);
        if (!block.success) continue;
        if (block.data.type === "tool_use") {
          const name = normalizeToolName(block.data.name);
          if (block.data.id !== undefined) toolNameById.set(block.data.id, name);
          seen.set(name, (seen.get(name) ?? 0) + 1);
        } else {
          const name = toolNameById.get(block.data.tool_use_id);
          if (name !== undefined && block.data.is_error !== true) {
            completed.set(name, (completed.get(name) ?? 0) + 1);
          }
        }
      }
    } else if (type === "result") {
      if (record["is_error"] === true || record["subtype"] !== "success") {
        errors.push(`result ${String(record["subtype"])}`);
      }
      const result = z.string().safeParse(record["result"]);
      if (result.success) resultText = result.data;
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
 * The message content blocks that the parser counts. A block of another
 * type, or a block with a field of the wrong type, is skipped.
 */
const ContentBlockSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("tool_use"),
    name: z.string(),
    id: z.string().optional().catch(undefined),
  }),
  z.object({ type: z.literal("tool_result"), tool_use_id: z.string(), is_error: z.unknown() }),
]);

/**
 * The `result` event fields that `parseResultUsage` reads. The claude stream
 * has no schema that warden owns, so this one names only the fields read. A
 * cost and the four token counts are required; the reasoning count and the
 * `modelUsage` map read as absent when their type is wrong.
 */
const ClaudeResultUsageSchema = z.object({
  total_cost_usd: z.number().nonnegative(),
  usage: z.object({
    input_tokens: z.number(),
    output_tokens: z.number(),
    cache_read_input_tokens: z.number(),
    cache_creation_input_tokens: z.number(),
    output_tokens_details: z
      .object({ thinking_tokens: z.number().optional().catch(undefined) })
      .optional()
      .catch(undefined),
  }),
  modelUsage: z.record(z.string(), z.unknown()).optional().catch(undefined),
});

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
  record: unknown,
  initModel: string | undefined,
): SessionUsage | undefined {
  const parsed = ClaudeResultUsageSchema.safeParse(record);
  if (!parsed.success) return undefined;
  const { total_cost_usd: cost, usage, modelUsage } = parsed.data;
  const models = modelUsage !== undefined ? Object.keys(modelUsage) : [];
  const model = models.length > 0 ? models.join(",") : initModel;
  return {
    costUsd: cost,
    tokens: {
      input: usage.input_tokens,
      output: usage.output_tokens,
      reasoning: usage.output_tokens_details?.thinking_tokens ?? 0,
      cacheRead: usage.cache_read_input_tokens,
      cacheWrite: usage.cache_creation_input_tokens,
    },
    ...(model !== undefined ? { model } : {}),
  };
}

export interface ClaudeCodeDriveOptions {
  repoRoot: string;
  /** The lane to run. Absent means `DOWN_LANE_SPEC`. */
  lane?: LaneSpec;
  baseRef?: string;
  model?: string;
  effort?: string;
  timeoutSecs?: number;
  /** Override for the smoke's fake executable. Absent means `claude` on `PATH`. */
  claudeBin?: string;
}

/**
 * Mirrors `driveOpencodeLane`: resolve the diff, derive the trusted
 * scope, run the lane, build the driver-owned envelope, and return the
 * `runPostPass` CommentSet. No MCP warmup step: `claude -p` connects MCP
 * servers before the first turn, and the init event reports the status.
 *
 * No scope ceiling: unlike `driveOpencodeLane`, this lane never applied
 * `laneScopeOverCeiling`, and the down path keeps that behavior. A scope
 * that the turn cap cannot fund ends `error_max_turns`, a failed lane.
 */
export async function driveClaudeCodeLane(opts: ClaudeCodeDriveOptions): Promise<DriveLaneResult> {
  const spec = opts.lane ?? DOWN_LANE_SPEC;
  const resolved = await resolveDiff({
    repoRoot: opts.repoRoot,
    mode: "review",
    ...(opts.baseRef !== undefined ? { baseRef: opts.baseRef } : {}),
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
        lane: spec.lane,
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
    spec,
    model: opts.model ?? CLAUDE_CODE_DEFAULT_MODEL,
    effort: opts.effort ?? CLAUDE_CODE_DEFAULT_EFFORT,
    mcpCommand: resolveWardenMcpCommand(),
    message: buildClaudeCodeMessage(baseRef),
  });
  const processResult = await spawnClaude(
    opts.claudeBin ?? "claude",
    argv,
    opts.repoRoot,
    buildClaudeCodeEnv(process.env),
    opts.timeoutSecs ?? DEFAULT_LANE_TIMEOUT_SECS,
  );
  const { parsed, usage } = parseClaudeCodeEvents(processResult.stdout);
  const verdict = evaluateLane(parsed, processResult);
  return await publish(
    {
      lane: spec.lane,
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
  bin: string,
  argv: string[],
  cwd: string,
  env: Record<string, string | undefined>,
  timeoutSecs: number,
): Promise<LaneProcessResult> {
  return new Promise((resolveP) => {
    // stdin is closed: `claude -p` waits on an open stdin before it starts.
    const child = spawn(bin, argv, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
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
    timer.unref();
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

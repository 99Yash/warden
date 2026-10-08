import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
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
export const DEFAULT_LANE_TIMEOUT_SECS = 900;

export interface OpencodeCommand {
  /** Binary to spawn (`opencode` on PATH, or a fake in the smoke). */
  bin: string;
  argv: string[];
}

/** `opencode run` never applies `agent.model` — the driver always passes `--model`. No `--auto`: an unexpected ask must fail closed. */
export function buildOpencodeCommand(opts: {
  bin?: string;
  model: string;
  message: string;
}): OpencodeCommand {
  return {
    bin: opts.bin ?? "opencode",
    argv: [
      "run",
      "--standalone",
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
  if (process.timedOut) return fail("opencode run timed out");
  if (process.exitCode !== 0) return fail(`opencode run exited ${process.exitCode}`);
  if (parsed.errors.length > 0) return fail(`opencode run error event: ${parsed.errors[0]}`);
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

export interface DriveOptions {
  repoRoot: string;
  baseRef?: string;
  model?: string;
  json?: boolean;
  verbose?: boolean;
  volumeCap?: number;
  lanesOut?: string;
  timeoutSecs?: number;
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
  const command = buildOpencodeCommand({
    model,
    message: buildLaneMessage(baseRef),
    ...(opts.opencodeBin !== undefined ? { bin: opts.opencodeBin } : {}),
  });
  const configPath = resolveLaneConfigPath();
  const childEnv: Record<string, string | undefined> = {
    ...process.env,
    [OPENCODE_AGENT_ENV]: configPath,
    [OPENCODE_PROJECT_DISABLE_ENV]: "1",
    [OPENCODE_CONTENT_ENV]: buildMcpConfigContent({
      command: resolveWardenMcpCommand(),
      cwd: opts.repoRoot,
    }),
  };
  const processResult = await spawnLane(command, opts.repoRoot, childEnv, timeoutSecs);
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
  if (opts.lanesOut !== undefined) {
    writeFileSync(
      resolve(opts.repoRoot, opts.lanesOut),
      JSON.stringify({ version: 1, lanes }, null, 2) + "\n",
    );
  }
  await publish(lanes, [
    ...(resolved.degraded ?? []),
    {
      kind: "info",
      topic: "lane-trace",
      message: `lane-trace: down ${verdict.status}${verdict.reason !== undefined ? ` (${verdict.reason})` : ""} — ${traceCounts === "" ? "no tool calls" : traceCounts}`,
    },
  ]);
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
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolveP({ exitCode: -1, stdout, timedOut: true });
    }, timeoutSecs * 1000);
    // Unref'd so the timer never holds the loop open on its own.
    timer.unref?.();
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveP({ exitCode: -1, stdout, timedOut: false });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveP({ exitCode: code ?? -1, stdout, timedOut: false });
    });
  });
}

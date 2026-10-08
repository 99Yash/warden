/**
 * Slice #42 / ADR-0053 §9: the down lane + driver smoke. No LLM, no
 * network. The materializer, parser, and command builder are unit-tested
 * directly; the driver end-to-end runs against a fake `opencode`
 * executable first on PATH inside a temp git repo with a real change.
 *
 * Usage: pnpm --filter @warden/cli smoke:opencode-lanes
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { CommentSetSchema, LaneFindingSchema, isNotClean, type CommentSet } from "@warden/core";
import {
  DOWN_LANE_SPEC,
  LANE_MCP_TOOLS,
  materializeLane,
  extractSection,
  type MaterializeInput,
} from "../src/opencode/materialize.js";
import {
  buildLaneMessage,
  buildMcpConfigContent,
  buildOpencodeCommand,
  evaluateLane,
  parseLaneEvents,
  resolveLoaderFlags,
  resolveWardenMcpCommand,
} from "../src/opencode/drive.js";

const CLI_ROOT = fileURLToPath(new URL("..", import.meta.url));
const TMP_ROOT = mkdtempSync(resolve(tmpdir(), "warden-opencode-lanes-"));

let failed = 0;
function assert(cond: unknown, msg: string): void {
  if (cond) {
    process.stdout.write(`  ✓ ${msg}\n`);
  } else {
    process.stdout.write(`  ✗ ${msg}\n`);
    failed++;
  }
}

function readCommitted(rel: string): string {
  return readFileSync(resolve(CLI_ROOT, rel), "utf8");
}

function materializeInput(): MaterializeInput {
  const charter = readFileSync(
    resolve(CLI_ROOT, "..", "..", "docs/reference/lanes/down.md"),
    "utf8",
  );
  const sources = new Map<string, string>();
  for (const include of DOWN_LANE_SPEC.includes) {
    if (!sources.has(include.file)) {
      sources.set(include.file, readFileSync(resolve(CLI_ROOT, "..", "..", include.file), "utf8"));
    }
  }
  return { charter, sources };
}

function stripKeys(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env };
  for (const k of [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GOOGLE_GENERATIVE_AI_API_KEY",
    "GEMINI_API_KEY",
    "VOYAGE_API_KEY",
  ]) {
    delete next[k];
  }
  next["WARDEN_CACHE_PATH"] = resolve(TMP_ROOT, ".warden/cache.sqlite");
  next["XDG_CONFIG_HOME"] = resolve(TMP_ROOT, ".config");
  return next;
}

function textEvent(text: string): string {
  return JSON.stringify({
    type: "text",
    timestamp: 2,
    sessionID: "s",
    part: { type: "text", text },
  });
}

function toolEvent(name: string, status = "completed"): string {
  return JSON.stringify({
    type: "tool_use",
    timestamp: 1,
    sessionID: "s",
    part: { type: "tool", id: "t1", name, state: { status }, time: {} },
  });
}

function submissionText(findings: unknown[]): string {
  return `Triage complete.\n\`\`\`json\n${JSON.stringify({ findings })}\n\`\`\``;
}

try {
  const input = materializeInput();

  // ---------------------------------------------------------------------------
  // [1] materializer is deterministic; --check passes on committed files.
  // ---------------------------------------------------------------------------
  process.stdout.write("\n[1] determinism — two runs, identical bytes; --check passes\n");
  const runA = materializeLane(DOWN_LANE_SPEC, input);
  const runB = materializeLane(DOWN_LANE_SPEC, materializeInput());
  assert(runA.prompt === runB.prompt, "prompt bytes identical across runs");
  assert(runA.configJson === runB.configJson, "config bytes identical across runs");
  assert(
    runA.prompt === readCommitted("opencode/warden-down.md"),
    "prompt matches the committed warden-down.md",
  );
  assert(
    runA.configJson === readCommitted("opencode/opencode.json"),
    "config matches the committed opencode.json",
  );
  let checkFailed = false;
  try {
    execFileSync(
      process.execPath,
      [
        "--import",
        import.meta.resolve("tsx/esm"),
        resolve(CLI_ROOT, "scripts/materialize-lanes.mts"),
        "--check",
      ],
      { cwd: CLI_ROOT, stdio: "pipe", encoding: "utf8" },
    );
  } catch {
    checkFailed = true;
  }
  assert(!checkFailed, "lanes:check exits 0 on the committed tree");

  // ---------------------------------------------------------------------------
  // [2] drift — a changed byte or a changed source section breaks the match.
  // ---------------------------------------------------------------------------
  process.stdout.write("\n[2] drift — one changed byte fails the byte comparison\n");
  const driftedPrompt = `${runA.prompt} `;
  assert(
    driftedPrompt !== readCommitted("opencode/warden-down.md"),
    "one appended byte breaks the prompt match",
  );
  const driftedConfig = runA.configJson.replace('"primary"', '"subagent"');
  assert(
    driftedConfig !== readCommitted("opencode/opencode.json"),
    "one changed value breaks the config match",
  );
  const changedSources = new Map(input.sources);
  const firstFile = DOWN_LANE_SPEC.includes[0]?.file as string;
  const firstHeading = DOWN_LANE_SPEC.includes[0]?.heading as string;
  changedSources.set(
    firstFile,
    (input.sources.get(firstFile) as string).replace(
      `${firstHeading}\n`,
      `${firstHeading}\nExtra line.\n`,
    ),
  );
  const driftedSource = materializeLane(DOWN_LANE_SPEC, {
    charter: input.charter,
    sources: changedSources,
  });
  assert(
    driftedSource.prompt !== readCommitted("opencode/warden-down.md"),
    "a changed source section changes the prompt bytes",
  );

  // ---------------------------------------------------------------------------
  // [3] missing heading throws naming file + heading.
  // ---------------------------------------------------------------------------
  process.stdout.write("\n[3] missing heading — throws naming file + heading\n");
  let missingErr = "";
  try {
    extractSection("# Real\n\nbody\n", "some/file.md", "## Absent heading");
  } catch (err) {
    missingErr = err instanceof Error ? err.message : String(err);
  }
  assert(
    missingErr.includes("some/file.md") && missingErr.includes("## Absent heading"),
    `throw names file + heading (${missingErr})`,
  );

  // ---------------------------------------------------------------------------
  // [4] generated config — deny-first, read-only, codemode off, schema in prompt.
  // ---------------------------------------------------------------------------
  process.stdout.write("\n[4] config — deny-first permissions, codemode false, schema embedded\n");
  const config = JSON.parse(runA.configJson) as Record<string, unknown>;
  const agent = (config["agents"] as Record<string, Record<string, unknown>>)[
    DOWN_LANE_SPEC.agentId
  ];
  assert(agent !== undefined, `agent ${DOWN_LANE_SPEC.agentId} exists`);
  const permissions = agent?.["permissions"] as Array<Record<string, string>>;
  assert(
    permissions[0]?.action === "*" &&
      permissions[0]?.resource === "*" &&
      permissions[0]?.effect === "deny",
    "first permission rule denies every tool",
  );
  const allowed = permissions.filter((p) => p.effect === "allow").map((p) => p.action);
  const wantAllowed = [...DOWN_LANE_SPEC.allowedTools, ...LANE_MCP_TOOLS];
  assert(
    allowed.length === wantAllowed.length && wantAllowed.every((t) => allowed.includes(t)),
    `allows exactly the lane spec tools (${allowed.join(",")})`,
  );
  for (const banned of ["shell", "edit", "webfetch", "subagent", "*"]) {
    assert(!allowed.includes(banned), `no allow for ${banned}`);
  }
  const servers = (config["mcp"] as Record<string, Record<string, Record<string, unknown>>>)[
    "servers"
  ];
  assert(servers?.["warden"]?.["codemode"] === false, "warden MCP server runs with codemode:false");
  assert(agent?.["mode"] === "primary", "agent mode is primary (--agent selects it regardless)");
  assert(
    typeof agent?.["model"] === "string",
    "agent carries a model default (--model still required: run ignores it)",
  );
  const schemaJson = JSON.stringify(z.toJSONSchema(LaneFindingSchema), null, 2);
  assert(runA.prompt.includes(schemaJson), "prompt embeds the rendered LaneFindingSchema");
  assert(
    runA.prompt.startsWith("<!-- GENERATED by pnpm lanes:materialize"),
    "prompt starts with the generated-file banner",
  );

  // ---------------------------------------------------------------------------
  // [5] parser — ok, last-block-wins, distinct failure reasons, tool counting.
  // ---------------------------------------------------------------------------
  process.stdout.write("\n[5] parser — verdicts and tool-call counts\n");
  const goodFinding = {
    file: "src/a.ts",
    lineStart: 1,
    lineEnd: 1,
    tier: 2,
    category: "correctness",
    kind: "assertion",
    claim: "smoke claim",
    explanation: "smoke explanation",
    sources: [],
    confidence: 0.9,
  };
  const okEvents = parseLaneEvents(
    [
      toolEvent("warden_run_det_priors"),
      toolEvent("read"),
      textEvent(submissionText([goodFinding])),
    ].join("\n"),
  );
  const okVerdict = evaluateLane(okEvents, { exitCode: 0, stdout: "", timedOut: false });
  assert(okVerdict.status === "ok", "valid submission with a det-priors call → ok");
  assert(
    okVerdict.toolCalls.some((t) => t.name === "warden_run_det_priors" && t.completed === 1),
    "tool-call counts record completed det-priors calls",
  );

  const twoBlocks = parseLaneEvents(
    [
      toolEvent("warden_run_det_priors"),
      textEvent(
        `${submissionText([{ ...goodFinding, claim: "first" }])}\nAfterthought:\n${submissionText([{ ...goodFinding, claim: "last" }])}`,
      ),
    ].join("\n"),
  );
  const twoVerdict = evaluateLane(twoBlocks, { exitCode: 0, stdout: "", timedOut: false });
  assert(
    twoVerdict.status === "ok" &&
      (twoVerdict.findings[0] as Record<string, unknown>)["claim"] === "last",
    "two fenced blocks → the last wins",
  );

  const cases: Array<{
    name: string;
    stdout: string;
    process: { exitCode: number; timedOut: boolean };
    reason: string;
  }> = [
    {
      name: "no block",
      stdout: textEvent("looks clean to me"),
      process: { exitCode: 0, timedOut: false },
      reason: "no fenced json submission",
    },
    {
      name: "bad JSON",
      stdout: textEvent("```json\n{not json\n```"),
      process: { exitCode: 0, timedOut: false },
      reason: "not valid JSON",
    },
    {
      name: "no findings array",
      stdout: textEvent(submissionText([]).replace('"findings"', '"comments"')),
      process: { exitCode: 0, timedOut: false },
      reason: 'no "findings" array',
    },
    {
      name: "error event",
      stdout: [
        toolEvent("warden_run_det_priors"),
        '{"type":"error","error":{"message":"boom"}}',
      ].join("\n"),
      process: { exitCode: 0, timedOut: false },
      reason: "error event",
    },
    {
      name: "non-zero exit",
      stdout: textEvent(submissionText([goodFinding])),
      process: { exitCode: 1, timedOut: false },
      reason: "exited 1",
    },
    {
      name: "timeout",
      stdout: textEvent(submissionText([goodFinding])),
      process: { exitCode: -1, timedOut: true },
      reason: "timed out",
    },
    {
      name: "no det-priors call",
      stdout: [toolEvent("read"), textEvent(submissionText([goodFinding]))].join("\n"),
      process: { exitCode: 0, timedOut: false },
      reason: "no completed warden_run_det_priors call",
    },
  ];
  for (const c of cases) {
    const verdict = evaluateLane(parseLaneEvents(c.stdout), { ...c.process, stdout: c.stdout });
    assert(
      verdict.status === "failed" &&
        (verdict.reason ?? "").includes(c.reason.split(" ")[0] as string),
      `${c.name} → failed (${verdict.reason ?? "no reason"})`,
    );
  }
  // A started-but-never-completed det-priors call does not satisfy the gate.
  const runningOnly = evaluateLane(
    parseLaneEvents(
      [
        toolEvent("warden_run_det_priors", "running"),
        textEvent(submissionText([goodFinding])),
      ].join("\n"),
    ),
    { exitCode: 0, stdout: "", timedOut: false },
  );
  assert(runningOnly.status === "failed", "non-completed det-priors call still fails the lane");

  // ---------------------------------------------------------------------------
  // [6] command builder + MCP command — argv shape, loader resolution.
  // ---------------------------------------------------------------------------
  process.stdout.write("\n[6] command — argv shape and warden MCP command\n");
  const cmd = buildOpencodeCommand({ model: "anthropic/claude-opus-5-5#high", message: "hello" });
  assert(cmd.bin === "opencode", "default binary is opencode");
  for (const want of [
    "run",
    "--standalone",
    "--agent",
    "warden-down",
    "--model",
    "--format",
    "json",
  ]) {
    assert(cmd.argv.includes(want), `argv includes ${want}`);
  }
  assert(!cmd.argv.includes("--auto"), "argv never passes --auto (unexpected asks fail closed)");
  assert(cmd.argv[cmd.argv.length - 1] === "hello", "message is the last argv entry");
  assert(
    buildLaneMessage("origin/main").includes("origin/main"),
    "lane message names the base ref",
  );
  const content = JSON.parse(
    buildMcpConfigContent({ command: ["node", "x", "mcp"], cwd: "/tmp/r" }),
  ) as Record<string, Record<string, Record<string, Record<string, unknown>>>>;
  assert(
    Array.isArray(content["mcp"]?.["servers"]?.["warden"]?.["command"]),
    "config content overrides only the warden MCP command/cwd",
  );
  const mcpCommand = resolveWardenMcpCommand();
  assert(mcpCommand[mcpCommand.length - 1] === "mcp", "warden MCP command ends with the mcp verb");
  assert(mcpCommand[0] === process.execPath, "warden MCP command launches this exact node");
  const flags = resolveLoaderFlags(["--import", "tsx/esm", "--other"]);
  assert(
    (flags[1] as string).startsWith("/") && flags[1] !== "tsx/esm",
    `bare tsx/esm resolves to an absolute path (${flags[1]})`,
  );

  // ---------------------------------------------------------------------------
  // [7] driver end-to-end with a fake opencode.
  // ---------------------------------------------------------------------------
  process.stdout.write("\n[7] driver — fake opencode end-to-end in a temp git repo\n");
  const REPO = mkdtempSync(resolve(tmpdir(), "warden-lanes-repo-"));
  const FAKE_BIN = mkdtempSync(resolve(tmpdir(), "warden-lanes-bin-"));
  const SRC = "src/a.ts";
  const V1 = [
    "export function add(a: number, b: number): number {",
    "  return a + b;",
    "}",
    "",
  ].join("\n");
  const ADDED = "export const extra = 1;";
  const V2 = `${V1}${ADDED}\n`;
  const git = (args: string[]): void => {
    execFileSync("git", args, { cwd: REPO, stdio: "ignore" });
  };
  git(["init"]);
  git(["config", "user.email", "smoke@example.com"]);
  git(["config", "user.name", "smoke"]);
  execFileSync("mkdir", ["-p", resolve(REPO, "src")]);
  writeFileSync(resolve(REPO, SRC), V1);
  git(["add", "-A"]);
  git(["commit", "-m", "v1"]);
  writeFileSync(resolve(REPO, SRC), V2);
  git(["add", "-A"]);
  git(["commit", "-m", "v2"]);

  // The fake asserts the driver's argv/env contract, then plays canned
  // JSONL per WARDEN_SMOKE_MODE. Any contract breach exits non-zero.
  const fakePath = resolve(FAKE_BIN, "opencode");
  writeFileSync(
    fakePath,
    `#!/usr/bin/env node
import { existsSync, writeFileSync } from "node:fs";
const argv = process.argv.slice(2);
const fail = (msg) => { process.stderr.write("fake opencode: " + msg + "\\n"); process.exit(3); };
const has = (flag, value) => {
  const i = argv.indexOf(flag);
  return value === undefined ? i !== -1 : argv[i + 1] === value;
};
if (argv[0] !== "run") fail("first argv must be run");
for (const w of ["--standalone", "--format"]) if (!has(w)) fail("missing " + w);
if (!has("--agent", "warden-down")) fail("wrong agent");
if (!has("--model") || (argv[argv.indexOf("--model") + 1] ?? "").length === 0) fail("missing --model value");
if (has("--auto")) fail("--auto must not be passed");
if (!existsSync(process.env.OPENCODE_CONFIG ?? "")) fail("OPENCODE_CONFIG does not exist");
if (process.env.OPENCODE_DISABLE_PROJECT_CONFIG !== "1") fail("project config not disabled");
let content;
try {
  content = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? "");
} catch { fail("OPENCODE_CONFIG_CONTENT is not JSON"); }
const wardenCmd = content?.mcp?.servers?.warden?.command;
if (!Array.isArray(wardenCmd) || !wardenCmd.some((p) => String(p).endsWith("mcp"))) fail("warden MCP command missing");
if (process.env.WARDEN_SMOKE_MARKER !== undefined) writeFileSync(process.env.WARDEN_SMOKE_MARKER, "invoked\\n");
const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
const text = (t) => emit({ type: "text", timestamp: 2, sessionID: "s", part: { type: "text", text: t } });
const tool = (name, status = "completed") =>
  emit({ type: "tool_use", timestamp: 1, sessionID: "s", part: { type: "tool", id: "t", name, state: { status }, time: {} } });
const mode = process.env.WARDEN_SMOKE_MODE ?? "ok";
const finding = JSON.parse(process.env.WARDEN_SMOKE_FINDING ?? "null");
const fence = String.fromCharCode(96).repeat(3);
const block = (findings) => "Triage.\\n" + fence + "json\\n" + JSON.stringify({ findings }) + "\\n" + fence;
if (mode === "ok" || mode === "notools" || mode === "outofscope") {
  if (mode !== "notools") tool("warden_run_det_priors");
  tool("read");
  text(block(mode === "outofscope" ? [{ ...finding, file: "src/other.ts" }] : [finding]));
} else if (mode === "nosubmission") {
  tool("warden_run_det_priors");
  text("looks clean to me, no block here");
}
`,
  );
  chmodSync(fakePath, 0o755);

  const inScopeFinding = {
    file: SRC,
    lineStart: 4,
    lineEnd: 4,
    tier: 2,
    category: "correctness",
    kind: "assertion",
    claim: "smoke: extra export is unused",
    explanation: "smoke explanation",
    sources: [
      {
        type: "tool",
        id: "t",
        title: "t",
        retrievedAt: "2026-10-08T00:00:00.000Z",
        path: SRC,
        line: 4,
        snippet: ADDED,
      },
    ],
    confidence: 0.9,
  };

  const runDriver = (
    args: string[],
    extraEnv: Record<string, string> = {},
  ): { exit: number; out: string } => {
    try {
      const out = execFileSync(
        process.execPath,
        [
          "--import",
          import.meta.resolve("tsx/esm"),
          resolve(CLI_ROOT, "src/index.ts"),
          "opencode-review",
          ...args,
        ],
        {
          cwd: REPO,
          env: {
            ...stripKeys(process.env),
            PATH: `${FAKE_BIN}:${process.env["PATH"] ?? ""}`,
            WARDEN_SMOKE_FINDING: JSON.stringify(inScopeFinding),
            ...extraEnv,
          },
          encoding: "utf8",
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      return { exit: 0, out: out as string };
    } catch (err) {
      const e = err as { status?: number; stdout?: string };
      return { exit: e.status ?? -1, out: e.stdout ?? "" };
    }
  };

  const parseOut = (out: string): CommentSet | undefined => {
    try {
      const parsed = CommentSetSchema.safeParse(JSON.parse(out));
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  };

  const okRun = runDriver(["--base", "HEAD~1", "--json", "--lanes-out", "lanes.json"]);
  const okSet = parseOut(okRun.out);
  assert(okRun.exit === 0, `in-scope submission exits 0 (got ${okRun.exit})`);
  assert(
    okSet?.comments.some((c) => c.claim === inScopeFinding.claim) === true,
    "in-scope submission publishes the comment",
  );
  assert(
    okSet?.metadata.degradedWorkers.some(
      (d) => d.topic === "lane-trace" && d.message.includes("warden_run_det_priors"),
    ) === true,
    "lane-trace entry records the tool-call counts",
  );
  let lanesOut: { version: number; lanes: Array<{ lane: string; status: string }> } | undefined;
  try {
    lanesOut = JSON.parse(readFileSync(resolve(REPO, "lanes.json"), "utf8"));
  } catch {
    lanesOut = undefined;
  }
  assert(
    lanesOut?.version === 1 &&
      lanesOut.lanes[0]?.lane === "down" &&
      lanesOut.lanes[0]?.status === "ok",
    "--lanes-out carries the down/ok envelope for replay",
  );

  const noSub = runDriver(["--base", "HEAD~1", "--json"], { WARDEN_SMOKE_MODE: "nosubmission" });
  const noSubSet = parseOut(noSub.out);
  assert(noSub.exit === 1, `no submission exits 1 (got ${noSub.exit})`);
  assert(
    noSubSet?.metadata.degradedWorkers.some(
      (d) => d.kind === "actionable" && d.topic === "lane-health",
    ) === true,
    "no submission carries an actionable lane-health entry",
  );

  const oos = runDriver(["--base", "HEAD~1", "--json"], { WARDEN_SMOKE_MODE: "outofscope" });
  const oosSet = parseOut(oos.out);
  assert(oos.exit === 1, `out-of-scope-only submission exits 1 (got ${oos.exit})`);
  assert(
    oosSet?.comments.length === 0 &&
      oosSet.metadata.degradedWorkers.some((d) => d.topic === "lane-health") === true,
    "out-of-scope finding drops and the lane is unhealthy",
  );

  const noTools = runDriver(["--base", "HEAD~1", "--json"], { WARDEN_SMOKE_MODE: "notools" });
  const noToolsSet = parseOut(noTools.out);
  assert(noTools.exit === 1, `no det-priors call exits 1 (got ${noTools.exit})`);
  assert(
    noToolsSet?.metadata.degradedWorkers.some(
      (d) => d.topic === "lane-health" && d.message.includes("warden_run_det_priors"),
    ) === true,
    "missing det-priors call names the gate in lane-health",
  );

  const marker = resolve(TMP_ROOT, "fake-invoked");
  const empty = runDriver(["--base", "HEAD", "--json"], { WARDEN_SMOKE_MARKER: marker });
  const emptySet = parseOut(empty.out);
  assert(empty.exit === 1, `empty diff exits 1 (got ${empty.exit})`);
  let markerHit = false;
  try {
    readFileSync(marker, "utf8");
    markerHit = true;
  } catch {
    markerHit = false;
  }
  assert(!markerHit, "empty diff never spawns OpenCode");
  assert(
    emptySet?.metadata.degradedWorkers.some(
      (d) =>
        d.kind === "actionable" &&
        d.topic === "lane-health" &&
        d.message.includes("empty review target"),
    ) === true,
    "empty diff fails the lane with empty review target",
  );
  rmSync(REPO, { recursive: true, force: true });
  rmSync(FAKE_BIN, { recursive: true, force: true });

  // ---------------------------------------------------------------------------
  // [8] isNotClean truth table.
  // ---------------------------------------------------------------------------
  process.stdout.write("\n[8] isNotClean — actionable lane-health/diff-source only\n");
  const mkSet = (entries: CommentSet["metadata"]["degradedWorkers"]): CommentSet => ({
    comments: [],
    metadata: { durationMs: 0, degradedWorkers: entries },
  });
  assert(
    isNotClean(mkSet([{ kind: "actionable", topic: "lane-health", message: "x" }])) === true,
    "actionable lane-health → not clean",
  );
  assert(
    isNotClean(mkSet([{ kind: "actionable", topic: "diff-source", message: "x" }])) === true,
    "actionable diff-source → not clean",
  );
  assert(
    isNotClean(mkSet([{ kind: "warning", topic: "lane-health", message: "x" }])) === false,
    "warning lane-health → clean",
  );
  assert(
    isNotClean(mkSet([{ kind: "actionable", topic: "noise-filter", message: "x" }])) === false,
    "other actionable topics do not gate",
  );
  assert(isNotClean(mkSet([])) === false, "no entries → clean");
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

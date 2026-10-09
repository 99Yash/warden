/**
 * Slice #42 / ADR-0053 §9: the down lane + driver smoke. No LLM, no
 * network. The materializer, parser, and command builder are unit-tested
 * directly; the driver end-to-end runs against a fake `opencode`
 * executable first on PATH inside a temp git repo with a real change.
 *
 * Usage: pnpm --filter @warden/cli smoke:opencode-lanes
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
  parseCharterIncludes,
  type MaterializeInput,
} from "../src/opencode/materialize.js";
import {
  buildLaneMessage,
  buildMcpConfigContent,
  buildOpencodeCommand,
  buildOpencodeServeCommand,
  driveOpencodeLane,
  evaluateLane,
  parseLaneEvents,
  parseMcpServers,
  parseSessionUsage,
  resolveLoaderFlags,
  resolveWardenMcpCommand,
  waitForWardenMcp,
  wardenMcpReadiness,
} from "../src/opencode/drive.js";
import { isOpencodeCostMeasured } from "./eval/score.mjs";

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
  for (const include of parseCharterIncludes(charter)) {
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

function textEvent(text: string, messageID?: string): string {
  return JSON.stringify({
    type: "text",
    timestamp: 2,
    sessionID: "s",
    part: {
      type: "text",
      text,
      ...(messageID !== undefined ? { messageID } : {}),
    },
  });
}

function stepEvent(messageID: string): string {
  return JSON.stringify({
    type: "step_start",
    timestamp: 1,
    sessionID: "s",
    part: {
      type: "step-start",
      messageID,
    },
  });
}

function toolEvent(name: string, status = "completed", messageID = "m"): string {
  // Real wire shape is `part.tool` (verified against a live `--format json`
  // stream); the driver also tolerates `part.name`. Every part carries the
  // step's `messageID`.
  return JSON.stringify({
    type: "tool_use",
    timestamp: 1,
    sessionID: "s",
    part: { type: "tool", id: "t1", tool: name, messageID, state: { status }, time: {} },
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
  const charterIncludes = parseCharterIncludes(input.charter);
  const firstFile = charterIncludes[0]?.file as string;
  const firstHeading = charterIncludes[0]?.heading as string;
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
  // A charter that names a missing section fails materialization naming
  // the charter line (the fence entry below no longer matches any heading
  // in the method source).
  let charterErr = "";
  try {
    materializeLane(DOWN_LANE_SPEC, {
      charter: input.charter.replace(":: ## Three review motions", ":: ## No such section"),
      sources: input.sources,
    });
  } catch (err) {
    charterErr = err instanceof Error ? err.message : String(err);
  }
  assert(
    charterErr.includes("down.md") && charterErr.includes("## No such section"),
    `charter include of a missing section fails naming file + heading (${charterErr})`,
  );
  // A second `includes` fence is rejected: two lists would be two homes for
  // the same fact, and only the first would take effect.
  let secondFenceErr = "";
  try {
    materializeLane(DOWN_LANE_SPEC, {
      charter: `${input.charter}\n\`\`\`includes\n${firstFile} :: ${firstHeading}\n\`\`\`\n`,
      sources: input.sources,
    });
  } catch (err) {
    secondFenceErr = err instanceof Error ? err.message : String(err);
  }
  assert(
    secondFenceErr.includes("second includes fence"),
    `a second includes fence fails closed (${secondFenceErr})`,
  );
  // A duplicate entry ships the section twice, so it is rejected too.
  const firstEntry = `${firstFile} :: ${firstHeading}`;
  let duplicateErr = "";
  try {
    materializeLane(DOWN_LANE_SPEC, {
      charter: input.charter.replace(firstEntry, `${firstEntry}\n${firstEntry}`),
      sources: input.sources,
    });
  } catch (err) {
    duplicateErr = err instanceof Error ? err.message : String(err);
  }
  assert(
    duplicateErr.includes("duplicate includes entry"),
    `a duplicate includes entry fails closed (${duplicateErr})`,
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
    allowed.length === wantAllowed.length + 1 && wantAllowed.every((t) => allowed.includes(t)),
    `allows the lane spec tools plus the .env.example carve-out (${allowed.join(",")})`,
  );
  // The `.env` guard sits after `allow read` and before the MCP allows:
  // agent rules append after global rules and the last match wins, so a
  // bare `allow read *` would otherwise re-open secret files.
  const ruleShape = permissions.map((p) => `${p.effect} ${p.action} ${p.resource}`);
  assert(
    ruleShape[1] === "allow read *" &&
      ruleShape[2] === "allow grep *" &&
      ruleShape[3] === "allow glob *" &&
      ruleShape[4] === "deny read *.env" &&
      ruleShape[5] === "deny read *.env.*" &&
      ruleShape[6] === "allow read *.env.example",
    `read allow is followed by the .env deny guard (${ruleShape.slice(1, 7).join(" | ")})`,
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
      stepEvent("m-ok"),
      toolEvent("warden_run_det_priors", "completed", "m-ok"),
      toolEvent("read", "completed", "m-ok"),
      textEvent(submissionText([goodFinding]), "m-ok"),
    ].join("\n"),
  );
  const okVerdict = evaluateLane(okEvents, { exitCode: 0, stdout: "", timedOut: false });
  assert(okVerdict.status === "ok", "valid submission with a det-priors call → ok");
  assert(
    okVerdict.toolCalls.some((t) => t.name === "warden_run_det_priors" && t.completed === 1),
    "tool-call counts record completed det-priors calls",
  );

  // Two blocks in the final message fail: the submission must end with
  // exactly one fenced block, so a quoted example can never win over (or
  // merge with) the real submission.
  const twoBlocks = parseLaneEvents(
    [
      stepEvent("m-final"),
      toolEvent("warden_run_det_priors", "completed", "m-final"),
      textEvent(
        `${submissionText([{ ...goodFinding, claim: "first" }])}\nAfterthought:\n${submissionText([{ ...goodFinding, claim: "last" }])}`,
        "m-final",
      ),
    ].join("\n"),
  );
  const twoVerdict = evaluateLane(twoBlocks, { exitCode: 0, stdout: "", timedOut: false });
  assert(
    twoVerdict.status === "failed" &&
      (twoVerdict.reason ?? "").includes("multiple fenced json submissions"),
    `two blocks in the final message → failed (${twoVerdict.reason ?? "no reason"})`,
  );

  // A draft block in an earlier message is not the submission: the final
  // message is prose (the step-cap shape), so the lane fails instead of
  // publishing the draft as clean.
  const draftThenSummary = parseLaneEvents(
    [
      stepEvent("m-draft"),
      textEvent(submissionText([]), "m-draft"),
      toolEvent("warden_run_det_priors", "completed", "m-draft"),
      stepEvent("m-summary"),
      textEvent("Work done so far: traced the callers, no block here.", "m-summary"),
    ].join("\n"),
  );
  const draftVerdict = evaluateLane(draftThenSummary, {
    exitCode: 0,
    stdout: "",
    timedOut: false,
  });
  assert(
    draftVerdict.status === "failed" &&
      (draftVerdict.reason ?? "").includes("no fenced json submission in the final message"),
    `draft-then-summary → failed, not clean (${draftVerdict.reason ?? "no reason"})`,
  );

  // A quoted example block after the real submission, in the same final
  // message, fails instead of flipping the result to clean.
  const quotedExample = parseLaneEvents(
    [
      stepEvent("m-final"),
      toolEvent("warden_run_det_priors", "completed", "m-final"),
      textEvent(
        `${submissionText([goodFinding])}\nFor example, a clean lane looks like:\n${submissionText([])}`,
        "m-final",
      ),
    ].join("\n"),
  );
  const quotedVerdict = evaluateLane(quotedExample, {
    exitCode: 0,
    stdout: "",
    timedOut: false,
  });
  assert(
    quotedVerdict.status === "failed" &&
      (quotedVerdict.reason ?? "").includes("multiple fenced json submissions"),
    `quoted example after the submission → failed (${quotedVerdict.reason ?? "no reason"})`,
  );

  // A triple backtick inside a JSON string (inline, not at a line start)
  // does not end the block: the closing fence is anchored to a line start.
  const inlineTicks = parseLaneEvents(
    [
      stepEvent("m"),
      toolEvent("warden_run_det_priors", "completed", "m"),
      textEvent(submissionText([{ ...goodFinding, explanation: "wrap it in ``` fences" }]), "m"),
    ].join("\n"),
  );
  const inlineVerdict = evaluateLane(inlineTicks, { exitCode: 0, stdout: "", timedOut: false });
  assert(
    inlineVerdict.status === "ok" &&
      (inlineVerdict.findings[0] as Record<string, unknown>)["explanation"] ===
        "wrap it in ``` fences",
    "inline triple backticks inside JSON do not end the block",
  );

  const cases: Array<{
    name: string;
    stdout: string;
    process: { exitCode: number; timedOut: boolean };
    reason: string;
  }> = [
    {
      name: "no block",
      stdout: [stepEvent("m"), textEvent("looks clean to me", "m")].join("\n"),
      process: { exitCode: 0, timedOut: false },
      reason: "no fenced json submission",
    },
    {
      name: "bad JSON",
      stdout: [stepEvent("m"), textEvent("```json\n{not json\n```", "m")].join("\n"),
      process: { exitCode: 0, timedOut: false },
      reason: "not valid JSON",
    },
    {
      name: "no findings array",
      stdout: [
        stepEvent("m"),
        textEvent(submissionText([]).replace('"findings"', '"comments"'), "m"),
      ].join("\n"),
      process: { exitCode: 0, timedOut: false },
      reason: 'no "findings" array',
    },
    {
      name: "error event",
      stdout: [
        stepEvent("m"),
        toolEvent("warden_run_det_priors", "completed", "m"),
        '{"type":"error","error":{"message":"boom"}}',
      ].join("\n"),
      process: { exitCode: 0, timedOut: false },
      reason: "error event",
    },
    {
      name: "non-zero exit",
      stdout: [stepEvent("m"), textEvent(submissionText([goodFinding]), "m")].join("\n"),
      process: { exitCode: 1, timedOut: false },
      reason: "exited 1",
    },
    {
      name: "timeout",
      stdout: [stepEvent("m"), textEvent(submissionText([goodFinding]), "m")].join("\n"),
      process: { exitCode: -1, timedOut: true },
      reason: "timed out",
    },
    {
      name: "no det-priors call",
      stdout: [
        stepEvent("m"),
        toolEvent("read", "completed", "m"),
        textEvent(submissionText([goodFinding]), "m"),
      ].join("\n"),
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
        stepEvent("m"),
        toolEvent("warden_run_det_priors", "running", "m"),
        textEvent(submissionText([goodFinding]), "m"),
      ].join("\n"),
    ),
    { exitCode: 0, stdout: "", timedOut: false },
  );
  assert(runningOnly.status === "failed", "non-completed det-priors call still fails the lane");
  // Forward tolerance: a `part.name` shape (no `part.tool`) still counts.
  // (`tool_use` parts need no `messageID` — only the final message's
  // identity comes from `step_start`, and only `text` parts select it.)
  const legacyName = parseLaneEvents(
    [
      stepEvent("m"),
      JSON.stringify({
        type: "tool_use",
        part: { type: "tool", name: "warden_run_det_priors", state: { status: "completed" } },
      }),
      textEvent(submissionText([goodFinding]), "m"),
    ].join("\n"),
  );
  assert(
    evaluateLane(legacyName, { exitCode: 0, stdout: "", timedOut: false }).status === "ok",
    "legacy part.name tool shape still satisfies the gate",
  );

  // The submission is the last assistant message by identity, not the last
  // message that has text. Each case below must fail, never publish a draft
  // as clean.
  // P1: the final step has no text — the earlier draft is not the submission.
  const textlessFinal = evaluateLane(
    parseLaneEvents(
      [
        stepEvent("m-draft"),
        textEvent(submissionText([]), "m-draft"),
        toolEvent("warden_run_det_priors", "completed", "m-draft"),
        stepEvent("m-final"),
      ].join("\n"),
    ),
    { exitCode: 0, stdout: "", timedOut: false },
  );
  assert(
    textlessFinal.status === "failed" &&
      (textlessFinal.reason ?? "").includes("no fenced json submission in the final message"),
    `final step with no text → failed, not clean (${textlessFinal.reason ?? "no reason"})`,
  );
  // P2: the final step has whitespace-only text.
  const blankFinal = evaluateLane(
    parseLaneEvents(
      [
        stepEvent("m-draft"),
        textEvent(submissionText([]), "m-draft"),
        toolEvent("warden_run_det_priors", "completed", "m-draft"),
        stepEvent("m-final"),
        textEvent("   \n", "m-final"),
      ].join("\n"),
    ),
    { exitCode: 0, stdout: "", timedOut: false },
  );
  assert(
    blankFinal.status === "failed" &&
      (blankFinal.reason ?? "").includes("no fenced json submission in the final message"),
    `final step with whitespace-only text → failed (${blankFinal.reason ?? "no reason"})`,
  );
  // P3: `reconcile()` re-emits an earlier step's text after the final block
  // — only the final message counts, and it holds no block.
  const reconciled = evaluateLane(
    parseLaneEvents(
      [
        stepEvent("m-draft"),
        toolEvent("warden_run_det_priors", "completed", "m-draft"),
        textEvent(submissionText([]), "m-draft"),
        stepEvent("m-final"),
        textEvent("Final: still checking, no submission yet.", "m-final"),
        textEvent(" (late tail of the draft)", "m-draft"),
      ].join("\n"),
    ),
    { exitCode: 0, stdout: "", timedOut: false },
  );
  assert(
    reconciled.status === "failed" &&
      (reconciled.reason ?? "").includes("no fenced json submission in the final message"),
    `reconciled earlier text after the final block → failed (${reconciled.reason ?? "no reason"})`,
  );
  // A `text` part with no `messageID` fails closed with a distinct reason —
  // without an ID the whole-stream fallback would let a draft win.
  const noId = evaluateLane(
    parseLaneEvents(
      [
        stepEvent("m"),
        toolEvent("warden_run_det_priors", "completed", "m"),
        JSON.stringify({
          type: "text",
          timestamp: 2,
          sessionID: "s",
          part: { type: "text", text: submissionText([]) },
        }),
        textEvent("Summary: done.", "m"),
      ].join("\n"),
    ),
    { exitCode: 0, stdout: "", timedOut: false },
  );
  assert(
    noId.status === "failed" && (noId.reason ?? "").includes("without messageID"),
    `text part with no messageID → failed (${noId.reason ?? "no reason"})`,
  );
  // Text with IDs but no `step_start` has no final-message identity either.
  const noStep = evaluateLane(
    parseLaneEvents(
      [
        toolEvent("warden_run_det_priors", "completed", "m"),
        textEvent(submissionText([goodFinding]), "m"),
      ].join("\n"),
    ),
    { exitCode: 0, stdout: "", timedOut: false },
  );
  assert(
    noStep.status === "failed" && (noStep.reason ?? "").includes("no step_start"),
    `stream with no step_start → failed (${noStep.reason ?? "no reason"})`,
  );
  // The `finalizing` race (Q1/L1/N1): the final step's `step_start` is
  // dropped and its text arrives via `reconcile()` with an unannounced ID.
  // The previous step's draft must not become the submission — the lane
  // fails closed instead of publishing a false clean.
  const droppedFinalStepStart = evaluateLane(
    parseLaneEvents(
      [
        stepEvent("m-early"),
        toolEvent("warden_run_det_priors", "completed", "m-early"),
        stepEvent("m-draft"),
        textEvent(submissionText([]), "m-draft"),
        toolEvent("read", "completed", "m-draft"),
        textEvent(submissionText([goodFinding]), "m-final"),
      ].join("\n"),
    ),
    { exitCode: 0, stdout: "", timedOut: false },
  );
  assert(
    droppedFinalStepStart.status === "failed" &&
      (droppedFinalStepStart.reason ?? "").includes("no step_start"),
    `final step_start dropped → failed (${droppedFinalStepStart.reason ?? "no reason"})`,
  );
  // A `step_start` without a `messageID` cannot anchor an identity either.
  const noIdStepStart = evaluateLane(
    parseLaneEvents(
      [
        stepEvent("m-draft"),
        textEvent(submissionText([]), "m-draft"),
        toolEvent("warden_run_det_priors", "completed", "m-draft"),
        JSON.stringify({
          type: "step_start",
          timestamp: 1,
          sessionID: "s",
          part: { type: "step-start" },
        }),
        textEvent(submissionText([goodFinding]), "m-final"),
      ].join("\n"),
    ),
    { exitCode: 0, stdout: "", timedOut: false },
  );
  assert(
    noIdStepStart.status === "failed" &&
      ((noIdStepStart.reason ?? "").includes("no step_start") ||
        (noIdStepStart.reason ?? "").includes("without messageID")),
    `step_start without messageID → failed (${noIdStepStart.reason ?? "no reason"})`,
  );
  // P3 `ok` shape (locks the r2 deviation ruling): the real block is in
  // the final message and the late reconciled draft carries an announced
  // earlier ID, so the real finding is preserved, not lost.
  const reconciledOk = evaluateLane(
    parseLaneEvents(
      [
        stepEvent("m-early"),
        toolEvent("warden_run_det_priors", "completed", "m-early"),
        textEvent(submissionText([]), "m-early"),
        stepEvent("m-final"),
        textEvent(submissionText([goodFinding]), "m-final"),
        textEvent(submissionText([]), "m-early"),
      ].join("\n"),
    ),
    { exitCode: 0, stdout: "", timedOut: false },
  );
  assert(
    reconciledOk.status === "ok" &&
      JSON.stringify(reconciledOk.findings).includes('"claim":"smoke claim"'),
    `real final block plus late reconciled earlier draft → ok with the real finding (${reconciledOk.reason ?? "no reason"})`,
  );

  // ---------------------------------------------------------------------------
  // [6] command builder + MCP command — argv shape, loader resolution.
  // ---------------------------------------------------------------------------
  process.stdout.write("\n[6] command — argv shape and warden MCP command\n");
  const cmd = buildOpencodeCommand({
    serverUrl: "http://127.0.0.1:4123",
    model: "anthropic/claude-opus-5-5#high",
    message: "hello",
  });
  assert(cmd.bin === "opencode", "default binary is opencode");
  for (const want of ["run", "--server", "--agent", "warden-down", "--model", "--format", "json"]) {
    assert(cmd.argv.includes(want), `argv includes ${want}`);
  }
  assert(
    cmd.argv[cmd.argv.indexOf("--server") + 1] === "http://127.0.0.1:4123",
    "--server carries the driver's serve URL",
  );
  assert(!cmd.argv.includes("--auto"), "argv never passes --auto (unexpected asks fail closed)");
  assert(
    !cmd.argv.includes("--standalone"),
    "run attaches to the warmed serve instance, never --standalone",
  );
  assert(cmd.argv[cmd.argv.length - 1] === "hello", "message is the last argv entry");
  const serveCmd = buildOpencodeServeCommand({ port: 4123 });
  assert(serveCmd.argv.join(" ") === "serve --hostname 127.0.0.1 --port 4123", "serve argv shape");
  assert(
    buildLaneMessage("origin/main").includes("origin/main"),
    "lane message names the base ref",
  );
  const content = JSON.parse(
    buildMcpConfigContent({ command: ["node", "x", "mcp"], cwd: "/tmp/r" }),
  ) as Record<string, Record<string, Record<string, Record<string, unknown>>>>;
  const wardenServer = content["mcp"]?.["servers"]?.["warden"];
  assert(
    Array.isArray(wardenServer?.["command"]) &&
      wardenServer?.["type"] === "local" &&
      wardenServer?.["codemode"] === false &&
      (wardenServer as Record<string, unknown>)["cwd"] === "/tmp/r",
    "config content carries the full server object (host replaces the whole mcp key)",
  );
  assert(!("provider" in content), "config content has no provider key without a base URL");
  const gatewayContent = JSON.parse(
    buildMcpConfigContent({
      command: ["node", "x", "mcp"],
      cwd: "/tmp/r",
      anthropicBaseUrl: "https://gw.example/anthropic/v1",
    }),
  ) as Record<string, Record<string, Record<string, Record<string, unknown>>>>;
  assert(
    gatewayContent["provider"]?.["anthropic"]?.["options"]?.["baseURL"] ===
      "https://gw.example/anthropic/v1" && gatewayContent["mcp"] !== undefined,
    "config content forwards ANTHROPIC_BASE_URL as provider.anthropic.options.baseURL",
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
  // [6b] MCP readiness — untrusted /api/mcp JSON, warden-only gating.
  // ---------------------------------------------------------------------------
  process.stdout.write("\n[6b] mcp — /api/mcp parsing and warden-only readiness\n");
  const connectedBody = {
    location: { directory: "/tmp/r" },
    data: [
      { name: "other", status: { status: "failed", error: "nope" } },
      { name: "warden", status: { status: "connected" } },
    ],
  };
  assert(
    wardenMcpReadiness(parseMcpServers(connectedBody)).state === "connected",
    "connected warden gates open (other servers ignored)",
  );
  const failedBody = {
    data: [{ name: "warden", status: { status: "failed", error: "boom" } }],
  };
  const failedReady = wardenMcpReadiness(parseMcpServers(failedBody));
  assert(
    failedReady.state === "failed" && failedReady.detail.includes("boom"),
    "failed warden carries the server error",
  );
  assert(
    wardenMcpReadiness(parseMcpServers({ data: [] })).state === "pending",
    "unlisted warden is pending, not failed",
  );
  assert(
    wardenMcpReadiness(parseMcpServers({ nope: 1 })).state === "pending",
    "bad shape is pending",
  );
  assert(wardenMcpReadiness(parseMcpServers(null)).state === "pending", "null body is pending");
  // waitForWardenMcp against a tiny inline server: instant connect, failed,
  // and timeout are all deterministic.
  const { createServer } = await import("node:http");
  const pollOnce = async (body: unknown, timeoutMs: number): Promise<void> => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
    await new Promise<void>((resolveP) => server.listen(0, "127.0.0.1", resolveP));
    const port = (server.address() as { port: number }).port;
    try {
      await waitForWardenMcp({
        baseUrl: `http://127.0.0.1:${port}`,
        password: "pw",
        directory: "/tmp",
        timeoutMs,
      });
    } finally {
      server.close();
    }
  };
  await pollOnce(connectedBody, 2000);
  assert(true, "waitForWardenMcp resolves on connected");
  let failedWait = "";
  try {
    await pollOnce(failedBody, 2000);
  } catch (err) {
    failedWait = err instanceof Error ? err.message : String(err);
  }
  assert(failedWait.includes("boom"), `wait rejects with the server error (${failedWait})`);
  let timeoutWait = "";
  try {
    await pollOnce({ data: [] }, 300);
  } catch (err) {
    timeoutWait = err instanceof Error ? err.message : String(err);
  }
  assert(timeoutWait.includes("not connected within"), `wait times out bounded (${timeoutWait})`);
  // ---------------------------------------------------------------------------
  // [7] driver end-to-end with a fake opencode (serve + run).
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
  // JSONL per WARDEN_SMOKE_MODE. `serve` runs a tiny HTTP server for
  // /api/mcp per WARDEN_SMOKE_SERVE_MODE; `run --server` plays the lane.
  // Any contract breach exits non-zero.
  const fakePath = resolve(FAKE_BIN, "opencode");
  writeFileSync(
    fakePath,
    `#!/usr/bin/env node
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
const argv = process.argv.slice(2);
const fail = (msg) => { process.stderr.write("fake opencode: " + msg + "\\n"); process.exit(3); };
const has = (flag, value) => {
  const i = argv.indexOf(flag);
  return value === undefined ? i !== -1 : argv[i + 1] === value;
};
const checkSharedEnv = () => {
  if (!existsSync(process.env.OPENCODE_CONFIG ?? "")) fail("OPENCODE_CONFIG does not exist");
  if (process.env.OPENCODE_DISABLE_PROJECT_CONFIG !== "1") fail("project config not disabled");
  let content;
  try {
    content = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? "");
  } catch { fail("OPENCODE_CONFIG_CONTENT is not JSON"); }
  const wardenServer = content?.mcp?.servers?.warden;
  const wardenCmd = wardenServer?.command;
  if (!Array.isArray(wardenCmd) || !wardenCmd.some((p) => String(p).endsWith("mcp"))) fail("warden MCP command missing");
  if (wardenServer?.type !== "local" || wardenServer?.codemode !== false) fail("warden MCP server must keep type local + codemode false");
  if (!process.env.OPENCODE_PASSWORD) fail("OPENCODE_PASSWORD must be set for serve auth");
  // opencode resolves its location from PWD, not the process cwd.
  if (realpathSync(process.env.PWD ?? "") !== realpathSync(process.cwd())) fail("PWD must match the cwd");
};
if (argv[0] === "serve") {
  checkSharedEnv();
  if (!has("--hostname", "127.0.0.1")) fail("serve must bind 127.0.0.1");
  if (!has("--port") || !(Number(argv[argv.indexOf("--port") + 1]) > 0)) fail("serve needs a --port value");
  const port = Number(argv[argv.indexOf("--port") + 1]);
  const mode = process.env.WARDEN_SMOKE_SERVE_MODE ?? "connected";
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://127.0.0.1");
    const checkAuth = () => {
      if (req.headers.authorization !== ("Basic " + Buffer.from("opencode:" + (process.env.OPENCODE_PASSWORD ?? ""), "utf8").toString("base64"))) {
        res.writeHead(401); res.end(JSON.stringify({ message: "Authentication required" })); return false;
      }
      return true;
    };
    const sessMatch = u.pathname.match(/^\\/api\\/session\\/(.+)$/);
    if (sessMatch) {
      if (!checkAuth()) return;
      const dir = u.searchParams.get("location[directory]");
      if (!dir) fail("session poll must send location[directory]");
      if (process.env.WARDEN_SMOKE_SESSION_MODE === "404") {
        res.writeHead(404); res.end(); return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: {
        id: decodeURIComponent(sessMatch[1] ?? ""),
        model: { id: "fake-model", providerID: "fake-provider", variant: "high" },
        cost: 0.0123,
        tokens: { input: 100, output: 50, reasoning: 10, cache: { read: 20, write: 30 } },
        outcome: "succeeded",
      } }));
      return;
    }
    if (u.pathname !== "/api/mcp") { res.writeHead(404); res.end(); return; }
    if (!checkAuth()) return;
    const dir = u.searchParams.get("location[directory]");
    if (!dir) fail("poll must send location[directory]");
    const data =
      mode === "connected"
        ? [{ name: "unrelated", status: { status: "connected" } }, { name: "warden", status: { status: "connected" } }]
        : mode === "failed"
          ? [{ name: "warden", status: { status: "failed", error: "fake mcp exploded" } }]
          : [{ name: "warden", status: { status: "pending" } }];
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ location: { directory: dir }, data }));
  });
  server.listen(port, "127.0.0.1", () => {
    if (process.env.WARDEN_SMOKE_SERVE_PORT !== undefined) writeFileSync(process.env.WARDEN_SMOKE_SERVE_PORT, String(port));
  });
} else {
if (argv[0] !== "run") fail("first argv must be run or serve");
for (const w of ["--server", "--format"]) if (!has(w)) fail("missing " + w);
if (has("--standalone")) fail("--standalone must not be passed (warmed serve owns MCP)");
if (!String(argv[argv.indexOf("--server") + 1] ?? "").startsWith("http://127.0.0.1:")) fail("wrong --server URL");
if (!has("--agent", "warden-down")) fail("wrong agent");
if (!has("--model") || (argv[argv.indexOf("--model") + 1] ?? "").length === 0) fail("missing --model value");
if (has("--auto")) fail("--auto must not be passed");
checkSharedEnv();
if (!process.env.OPENCODE_PASSWORD) fail("run needs OPENCODE_PASSWORD for --server auth");
if (process.env.WARDEN_SMOKE_RUN_MARKER !== undefined) writeFileSync(process.env.WARDEN_SMOKE_RUN_MARKER, "invoked\\n");
const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
const MID = "m-lane";
emit({ type: "step_start", timestamp: 1, sessionID: "s", part: { type: "step-start", messageID: MID } });
const text = (t) => emit({ type: "text", timestamp: 2, sessionID: "s", part: { type: "text", text: t, messageID: MID } });
const tool = (name, status = "completed") =>
  emit({ type: "tool_use", timestamp: 1, sessionID: "s", part: { type: "tool", id: "t", tool: name, messageID: MID, state: { status }, time: {} } });
const mode = process.env.WARDEN_SMOKE_MODE ?? "ok";
const finding = JSON.parse(process.env.WARDEN_SMOKE_FINDING ?? "null");
const fence = String.fromCharCode(96).repeat(3);
const block = (findings) => "Triage.\\n" + fence + "json\\n" + JSON.stringify({ findings }) + "\\n" + fence;
if (mode === "runfail") {
  tool("warden_run_det_priors");
  text(block([finding]));
  process.stderr.write("fake run exploded\\n");
  process.exit(1);
} else if (mode === "ok" || mode === "notools" || mode === "outofscope") {
  if (mode !== "notools") tool("warden_run_det_priors");
  tool("read");
  text(block(mode === "outofscope" ? [{ ...finding, file: "src/other.ts" }] : [finding]));
} else if (mode === "nosubmission") {
  tool("warden_run_det_priors");
  text("looks clean to me, no block here");
}
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
            WARDEN_SMOKE_SERVE_PORT: resolve(TMP_ROOT, "fake-serve-port"),
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

  const fakeServePort = (): number | undefined => {
    try {
      const raw = readFileSync(resolve(TMP_ROOT, "fake-serve-port"), "utf8").trim();
      const port = Number(raw);
      return Number.isInteger(port) && port > 0 ? port : undefined;
    } catch {
      return undefined;
    }
  };

  const assertServeDead = async (label: string): Promise<void> => {
    const port = fakeServePort();
    assert(port !== undefined, `${label}: fake serve recorded its port`);
    if (port === undefined) return;
    let reachable = false;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      await fetch(`http://127.0.0.1:${port}/api/mcp`, { signal: controller.signal });
      clearTimeout(timer);
      reachable = true;
    } catch {
      reachable = false;
    }
    assert(!reachable, `${label}: no serve process left (port ${port} closed)`);
  };

  const parseOut = (out: string): CommentSet | undefined => {
    try {
      const parsed = CommentSetSchema.safeParse(JSON.parse(out));
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  };

  // (a) happy path: serve reports connected, then run submits.
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
  await assertServeDead("happy path");
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
  // The fake serve answers the session route with a fixed usage; the
  // lane-trace entry carries it as a cost suffix.
  assert(
    okSet?.metadata.degradedWorkers.some(
      (d) =>
        d.topic === "lane-trace" &&
        d.message.includes("cost $0.0123") &&
        d.message.includes("tokens 150/50"),
    ) === true,
    "lane-trace entry carries the session cost (150 in / 50 out)",
  );
  // parseSessionUsage validates the same shape the fake serve sends.
  const smokeUsage = parseSessionUsage({
    data: {
      id: "s",
      model: { id: "fake-model", providerID: "fake-provider", variant: "high" },
      cost: 0.0123,
      tokens: { input: 100, output: 50, reasoning: 10, cache: { read: 20, write: 30 } },
      outcome: "succeeded",
    },
  });
  assert(
    smokeUsage !== undefined &&
      smokeUsage.costUsd === 0.0123 &&
      smokeUsage.model === "fake-provider/fake-model#high",
    "parseSessionUsage reads the fake serve shape",
  );

  // (a2) the returning core publishes the same CommentSet the wrapper
  // prints (minus wall-clock duration), plus the session usage.
  process.env.WARDEN_SMOKE_FINDING = JSON.stringify(inScopeFinding);
  process.env.WARDEN_SMOKE_SERVE_PORT = resolve(TMP_ROOT, "fake-serve-port-core");
  delete process.env.WARDEN_SMOKE_MODE;
  delete process.env.WARDEN_SMOKE_SESSION_MODE;
  const driven = await driveOpencodeLane({
    repoRoot: REPO,
    baseRef: "HEAD~1",
    opencodeBin: fakePath,
  });
  delete process.env.WARDEN_SMOKE_FINDING;
  delete process.env.WARDEN_SMOKE_SERVE_PORT;
  // Key order differs across the CLI JSON round-trip, so canonicalize
  // (sorted keys) before comparing.
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (typeof value === "object" && value !== null) {
      return Object.fromEntries(
        Object.keys(value as Record<string, unknown>)
          .sort()
          .map((k) => [k, canonical((value as Record<string, unknown>)[k])]),
      );
    }
    return value;
  };
  const normalize = (set: CommentSet): string =>
    JSON.stringify(canonical({ ...set, metadata: { ...set.metadata, durationMs: 0 } }));
  assert(
    okSet !== undefined && normalize(driven.result) === normalize(okSet),
    "driveOpencodeLane returns the CommentSet the wrapper prints",
  );
  assert(driven.usage?.costUsd === 0.0123, "driveOpencodeLane returns the session usage");
  assert(
    driven.lanes[0]?.status === "ok" &&
      driven.result.metadata.degradedWorkers.some(
        (d) => d.topic === "lane-trace" && d.message.includes("cost $0.0123"),
      ),
    "core result carries the cost-suffixed lane-trace entry",
  );

  // (a3) the session route 404s: the lane still publishes, trace has no cost.
  const noUsage = runDriver(["--base", "HEAD~1", "--json"], { WARDEN_SMOKE_SESSION_MODE: "404" });
  const noUsageSet = parseOut(noUsage.out);
  assert(noUsage.exit === 0, `session 404 still exits 0 (got ${noUsage.exit})`);
  assert(
    noUsageSet?.comments.some((c) => c.claim === inScopeFinding.claim) === true,
    "session 404 still publishes the comment",
  );
  assert(
    noUsageSet?.metadata.degradedWorkers.some(
      (d) =>
        d.topic === "lane-trace" &&
        d.message.includes("warden_run_det_priors") &&
        !d.message.includes("cost $"),
    ) === true,
    "session 404 leaves the lane-trace entry without a cost suffix",
  );
  await assertServeDead("session 404");

  // (b) warden never connects: lane failed, run never spawned, serve killed.
  const runMarkerB = resolve(TMP_ROOT, "run-invoked-b");
  const never = runDriver(["--base", "HEAD~1", "--json", "--mcp-timeout", "2"], {
    WARDEN_SMOKE_SERVE_MODE: "never",
    WARDEN_SMOKE_RUN_MARKER: runMarkerB,
  });
  const neverSet = parseOut(never.out);
  assert(never.exit === 1, `unconnected MCP exits 1 (got ${never.exit})`);
  assert(
    neverSet?.metadata.degradedWorkers.some(
      (d) =>
        d.kind === "actionable" &&
        d.topic === "lane-health" &&
        d.message.includes("not connected within"),
    ) === true,
    "unconnected MCP fails the lane naming the timeout",
  );
  let runHitB = false;
  try {
    readFileSync(runMarkerB, "utf8");
    runHitB = true;
  } catch {
    runHitB = false;
  }
  assert(!runHitB, "unconnected MCP never spawns run");
  await assertServeDead("unconnected MCP");

  // (b2) MCP warmup failure through the returning core: no run spawned,
  // so the eval scores a known $0 measured sample and the run continues.
  process.env.WARDEN_SMOKE_SERVE_MODE = "failed";
  process.env.WARDEN_SMOKE_SERVE_PORT = resolve(TMP_ROOT, "fake-serve-port");
  const warmupFailed = await driveOpencodeLane({
    repoRoot: REPO,
    baseRef: "HEAD~1",
    opencodeBin: fakePath,
    mcpTimeoutSecs: 2,
  });
  delete process.env.WARDEN_SMOKE_SERVE_MODE;
  delete process.env.WARDEN_SMOKE_SERVE_PORT;
  assert(
    warmupFailed.runSpawned === false &&
      warmupFailed.usage === undefined &&
      warmupFailed.lanes[0]?.status === "failed",
    "MCP warmup failure → failed lane, runSpawned false, no usage",
  );
  assert(
    isOpencodeCostMeasured(warmupFailed.runSpawned, warmupFailed.usage),
    "MCP warmup failure → measured $0 (the eval run continues)",
  );
  assert(
    driven.runSpawned === true && isOpencodeCostMeasured(driven.runSpawned, driven.usage),
    "spawned run with a priced session usage → measured",
  );
  assert(
    driven.model === DOWN_LANE_SPEC.defaultModel &&
      warmupFailed.model === DOWN_LANE_SPEC.defaultModel,
    "the returning core reports the resolved requested model (the driver default) on every path",
  );
  assert(
    !isOpencodeCostMeasured(true, undefined),
    "spawned run with no session usage → unmeasured (stops the run)",
  );
  await assertServeDead("MCP warmup failure (core)");

  // (c) warden failed status: lane failed with the server error in the reason.
  const failedMcp = runDriver(["--base", "HEAD~1", "--json", "--mcp-timeout", "2"], {
    WARDEN_SMOKE_SERVE_MODE: "failed",
  });
  const failedMcpSet = parseOut(failedMcp.out);
  assert(failedMcp.exit === 1, `failed MCP exits 1 (got ${failedMcp.exit})`);
  assert(
    failedMcpSet?.metadata.degradedWorkers.some(
      (d) => d.topic === "lane-health" && d.message.includes("fake mcp exploded"),
    ) === true,
    "failed MCP names the server error",
  );
  await assertServeDead("failed MCP");

  // (d) run failure: the reason carries the stderr tail.
  const runFail = runDriver(["--base", "HEAD~1", "--json"], { WARDEN_SMOKE_MODE: "runfail" });
  const runFailSet = parseOut(runFail.out);
  assert(runFail.exit === 1, `run failure exits 1 (got ${runFail.exit})`);
  assert(
    runFailSet?.metadata.degradedWorkers.some(
      (d) => d.topic === "lane-health" && d.message.includes("fake run exploded"),
    ) === true,
    "run failure reason carries the stderr tail",
  );
  await assertServeDead("run failure");

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

  const runMarker = resolve(TMP_ROOT, "run-invoked");
  rmSync(resolve(TMP_ROOT, "fake-serve-port"), { force: true });
  const empty = runDriver(["--base", "HEAD", "--json"], { WARDEN_SMOKE_RUN_MARKER: runMarker });
  const emptySet = parseOut(empty.out);
  assert(empty.exit === 1, `empty diff exits 1 (got ${empty.exit})`);
  let markerHit = false;
  try {
    readFileSync(runMarker, "utf8");
    markerHit = true;
  } catch {
    markerHit = false;
  }
  assert(!markerHit, "empty diff never spawns run");
  assert(fakeServePort() === undefined, "empty diff never spawns serve");
  assert(
    emptySet?.metadata.degradedWorkers.some(
      (d) =>
        d.kind === "actionable" &&
        d.topic === "lane-health" &&
        d.message.includes("empty review target"),
    ) === true,
    "empty diff fails the lane with empty review target",
  );

  // (X1) no `opencode` on PATH: exit 1 with an actionable lane-health
  // entry and JSON output, at once (no MCP-timeout wait). Timed as a CLI
  // subprocess: the in-process return settles at once, but only the
  // process exit proves the orphan MCP poll and its timers are stopped.
  const NOBIN = mkdtempSync(resolve(tmpdir(), "warden-lanes-nobin-"));
  const gitPath = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  symlinkSync(gitPath, resolve(NOBIN, "git"));
  const nobinStart = Date.now();
  let nobinExit = -1;
  let nobinOut = "";
  try {
    nobinOut = execFileSync(
      process.execPath,
      [
        "--import",
        import.meta.resolve("tsx/esm"),
        resolve(CLI_ROOT, "src/index.ts"),
        "opencode-review",
        "--base",
        "HEAD~1",
        "--json",
      ],
      {
        cwd: REPO,
        env: { ...stripKeys(process.env), PATH: NOBIN },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 90000,
      },
    ) as string;
    nobinExit = 0;
  } catch (err) {
    const e = err as { status?: number; stdout?: unknown };
    nobinExit = e.status ?? -1;
    nobinOut = typeof e.stdout === "string" ? e.stdout : "";
  }
  const nobinSecs = Math.round((Date.now() - nobinStart) / 1000);
  const nobinSet = parseOut(nobinOut);
  assert(nobinExit === 1, `missing opencode binary exits 1 (got ${nobinExit})`);
  assert(
    Date.now() - nobinStart < 15000,
    `missing binary fails at once, without waiting out the 30 s MCP timeout (took ${nobinSecs} s)`,
  );
  assert(nobinSet !== undefined, "missing binary still prints a JSON CommentSet");
  assert(
    nobinSet?.metadata.degradedWorkers.some(
      (d) => d.kind === "actionable" && d.topic === "lane-health",
    ) === true,
    "missing binary carries an actionable lane-health entry",
  );
  rmSync(NOBIN, { recursive: true, force: true });
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

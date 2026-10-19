/** Live OpenCode config discovery regression. Requires opencode on PATH.
 * Uses only temp fixtures and a loopback model stub; no provider call.
 * Usage: pnpm --filter @warden/cli smoke:opencode-config-isolation
 */
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { allocFreePort, createOpencodeIsolation } from "../src/opencode/drive.js";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
  process.stdout.write(`  ✓ ${message}\n`);
}

const root = mkdtempSync(resolve(tmpdir(), "warden-opencode-config-smoke-"));
const repo = resolve(root, "repo");
const home = resolve(root, "home");
const config = resolve(root, "xdg/opencode");
const globalPlugin = resolve(root, "global-plugin-ran");
const projectPlugin = resolve(root, "project-plugin-ran");
const instruction = "WARDEN_GLOBAL_INSTRUCTION_MARKER";
const skill = "warden-global-skill";
const isolation = createOpencodeIsolation();
const requests: string[] = [];
// oxlint-disable-next-line typescript/no-misused-promises -- a rejected handler crashes the probe, which is the loud failure a smoke run wants
const provider = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk.toString();
  requests.push(body);
  res.writeHead(200, { "content-type": "text/event-stream" });
  const events = [
    {
      type: "message_start",
      message: {
        id: "msg_probe",
        type: "message",
        role: "assistant",
        content: [],
        model: "claude-haiku-4-5",
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Probe complete." },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 1 },
    },
    { type: "message_stop" },
  ];
  for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  res.end();
});

async function probe(
  overrides: Record<string, string>,
): Promise<{ sources: string; skills: string; prompt: string }> {
  requests.length = 0;
  rmSync(globalPlugin, { force: true });
  rmSync(projectPlugin, { force: true });
  const port = await allocFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const providerPort = (provider.address() as { port: number }).port;
  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: resolve(root, "xdg"),
    XDG_DATA_HOME: resolve(root, "data"),
    XDG_CACHE_HOME: resolve(root, "cache"),
    XDG_STATE_HOME: resolve(root, "state"),
    OPENCODE_TEST_HOME: home,
    OPENCODE_CONFIG_DIR: config,
    OPENCODE_CONFIG: "",
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_CONFIG_PROJECT_DISABLE: "0",
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      provider: {
        anthropic: {
          options: { apiKey: "fixture", baseURL: `http://127.0.0.1:${providerPort}/v1` },
        },
      },
    }),
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_PASSWORD: "fixture",
    PWD: repo,
    ...overrides,
  };
  const server = spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: repo,
    env,
    stdio: "ignore",
  });
  const closed = once(server, "close");
  const get = async (path: string): Promise<string> => {
    const url = new URL(path, baseUrl);
    url.searchParams.set("location[directory]", repo);
    const response = await fetch(url, {
      headers: { authorization: `Basic ${Buffer.from("opencode:fixture").toString("base64")}` },
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) throw new Error(`OpenCode ${path}: ${response.status}`);
    return await response.text();
  };
  try {
    let sources: string | undefined;
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      try {
        sources = await get("/api/config");
        break;
      } catch {
        if (server.exitCode !== null) throw new Error("OpenCode serve exited before readiness");
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    assert(sources !== undefined, "live OpenCode server becomes ready");
    // Location plugins and skill discovery finish after config becomes available.
    await new Promise((r) => setTimeout(r, 1500));
    const skills = await get("/api/skill");
    const run = spawn(
      "opencode",
      [
        "run",
        "--server",
        baseUrl,
        "--agent",
        "build",
        "--model",
        "anthropic/claude-haiku-4-5",
        "--format",
        "json",
        "Say probe complete without tools.",
      ],
      { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    run.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    run.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    const timer = setTimeout(() => run.kill("SIGKILL"), 20000);
    const [code] = await once(run, "close");
    clearTimeout(timer);
    if (code !== 0 || requests.length === 0)
      throw new Error(`model stub failed: ${output.slice(-1000)}`);
    assert(true, "loopback model receives the prompt");
    return { sources, skills, prompt: requests.join("\n") };
  } finally {
    server.kill("SIGTERM");
    const timer = setTimeout(() => server.kill("SIGKILL"), 2000);
    await closed;
    clearTimeout(timer);
  }
}

try {
  process.stdout.write(execFileSync("opencode", ["--version"], { encoding: "utf8" }));
  for (const dir of [
    repo,
    config,
    resolve(config, "plugin"),
    resolve(home, ".claude/skills/probe"),
    resolve(repo, ".opencode/plugin"),
  ])
    mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repo });
  writeFileSync(resolve(config, "AGENTS.md"), instruction);
  writeFileSync(
    resolve(config, "opencode.json"),
    JSON.stringify({ agents: { "global-probe": { description: "global config marker" } } }),
  );
  writeFileSync(
    resolve(home, ".claude/skills/probe/SKILL.md"),
    `---\nname: ${skill}\ndescription: global skill marker\n---\nGlobal skill content\n`,
  );
  for (const [dir, marker] of [
    [resolve(config, "plugin"), globalPlugin],
    [resolve(repo, ".opencode/plugin"), projectPlugin],
  ] as const) {
    writeFileSync(
      resolve(dir, "probe.ts"),
      `import {writeFileSync} from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "ran"); export default {id:"probe", setup:async()=>{}};`,
    );
  }
  await new Promise<void>((r) => provider.listen(0, "127.0.0.1", r));
  const inherited = await probe({});
  assert(inherited.sources.includes("global-probe"), "control loads global config");
  assert(existsSync(globalPlugin), "control executes global plugin");
  assert(existsSync(projectPlugin), "inherited new flag enables project plugin despite old flag");
  assert(
    inherited.prompt.includes(instruction),
    "control loads global AGENTS.md into the model prompt",
  );
  assert(inherited.skills.includes(skill), "control discovers home skills");
  const configOnly = await probe({
    OPENCODE_CONFIG_DIR: isolation.env["OPENCODE_CONFIG_DIR"]!,
    OPENCODE_CONFIG_PROJECT_DISABLE: "1",
  });
  assert(
    !existsSync(globalPlugin) && !existsSync(projectPlugin),
    "empty config and both flags exclude global and project plugins",
  );
  assert(!configOnly.prompt.includes(instruction), "empty config excludes global AGENTS.md");
  assert(configOnly.skills.includes(skill), "empty config alone still discovers home skills");
  const isolated = await probe(isolation.env);
  assert(!isolated.sources.includes("global-probe"), "driver isolation excludes global config");
  assert(
    !existsSync(globalPlugin) && !existsSync(projectPlugin),
    "driver isolation executes neither plugin",
  );
  assert(!isolated.prompt.includes(instruction), "driver isolation excludes global AGENTS.md");
  assert(!isolated.skills.includes(skill), "driver isolation excludes home skills");
  process.stdout.write("all assertions passed\n");
} finally {
  provider.closeAllConnections();
  provider.close();
  isolation.cleanup();
  rmSync(root, { recursive: true, force: true });
}

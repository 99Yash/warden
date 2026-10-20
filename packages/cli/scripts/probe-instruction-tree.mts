/** S7 investigation only: real Git worktree and OpenCode reads against a loopback model. */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { text } from "node:stream/consumers";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveDiff, runPostPass } from "@warden/core";
import { z } from "zod";
import { allocFreePort, createOpencodeIsolation } from "../src/opencode/drive.js";

const root = mkdtempSync(join(tmpdir(), "warden-instruction-tree-"));
const repo = join(root, "repo");
const tree = join(root, "tree");
const isolation = createOpencodeIsolation();
const markers = {
  base: "WARDEN_PROBE_BASE_POLICY",
  changed: "WARDEN_PROBE_PR_POLICY",
  added: "WARDEN_PROBE_NEW_POLICY",
  local: "WARDEN_PROBE_UNTRACKED_POLICY",
  dependency: "WARDEN_PROBE_DEPENDENCY_POLICY",
};
const paths = [
  "src/index.ts",
  "added/index.ts",
  "local/index.ts",
  "node_modules/vendor/index.d.ts",
];
/** The fields the fake provider reads from an Anthropic Messages request; the rest is kept. */
const ProviderRequestSchema = z.looseObject({
  tools: z.array(z.looseObject({ name: z.string() })).optional(),
});
let requests: Array<Record<string, unknown>> = [];
let step = 0;
// oxlint-disable-next-line typescript/no-misused-promises -- a rejected handler crashes the probe, which is the loud failure a smoke run wants
const provider = createServer(async (req, res) => {
  const body = await text(req);
  const request = ProviderRequestSchema.parse(JSON.parse(body));
  requests.push(request);
  // Title/summary calls have no tools. Reply without advancing the read sequence.
  const hasRead = request.tools?.some((t) => t.name === "read");
  const path = hasRead ? paths[step++] : undefined;
  res.writeHead(200, { "content-type": "text/event-stream" });
  const content =
    path === undefined
      ? { type: "text", text: "" }
      : { type: "tool_use", id: `read_${step}`, name: "read", input: {} };
  const delta =
    path === undefined
      ? { type: "text_delta", text: "Probe complete." }
      : { type: "input_json_delta", partial_json: JSON.stringify({ path, offset: 1, limit: 20 }) };
  const events = [
    {
      type: "message_start",
      message: {
        id: `msg_${step}`,
        type: "message",
        role: "assistant",
        content: [],
        model: "claude-haiku-4-5",
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: content },
    { type: "content_block_delta", index: 0, delta },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: path === undefined ? "end_turn" : "tool_use", stop_sequence: null },
      usage: { output_tokens: 1 },
    },
    { type: "message_stop" },
  ];
  for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  res.end();
});
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}
function put(base: string, path: string, content: string): void {
  mkdirSync(dirname(join(base, path)), { recursive: true });
  writeFileSync(join(base, path), content);
}
async function readProbe(directory: string) {
  requests = [];
  step = 0;
  const port = await allocFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const providerAddress = provider.address();
  if (providerAddress === null || typeof providerAddress === "string") {
    throw new Error("probe: the fake provider is not listening on a TCP port");
  }
  const providerPort = providerAddress.port;
  const env = {
    ...process.env,
    ...isolation.env,
    OPENCODE_CONFIG: "",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_PASSWORD: "fixture",
    PWD: directory,
    XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_STATE_HOME: join(root, "state"),
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      provider: {
        anthropic: {
          options: { apiKey: "fixture", baseURL: `http://127.0.0.1:${providerPort}/v1` },
        },
      },
      agents: {
        "tree-probe": {
          description: "Instruction discovery probe",
          mode: "primary",
          steps: 10,
          system: "Complete the requested reads.",
          permissions: [
            { action: "*", resource: "*", effect: "deny" },
            { action: "read", resource: "*", effect: "allow" },
          ],
        },
      },
    }),
  };
  const server = spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: directory,
    env,
    stdio: "ignore",
  });
  const closed = once(server, "close");
  try {
    const deadline = Date.now() + 20000;
    let ready = false;
    while (Date.now() < deadline) {
      try {
        const url = new URL("/api/config", baseUrl);
        url.searchParams.set("location[directory]", directory);
        const response = await fetch(url, {
          headers: { authorization: `Basic ${Buffer.from("opencode:fixture").toString("base64")}` },
          signal: AbortSignal.timeout(2000),
        });
        if (response.ok) {
          ready = true;
          break;
        }
      } catch {
        /* wait for serve */
      }
      if (server.exitCode !== null) throw new Error("OpenCode exited before readiness");
      await new Promise((r) => setTimeout(r, 200));
    }
    assert(ready, "OpenCode server becomes ready");
    const run = spawn(
      "opencode",
      [
        "run",
        "--server",
        baseUrl,
        "--agent",
        "tree-probe",
        "--model",
        "anthropic/claude-haiku-4-5",
        "--format",
        "json",
        "Read the four fixture paths.",
      ],
      { cwd: directory, env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    run.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    run.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    const timer = setTimeout(() => run.kill("SIGKILL"), 30000);
    // `events.once` types the event arguments as `any[]`; "close" passes the exit code first.
    const closeArgs: unknown[] = await once(run, "close");
    const [code] = closeArgs;
    clearTimeout(timer);
    assert.equal(code, 0, output.slice(-1200));
    assert.equal(step, 5, "all four scripted reads reach the loopback provider");
    const prompt = JSON.stringify(requests);
    return Object.fromEntries(
      Object.entries(markers).map(([name, marker]) => [name, prompt.includes(marker)]),
    );
  } finally {
    server.kill("SIGTERM");
    const timer = setTimeout(() => server.kill("SIGKILL"), 2000);
    await closed;
    clearTimeout(timer);
  }
}

try {
  const version = execFileSync("opencode", ["--version"], { encoding: "utf8" }).trim();
  process.stdout.write(`OpenCode ${version}\n`);
  mkdirSync(repo);
  git(repo, "init", "-q");
  put(repo, ".gitignore", "node_modules/\nlocal/\n");
  put(repo, "src/AGENTS.md", markers.base);
  put(repo, "src/index.ts", "export const value = 1;\n");
  git(repo, "add", ".");
  git(
    repo,
    "-c",
    "user.name=probe",
    "-c",
    "user.email=probe@example.invalid",
    "commit",
    "-qm",
    "base",
  );
  const base = git(repo, "rev-parse", "HEAD").trim();
  put(repo, "src/AGENTS.md", markers.changed);
  put(repo, "src/index.ts", "export const value = 2;\n");
  put(repo, "added/AGENTS.md", markers.added);
  put(repo, "added/index.ts", "export const added = 1;\n");
  git(repo, "add", ".");
  git(
    repo,
    "-c",
    "user.name=probe",
    "-c",
    "user.email=probe@example.invalid",
    "commit",
    "-qm",
    "review target",
  );
  const original = await resolveDiff({ repoRoot: repo, mode: "review", baseRef: base });
  put(repo, "local/AGENTS.md", markers.local);
  put(repo, "local/index.ts", "export const local = 1;\n");
  put(repo, "node_modules/vendor/AGENTS.md", markers.dependency);
  put(repo, "node_modules/vendor/index.d.ts", "export declare const dependency: number;\n");
  git(repo, "worktree", "add", "--detach", tree, "HEAD");
  assert(
    !existsSync(join(tree, "node_modules")) && !existsSync(join(tree, "local")),
    "HEAD worktree excludes dependencies and ignored files",
  );
  git(tree, "restore", `--source=${base}`, "--worktree", "--", "src/AGENTS.md");
  rmSync(join(tree, "added/AGENTS.md"));
  const unchangedPaths = git(repo, "ls-files", "-z")
    .split("\0")
    .filter((p) => p && !p.endsWith("/AGENTS.md"));
  assert(
    unchangedPaths.every((p) => readFileSync(join(repo, p)).equals(readFileSync(join(tree, p)))),
    "every other tracked path has identical bytes",
  );
  const restored = await resolveDiff({ repoRoot: tree, mode: "review", baseRef: base });
  assert.equal(
    restored.diff,
    original.diff,
    "commit diff remains identical after policy restoration",
  );
  assert(
    git(tree, "diff", "HEAD").includes(markers.base),
    "working-tree diff includes the artificial policy restoration",
  );
  const finding = {
    file: "src/AGENTS.md",
    lineStart: 1,
    lineEnd: 1,
    tier: 2,
    category: "correctness",
    kind: "assertion",
    claim: "Changed policy needs review",
    explanation: "Fixture policy change",
    confidence: 0.9,
    sources: [
      {
        type: "tool",
        path: "src/AGENTS.md",
        line: 1,
        snippet: markers.changed,
        retrievedAt: new Date().toISOString(),
      },
    ],
  };
  const lanes = [
    { lane: "down" as const, status: "ok" as const, scope: ["src/AGENTS.md"], findings: [finding] },
  ];
  const verifiedOriginal = await runPostPass({ repoRoot: repo, diff: original.diff, lanes });
  const verifiedTree = await runPostPass({ repoRoot: tree, diff: original.diff, lanes });
  assert.equal(
    verifiedOriginal.comments.length,
    1,
    "post-pass verifies PR policy against original root",
  );
  assert.equal(
    verifiedTree.comments.length,
    0,
    "sanitized root cannot verify the original policy snippet",
  );
  await new Promise<void>((r) => provider.listen(0, "127.0.0.1", r));
  const control = await readProbe(repo);
  assert(
    control.changed && control.added && control.local && control.dependency,
    "control discovers tracked, ignored, and dependency instructions",
  );
  const clean = await readProbe(tree);
  assert(
    clean.base && !clean.changed && !clean.added && !clean.local && !clean.dependency,
    "restored tree keeps base policy and excludes PR and local policy",
  );
  symlinkSync(join(repo, "node_modules"), join(tree, "node_modules"));
  put(tree, "local/AGENTS.md", markers.local);
  put(tree, "local/index.ts", "export const local = 1;\n");
  const withDependencies = await readProbe(tree);
  assert(
    withDependencies.local && withDependencies.dependency,
    "linking dependencies and copying ignored files restores instruction channels",
  );
  rmSync(join(tree, "src/AGENTS.md"));
  rmSync(join(tree, "local/AGENTS.md"));
  rmSync(join(tree, "node_modules"));
  put(tree, "node_modules/vendor/index.d.ts", "export declare const dependency: number;\n");
  const withoutInstructions = await readProbe(tree);
  assert(
    Object.values(withoutInstructions).every((loaded) => !loaded),
    "removing policies from the final readable tree excludes all instruction markers",
  );
  put(repo, "src/index.ts", "export const value = 3;\n");
  assert.notEqual(
    readFileSync(join(repo, "src/index.ts"), "utf8"),
    readFileSync(join(tree, "src/index.ts"), "utf8"),
    "HEAD worktree omits dirty checkout changes",
  );
  process.stdout.write(
    JSON.stringify(
      {
        version,
        trackedBytesPreserved: true,
        commitDiffPreserved: true,
        originalRootCitationVerified: true,
        dirtyChangesOmitted: true,
        control,
        restored: clean,
        withDependencies,
        withoutInstructions,
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  provider.closeAllConnections();
  provider.close();
  isolation.cleanup();
  if (existsSync(tree)) git(repo, "worktree", "remove", "--force", tree);
  rmSync(root, { recursive: true, force: true });
}

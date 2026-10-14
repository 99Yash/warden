/** ADR-0054: real child processes and repo-controlled detector code see no inherited secrets. */
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { buildMcpConfigContent } from "../src/opencode/drive.js";

const root = mkdtempSync(resolve(tmpdir(), "warden-secret-isolation-"));
const cliRoot = fileURLToPath(new URL("..", import.meta.url));
// This is a private core helper, outside the CLI's composite TS project.
const { spawnCapture } = await import(resolve(cliRoot, "../core/src/runners/_shared.ts"));
const secrets = {
  ANTHROPIC_API_KEY: "smoke-provider-value",
  OPENAI_API_KEY: "smoke-provider-value",
  LANGFUSE_SECRET_KEY: "smoke-telemetry-value",
  GITHUB_TOKEN: "smoke-checkout-value",
  CUSTOM_CI_SECRET: "smoke-custom-value",
};
const client = new Client({ name: "secret-isolation-smoke", version: "1" });
let failed = 0;
function check(ok: unknown, message: string): void {
  process.stdout.write(`  ${ok ? "✓" : "✗"} ${message}\n`);
  if (!ok) failed++;
}
try {
  const capture = await spawnCapture(
    process.execPath,
    ["-e", "process.stdout.write(JSON.stringify(process.env))"],
    {
      cwd: root,
      env: { ...process.env, ...secrets, NODE_OPTIONS: "--no-warnings" },
    },
  );
  assert(capture.ok);
  const childEnv = JSON.parse(capture.stdout);
  check(
    Object.keys(secrets).every((key) => childEnv[key] === undefined),
    "detector child excludes all supplied secrets",
  );
  check(childEnv.NODE_OPTIONS === undefined, "detector child excludes Node startup hooks");
  check(childEnv.PATH === process.env.PATH, "detector child retains PATH");

  const config = JSON.parse(
    buildMcpConfigContent({
      cwd: root,
      command: [process.execPath, "-e", "process.stdout.write(JSON.stringify(process.env))"],
    }),
  );
  const [bin, ...argv] = config.mcp.servers.warden.command;
  const mcpEnv = JSON.parse(
    execFileSync(bin, argv, { cwd: root, env: { ...process.env, ...secrets }, encoding: "utf8" }),
  );
  check(
    Object.keys(secrets).every((key) => mcpEnv[key] === undefined),
    "MCP command clears inherited secrets before Node starts",
  );
  check(mcpEnv.PATH === process.env.PATH, "MCP command retains PATH");

  // Both a repo ESLint config and a substituted tsc executable can run JS.
  mkdirSync(resolve(root, "node_modules/.bin"), { recursive: true });
  symlinkSync(
    resolve(cliRoot, "../core/node_modules/eslint/bin/eslint.js"),
    resolve(root, "node_modules/.bin/eslint"),
  );
  const probe = (name: string) =>
    `require('node:fs').writeFileSync(${JSON.stringify(resolve(root, name))}, JSON.stringify(process.env));`;
  writeFileSync(
    resolve(root, "eslint.config.cjs"),
    `${probe("eslint-env.json")}\nmodule.exports = [{ files: ['**/*.js'], rules: {} }];\n`,
  );
  writeFileSync(
    resolve(root, "node_modules/.bin/tsc"),
    `#!${process.execPath}\n${probe("tsc-env.json")}\n`,
    { mode: 0o755 },
  );
  writeFileSync(
    resolve(root, "package.json"),
    JSON.stringify({ name: "fixture", version: "1.0.0" }),
  );
  writeFileSync(resolve(root, "tsconfig.json"), "{}");
  writeFileSync(resolve(root, "a.js"), "const a = 1;\n");
  execFileSync("git", ["init", "-q"], { cwd: root });
  const configHome = resolve(root, "config-home");
  mkdirSync(resolve(configHome, "warden"), { recursive: true });
  writeFileSync(resolve(configHome, "warden/env"), "GLOBAL_FILE_SECRET=smoke-global-value\n");
  writeFileSync(resolve(root, ".env"), "PROJECT_FILE_SECRET=smoke-project-value\n");
  const override = resolve(root, "override.env");
  writeFileSync(override, "OVERRIDE_FILE_SECRET=smoke-override-value\n");
  writeFileSync(resolve(root, "configured.env"), "CONFIGURED_FILE_SECRET=smoke-configured-value\n");
  writeFileSync(
    resolve(root, "warden.jsonc"),
    JSON.stringify({ env: { files: ["configured.env"] } }),
  );
  const runtimeProbe = resolve(root, "runtime-probe.mjs");
  writeFileSync(
    runtimeProbe,
    `
    import { loadWardenRuntime, currentWardenRuntime, restrictProcessToDeterministicEnv } from ${JSON.stringify(resolve(cliRoot, "../env/src/index.ts"))};
    restrictProcessToDeterministicEnv();
    const runtime = loadWardenRuntime({ repoRoot: ${JSON.stringify(root)}, loadEnvFiles: false });
    const next = currentWardenRuntime({ repoRoot: ${JSON.stringify(resolve(root, "another-repo"))} });
    process.stdout.write(JSON.stringify({ env: process.env, files: runtime.envFiles, nextFiles: next.envFiles }));
  `,
  );
  const runtime = JSON.parse(
    execFileSync(
      process.execPath,
      ["--import", fileURLToPath(import.meta.resolve("tsx/esm")), runtimeProbe],
      {
        env: { ...process.env, ...secrets, XDG_CONFIG_HOME: configHome, WARDEN_ENV_FILE: override },
        encoding: "utf8",
      },
    ),
  );
  check(
    Object.keys(secrets).every((key) => runtime.env[key] === undefined),
    "MCP runtime removes inherited secrets",
  );
  check(
    runtime.files.length === 0 && runtime.nextFiles.length === 0,
    "MCP runtime keeps env-file loading off across repo changes",
  );
  check(
    [
      "GLOBAL_FILE_SECRET",
      "PROJECT_FILE_SECRET",
      "OVERRIDE_FILE_SECRET",
      "CONFIGURED_FILE_SECRET",
    ].every((key) => runtime.env[key] === undefined),
    "MCP runtime does not reload env-file secrets",
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      "--import",
      fileURLToPath(import.meta.resolve("tsx/esm")),
      resolve(cliRoot, "src/index.ts"),
      "mcp",
    ],
    cwd: root,
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          (pair): pair is [string, string] => pair[1] !== undefined,
        ),
      ),
      ...secrets,
      XDG_CONFIG_HOME: configHome,
      WARDEN_ENV_FILE: override,
      WARDEN_CACHE_PATH: resolve(root, "cache.sqlite"),
    },
    stderr: "pipe",
  });
  await client.connect(transport);
  const result = await client.callTool({
    name: "run_det_priors",
    arguments: {
      request: {
        target: "diff",
        mode: "check",
        diff: "diff --git a/a.js b/a.js\n--- /dev/null\n+++ b/a.js\n@@ -0,0 +1 @@\n+const a = 1;\n",
      },
    },
  });
  check(!result.isError, "real MCP runs the fixture detectors");
  for (const name of ["eslint", "tsc"]) {
    const env = JSON.parse(readFileSync(resolve(root, `${name}-env.json`), "utf8"));
    check(
      Object.keys(secrets).every((key) => env[key] === undefined),
      `${name} repo code cannot read inherited secrets`,
    );
    check(
      [
        "GLOBAL_FILE_SECRET",
        "PROJECT_FILE_SECRET",
        "OVERRIDE_FILE_SECRET",
        "CONFIGURED_FILE_SECRET",
      ].every((key) => env[key] === undefined),
      `${name} repo code cannot read secrets reloaded from env files`,
    );
  }
} finally {
  await client.close();
  rmSync(root, { recursive: true, force: true });
}
if (failed) throw new Error(`${failed} secret-isolation assertions failed`);
process.stdout.write("all assertions passed\n");

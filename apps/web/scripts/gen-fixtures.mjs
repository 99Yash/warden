import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "..");
const repoRoot = resolve(appRoot, "../..");
const fixturePath = resolve(appRoot, "src/fixtures/warden-on-warden.json");

const child = spawn("pnpm", ["warden", "review", "--json", "--base", "main"], {
  cwd: repoRoot,
  env: process.env,
  stdio: ["ignore", "pipe", "inherit"],
});

let output = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  output += chunk;
});

const code = await new Promise((resolveCode) => {
  child.on("close", resolveCode);
});

if (code !== 0) {
  throw new Error(`warden review failed with exit code ${code}`);
}

const parsed = JSON.parse(output);
await writeFile(fixturePath, `${JSON.stringify(parsed, null, 2)}\n`);
console.log(`wrote ${fixturePath}`);

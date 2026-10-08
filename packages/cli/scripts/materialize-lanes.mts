/**
 * Slice #42: materialize the down-lane OpenCode agent config from warden's
 * method sources. Usage:
 *   pnpm lanes:materialize       # write packages/cli/opencode/*
 *   pnpm lanes:check             # regenerate in memory, fail on drift
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  CHARTER_PATH,
  CONFIG_FILENAME,
  DOWN_LANE_SPEC,
  PROMPT_FILENAME,
  materializeLane,
} from "../src/opencode/materialize.js";

const CLI_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(CLI_ROOT, "..", "..");
const OUT_DIR = resolve(CLI_ROOT, "opencode");

function readSource(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), "utf8");
}

const charter = readSource(CHARTER_PATH);
const sources = new Map<string, string>();
for (const include of DOWN_LANE_SPEC.includes) {
  if (!sources.has(include.file)) sources.set(include.file, readSource(include.file));
}
const { prompt, configJson } = materializeLane(DOWN_LANE_SPEC, { charter, sources });

const outputs: Array<{ filename: string; content: string }> = [
  { filename: PROMPT_FILENAME, content: prompt },
  { filename: CONFIG_FILENAME, content: configJson },
];

if (process.argv.includes("--check")) {
  const drifted = outputs
    .filter(({ filename, content }) => {
      const path = resolve(OUT_DIR, filename);
      return !existsSync(path) || readFileSync(path, "utf8") !== content;
    })
    .map(({ filename }) => filename);
  if (drifted.length > 0) {
    process.stderr.write(
      `lanes:check: drifted files: ${drifted.join(", ")} — run pnpm lanes:materialize\n`,
    );
    process.exit(1);
  }
  process.stdout.write("lanes:check: materialized files match the method sources\n");
} else {
  mkdirSync(OUT_DIR, { recursive: true });
  for (const { filename, content } of outputs) {
    writeFileSync(resolve(OUT_DIR, filename), content);
  }
  process.stdout.write(`lanes:materialize: wrote ${outputs.map((o) => o.filename).join(", ")}\n`);
}

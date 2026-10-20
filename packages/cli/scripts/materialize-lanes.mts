/**
 * Slice #42: materialize each lane's OpenCode agent config (`LANE_SPECS`)
 * from warden's method sources. Usage:
 *   pnpm lanes:materialize       # write packages/cli/opencode/*
 *   pnpm lanes:check             # regenerate in memory, fail on drift
 *
 * Both modes fail when a materialized prompt loses one of its spec's
 * required phrases (the read/grep exclusions and the read bound).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  LANE_SPECS,
  materializeLane,
  missingRequiredPhrases,
} from "../src/opencode/materialize.js";
import { readLaneInput } from "./lane-input.mjs";

const CLI_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(CLI_ROOT, "..", "..");
const OUT_DIR = resolve(CLI_ROOT, "opencode");

const outputs: Array<{ filename: string; content: string }> = [];
const lostPhrases: string[] = [];
for (const spec of LANE_SPECS) {
  const { prompt, configJson } = materializeLane(spec, readLaneInput(spec, REPO_ROOT));
  for (const phrase of missingRequiredPhrases(spec, prompt)) {
    lostPhrases.push(`${spec.promptFilename}: "${phrase}"`);
  }
  outputs.push(
    { filename: spec.promptFilename, content: prompt },
    { filename: spec.configFilename, content: configJson },
  );
}

if (lostPhrases.length > 0) {
  process.stderr.write(
    `lanes: a prompt lost a required phrase (restore it in the charter): ${lostPhrases.join("; ")}\n`,
  );
  process.exit(1);
}

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

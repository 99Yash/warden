/**
 * Offline size report for each lane's materialized prompt (`LANE_SPECS`):
 * total bytes, a token estimate, and the bytes of each part (charter body,
 * each included section, the finding schema). No model call, no network.
 *
 * The estimate is UTF-8 bytes / 4. It is a planning figure, not a
 * tokenizer count; the provider's token count for the same text can
 * differ by 10–20%.
 *
 * Usage: pnpm --filter @warden/cli lanes:measure
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LANE_SPECS, extractSection, materializeLane } from "../src/opencode/materialize.js";
import { readLaneInput } from "./lane-input.mjs";

const CLI_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(CLI_ROOT, "..", "..");
/** Planning ratio: UTF-8 bytes per token for English prose and markdown. */
const BYTES_PER_TOKEN = 4;

function bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function tokens(n: number): string {
  return `~${(n / BYTES_PER_TOKEN / 1000).toFixed(1)}K`;
}

const lines: string[] = [
  "| Lane | Prompt file | Prompt bytes | Est. tokens (bytes/4) | Config bytes |",
  "| --- | --- | ---: | ---: | ---: |",
];
const parts: string[] = ["| Lane | Part | Bytes | Est. tokens |", "| --- | --- | ---: | ---: |"];
for (const spec of LANE_SPECS) {
  const { charter, sources, includes } = readLaneInput(spec, REPO_ROOT);
  const { prompt, configJson } = materializeLane(spec, { charter, sources });
  const total = bytes(prompt);
  lines.push(
    `| ${spec.lane} | \`${spec.promptFilename}\` | ${total} | ${tokens(total)} | ${bytes(configJson)} |`,
  );
  const charterBytes = bytes(charter.replace(/\s+$/, ""));
  parts.push(
    `| ${spec.lane} | charter \`${spec.charterPath}\` | ${charterBytes} | ${tokens(charterBytes)} |`,
  );
  let sectionBytes = 0;
  for (const include of includes) {
    const source = sources.get(include.file);
    if (source === undefined) {
      throw new Error(`lanes:measure: readLaneInput did not read included file ${include.file}`);
    }
    const n = bytes(extractSection(source, include.file, include.heading));
    sectionBytes += n;
    parts.push(`| ${spec.lane} | \`${include.file}\` ${include.heading} | ${n} | ${tokens(n)} |`);
  }
  // The rest is the banner, the joins, and the schema block.
  const rest = total - charterBytes - sectionBytes;
  parts.push(`| ${spec.lane} | banner + finding schema | ${rest} | ${tokens(rest)} |`);
}
process.stdout.write(`${lines.join("\n")}\n\n${parts.join("\n")}\n`);

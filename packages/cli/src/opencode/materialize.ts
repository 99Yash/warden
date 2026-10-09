import { z } from "zod";
import { LaneFindingSchema } from "@warden/core";

/**
 * Slice #42 / ADR-0053 §9: the down-lane prompt materializer. Pure —
 * inputs are file contents, outputs are file contents; no spawning, no
 * disk access. The script entry (`scripts/materialize-lanes.mts`) owns
 * I/O; the smoke drives these functions directly.
 *
 * One typed const (`DOWN_LANE_SPEC`) is the single source for the lane
 * id, agent id, tier, default model, step cap, and allowed tools — the
 * agent config and the driver both read it. The included method sections
 * have one home only: the fenced `includes` list in the charter, which
 * `materializeLane` parses (format `<path> :: <heading>`, one per line).
 */

export interface LaneInclude {
  /** Repo-root-relative path of the method source file. */
  file: string;
  /** Exact heading text to extract (must match one line verbatim). */
  heading: string;
}

export interface LaneSpec {
  lane: "down";
  agentId: string;
  tier: "strong";
  /** Tier default; the client's provider config owns the real choice. */
  defaultModel: string;
  steps: number;
  description: string;
  /** Read-only v2 tool names, verified against `core/src/tool/plugin/*`. */
  allowedTools: string[];
}

export const DOWN_LANE_SPEC: LaneSpec = {
  lane: "down",
  agentId: "warden-down",
  tier: "strong",
  defaultModel: "anthropic/claude-opus-5-5#high",
  steps: 60,
  description:
    "Warden down lane: invariant proof with a correctness focus. Traces claimed behavior through callers, state, and failure; submits findings as JSON.",
  allowedTools: ["read", "grep", "glob"],
};

export const CHARTER_PATH = "docs/reference/lanes/down.md";
export const PROMPT_FILENAME = "warden-down.md";
export const CONFIG_FILENAME = "opencode.json";

/** MCP tool actions the lane may call (server `warden` + tool name). */
export const LANE_MCP_TOOLS = ["warden_run_det_priors", "warden_lookup_type_def"] as const;

/**
 * Extracts one section from a method source: from the line matching
 * `heading` exactly to (not including) the next heading of the same or
 * higher level. Strips single-line `<!-- … -->` comment lines. Throws
 * naming the file and heading when the heading is absent.
 */
export function extractSection(source: string, file: string, heading: string): string {
  const lines = source.split("\n");
  const level = headingLevel(heading);
  if (level === undefined) {
    throw new Error(`materialize: "${heading}" is not a heading (no leading #) in ${file}`);
  }
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) {
    throw new Error(`materialize: heading "${heading}" not found in ${file}`);
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] as string;
    const lineLevel = headingLevel(line);
    if (lineLevel !== undefined && lineLevel <= level) {
      end = i;
      break;
    }
  }
  return lines
    .slice(start, end)
    .filter((line) => !isCommentLine(line))
    .join("\n")
    .replace(/\s+$/, "");
}

function headingLevel(line: string): number | undefined {
  const match = /^(#{1,6})\s/.exec(line.trim());
  return match?.[1] !== undefined ? (match[1] as string).length : undefined;
}

function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("<!--") && trimmed.endsWith("-->");
}

export interface MaterializeInput {
  /** Charter file content (the fenced include list is parsed, not just kept verbatim). */
  charter: string;
  /** Method source contents keyed by repo-root-relative path. */
  sources: Map<string, string>;
}

export interface MaterializeOutput {
  prompt: string;
  configJson: string;
}

/**
 * Parses the charter's fenced `includes` list — the single home of "the
 * method sections this lane carries". Format `<path> :: <heading>`, one
 * entry per line. A malformed entry fails naming the charter line.
 */
export function parseCharterIncludes(charter: string): LaneInclude[] {
  return parseCharterIncludesLined(charter).map(({ include }) => include);
}

function parseCharterIncludesLined(
  charter: string,
): Array<{ include: LaneInclude; lineNo: number }> {
  const fence = /```includes[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/m.exec(charter);
  if (fence === null) {
    throw new Error(`materialize: no fenced includes list in ${CHARTER_PATH}`);
  }
  const fenceLine = charter.slice(0, fence.index).split("\n").length;
  const body = (fence[1] as string).split("\n");
  const includes: Array<{ include: LaneInclude; lineNo: number }> = [];
  body.forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed === "") return;
    const lineNo = fenceLine + index + 1;
    const sep = trimmed.indexOf(" :: ");
    const file = sep === -1 ? "" : trimmed.slice(0, sep).trim();
    const heading = sep === -1 ? "" : trimmed.slice(sep + 4).trim();
    if (sep === -1 || file === "" || heading === "" || !heading.startsWith("#")) {
      throw new Error(
        `materialize: ${CHARTER_PATH} line ${lineNo}: malformed includes entry "${trimmed}" (want "<path> :: <heading>")`,
      );
    }
    includes.push({ include: { file, heading }, lineNo });
  });
  if (includes.length === 0) {
    throw new Error(`materialize: empty includes list in ${CHARTER_PATH}`);
  }
  return includes;
}

/**
 * Assembles the system prompt (banner → charter → included sections →
 * finding schema) and the v2 agent config. Output is byte-stable: fixed
 * key order, `\n` endings, trailing newline.
 */
export function materializeLane(spec: LaneSpec, input: MaterializeInput): MaterializeOutput {
  const lined = parseCharterIncludesLined(input.charter);
  const includes = lined.map(({ include }) => include);
  const sourceFiles = uniqueFiles(includes);
  for (const file of sourceFiles) {
    if (!input.sources.has(file)) {
      throw new Error(`materialize: source file not provided: ${file}`);
    }
  }
  const bannerSources = [CHARTER_PATH, ...sourceFiles].join(", ");
  const banner = `<!-- GENERATED by pnpm lanes:materialize from ${bannerSources} — do not edit -->`;
  // A charter entry that names a missing section fails naming the charter
  // line, so `lanes:check` catches a stale include list.
  const sections = lined.map(({ include, lineNo }) => {
    try {
      return extractSection(
        input.sources.get(include.file) as string,
        include.file,
        include.heading,
      );
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`materialize: ${CHARTER_PATH} line ${lineNo}: ${detail}`);
    }
  });
  const schemaJson = JSON.stringify(z.toJSONSchema(LaneFindingSchema), null, 2);
  const prompt = [
    banner,
    "",
    input.charter.replace(/\s+$/, ""),
    ...sections.flatMap((section) => ["", section]),
    "",
    "## Finding JSON schema",
    "",
    "Each submitted finding must validate against this schema (no `id` — the post-pass mints it):",
    "",
    "```json",
    schemaJson,
    "```",
    "",
  ].join("\n");

  const permissions = [
    { action: "*", resource: "*", effect: "deny" },
    ...spec.allowedTools.map((tool) => ({ action: tool, resource: "*", effect: "allow" })),
    ...LANE_MCP_TOOLS.map((tool) => ({ action: tool, resource: "*", effect: "allow" })),
  ];
  const config = {
    agents: {
      [spec.agentId]: {
        description: spec.description,
        mode: "primary",
        model: spec.defaultModel,
        steps: spec.steps,
        system: `{file:./${PROMPT_FILENAME}}`,
        permissions,
      },
    },
    mcp: {
      servers: {
        warden: { type: "local", command: ["warden", "mcp"], codemode: false },
      },
    },
  };
  return { prompt, configJson: `${JSON.stringify(config, null, 2)}\n` };
}

function uniqueFiles(includes: LaneInclude[]): string[] {
  const seen: string[] = [];
  for (const include of includes) {
    if (!seen.includes(include.file)) seen.push(include.file);
  }
  return seen;
}

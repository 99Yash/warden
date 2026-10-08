import { z } from "zod";
import { LaneFindingSchema } from "@warden/core";

/**
 * Slice #42 / ADR-0053 §9: the down-lane prompt materializer. Pure —
 * inputs are file contents, outputs are file contents; no spawning, no
 * disk access. The script entry (`scripts/materialize-lanes.mts`) owns
 * I/O; the smoke drives these functions directly.
 *
 * One typed const (`DOWN_LANE_SPEC`) is the single source for the lane
 * id, agent id, tier, default model, step cap, includes, and allowed
 * tools — the agent config and the driver both read it.
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
  includes: LaneInclude[];
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
  includes: [
    { file: "docs/reference/structural-review.md", heading: "## Three review motions" },
    {
      file: "docs/reference/structural-review.md",
      heading: "## Three dimensions for drilling down",
    },
    {
      file: "packages/core/src/review-harness/prompts/workers/correctness-system.md",
      heading: "# What counts as a correctness finding",
    },
    {
      file: "packages/core/src/review-harness/prompts/workers/correctness-system.md",
      heading: "# What you do NOT flag",
    },
    {
      file: "packages/core/src/review-harness/prompts/workers/diligent-preamble.md",
      heading: "## Investigate before you judge (mandatory, not optional)",
    },
    {
      file: "packages/core/src/review-harness/prompts/workers/diligent-preamble.md",
      heading: "## Two archetypes to hunt explicitly",
    },
  ],
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
  /** Charter file content (includes the fenced include list, kept verbatim). */
  charter: string;
  /** Method source contents keyed by repo-root-relative path. */
  sources: Map<string, string>;
}

export interface MaterializeOutput {
  prompt: string;
  configJson: string;
}

/**
 * Assembles the system prompt (banner → charter → included sections →
 * finding schema) and the v2 agent config. Output is byte-stable: fixed
 * key order, `\n` endings, trailing newline.
 */
export function materializeLane(spec: LaneSpec, input: MaterializeInput): MaterializeOutput {
  const sourceFiles = uniqueFiles(spec.includes);
  for (const file of sourceFiles) {
    if (!input.sources.has(file)) {
      throw new Error(`materialize: source file not provided: ${file}`);
    }
  }
  const bannerSources = [CHARTER_PATH, ...sourceFiles].join(", ");
  const banner = `<!-- GENERATED by pnpm lanes:materialize from ${bannerSources} — do not edit -->`;
  const sections = spec.includes.map((include) =>
    extractSection(input.sources.get(include.file) as string, include.file, include.heading),
  );
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

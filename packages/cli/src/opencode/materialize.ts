import { z } from "zod";
import {
  LaneFindingSchema,
  READ_SECRET_FILE_GLOBS,
  GIT_METADATA_GLOBS,
  type LaneName,
} from "@warden/core";

/**
 * Slice #42 / ADR-0053 §9: the lane prompt materializer. Pure — inputs
 * are file contents, outputs are file contents; no spawning, no disk
 * access. The script entry (`scripts/materialize-lanes.mts`) owns I/O;
 * the smoke drives these functions directly.
 *
 * A `LaneSpec` is the single source for one lane: the lane id, agent id,
 * tier, default model, step cap, allowed tools, charter path, generated
 * file names, and the phrases its prompt must keep. The materializer and
 * the driver both take a spec as data, and `LANE_SPECS` lists every lane
 * that `lanes:materialize` writes. The included method sections have one
 * home only: the fenced `includes` list in the charter, which
 * `materializeLane` parses (format `<path> :: <heading>`, one per line).
 *
 * The output contract is the same for every lane, so it is not spec
 * data: the final message ends with one fenced ` ```json ` block that
 * holds `{"findings":[...]}`, each finding validates against
 * `LaneFindingSchema` (appended to every prompt), and the driver's
 * `evaluateLane` reads it.
 */

export interface LaneInclude {
  /** Repo-root-relative path of the method source file. */
  file: string;
  /** Exact heading text to extract (must match one line verbatim). */
  heading: string;
}

export interface LaneSpec {
  /** The post-pass lane name (`LaneNameEnum`) that the driver writes into the lane envelope. */
  lane: Extract<LaneName, "down" | "up">;
  agentId: string;
  tier: "strong";
  /** Tier default; the client's provider config owns the real choice. */
  defaultModel: string;
  /** OpenCode step cap. The driver's scope ceiling derives from it (`laneScopeCeiling`). */
  steps: number;
  /** The charter's step cost, from which the driver derives the scope ceiling. */
  scopeBudget: LaneScopeBudget;
  description: string;
  /** Read-only v2 tool names, verified against `core/src/tool/plugin/*`. */
  allowedTools: string[];
  /** Repo-root-relative path of the canonical charter. */
  charterPath: string;
  /** Generated system prompt, in `packages/cli/opencode/`. */
  promptFilename: string;
  /**
   * Generated OpenCode config, in `packages/cli/opencode/`. Each lane has
   * its own file: `compaction` is a top-level key, and the driver points
   * one private `serve` at one config.
   */
  configFilename: string;
  /**
   * Phrases that the materialized prompt must keep, compared with
   * whitespace collapsed: the read/grep exclusions and the lane's read
   * bound. `lanes:check` fails when one is missing (`missingRequiredPhrases`).
   */
  requiredPhrases: readonly string[];
}

/**
 * Issue #57: the tool steps that the charter's method spends, for the
 * driver's scope ceiling (`laneScopeCeiling`). Each text field names the
 * cost in the over-ceiling reason.
 */
export interface LaneScopeBudget {
  /** Tool steps that each changed file costs. */
  stepsPerFile: number;
  /** What one file costs, for example "one read per changed file". */
  perFile: string;
  /** Tool steps that the method spends whatever the scope size, and on what. */
  fixed?: { steps: number; what: string };
}

/**
 * The read/grep exclusions that every charter states (issue #57). The
 * host keys grep permission on the pattern, not the path, so the charter
 * is the only thing that keeps read/grep out of the fixtures and the ADR
 * corpus.
 */
const READ_EXCLUSION_PHRASES = ["`**/fixtures/**`", "`**/*.patch`", "root-level `*.md`"] as const;

export const DOWN_LANE_SPEC: LaneSpec = {
  lane: "down",
  agentId: "warden-down",
  tier: "strong",
  defaultModel: "anthropic/claude-opus-5-5#high",
  steps: 60,
  scopeBudget: { stepsPerFile: 1, perFile: "one read per changed file" },
  description:
    "Warden down lane: invariant proof with a correctness focus. Traces claimed behavior through callers, state, and failure; submits findings as JSON.",
  allowedTools: ["read", "grep", "glob"],
  charterPath: "docs/reference/lanes/down.md",
  promptFilename: "warden-down.md",
  configFilename: "opencode.json",
  // Issue #57: the down lane ran out its timeout because the charter
  // asked for unbounded depth. The bound and its route to `unproven` must
  // reach the model.
  requiredPhrases: [
    ...READ_EXCLUSION_PHRASES,
    "trace each claim **one hop** from a changed symbol",
    "open **at most 3 files per claim**",
    "**Reaching the bound is a normal end, not a failure.**",
    "conclude **unproven**: the missing evidence is the next file you would have opened",
    "where they differ, the bound wins",
    "A claim that reaches the step 2 bound is **unproven**",
  ],
};

/**
 * ADR-0052 (Lever D), proposed and not ratified: the up lane ships
 * default-off. `lanes:materialize` writes its files, but the driver runs
 * it only on `--lane up` (`warden opencode-review`) or the eval config
 * `opencode-up`. Option A (2026-10-20): the down lane keeps its read cap,
 * and the up lane has its own bound — at most 3 confirmed candidates, at
 * most 3 home files per candidate.
 */
export const UP_LANE_SPEC: LaneSpec = {
  lane: "up",
  agentId: "warden-up",
  tier: "strong",
  defaultModel: "anthropic/claude-opus-5-5#high",
  steps: 60,
  // Pass 1 reads each changed file and greps for its other homes; pass 2
  // opens at most 3 home files for each of at most 3 candidates.
  scopeBudget: {
    stepsPerFile: 2,
    perFile: "one read and one grep per changed file",
    fixed: { steps: 9, what: "pass 2 reads (3 candidates x 3 home files)" },
  },
  description:
    "Warden up lane: structural search with a drift focus. Maps where each changed fact lives, confirms gated restructures, and submits findings as JSON.",
  allowedTools: ["read", "grep", "glob"],
  charterPath: "docs/reference/lanes/up.md",
  promptFilename: "warden-up.md",
  configFilename: "opencode-up.json",
  requiredPhrases: [
    ...READ_EXCLUSION_PHRASES,
    "Confirm **at most 3 candidates**",
    "open **at most 3 home files per candidate**",
    "**Reaching the bound is a normal end, not a failure.**",
    "where they differ, the bound wins",
    "the right answer when no candidate clears the admission gates",
  ],
};

/** Every lane that `lanes:materialize` writes, in output order. */
export const LANE_SPECS: readonly LaneSpec[] = [DOWN_LANE_SPEC, UP_LANE_SPEC];

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
  // The section ends at the next heading of the same or a higher level.
  const next = lines.findIndex((line, i) => {
    if (i <= start) return false;
    const lineLevel = headingLevel(line);
    return lineLevel !== undefined && lineLevel <= level;
  });
  const end = next === -1 ? lines.length : next;
  return lines
    .slice(start, end)
    .filter((line) => !isCommentLine(line))
    .join("\n")
    .replace(/\s+$/, "");
}

function headingLevel(line: string): number | undefined {
  const match = /^(#{1,6})\s/.exec(line.trim());
  return match?.[1] !== undefined ? match[1].length : undefined;
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
 * entry per line. A malformed entry fails naming the charter path and
 * line.
 */
export function parseCharterIncludes(charter: string, charterPath: string): LaneInclude[] {
  return parseCharterIncludesLined(charter, charterPath).map(({ include }) => include);
}

function parseCharterIncludesLined(
  charter: string,
  charterPath: string,
): Array<{ include: LaneInclude; lineNo: number }> {
  const fences = [...charter.matchAll(/```includes[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/gm)];
  const [fence, second] = fences;
  if (fence === undefined) {
    throw new Error(`materialize: no fenced includes list in ${charterPath}`);
  }
  if (second !== undefined) {
    const lineNo = charter.slice(0, second.index).split("\n").length;
    throw new Error(
      `materialize: ${charterPath} line ${lineNo}: second includes fence (only one includes list is allowed)`,
    );
  }
  const fenceLine = charter.slice(0, fence.index).split("\n").length;
  const body = (fence[1] ?? "").split("\n");
  const includes: Array<{ include: LaneInclude; lineNo: number }> = [];
  const seen = new Set<string>();
  body.forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed === "") return;
    const lineNo = fenceLine + index + 1;
    const sep = trimmed.indexOf(" :: ");
    const file = sep === -1 ? "" : trimmed.slice(0, sep).trim();
    const heading = sep === -1 ? "" : trimmed.slice(sep + 4).trim();
    if (sep === -1 || file === "" || heading === "" || !heading.startsWith("#")) {
      throw new Error(
        `materialize: ${charterPath} line ${lineNo}: malformed includes entry "${trimmed}" (want "<path> :: <heading>")`,
      );
    }
    const key = `${file} :: ${heading}`;
    if (seen.has(key)) {
      throw new Error(
        `materialize: ${charterPath} line ${lineNo}: duplicate includes entry "${trimmed}"`,
      );
    }
    seen.add(key);
    includes.push({ include: { file, heading }, lineNo });
  });
  if (includes.length === 0) {
    throw new Error(`materialize: empty includes list in ${charterPath}`);
  }
  return includes;
}

/**
 * The spec's required phrases that the prompt does not contain, compared
 * with whitespace collapsed so a reflow does not trip it. Empty when the
 * prompt keeps all of them.
 */
export function missingRequiredPhrases(spec: LaneSpec, prompt: string): string[] {
  const flat = (text: string): string => text.replace(/\s+/g, " ");
  const flatPrompt = flat(prompt);
  return spec.requiredPhrases.filter((phrase) => !flatPrompt.includes(flat(phrase)));
}

/**
 * Assembles the system prompt (banner → charter → included sections →
 * finding schema) and the v2 agent config. Output is byte-stable: fixed
 * key order, `\n` endings, trailing newline.
 */
export function materializeLane(spec: LaneSpec, input: MaterializeInput): MaterializeOutput {
  const lined = parseCharterIncludesLined(input.charter, spec.charterPath);
  const includes = lined.map(({ include }) => include);
  const sourceFiles = uniqueFiles(includes);
  for (const file of sourceFiles) {
    if (!input.sources.has(file)) {
      throw new Error(`materialize: source file not provided: ${file}`);
    }
  }
  const bannerSources = [spec.charterPath, ...sourceFiles].join(", ");
  const banner = `<!-- GENERATED by pnpm lanes:materialize from ${bannerSources} — do not edit -->`;
  // A charter entry that names a missing section fails naming the charter
  // line, so `lanes:check` catches a stale include list.
  const sections = lined.map(({ include, lineNo }) => {
    // The loop above checked every file, so this lookup always finds one.
    const source = input.sources.get(include.file);
    if (source === undefined) {
      throw new Error(`materialize: source file not provided: ${include.file}`);
    }
    try {
      return extractSection(source, include.file, include.heading);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const succinct = detail.startsWith("materialize: ")
        ? detail.slice("materialize: ".length)
        : detail;
      throw new Error(`materialize: ${spec.charterPath} line ${lineNo}: ${succinct}`, {
        cause: err,
      });
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
    // Secret guard (mirrors the built-in `explore` agent): agent rules are
    // appended after global rules and the last match wins, so a bare
    // `allow read *` would re-open `.env` files the host default and the
    // user's global config deny. Deny (not ask): the host enforces a deny
    // before any client reply, while an ask depends on the run client's
    // reply, which is version-dependent.
    // Read permissions have their own policy. The publication guard covers
    // these paths and additional sensitive paths (ADR-0054 §3).
    ...READ_SECRET_FILE_GLOBS.deny.map((glob) => ({
      action: "read",
      resource: glob,
      effect: "deny",
    })),
    ...READ_SECRET_FILE_GLOBS.allow.map((glob) => ({
      action: "read",
      resource: glob,
      effect: "allow",
    })),
    ...GIT_METADATA_GLOBS.map((glob) => ({ action: "read", resource: glob, effect: "deny" })),
    ...LANE_MCP_TOOLS.map((tool) => ({ action: tool, resource: "*", effect: "allow" })),
  ];
  const config = {
    agents: {
      [spec.agentId]: {
        description: spec.description,
        mode: "primary",
        model: spec.defaultModel,
        steps: spec.steps,
        system: `{file:./${spec.promptFilename}}`,
        permissions,
      },
    },
    mcp: {
      servers: {
        warden: { type: "local", command: ["warden", "mcp"], codemode: false },
      },
    },
    // A lane must not compact: a summary drops the code text a finding
    // cites. OpenCode compacts by default (`{auto: true, keep: 15000}`),
    // before a step near the context limit and after a provider overflow.
    // `auto: false` skips both; only a manual compact still runs. The key
    // is top-level; there is no per-agent field (verified in the shipped
    // binary v2.0.32). At the limit the provider rejects the request, and
    // the driver fails the lane with a `context_limit` reason.
    compaction: { auto: false },
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

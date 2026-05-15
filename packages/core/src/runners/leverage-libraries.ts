import { open, readFile } from "node:fs/promises";
import { dirname, resolve as resolvePath, sep as pathSep } from "node:path";
import {
  Output,
  getWorkerCheapFallbackModel,
  getWorkerCheapModel,
  stepCountIs,
  streamText,
  type LanguageModel,
  type ToolSet,
} from "@warden/ai";
import { z } from "zod";
import { stableCommentId } from "../comment-id.js";
import type { ChangedFile } from "../diff/index.js";
import { loadLeverageSystemPrompt } from "../llm/prompt-loader.js";
import { makeLookupTypeDefTool } from "../llm/tools/lookup-type-def.js";
import type { Runner, RunnerInput, RunnerOutput } from "../orchestration/runner.js";
import type { Comment, DegradedEntry, Source } from "../schema.js";
import { formatErr } from "./_shared.js";

/**
 * Leverage sub-agent (ADR-0027, M12). Cheap-tier LLM (Haiku) scans the diff
 * for library-substitution opportunities — places where hand-rolled code
 * duplicates an installed library primitive (Drizzle relational `with:`,
 * Elysia `.guard()`, AI SDK `Output.array`, etc.).
 *
 * Lane discipline (ADR-0021 §3): sub-agents emit questions, never assertions.
 * Each finding's `api_def` source is copied verbatim from M11's
 * `lookupTypeDef` and flows through to the post-pass global verifier
 * (`verify-citations.ts`) for substring-match against the cited `.d.ts`.
 * Findings whose path is outside the diff are dropped silently (lane
 * integrity) before becoming Comments; the global verifier is the second
 * line of defense against hallucinated `.d.ts` references.
 *
 * Mode gate: dispatch only registers this runner in `review` mode. `check`
 * stays deterministic per ADR-0011 — no LLM calls.
 */

const DEFAULT_TIMEOUT_MS = 60_000;
const TOOL_USE_STEP_CAP = 8;
const SNIPPET_LINE_CAP = 20;
const CONTEXT_LINES = 2;
const MAX_READ_BYTES = 16_384;
const BINARY_SNIFF_BYTES = 2048;

const SENSITIVE_PATH_PATTERNS: ReadonlyArray<RegExp> = [
  /(^|\/)\.env(\..+)?$/,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /\.crt$/i,
  /(^|\/)id_(rsa|ed25519|dsa|ecdsa)(\.pub)?$/,
  /(^|\/)\.aws\/credentials$/,
  /(^|\/)\.npmrc$/,
  /(^|\/)\.netrc$/,
];

/**
 * Schema mirrors M11's `SuggestedApiDefSource` so the LLM can copy
 * `lookupTypeDef`'s result verbatim. The global verifier post-pass
 * substring-checks `(path, line, snippet)` against the cited file.
 */
const SubAgentSourceSchema = z.object({
  type: z.literal("api_def"),
  id: z.string(),
  title: z.string(),
  path: z.string(),
  line: z.number().int().positive(),
  snippet: z.string(),
  retrievedAt: z.string(),
});

const SubAgentFindingSchema = z.object({
  path: z.string(),
  line: z.number().int().positive(),
  snippet: z.string(),
  claim: z.string().min(1),
  explanation: z.string().min(1),
  suggestedAction: z.string().min(1),
  sources: z.array(SubAgentSourceSchema).default([]),
  tier: z.union([z.literal(2), z.literal(3)]).default(2),
  confidence: z.number().min(0).max(1).default(0.75),
});

const SubAgentOutputSchema = z.object({
  findings: z.array(SubAgentFindingSchema).default([]),
});

type SubAgentFinding = z.infer<typeof SubAgentFindingSchema>;

export interface LeverageLibrariesRunnerInput {
  repoRoot: string;
  changed: ChangedFile[];
  /** Override per-provider timeout (ms). */
  timeoutMs?: number;
}

export interface LeverageLibrariesRunnerOutput {
  questions: Comment[];
  degraded: DegradedEntry[];
}

export async function runLeverageLibraries(
  input: LeverageLibrariesRunnerInput,
): Promise<LeverageLibrariesRunnerOutput> {
  const degraded: DegradedEntry[] = [];
  const questions: Comment[] = [];

  if (input.changed.length === 0) {
    return { questions, degraded };
  }

  // Build the deps preamble + workspace package search roots. Read failures
  // degrade silently — a missing/malformed manifest is not actionable
  // mid-review, and the LLM will simply have no libraries to suggest from.
  const depsContext = await buildDependencyContext(input.repoRoot, input.changed);

  if (depsContext.dependencies.length === 0) {
    // No installed libraries discovered → no plausible substitutions. Short
    // circuit before the LLM call to save tokens. Stays silent (info-level
    // would be noise on most reviews).
    return { questions, degraded };
  }

  const fileInputs: SubAgentFileInput[] = [];
  for (const cf of input.changed) {
    try {
      const fi = await buildFileInput(input.repoRoot, cf);
      if (fi === null) continue;
      fileInputs.push(fi);
    } catch (err) {
      degraded.push({
        kind: "info",
        topic: "leverage-libraries",
        message: `leverage-libraries: skipped ${cf.path} (${formatErr(err)})`,
      });
    }
  }
  if (fileInputs.length === 0) {
    return { questions, degraded };
  }

  const lookupTool = makeLookupTypeDefTool({
    repoRoot: input.repoRoot,
    packageSearchRoots: depsContext.packageRoots,
    degraded,
  });
  const tools: ToolSet = { lookupTypeDef: lookupTool };

  const systemPrompt = loadLeverageSystemPrompt();
  const userPrompt = renderUserPrompt(depsContext.preamble, fileInputs);

  const subAgent = await callSubAgent({
    systemPrompt,
    userPrompt,
    tools,
    timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
  if (!subAgent.ok) {
    degraded.push({
      kind: "warning",
      topic: "leverage-libraries",
      message: `leverage-libraries: sub-agent failed (${subAgent.error})`,
    });
    return { questions, degraded };
  }
  if (subAgent.fellBackToGoogle) {
    degraded.push({
      kind: "warning",
      topic: "leverage-libraries",
      message: `leverage-libraries: anthropic failed (${subAgent.fallbackReason ?? "unknown"}), served from google`,
    });
  }

  const changedPaths = new Set(input.changed.map((cf) => cf.path));
  let droppedUnknownPath = 0;
  let droppedUncited = 0;
  for (const f of subAgent.findings) {
    if (!changedPaths.has(f.path)) {
      droppedUnknownPath += 1;
      continue;
    }
    if (f.sources.length === 0) {
      droppedUncited += 1;
      continue;
    }
    questions.push(toQuestion(f));
  }
  if (droppedUnknownPath > 0) {
    degraded.push({
      kind: "info",
      topic: "leverage-libraries",
      message: `leverage-libraries: dropped ${droppedUnknownPath} finding${droppedUnknownPath === 1 ? "" : "s"} citing paths outside the diff`,
    });
  }
  if (droppedUncited > 0) {
    degraded.push({
      kind: "info",
      topic: "leverage-libraries",
      message: `leverage-libraries: dropped ${droppedUncited} uncited finding${droppedUncited === 1 ? "" : "s"}`,
    });
  }

  return { questions, degraded };
}

export const leverageLibrariesRunner: Runner = {
  name: "leverage-libraries",
  async run(input: RunnerInput): Promise<RunnerOutput> {
    const result = await runLeverageLibraries({
      repoRoot: input.repoRoot,
      changed: input.changed,
    });
    return {
      name: "leverage-libraries",
      findings: [],
      questions: result.questions,
      degraded: result.degraded,
      durationMs: 0, // dispatcher overrides
    };
  },
};

// ---------------------------------------------------------------------------
// Dependency preamble + workspace package search roots.
// ---------------------------------------------------------------------------

interface DependencyContext {
  preamble: string;
  /** Installed package names (deduped) for the LLM's "Installed libraries" gate. */
  dependencies: string[];
  /** Workspace package roots whose `node_modules/` may hold packages not
   * present at the repo root. Always includes `repoRoot`. */
  packageRoots: string[];
}

const MANIFEST_DEP_KEYS = ["dependencies", "devDependencies", "peerDependencies"] as const;

async function buildDependencyContext(
  repoRoot: string,
  changed: ChangedFile[],
): Promise<DependencyContext> {
  const rootAbs = resolvePath(repoRoot);
  const manifestRoots = new Set<string>([rootAbs]);

  for (const cf of changed) {
    const fileAbs = resolveWithinRoot(rootAbs, cf.path);
    if (fileAbs === null) continue;
    const nearest = await findNearestPackageRoot(dirname(fileAbs), rootAbs);
    if (nearest) manifestRoots.add(nearest);
  }

  const dependencySet = new Set<string>();
  for (const root of manifestRoots) {
    try {
      const raw = await readFile(resolvePath(root, "package.json"), "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      for (const key of MANIFEST_DEP_KEYS) {
        const block = parsed[key];
        if (!block || typeof block !== "object") continue;
        for (const dep of Object.keys(block as Record<string, unknown>)) {
          dependencySet.add(dep);
        }
      }
    } catch {
      // Missing or malformed manifest → ignore. The LLM will operate on
      // whichever roots parsed cleanly.
    }
  }

  const dependencies = [...dependencySet].sort();
  const preamble =
    dependencies.length > 0
      ? `Installed libraries: ${dependencies.join(", ")}`
      : `Installed libraries: (none discovered)`;
  const packageRoots = [...manifestRoots];

  return { preamble, dependencies, packageRoots };
}

async function findNearestPackageRoot(startDir: string, rootAbs: string): Promise<string | null> {
  let cursor = startDir;
  // Walk upward until we hit `rootAbs` (inclusive) or fail to ascend.
  while (true) {
    try {
      await readFile(resolvePath(cursor, "package.json"), "utf8");
      return cursor;
    } catch {
      // not present here — climb
    }
    if (cursor === rootAbs) return null;
    const parent = dirname(cursor);
    if (parent === cursor) return null;
    // Stay within rootAbs.
    if (!parent.startsWith(rootAbs)) return null;
    cursor = parent;
  }
}

function resolveWithinRoot(repoRoot: string, relativePath: string): string | null {
  if (relativePath.length === 0) return null;
  const rootAbs = resolvePath(repoRoot);
  const candidate = resolvePath(rootAbs, relativePath);
  if (candidate === rootAbs) return candidate;
  if (candidate.startsWith(rootAbs + pathSep)) return candidate;
  return null;
}

// ---------------------------------------------------------------------------
// Per-file diff snippet (mirrors committability's posture).
// ---------------------------------------------------------------------------

interface SubAgentFileInput {
  path: string;
  sizeBytes: number;
  snippet: string;
  binary: boolean;
}

function isSensitivePath(p: string): boolean {
  return SENSITIVE_PATH_PATTERNS.some((re) => re.test(p));
}

async function buildFileInput(
  repoRoot: string,
  cf: ChangedFile,
): Promise<SubAgentFileInput | null> {
  const abs = resolveWithinRoot(repoRoot, cf.path);
  if (abs === null) return null;

  if (isSensitivePath(cf.path)) {
    return {
      path: cf.path,
      sizeBytes: -1,
      snippet: "[sensitive path — content withheld]",
      binary: false,
    };
  }

  const handle = await open(abs, "r");
  try {
    const stats = await handle.stat();
    const sizeBytes = stats.size;
    const readBytes = Math.min(MAX_READ_BYTES, sizeBytes);
    const buf = Buffer.alloc(readBytes);
    if (readBytes > 0) await handle.read(buf, 0, readBytes, 0);
    const sniff = buf.subarray(0, Math.min(BINARY_SNIFF_BYTES, readBytes));
    if (sniff.includes(0)) {
      return {
        path: cf.path,
        sizeBytes,
        snippet: `[binary; size=${sizeBytes}B]`,
        binary: true,
      };
    }
    const text = buf.toString("utf8");
    const truncated = readBytes < sizeBytes;
    const snippet = buildDiffScopedSnippet(text, cf.addedLines, truncated, sizeBytes);
    return {
      path: cf.path,
      sizeBytes,
      snippet,
      binary: false,
    };
  } finally {
    await handle.close();
  }
}

function buildDiffScopedSnippet(
  fullText: string,
  addedLines: number[],
  truncated: boolean,
  fileSize: number,
): string {
  if (addedLines.length === 0) {
    return "[deletion-only diff — no added lines to inspect]";
  }
  const allLines = fullText.split("\n");
  const sorted = [...addedLines].sort((a, b) => a - b);
  const windows: Array<{ start: number; end: number }> = [];
  for (const ln of sorted) {
    const start = Math.max(1, ln - CONTEXT_LINES);
    const end = ln + CONTEXT_LINES;
    const last = windows[windows.length - 1];
    if (last && start <= last.end + 1) {
      last.end = Math.max(last.end, end);
    } else {
      windows.push({ start, end });
    }
  }
  const out: string[] = [];
  let lineCount = 0;
  let reachedTruncation = false;
  for (const w of windows) {
    if (lineCount >= SNIPPET_LINE_CAP) break;
    if (out.length > 0) out.push("...");
    for (let i = w.start; i <= w.end && lineCount < SNIPPET_LINE_CAP; i++) {
      const line = allLines[i - 1];
      if (line === undefined) {
        if (truncated) reachedTruncation = true;
        break;
      }
      out.push(`${i}: ${line}`);
      lineCount++;
    }
  }
  if (reachedTruncation) {
    out.push(`... [truncated; file > ${MAX_READ_BYTES}B (size=${fileSize}B)]`);
  }
  return out.join("\n");
}

function renderUserPrompt(depsPreamble: string, files: SubAgentFileInput[]): string {
  const blocks = files.map((f) => {
    const sizeLabel = f.sizeBytes < 0 ? "" : ` (${f.sizeBytes}B${f.binary ? ", binary" : ""})`;
    return `### ${f.path}${sizeLabel}\n\`\`\`\n${f.snippet}\n\`\`\``;
  });
  return [
    `<deps>`,
    depsPreamble,
    `</deps>`,
    ``,
    `<diff>`,
    `Review the following ${files.length} file${files.length === 1 ? "" : "s"} for leverage opportunities.`,
    `Each block shows the file path and the diff-touched line ranges. Lines are prefixed with their line number followed by a colon (\`47: ...\`).`,
    `When citing a snippet in a finding, quote ONLY the file content — do not include the \`<n>: \` line-number prefix. The line number goes in the \`line\` field.`,
    ``,
    blocks.join("\n\n"),
    ``,
    `Only emit findings whose substitute library API you verified via \`lookupTypeDef\` and whose suggestion materially improves the diff. Empty findings is the right answer when nothing fires.`,
    `</diff>`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// LLM call + provider cascade.
// ---------------------------------------------------------------------------

interface SubAgentOk {
  ok: true;
  findings: SubAgentFinding[];
  fellBackToGoogle: boolean;
  fallbackReason?: string;
}

interface SubAgentErr {
  ok: false;
  error: string;
}

async function callSubAgent(opts: {
  systemPrompt: string;
  userPrompt: string;
  tools: ToolSet;
  timeoutMs: number;
}): Promise<SubAgentOk | SubAgentErr> {
  // `getWorkerCheapModel()` reads `ANTHROPIC_API_KEY` and throws when unset;
  // catch it here so a missing key surfaces as a degraded warning instead of
  // crashing the review. Same for the Google fallback.
  let primary: LanguageModel;
  try {
    primary = getWorkerCheapModel();
  } catch (err) {
    return { ok: false, error: `anthropic model unavailable (${formatErr(err)})` };
  }
  const first = await tryProvider(primary, opts);
  if (first.ok) {
    return { ok: true, findings: first.findings, fellBackToGoogle: false };
  }
  let fallback: LanguageModel | undefined;
  try {
    fallback = getWorkerCheapFallbackModel();
  } catch {
    fallback = undefined;
  }
  if (!fallback) {
    return {
      ok: false,
      error: `anthropic ${first.error}; no google fallback configured`,
    };
  }
  const second = await tryProvider(fallback, opts);
  if (second.ok) {
    return {
      ok: true,
      findings: second.findings,
      fellBackToGoogle: true,
      fallbackReason: first.error,
    };
  }
  return {
    ok: false,
    error: `anthropic ${first.error}; google ${second.error}`,
  };
}

interface ProviderOk {
  ok: true;
  findings: SubAgentFinding[];
}

interface ProviderErr {
  ok: false;
  error: string;
}

async function tryProvider(
  model: LanguageModel,
  opts: { systemPrompt: string; userPrompt: string; tools: ToolSet; timeoutMs: number },
): Promise<ProviderOk | ProviderErr> {
  try {
    const result = streamText({
      model,
      system: opts.systemPrompt,
      prompt: opts.userPrompt,
      tools: opts.tools,
      stopWhen: [stepCountIs(TOOL_USE_STEP_CAP)],
      output: Output.object({ schema: SubAgentOutputSchema }),
      timeout: { totalMs: opts.timeoutMs },
    });
    (async () => {
      try {
        for await (const _ of result.fullStream) {
          // drained — sub-agent doesn't stream reasoning to the UX
        }
      } catch {
        // surfaced via awaited result.output below
      }
    })();
    const parsed = await result.output;
    return { ok: true, findings: parsed.findings };
  } catch (err) {
    return { ok: false, error: formatErr(err) };
  }
}

// ---------------------------------------------------------------------------
// Comment shaping.
// ---------------------------------------------------------------------------

function toQuestion(f: SubAgentFinding): Comment {
  return {
    id: stableCommentId(`leverage-libraries:${f.path}:${f.line}:${f.claim}`),
    file: f.path,
    lineStart: f.line,
    lineEnd: f.line,
    tier: f.tier,
    category: "leverage",
    kind: "question",
    claim: f.claim,
    explanation: f.explanation,
    suggestedAction: f.suggestedAction,
    sources: f.sources as Source[],
    confidence: f.confidence,
  };
}

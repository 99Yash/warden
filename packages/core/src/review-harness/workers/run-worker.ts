import {
  Output,
  getWorkerCheapFallbackModel,
  getWorkerCheapModel,
  getWorkerStrongFallbackModel,
  getWorkerStrongModel,
  stepCountIs,
  streamText,
  type LanguageModel,
  type ToolSet,
} from "@warden/ai";
import { stableCommentId } from "../../comment-id.js";
import type { ChangedFile } from "../../diff/index.js";
import { makeLookupTypeDefTool } from "../../llm/tools/lookup-type-def.js";
import type {
  Category,
  Comment,
  DegradedEntry,
  Source,
} from "../../schema.js";
import { loadWorkerSystemPrompt } from "../prompts/loader.js";
import type { TokenUsage } from "../scratchpad.js";
import type {
  Concern,
  DispatchPhase,
  WorkerInvocation,
  WorkerInvocationResult,
  WorkerTier,
} from "../tools/dispatch-worker.js";
import { makeGrepRepoTool } from "../tools/grep-repo.js";
import { makeReadFileTool } from "../tools/read-file.js";
import { buildFileSnippet, type FileSnippet } from "./file-snippet.js";
import { WorkerOutputSchema, type WorkerFinding } from "./finding-schema.js";

/**
 * Shared M14 review-harness worker runtime. The 6 concerns (`correctness`,
 * `scalability`, `consistency`, `security`, `committability`, `leverage`)
 * differ only in (a) system prompt, (b) default tier, and (c) the
 * `category` slot in the emitted Comment. Everything else — tool wiring,
 * provider cascade, lane discipline, citation defaults — is identical, so
 * a single `runWorker()` covers all six.
 *
 * The boss dispatches a worker via the `dispatch_worker` tool; the dispatch
 * tool's `route` function (constructed in `workers/dispatch.ts`) invokes
 * `runWorker()` with the changed-file slice + harness-scoped tool deps.
 * Lane discipline (drop findings outside the dispatched files) lives in the
 * dispatch tool descriptor; `runWorker()` only enforces the per-finding
 * shape + citation defaults + Comment id assignment.
 *
 * Per-concern tier defaults match the M14 plan §5 table; the boss can
 * override via `tier?` on the dispatch call.
 */

const PER_WORKER_STEP_CAP = 8;
const DEFAULT_TIMEOUT_MS = 90_000;

const TIER_BY_CONCERN: Record<Concern, WorkerTier> = {
  correctness: "sonnet",
  scalability: "sonnet",
  consistency: "sonnet",
  security: "sonnet",
  committability: "haiku",
  leverage: "haiku",
};

const CATEGORY_BY_CONCERN: Record<Concern, Category> = {
  correctness: "correctness",
  scalability: "scalability",
  consistency: "consistency",
  security: "security",
  committability: "committability",
  leverage: "leverage",
};

export interface RunWorkerInput extends WorkerInvocation {
  /**
   * Changed-file entries scoped to the dispatched `files`. Pre-filtered by
   * the route function so the user-prompt assembly stays lane-disciplined
   * even before the LLM call. Files not in this list are dropped by the
   * route function before invocation.
   */
  changed: ChangedFile[];
  /**
   * Workspace package roots whose `node_modules/` may hold packages not
   * present at `repoRoot`. Forwarded to `lookupTypeDef`. Always includes
   * `repoRoot`.
   */
  packageSearchRoots: string[];
  /**
   * Mutable shared collector for the `lookupTypeDef` once-per-review "no
   * node_modules/" degraded entry. The dispatch route passes the same
   * collector for every worker so the entry is emitted at most once.
   */
  apiClaimDegraded: DegradedEntry[];
  /**
   * Preamble string surfaced in the user prompt (e.g. for `leverage`, the
   * installed-libraries list). Optional; falsy = omitted.
   */
  preamble?: string;
  /** Override worker timeout (ms). */
  timeoutMs?: number;
}

export async function runWorker(input: RunWorkerInput): Promise<WorkerInvocationResult> {
  const startedAt = Date.now();
  const degraded: DegradedEntry[] = [];

  // Pre-render diff-scoped snippets per file. Failures degrade silently —
  // workers can still readFile for the missing files.
  const snippets: FileSnippet[] = [];
  for (const cf of input.changed) {
    try {
      const snippet = await buildFileSnippet(input.repoRoot, cf);
      if (snippet) snippets.push(snippet);
    } catch (err) {
      degraded.push({
        kind: "info",
        topic: `worker-${input.concern}`,
        message: `${input.concern}: failed to snippet ${cf.path} (${formatErr(err)})`,
      });
    }
  }

  const tier: WorkerTier = input.tier ?? TIER_BY_CONCERN[input.concern];

  // No usable snippets → empty result, save the LLM call. Worker had nothing
  // to look at (sensitive paths only, binary files only, or every snippet
  // build threw).
  if (snippets.length === 0) {
    return {
      findings: [],
      toolCalls: 0,
      degraded,
      durationMs: Date.now() - startedAt,
      tier,
    };
  }

  const tools: ToolSet = {
    lookupTypeDef: makeLookupTypeDefTool({
      repoRoot: input.repoRoot,
      packageSearchRoots: input.packageSearchRoots,
      degraded: input.apiClaimDegraded,
    }),
    readFile: makeReadFileTool({ repoRoot: input.repoRoot }),
    grepRepo: makeGrepRepoTool({ repoRoot: input.repoRoot }),
  };

  const systemPrompt = loadWorkerSystemPrompt(input.concern);
  const userPrompt = renderUserPrompt({
    files: input.files,
    snippets,
    focus: input.focus,
    phase: input.phase,
    preamble: input.preamble,
  });

  const call = await callWorker({
    tier,
    systemPrompt,
    userPrompt,
    tools,
    timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });

  if (!call.ok) {
    degraded.push({
      kind: "warning",
      topic: `worker-${input.concern}`,
      message: `${input.concern}: ${call.error}`,
    });
    return {
      findings: [],
      toolCalls: 0,
      degraded,
      durationMs: Date.now() - startedAt,
      tier,
    };
  }

  if (call.fellBackToGoogle) {
    degraded.push({
      kind: "warning",
      topic: `worker-${input.concern}`,
      message: `${input.concern}: anthropic failed (${call.fallbackReason ?? "unknown"}), served from google`,
    });
  }

  const category = CATEGORY_BY_CONCERN[input.concern];
  const nowIso = new Date().toISOString();
  const findings: Comment[] = [];
  let droppedUncited = 0;
  for (const f of call.findings) {
    const sources = normalizeSources(f.sources, nowIso);
    if (sources.length === 0) {
      droppedUncited += 1;
      continue;
    }
    findings.push(toComment(f, input.concern, category, sources));
  }
  if (droppedUncited > 0) {
    degraded.push({
      kind: "info",
      topic: `worker-${input.concern}`,
      message: `${input.concern}: dropped ${droppedUncited} uncited finding${droppedUncited === 1 ? "" : "s"}`,
    });
  }

  return {
    findings,
    toolCalls: call.toolCalls,
    degraded,
    durationMs: Date.now() - startedAt,
    ...(call.tokenUsage !== undefined ? { tokenUsage: call.tokenUsage } : {}),
    tier,
  };
}

function renderUserPrompt(opts: {
  files: string[];
  snippets: FileSnippet[];
  focus?: string;
  phase: DispatchPhase;
  preamble?: string;
}): string {
  const blocks = opts.snippets.map((f) => {
    const sizeLabel = f.sizeBytes < 0 ? "" : ` (${f.sizeBytes}B${f.binary ? ", binary" : ""})`;
    return `### ${f.path}${sizeLabel}\n\`\`\`\n${f.snippet}\n\`\`\``;
  });
  const lines: string[] = [];
  if (opts.preamble) {
    lines.push(`<context>`, opts.preamble, `</context>`, ``);
  }
  lines.push(
    `<dispatch>`,
    `phase: ${opts.phase}`,
    `files: ${opts.files.join(", ")}`,
  );
  if (opts.focus) lines.push(`focus: ${opts.focus}`);
  lines.push(
    `</dispatch>`,
    ``,
    `<diff>`,
    `${opts.snippets.length} file${opts.snippets.length === 1 ? "" : "s"} dispatched. Lines are prefixed with their line number followed by a colon ("47: ..."). When citing a snippet, quote ONLY the file content — do not include the "<n>: " line-number prefix. The line number goes in the source's "line" field.`,
    ``,
    blocks.join("\n\n"),
    ``,
    `Findings whose path is outside the dispatched files set are dropped before reaching the boss. Empty findings is the right answer when nothing fires.`,
    `</diff>`,
  );
  return lines.join("\n");
}

function toComment(
  f: WorkerFinding,
  concern: Concern,
  category: Category,
  sources: Source[],
): Comment {
  const lineStart = f.lineStart;
  const lineEnd = Math.max(f.lineEnd, lineStart);
  return {
    id: stableCommentId(`${concern}:${f.path}:${lineStart}:${f.claim}`),
    file: f.path,
    lineStart,
    lineEnd,
    tier: f.tier,
    category,
    kind: f.kind,
    claim: f.claim,
    explanation: f.explanation,
    ...(f.suggestedAction !== undefined ? { suggestedAction: f.suggestedAction } : {}),
    sources,
    confidence: f.confidence,
  };
}

/**
 * Normalize a worker's emitted `sources[]`:
 *   - inject `retrievedAt: nowIso` when the LLM forgot the field on a
 *     freshly-authored `tool` source (api_def sources from `lookupTypeDef`
 *     already carry one);
 *   - drop sources with a partial `{path, line, snippet}` triple (Source
 *     schema's `.refine()` rejects them at parse time, but the LLM may
 *     have produced strict-mode-incompatible objects in rare cases — be
 *     defensive at the workspace boundary).
 *
 * Returns the filtered list. Sources count to "cited" iff they pass the
 * partial-triple check.
 */
function normalizeSources(sources: Source[], nowIso: string): Source[] {
  const out: Source[] = [];
  for (const src of sources) {
    const hasAny =
      src.path !== undefined || src.line !== undefined || src.snippet !== undefined;
    const hasAll =
      src.path !== undefined && src.line !== undefined && src.snippet !== undefined;
    if (hasAny && !hasAll) continue;
    out.push(src.retrievedAt ? src : { ...src, retrievedAt: nowIso });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Provider call + cascade.
// ---------------------------------------------------------------------------

interface WorkerCallOk {
  ok: true;
  findings: WorkerFinding[];
  toolCalls: number;
  fellBackToGoogle: boolean;
  fallbackReason?: string;
  tokenUsage?: TokenUsage;
}

interface WorkerCallErr {
  ok: false;
  error: string;
}

async function callWorker(opts: {
  tier: WorkerTier;
  systemPrompt: string;
  userPrompt: string;
  tools: ToolSet;
  timeoutMs: number;
}): Promise<WorkerCallOk | WorkerCallErr> {
  let primary: LanguageModel;
  try {
    primary = opts.tier === "sonnet" ? getWorkerStrongModel() : getWorkerCheapModel();
  } catch (err) {
    return { ok: false, error: `anthropic ${opts.tier} model unavailable (${formatErr(err)})` };
  }
  const first = await tryProvider(primary, opts);
  if (first.ok) {
    return {
      ok: true,
      findings: first.findings,
      toolCalls: first.toolCalls,
      fellBackToGoogle: false,
      tokenUsage: first.tokenUsage,
    };
  }
  let fallback: LanguageModel | undefined;
  try {
    fallback =
      opts.tier === "sonnet"
        ? getWorkerStrongFallbackModel()
        : getWorkerCheapFallbackModel();
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
      toolCalls: second.toolCalls,
      fellBackToGoogle: true,
      fallbackReason: first.error,
      tokenUsage: second.tokenUsage,
    };
  }
  return {
    ok: false,
    error: `anthropic ${first.error}; google ${second.error}`,
  };
}

interface ProviderOk {
  ok: true;
  findings: WorkerFinding[];
  toolCalls: number;
  tokenUsage?: TokenUsage;
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
      stopWhen: [stepCountIs(PER_WORKER_STEP_CAP)],
      output: Output.object({ schema: WorkerOutputSchema }),
      timeout: { totalMs: opts.timeoutMs },
    });
    let toolCalls = 0;
    (async () => {
      try {
        for await (const part of result.fullStream) {
          if (part.type === "tool-call") toolCalls += 1;
        }
      } catch {
        // surfaced via awaited result.output below
      }
    })();
    const parsed = await result.output;
    let tokenUsage: TokenUsage | undefined;
    try {
      const usage = await result.usage;
      tokenUsage = {
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
        ...(usage.cachedInputTokens !== undefined
          ? { cachedInputTokens: usage.cachedInputTokens }
          : {}),
      };
    } catch {
      tokenUsage = undefined;
    }
    return { ok: true, findings: parsed.findings, toolCalls, tokenUsage };
  } catch (err) {
    return { ok: false, error: formatErr(err) };
  }
}

function formatErr(err: unknown): string {
  if (err instanceof Error) return err.message.slice(0, 160);
  return String(err).slice(0, 160);
}

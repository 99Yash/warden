import {
  Output,
  buildReviewTelemetry,
  getWorkerCheapModelInfo,
  getWorkerCheapModel,
  getWorkerStrongModelInfo,
  getWorkerStrongModel,
  recordDroppedCandidate,
  stepCountIs,
  streamText,
  transformSchemaForGemini,
  type LanguageModel,
  type LlmProviderOptions,
  type ReviewTelemetrySettings,
  type ToolSet,
} from "@warden/ai";
import { stableCommentId } from "../../comment-id.js";
import type { ChangedFile } from "../../diff/index.js";
import { makeLookupTypeDefTool } from "../../llm/tools/lookup-type-def.js";
import type { Category, Comment, DegradedEntry, Source } from "../../schema.js";
import type { ReasonedFindingMode } from "../boss-loop.js";
import { loadWorkerSystemPrompt, type WorkerPromptVariant } from "../prompts/loader.js";
import type { TokenUsage } from "../scratchpad.js";
import {
  resolveWorkerTier,
  type Concern,
  type DispatchPhase,
  type WorkerInvocation,
  type WorkerInvocationResult,
  type WorkerTier,
} from "../tools/dispatch-worker.js";
import { makeGrepRepoTool } from "../tools/grep-repo.js";
import { makeReadFileTool } from "../tools/read-file.js";
import { buildFileSnippet, type FileSnippet } from "./file-snippet.js";
import {
  ReasonedWorkerOutputSchema,
  WorkerOutputSchema,
  type WorkerFinding,
  type WorkerOutput,
} from "./finding-schema.js";

// Adapter is vestigial post-ADR-0017 2026-05-17 amendment (Gemini fallback
// is no longer registered for tool-using worker call sites — see the cascade
// definition in `callWorker()` below). Kept wired so the reversal block from
// `git log` re-enables fallback in a single edit; the adapter is universal
// (Anthropic accepts string-form enums identically) so it costs nothing on
// the Anthropic-only happy path. The `responseTransform` coerces strings
// back to numbers pre-`WorkerFinding`.
const LEGACY_WORKER_GEMINI_PAIR = transformSchemaForGemini(WorkerOutputSchema);
const REASONED_WORKER_GEMINI_PAIR = transformSchemaForGemini(ReasonedWorkerOutputSchema);

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
  /**
   * Worker prompt variant; passed straight through to `loadWorkerSystemPrompt`.
   * The eval suite flips this between configs to test whether Sentry-Warden's
   * prompt-craft borrows close the recall gap on the M6 + alfred PR fixtures.
   * Absent → baseline prompts.
   */
  workerPromptVariant?: WorkerPromptVariant;
  /**
   * ADR-0044 eval seam. Default/absent preserves the M14 source-required
   * behavior. `allow-empty-sources` lets eval retain reasoned findings with
   * empty `sources[]` before the public `evidence` field exists.
   */
  reasonedFindingMode?: ReasonedFindingMode;
  /**
   * ADR-0048 §2 review-run id. When set (and Langfuse keys present), this
   * worker's `streamText` call emits OTEL spans tagged with the run-id so the
   * boss + all workers group into a single Langfuse trace. Absent → telemetry
   * off (no-op).
   */
  runId?: string;
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

  const tier: WorkerTier = resolveWorkerTier(input.concern, input.tier);

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

  const baseSystemPrompt = loadWorkerSystemPrompt(input.concern, input.workerPromptVariant);
  const systemPrompt = applyReasonedFindingPromptOverride(
    baseSystemPrompt,
    input.reasonedFindingMode,
  );
  const userPrompt = renderUserPrompt({
    files: input.files,
    snippets,
    focus: input.focus,
    phase: input.phase,
    preamble: input.preamble,
  });

  let primary: LanguageModel;
  let primaryLabel: string;
  let primaryProviderOptions: LlmProviderOptions | undefined;
  try {
    const primaryInfo = tier === "sonnet" ? getWorkerStrongModelInfo() : getWorkerCheapModelInfo();
    primaryLabel = primaryInfo.label;
    primaryProviderOptions = primaryInfo.providerOptions;
    primary = tier === "sonnet" ? getWorkerStrongModel() : getWorkerCheapModel();
  } catch (err) {
    degraded.push({
      kind: "warning",
      topic: `worker-${input.concern}`,
      message: `${input.concern}: ${tier} model unavailable (${formatErr(err)})`,
    });
    return {
      findings: [],
      toolCalls: 0,
      degraded,
      durationMs: Date.now() - startedAt,
      tier,
    };
  }

  // ADR-0048 §3 — per-worker telemetry. Tagged by concern/tier/file so the
  // Langfuse trace shows which worker investigated what. No-op unless a run-id
  // is threaded AND Langfuse keys are present.
  const telemetry =
    input.runId !== undefined
      ? buildReviewTelemetry({
          runId: input.runId,
          role: "worker",
          concern: input.concern,
          tier,
          ...(input.files.length === 1 ? { file: input.files[0] } : {}),
        })
      : undefined;

  const call = await callWorker({
    tier,
    modelLabel: primaryLabel,
    primary,
    ...(primaryProviderOptions !== undefined ? { providerOptions: primaryProviderOptions } : {}),
    systemPrompt,
    userPrompt,
    tools,
    timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    ...(input.reasonedFindingMode !== undefined
      ? { reasonedFindingMode: input.reasonedFindingMode }
      : {}),
    ...(telemetry !== undefined ? { telemetry } : {}),
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

  const category = CATEGORY_BY_CONCERN[input.concern];
  const nowIso = new Date().toISOString();
  const findings: Comment[] = [];
  let droppedUncited = 0;
  const allowEmptySources = input.reasonedFindingMode === "allow-empty-sources";
  for (const f of call.findings) {
    const sources = normalizeSources(f.sources, nowIso);
    if (sources.length === 0 && !allowEmptySources) {
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
    // ADR-0048 §4 — uncited-drop span, grouped under the run-id trace. Runs
    // after the worker stream has closed (no active span), and is a no-op
    // without a run-id since telemetry is off in that case anyway.
    if (input.runId !== undefined) {
      recordDroppedCandidate("uncited", {
        runId: input.runId,
        attrs: { "warden.concern": input.concern, "warden.count": droppedUncited },
      });
    }
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
  lines.push(`<dispatch>`, `phase: ${opts.phase}`, `files: ${opts.files.join(", ")}`);
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

/**
 * ADR-0044 eval seam (measurement only). When `allow-empty-sources` is set,
 * appends an override letting workers emit reasoned, empty-`sources[]` findings.
 * Two limits are deliberate and deferred with the public `Comment.evidence`
 * migration: (1) reasoned findings carry no substring-verified evidence
 * locator, so they receive no anti-fabrication check; (2) the degrade-to-
 * question below is a prompt instruction, not the deterministic post-pass
 * ADR-0044 §6 prescribes. Recall measured under this mode is therefore an
 * upper bound — see the `reasoned-assertions` config comment.
 */
function applyReasonedFindingPromptOverride(
  basePrompt: string,
  mode: ReasonedFindingMode | undefined,
): string {
  if (mode !== "allow-empty-sources") return basePrompt;
  return [
    basePrompt,
    ``,
    `## ADR-0044 eval override`,
    ``,
    `This eval run is measuring reasoned findings. This section overrides any older cite-or-drop instruction above.`,
    ``,
    `- For claims whose truth is a judgment about the diff's own code, do not invent a \`tool\` source. Use \`sources: []\`; the finding is still valid when \`path\`, \`lineStart\`, and \`lineEnd\` locate the code being judged.`,
    `- For claims whose truth rests on an external authority, still cite that authority: use \`lookupTypeDef\` for library API behavior and copy its \`api_def\` source verbatim.`,
    `- Low confidence should change \`kind\` to \`question\`, not make you drop the finding. Empty \`sources[]\` alone is never a reason to stay silent in this eval mode.`,
  ].join("\n");
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
    const hasAny = src.path !== undefined || src.line !== undefined || src.snippet !== undefined;
    const hasAll = src.path !== undefined && src.line !== undefined && src.snippet !== undefined;
    if (hasAny && !hasAll) continue;
    out.push(src.retrievedAt ? src : { ...src, retrievedAt: nowIso });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Provider call.
//
// Per ADR-0017 2026-05-17 amendment ("tools + structured-output exception"),
// tool-using worker call sites do NOT register a Gemini fallback. The cascade
// here is **Anthropic primary only** — the 1× transient retry already lives
// inside `ai-retry`'s default behavior when the model is constructed (not
// wired here in v0) and intra-`streamText` provider retries are out of scope
// for the worker path. On Anthropic failure, the caller surfaces a `warning`
// degraded entry whose message includes the literal "Gemini fallback skipped
// (tools required)" sentinel — see `runWorker()` above.
//
// Pre-amendment, this function resolved `getWorkerStrongFallbackModel()` /
// `getWorkerCheapFallbackModel()` and made a second `tryProvider()` call on
// Anthropic failure. That block was removed wholesale; the fallback getters
// remain exported from `@warden/ai` so reversal is the inverse delta from
// `git log`.
// ---------------------------------------------------------------------------

interface WorkerCallOk {
  ok: true;
  findings: WorkerFinding[];
  toolCalls: number;
  tokenUsage?: TokenUsage;
}

interface WorkerCallErr {
  ok: false;
  error: string;
}

/**
 * Worker LLM-call policy boundary. Exported so the M14 / ADR-0017 amendment
 * smoke (`smoke-bugfloor-gemini-skip-with-tools.mts`) can drive a stub
 * primary model directly and assert on the resulting failure shape without
 * standing up the full `runWorker()` snippet-rendering path. Production
 * callers all flow through `runWorker()`, which resolves `primary` from
 * `@warden/ai`'s tier getters.
 *
 * @internal
 */
export async function callWorker(opts: {
  tier: WorkerTier;
  primary: LanguageModel;
  modelLabel?: string;
  providerOptions?: LlmProviderOptions;
  systemPrompt: string;
  userPrompt: string;
  tools: ToolSet;
  timeoutMs: number;
  reasonedFindingMode?: ReasonedFindingMode;
  /** ADR-0048 §3 telemetry settings; absent → no spans for this call. */
  telemetry?: ReviewTelemetrySettings;
}): Promise<WorkerCallOk | WorkerCallErr> {
  const first = await tryProvider(opts.primary, opts);
  if (first.ok) {
    return {
      ok: true,
      findings: first.findings,
      toolCalls: first.toolCalls,
      tokenUsage: first.tokenUsage,
    };
  }
  const modelLabel = opts.modelLabel ?? `anthropic ${opts.tier}`;
  return {
    ok: false,
    error: `${modelLabel} failed (${first.error}); Gemini fallback skipped (tools required)`,
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
  opts: {
    systemPrompt: string;
    userPrompt: string;
    tools: ToolSet;
    providerOptions?: LlmProviderOptions;
    timeoutMs: number;
    reasonedFindingMode?: ReasonedFindingMode;
    telemetry?: ReviewTelemetrySettings;
  },
): Promise<ProviderOk | ProviderErr> {
  try {
    const schemaPair =
      opts.reasonedFindingMode === "allow-empty-sources"
        ? REASONED_WORKER_GEMINI_PAIR
        : LEGACY_WORKER_GEMINI_PAIR;
    const result = streamText({
      model,
      system: opts.systemPrompt,
      prompt: opts.userPrompt,
      tools: opts.tools,
      stopWhen: [stepCountIs(PER_WORKER_STEP_CAP)],
      output: Output.object({ schema: schemaPair.requestSchema }),
      ...(opts.providerOptions !== undefined ? { providerOptions: opts.providerOptions } : {}),
      ...(opts.telemetry !== undefined ? { experimental_telemetry: opts.telemetry } : {}),
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
    const rawOutput = await result.output;
    // Coerce string-form numeric literals back to numbers. No-op when the
    // schema contained no numeric-literal-union (pair is identity).
    const parsed = schemaPair.responseTransform(rawOutput) as WorkerOutput;
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

import { stableCommentId } from "../comment-id.js";
import type { Comment, RetrievedContext } from "../schema.js";
import { callWithCascade } from "./cascade.js";
import { computeCacheKey, getLlmCached, hashString, putLlmCached } from "./cache.js";
import type { FormatterListener } from "./events.js";
import { loadSystemPrompt, loadUserPrompt } from "./prompt-loader.js";
import type { LlmOutput, Question, RevisedComment } from "./schema.js";

/**
 * The M4 LLM formatter (ADR-0008 + Q1 A+C decision).
 *
 * Pipeline:
 *  1. Build user prompt from inputs.
 *  2. Cache lookup (content-addressed; ADR-0007 / Q10).
 *  3. Cascade call (ADR-0017): Anthropic → retry → Google fallback.
 *  4. Apply revisions to input comments (default-keep on unmentioned ids).
 *  5. Append questions as `kind: "question"` comments.
 *
 * The LLM is constrained to triage + ask questions only — never to invent
 * assertions. `sources[]` is preserved verbatim from input comments so the
 * citation thesis (ADR-0008) survives the LLM stage by construction.
 */

export interface FormatInput {
  diff: string;
  /** Tool findings already mapped through `toComment()` — diff-scoped per Q9 / L1. */
  toolComments: Comment[];
  /** Vulnerability comments (un-scoped; CVEs surface even when lockfile isn't in diff). */
  vulnComments: Comment[];
  /** M4 always passes `{ chunks: [] }`; M5 selector populates. */
  retrievedContext: RetrievedContext;
  /** Override the Anthropic extended-thinking budget. Default 4096. */
  thinkingBudget?: number;
  /** Hard timeout per provider attempt (ms). Default 60_000. */
  timeoutMs?: number;
  emit?: FormatterListener;
}

export interface FormatResult {
  /** Comments to render — assertions (revised tool findings) + questions. */
  comments: Comment[];
  /** degradedWorkers entries from the cascade. */
  degraded: string[];
  /** Whether the result came from cache. */
  cacheHit: boolean;
}

const DEFAULT_THINKING_BUDGET = 4096;
const DEFAULT_TIMEOUT_MS = 60_000;

export async function formatReview(input: FormatInput): Promise<FormatResult> {
  const systemPrompt = loadSystemPrompt();
  const allInputComments = [...input.toolComments, ...input.vulnComments];

  const userPrompt = loadUserPrompt({
    diff: input.diff || "(no diff supplied)",
    toolFindings: renderComments(input.toolComments),
    verifiedAdvisories: renderComments(input.vulnComments),
    retrievedContext: renderRetrievedContext(input.retrievedContext),
  });

  const cacheKey = computeCacheKey({
    modelId: "anthropic-primary",
    systemPromptHash: hashString(systemPrompt),
    userTemplateHash: hashString(userPrompt),
    inputCommentIds: allInputComments.map((c) => c.id),
    diffHash: hashString(input.diff),
  });

  const cached = getLlmCached(cacheKey);
  if (cached) {
    return {
      comments: applyLlmOutput(allInputComments, cached.payload),
      degraded: [`llm: cache hit (${cached.provider}/${cached.modelId})`],
      cacheHit: true,
    };
  }

  const cascade = await callWithCascade({
    systemPrompt,
    userPrompt,
    thinkingBudget: input.thinkingBudget ?? readThinkingBudgetFromEnv() ?? DEFAULT_THINKING_BUDGET,
    timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    emit: input.emit,
  });

  putLlmCached({
    cacheKey,
    provider: cascade.provider,
    modelId: cascade.modelId,
    payload: cascade.output,
    durationMs: cascade.durationMs,
  });

  const merged = applyLlmOutput(allInputComments, cascade.output);

  input.emit?.({
    type: "phase-complete",
    phase: "llm",
    revisedCount: cascade.output.revisedComments.length,
    questionCount: cascade.output.questions.length,
    durationMs: cascade.durationMs,
  });

  return { comments: merged, degraded: cascade.degraded, cacheHit: false };
}

/**
 * Apply the LLM's revisions and questions to the input list. Default-keep
 * (Q9 / M1): unmentioned ids pass through verbatim. Hard rules from Q4:
 *  - sources verbatim from input
 *  - confidence preserved or lowered, never raised
 *  - only claim/explanation/suggestedAction rewritable
 */
function applyLlmOutput(inputs: Comment[], output: LlmOutput): Comment[] {
  const revisionById = new Map<string, RevisedComment>();
  for (const r of output.revisedComments) revisionById.set(r.id, r);

  const result: Comment[] = [];
  for (const c of inputs) {
    const r = revisionById.get(c.id);
    if (r?.drop === true) continue;
    if (!r) {
      result.push(c);
      continue;
    }
    result.push({
      ...c,
      claim: r.claim ?? c.claim,
      explanation: r.explanation ?? c.explanation,
      suggestedAction: r.suggestedAction ?? c.suggestedAction,
      confidence: clampConfidence(c.confidence, r.confidence),
    });
  }

  for (const q of output.questions) {
    result.push(questionToComment(q));
  }

  return result;
}

function clampConfidence(input: number, llm: number | undefined): number {
  if (llm === undefined) return input;
  return Math.min(input, llm);
}

function questionToComment(q: Question): Comment {
  return {
    id: stableCommentId(`question:${q.file}:${q.lineStart}:${q.lineEnd}:${q.category}:${q.claim}`),
    file: q.file,
    lineStart: q.lineStart,
    lineEnd: q.lineEnd,
    tier: 2,
    category: q.category,
    kind: "question",
    claim: q.claim,
    explanation: q.explanation,
    sources: [],
    confidence: q.confidence,
  };
}

function renderComments(comments: Comment[]): string {
  if (comments.length === 0) return "(none)";
  return comments
    .map((c) => {
      const range = c.lineStart === c.lineEnd ? `${c.lineStart}` : `${c.lineStart}-${c.lineEnd}`;
      return [
        `- id: ${c.id}`,
        `  file: ${c.file}:${range}`,
        `  category: ${c.category} (tier ${c.tier})`,
        `  claim: ${c.claim}`,
        `  explanation: ${c.explanation}`,
        `  sources: ${c.sources.map((s) => s.id ?? s.url ?? s.type).join(", ") || "(none)"}`,
      ].join("\n");
    })
    .join("\n\n");
}

function renderRetrievedContext(ctx: RetrievedContext): string {
  const sections: string[] = [];

  if (ctx.chunks.length > 0) {
    sections.push("## Adjacent files (with evidence)");
    sections.push(
      ctx.chunks
        .map(
          (c) =>
            `### ${c.path}:${c.lineStart}-${c.lineEnd}\nReason: ${c.reason}\n\`\`\`\n${c.snippet}\n\`\`\``,
        )
        .join("\n\n"),
    );
  }

  if (ctx.sameFolderPaths.length > 0) {
    sections.push("## Same-folder neighbors (paths only — awareness signal, no content)");
    sections.push(ctx.sameFolderPaths.map((p) => `- ${p}`).join("\n"));
  }

  if (sections.length === 0) {
    return "(empty — no adjacent context surfaced for this diff)";
  }
  return sections.join("\n\n");
}

function readThinkingBudgetFromEnv(): number | undefined {
  const raw = process.env["WARDEN_THINKING_BUDGET"];
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

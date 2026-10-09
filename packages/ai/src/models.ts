// We deliberately narrow from `ai`'s `LanguageModel` (which is
// `LanguageModelV3 | GatewayLanguageModelId` to allow string gateway ids) to
// ai-retry's `LanguageModel` alias (`LanguageModelV3`). The provider factory
// always returns a model instance at runtime; the narrower type is what both
// `streamText` (a supertype consumer) and `createRetryable` (which generics
// strictly over `LanguageModelV3`) want.
import type { LanguageModel } from "ai-retry";
import {
  configuredLlmExplicitPrimaryProvider,
  isProviderConfigured,
  requireAnyProviderApiKey,
} from "@warden/env";
import { modelCatalogPrice } from "./model-catalog.js";
import { anthropicProvider, googleProvider, openaiProvider } from "./provider.js";

export type LlmProviderId = "anthropic" | "openai" | "google";
export type ReviewCostTier = "opus" | "sonnet" | "haiku";
export type LlmJsonValue = null | string | number | boolean | LlmJsonObject | LlmJsonValue[];
export interface LlmJsonObject {
  [key: string]: LlmJsonValue | undefined;
}
export type LlmProviderOptions = Record<string, LlmJsonObject>;

export interface LlmModelPrice {
  /** USD per 1M uncached input tokens. */
  input: number;
  /** USD per 1M output tokens. */
  output: number;
  /** USD per 1M cached input tokens, when the provider reports them. */
  cachedInput: number;
}

export interface ResolvedLlmModel {
  provider: LlmProviderId;
  modelId: string;
  label: string;
  fallbackPricePerMillionTokens: LlmModelPrice;
  providerOptions?: LlmProviderOptions;
}

// Model choice is a cost decision: re-check models.dev prices when a new
// model ships. 2026-10-09: Opus 5.5 ($4/$20) and Sonnet 5.5 ($2/$10) are
// cheaper than Opus 4.8 ($5/$25) and Sonnet 4.6 ($3/$15). `high` effort
// matches the OpenCode lane's `anthropic/claude-opus-5-5#high`.
const ANTHROPIC_OPUS_5_5 = {
  provider: "anthropic",
  modelId: "claude-opus-5-5",
  label: "claude-opus-5-5 high",
  fallbackPricePerMillionTokens: { input: 4, output: 20, cachedInput: 0.2 },
  providerOptions: { anthropic: { effort: "high" } },
} satisfies ResolvedLlmModel;

const ANTHROPIC_SONNET_5_5 = {
  provider: "anthropic",
  modelId: "claude-sonnet-5-5",
  label: "claude-sonnet-5-5 high",
  fallbackPricePerMillionTokens: { input: 2, output: 10, cachedInput: 0.1 },
  providerOptions: { anthropic: { effort: "high" } },
} satisfies ResolvedLlmModel;

// Haiku 5.5 ($0.1/$0.5) is cheaper, but Cloudflare AI Gateway Unified
// Billing does not serve it yet (2026-10-09: the gateway forwards the call
// with no key). Keep Haiku 4.5 until it does.
const ANTHROPIC_HAIKU_4_5 = {
  provider: "anthropic",
  modelId: "claude-haiku-4-5-20251001",
  label: "claude-haiku-4-5",
  fallbackPricePerMillionTokens: { input: 1, output: 5, cachedInput: 0.1 },
} satisfies ResolvedLlmModel;

// `strictJsonSchema: false` is load-bearing on the OpenAI path. OpenAI's
// strict structured-output validator requires *every* property to appear in
// the schema's `required` array; our shared `SourceSchema` (and the worker
// finding schema that reuses it) carries optional fields (`url`, `id`,
// `title`, `{path,line,snippet}`), so strict mode 400s with
// `'required' is required to be supplied ... Missing 'url'`. That rejection
// makes every worker `Output.object` call fail, the boss emits an empty
// review, and the CLI false-cleans (see issue #29). Disabling strict keeps
// the request schema as guidance while our own zod parse (`Output.object` /
// the worker output schema) still validates the response — so correctness is
// preserved and a non-conforming response surfaces as a loud worker error,
// not a silent 400. This is the second variant of the landmine in
// `project_warden_boss_structured_output`; the `z.url()` → `format:"uri"`
// fix lives in `SourceSchema` itself. Anthropic ignores `openai` provider
// options, so this is a no-op on that path.
//
// 2026-10-09 prices: GPT-6.1 Sol ($2/$10) replaces GPT-5.5 ($5/$30), and
// GPT-6 Luna ($0.1/$0.5) replaces GPT-5.4 mini ($0.75/$4.5).
const OPENAI_GPT_6_1_SOL = {
  provider: "openai",
  modelId: "gpt-6.1-sol",
  label: "gpt-6.1-sol high",
  fallbackPricePerMillionTokens: { input: 2, output: 10, cachedInput: 0.1 },
  providerOptions: { openai: { reasoningEffort: "high", strictJsonSchema: false } },
} satisfies ResolvedLlmModel;

const OPENAI_GPT_6_LUNA = {
  provider: "openai",
  modelId: "gpt-6-luna",
  label: "gpt-6-luna high",
  fallbackPricePerMillionTokens: { input: 0.1, output: 0.5, cachedInput: 0.01 },
  providerOptions: { openai: { reasoningEffort: "high", strictJsonSchema: false } },
} satisfies ResolvedLlmModel;

/**
 * Boss model. Used by the M14 review harness as the single planning brain
 * across the `dispatch_worker` tool-use loop. Default role policy:
 * Anthropic key present -> Claude Opus 5.5 boss; otherwise OpenAI key
 * present -> GPT-6.1 Sol boss. An explicit `routing.llm.primary` overrides this
 * (the pinned provider wins for every role when its key is configured).
 */
export function getBossModel(): LanguageModel {
  return modelFromInfo(getBossModelInfo());
}

/**
 * Apex-tier model for opt-in deep security analysis (M18 / ADR-0029).
 * Deliberately separate from the default-review boss tier so `warden review`
 * does not silently inherit the deep tier's higher cost.
 */
export function getApexModel(): LanguageModel {
  return modelFromInfo(getApexModelInfo());
}

/**
 * Strong-tier worker model. By default OpenAI is preferred when configured
 * because GPT-6 Luna is the intended cost/performance worker default, with
 * Anthropic Sonnet as the no-OpenAI fallback. An explicit `routing.llm.primary`
 * overrides this and pins workers to the chosen provider.
 */
export function getWorkerStrongModel(): LanguageModel {
  return modelFromInfo(getWorkerStrongModelInfo());
}

/**
 * Cheap-tier worker model for pattern-matching tasks. For now the OpenAI
 * default deliberately collapses strong/cheap workers onto GPT-6 Luna;
 * a future CLI model policy can split this further once there are evals.
 */
export function getWorkerCheapModel(): LanguageModel {
  return modelFromInfo(getWorkerCheapModelInfo());
}

type ReviewRole = "boss" | "apex" | "workerStrong" | "workerCheap";
type ReviewLlmProvider = Extract<LlmProviderId, "anthropic" | "openai">;

/** Per-provider model for each review role. */
const PROVIDER_ROLE_MODELS: Record<ReviewLlmProvider, Record<ReviewRole, ResolvedLlmModel>> = {
  anthropic: {
    boss: ANTHROPIC_OPUS_5_5,
    apex: ANTHROPIC_OPUS_5_5,
    workerStrong: ANTHROPIC_SONNET_5_5,
    workerCheap: ANTHROPIC_HAIKU_4_5,
  },
  openai: {
    boss: OPENAI_GPT_6_1_SOL,
    apex: OPENAI_GPT_6_1_SOL,
    // OpenAI deliberately collapses strong/cheap workers onto GPT-6 Luna for
    // now; a future model policy can split this once there are evals.
    workerStrong: OPENAI_GPT_6_LUNA,
    workerCheap: OPENAI_GPT_6_LUNA,
  },
};

/**
 * Default provider preference per role when the user has not pinned
 * `routing.llm.primary`. Boss/apex favor Anthropic Opus for planning; workers
 * favor OpenAI GPT-6 Luna for cost/performance. An explicit primary overrides
 * this for every role (see {@link roleProviderOrder}).
 */
const ROLE_DEFAULT_PROVIDER_ORDER: Record<ReviewRole, readonly ReviewLlmProvider[]> = {
  boss: ["anthropic", "openai"],
  apex: ["anthropic", "openai"],
  workerStrong: ["openai", "anthropic"],
  workerCheap: ["openai", "anthropic"],
};

function isReviewLlmProvider(id: string | undefined): id is ReviewLlmProvider {
  return id === "anthropic" || id === "openai";
}

/**
 * Provider preference for a role. An explicitly configured `routing.llm.primary`
 * wins for every role (when it is a review LLM provider); the role default order
 * is the tiebreaker / fallback. Honors ADR routing config that model selection
 * previously ignored.
 */
function roleProviderOrder(role: ReviewRole): readonly ReviewLlmProvider[] {
  const order = ROLE_DEFAULT_PROVIDER_ORDER[role];
  const primary = configuredLlmExplicitPrimaryProvider();
  if (isReviewLlmProvider(primary)) {
    return [primary, ...order.filter((p) => p !== primary)];
  }
  return order;
}

function resolveRoleModel(role: ReviewRole): ResolvedLlmModel {
  for (const provider of roleProviderOrder(role)) {
    if (isProviderConfigured(provider)) return PROVIDER_ROLE_MODELS[provider][role];
  }
  return throwMissingReviewLlmProvider();
}

export function getBossModelInfo(): ResolvedLlmModel {
  return resolveRoleModel("boss");
}

export function getApexModelInfo(): ResolvedLlmModel {
  return resolveRoleModel("apex");
}

export function getWorkerStrongModelInfo(): ResolvedLlmModel {
  return resolveRoleModel("workerStrong");
}

export function getWorkerCheapModelInfo(): ResolvedLlmModel {
  return resolveRoleModel("workerCheap");
}

export async function getReviewModelPricingByTier(): Promise<
  Record<ReviewCostTier, LlmModelPrice>
> {
  const [opus, sonnet, haiku] = await Promise.all([
    modelCatalogPrice(getBossModelInfo()),
    modelCatalogPrice(getWorkerStrongModelInfo()),
    modelCatalogPrice(getWorkerCheapModelInfo()),
  ]);
  return {
    opus,
    sonnet,
    haiku,
  };
}

export function getReviewModelLabelsByTier(): Record<ReviewCostTier, string> {
  return {
    opus: getBossModelInfo().label,
    sonnet: getWorkerStrongModelInfo().label,
    haiku: getWorkerCheapModelInfo().label,
  };
}

/**
 * ADR-0017 fallback dispatchers. Returns the Google-tier counterpart of
 * the corresponding Anthropic getter, or `undefined` when no Google key is
 * configured — caller-side cascade then proceeds to hard fail.
 *
 * Tier mapping is the stable contract; specific Gemini SKUs are
 * point-in-time and revisited on each Google generation ship.
 */
export function getBossFallbackModel(): LanguageModel | undefined {
  const g = googleProvider();
  return g?.("gemini-2.5-pro");
}

export function getApexFallbackModel(): LanguageModel | undefined {
  const g = googleProvider();
  return g?.("gemini-2.5-pro");
}

export function getWorkerStrongFallbackModel(): LanguageModel | undefined {
  const g = googleProvider();
  return g?.("gemini-2.5-pro");
}

export function getWorkerCheapFallbackModel(): LanguageModel | undefined {
  const g = googleProvider();
  return g?.("gemini-2.5-flash");
}

function modelFromInfo(info: ResolvedLlmModel): LanguageModel {
  switch (info.provider) {
    case "anthropic":
      return anthropicProvider()(info.modelId);
    case "openai":
      return openaiProvider()(info.modelId);
    case "google": {
      const g = googleProvider();
      if (!g) {
        throw new Error(`Provider "google" is not configured for ${info.modelId}.`);
      }
      return g(info.modelId);
    }
  }
}

function throwMissingReviewLlmProvider(): never {
  requireAnyProviderApiKey(["anthropic", "openai"], "warden review");
  throw new Error("No supported review LLM provider is configured.");
}

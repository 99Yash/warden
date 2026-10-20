import { z } from "zod";
import type { LlmContextTier, LlmModelPrice, ResolvedLlmModel } from "./models.js";

const MODELS_DEV_API_URL = "https://models.dev/api.json";
const FETCH_TIMEOUT_MS = 2_000;
const CACHE_TTL_MS = 6 * 60 * 60_000;

const ModelsDevModelSchema = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    cost: z
      .object({
        input: z.number().optional(),
        output: z.number().optional(),
        cache_read: z.number().optional(),
        cache_write: z.number().optional(),
        // Long-context tiers. Kept `unknown` here and parsed one by one in
        // `contextTiers()`, so one odd tier entry cannot fail the parse of
        // the whole catalog (that would drop every model to its fallback).
        tiers: z.unknown().optional(),
      })
      .optional(),
    limit: z
      .object({
        context: z.number().optional(),
        input: z.number().optional(),
        output: z.number().optional(),
      })
      .optional(),
    reasoning: z.boolean().optional(),
    reasoning_options: z.array(z.unknown()).optional(),
    tool_call: z.boolean().optional(),
    structured_output: z.boolean().optional(),
  })
  .loose();

const ModelsDevCatalogSchema = z.record(
  z.string(),
  z
    .object({
      models: z.record(z.string(), ModelsDevModelSchema).optional(),
    })
    .loose(),
);

/**
 * One models.dev price tier, for example (2026-10-20, `openai/gpt-6.1-sol`):
 * `{ input: 4, output: 15, cache_read: 0.2, cache_write: 5,
 *    tier: { type: "context", size: 272000 } }`.
 * A `context` tier applies to a request whose prompt is more than `size`
 * input tokens (OpenAI: "Prompts with more than 272K input tokens are priced
 * at 2x input and cache rates and 1.5x output for the full request").
 */
const ModelsDevTierSchema = z
  .object({
    input: z.number(),
    output: z.number(),
    cache_read: z.number().optional(),
    cache_write: z.number().optional(),
    tier: z.object({ type: z.string(), size: z.number().nonnegative() }).loose(),
  })
  .loose();

type ModelsDevModel = z.infer<typeof ModelsDevModelSchema>;
type ModelsDevCatalog = z.infer<typeof ModelsDevCatalogSchema>;

export interface ModelCatalogMetadata {
  name?: string;
  pricePerMillionTokens?: LlmModelPrice;
  contextWindow?: number;
}

let cachedCatalog: { fetchedAt: number; value: ModelsDevCatalog } | undefined;
let pendingCatalog: Promise<ModelsDevCatalog | undefined> | undefined;

export async function modelCatalogMetadata(model: ResolvedLlmModel): Promise<ModelCatalogMetadata> {
  const catalog = await fetchModelsDevCatalog();
  const entry = catalog?.[model.provider]?.models?.[model.modelId];
  if (!entry) return {};
  const pricePerMillionTokens = modelPrice(entry);
  return {
    ...(entry.name !== undefined ? { name: entry.name } : {}),
    ...(pricePerMillionTokens !== undefined ? { pricePerMillionTokens } : {}),
    ...(entry.limit?.context !== undefined ? { contextWindow: entry.limit.context } : {}),
  };
}

export async function modelCatalogPrice(model: ResolvedLlmModel): Promise<LlmModelPrice> {
  const metadata = await modelCatalogMetadata(model);
  return metadata.pricePerMillionTokens ?? model.fallbackPricePerMillionTokens;
}

function modelPrice(model: ModelsDevModel): LlmModelPrice | undefined {
  const cost = model.cost;
  if (cost?.input === undefined || cost.output === undefined) return undefined;
  const tiers = contextTiers(cost.tiers);
  return {
    input: cost.input,
    output: cost.output,
    cachedInput: cost.cache_read ?? cost.input,
    cacheWriteInput: cost.cache_write ?? cost.input,
    ...(tiers.length > 0 ? { contextTiers: tiers } : {}),
  };
}

/**
 * Parse the models.dev `cost.tiers` array. Only `context` tiers are priced;
 * an entry that does not parse is skipped. Inside a tier, a missing cache
 * price falls back to the tier's input price, the same rule as the base.
 */
function contextTiers(raw: unknown): LlmContextTier[] {
  if (!Array.isArray(raw)) return [];
  const out: LlmContextTier[] = [];
  for (const entry of raw) {
    const parsed = ModelsDevTierSchema.safeParse(entry);
    if (!parsed.success || parsed.data.tier.type !== "context") continue;
    const t = parsed.data;
    out.push({
      aboveInputTokens: t.tier.size,
      rates: {
        input: t.input,
        output: t.output,
        cachedInput: t.cache_read ?? t.input,
        cacheWriteInput: t.cache_write ?? t.input,
      },
    });
  }
  return out;
}

async function fetchModelsDevCatalog(): Promise<ModelsDevCatalog | undefined> {
  const now = Date.now();
  if (cachedCatalog && now - cachedCatalog.fetchedAt < CACHE_TTL_MS) {
    return cachedCatalog.value;
  }
  if (!pendingCatalog) {
    pendingCatalog = fetchModelsDevCatalogUncached()
      .then((value) => {
        if (value) cachedCatalog = { fetchedAt: Date.now(), value };
        return value;
      })
      .finally(() => {
        pendingCatalog = undefined;
      });
  }
  return pendingCatalog;
}

async function fetchModelsDevCatalogUncached(): Promise<ModelsDevCatalog | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(MODELS_DEV_API_URL, { signal: controller.signal });
    if (!res.ok) return undefined;
    return ModelsDevCatalogSchema.parse(await res.json());
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** Test-only: drop the in-process models.dev cache. */
export function _resetModelCatalogCacheForTests(): void {
  cachedCatalog = undefined;
  pendingCatalog = undefined;
}

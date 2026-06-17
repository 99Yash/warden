import { z } from "zod";
import type { LlmModelPrice, ResolvedLlmModel } from "./models.js";

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
  .passthrough();

const ModelsDevCatalogSchema = z.record(
  z.string(),
  z
    .object({
      models: z.record(z.string(), ModelsDevModelSchema).optional(),
    })
    .passthrough(),
);

type ModelsDevModel = z.infer<typeof ModelsDevModelSchema>;
type ModelsDevCatalog = z.infer<typeof ModelsDevCatalogSchema>;

export interface ModelCatalogMetadata {
  name?: string;
  pricePerMillionTokens?: LlmModelPrice;
  contextWindow?: number;
}

let cachedCatalog: { fetchedAt: number; value: ModelsDevCatalog } | undefined;
let pendingCatalog: Promise<ModelsDevCatalog | undefined> | undefined;

export async function modelCatalogMetadata(
  model: ResolvedLlmModel,
): Promise<ModelCatalogMetadata> {
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
  return {
    input: cost.input,
    output: cost.output,
    cachedInput: cost.cache_read ?? cost.input,
  };
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

import {
  _resetModelCatalogCacheForTests,
  modelCatalogPrice,
} from "@warden/ai/model-catalog";
import type { ResolvedLlmModel } from "@warden/ai";

const originalFetch = globalThis.fetch;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
  process.stdout.write(`  ✓ ${message}\n`);
}

const MODEL = {
  provider: "openai",
  modelId: "gpt-5.4-mini",
  label: "gpt-5.4-mini xhigh",
  fallbackPricePerMillionTokens: { input: 99, output: 199, cachedInput: 9 },
  providerOptions: { openai: { reasoningEffort: "xhigh" } },
} satisfies ResolvedLlmModel;

try {
  process.stdout.write("\n[1] models.dev price lookup\n");
  _resetModelCatalogCacheForTests();
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        openai: {
          models: {
            "gpt-5.4-mini": {
              id: "gpt-5.4-mini",
              name: "GPT-5.4 mini",
              cost: { input: 0.75, output: 4.5, cache_read: 0.075 },
            },
          },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  const price = await modelCatalogPrice(MODEL);
  assert(price.input === 0.75, "uses models.dev input price");
  assert(price.output === 4.5, "uses models.dev output price");
  assert(price.cachedInput === 0.075, "uses models.dev cache_read price");

  process.stdout.write("\n[2] unavailable catalog falls back\n");
  _resetModelCatalogCacheForTests();
  globalThis.fetch = async () => new Response("nope", { status: 503 });
  const fallback = await modelCatalogPrice(MODEL);
  assert(fallback.input === 99, "falls back to local input price");
  assert(fallback.output === 199, "falls back to local output price");
  assert(fallback.cachedInput === 9, "falls back to local cached-input price");

  process.stdout.write("\n✓ smoke-model-catalog passed\n");
} finally {
  globalThis.fetch = originalFetch;
  _resetModelCatalogCacheForTests();
}

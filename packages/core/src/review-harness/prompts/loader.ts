import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Concern } from "../tools/dispatch-worker.js";

/**
 * Loads M14 review-harness prompts from sibling `.md` files. Mirrors the
 * shape of `packages/core/src/llm/prompt-loader.ts` (which serves the
 * legacy M4/M7/M12/M13 prompts) but reads from its own `prompts/` directory
 * so the two surfaces evolve independently and the legacy prompts can
 * eventually retire without churning this loader.
 *
 * Path resolution uses `import.meta.url` so the loader works both in dev
 * (running TS source directly) and in built dist (tsdown copies the
 * `.md` files alongside the JS bundle — see `packages/core/tsdown.config.ts`).
 *
 * Prompts-as-files invariant per ADR-0015: never embed multi-hundred-line
 * prompt content as TS string literals.
 */

const DIR = dirname(fileURLToPath(import.meta.url));
const WORKERS_DIR = resolve(DIR, "workers");

/**
 * M15 (ADR-0031): the boss prompt has two shapes. `'rules'` is the M14
 * rules-based prompt (`boss-system.md`); `'examples'` is the M15 examples-
 * first rewrite (`boss-system-examples.md`) driven by worked examples
 * sourced from the synthetic fixture set + M14 close-out labels. The
 * default stays `'rules'` to preserve M14 behavior; the eval suite flips
 * the variant on a per-config basis to compare them.
 */
export type BossPromptVariant = "rules" | "examples";

const BOSS_PROMPT_PATHS: Record<BossPromptVariant, string> = {
  rules: resolve(DIR, "boss-system.md"),
  examples: resolve(DIR, "boss-system-examples.md"),
};

const bossCache = new Map<BossPromptVariant, string>();
const workerCache = new Map<Concern, string>();

export function loadBossSystemPrompt(
  variant: BossPromptVariant = "rules",
): string {
  const cached = bossCache.get(variant);
  if (cached !== undefined) return cached;
  const raw = readFileSync(BOSS_PROMPT_PATHS[variant], "utf8");
  bossCache.set(variant, raw);
  return raw;
}

export function loadWorkerSystemPrompt(concern: Concern): string {
  const cached = workerCache.get(concern);
  if (cached !== undefined) return cached;
  const raw = readFileSync(resolve(WORKERS_DIR, `${concern}-system.md`), "utf8");
  workerCache.set(concern, raw);
  return raw;
}

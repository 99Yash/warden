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
const BOSS_PROMPT_PATH = resolve(DIR, "boss-system.md");
const WORKERS_DIR = resolve(DIR, "workers");

let bossCache: string | undefined;
const workerCache = new Map<Concern, string>();

export function loadBossSystemPrompt(): string {
  if (bossCache !== undefined) return bossCache;
  bossCache = readFileSync(BOSS_PROMPT_PATH, "utf8");
  return bossCache;
}

export function loadWorkerSystemPrompt(concern: Concern): string {
  const cached = workerCache.get(concern);
  if (cached !== undefined) return cached;
  const raw = readFileSync(resolve(WORKERS_DIR, `${concern}-system.md`), "utf8");
  workerCache.set(concern, raw);
  return raw;
}

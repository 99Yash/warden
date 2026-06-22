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

/**
 * Worker prompt variant. `'baseline'` (default) loads each worker's
 * `<concern>-system.md`. `'sentry-borrow'` tries `<concern>-system.sentry-borrow.md`
 * first and silently falls back to the baseline when the variant file is
 * absent — letting us patch only the workers where Sentry-Warden's
 * prompt-craft borrows actually fit (correctness + scalability fully;
 * consistency + security partially; committability + leverage not at all)
 * without requiring all 6 variant files to exist.
 *
 * `'diligent'` is a *compose* variant rather than a per-concern rewrite: it
 * prepends the concern-agnostic investigation protocol in
 * `diligent-preamble.md` to each worker's baseline prompt. One file applies
 * to every concern and automatically inherits baseline edits (no drift), so
 * it targets the cross-file recall gap (PR#235 head-to-head: unwired params,
 * order/window contracts, cross-file N+1) without duplicating each catalog.
 */
export type WorkerPromptVariant = "baseline" | "sentry-borrow" | "diligent";

const DILIGENT_PREAMBLE_PATH = resolve(WORKERS_DIR, "diligent-preamble.md");
let diligentPreambleCache: string | undefined;

function loadDiligentPreamble(): string {
  if (diligentPreambleCache !== undefined) return diligentPreambleCache;
  diligentPreambleCache = readFileSync(DILIGENT_PREAMBLE_PATH, "utf8");
  return diligentPreambleCache;
}

const BOSS_PROMPT_PATHS: Record<BossPromptVariant, string> = {
  rules: resolve(DIR, "boss-system.md"),
  examples: resolve(DIR, "boss-system-examples.md"),
};

const bossCache = new Map<BossPromptVariant, string>();
// Cache key: `${variant}:${concern}` so baseline + variant for the same
// concern coexist without invalidation across eval-suite config sweeps.
const workerCache = new Map<string, string>();

export function loadBossSystemPrompt(variant: BossPromptVariant = "rules"): string {
  const cached = bossCache.get(variant);
  if (cached !== undefined) return cached;
  const raw = readFileSync(BOSS_PROMPT_PATHS[variant], "utf8");
  bossCache.set(variant, raw);
  return raw;
}

export function loadWorkerSystemPrompt(
  concern: Concern,
  variant: WorkerPromptVariant = "baseline",
): string {
  const key = `${variant}:${concern}`;
  const cached = workerCache.get(key);
  if (cached !== undefined) return cached;

  if (variant === "sentry-borrow") {
    try {
      const variantPath = resolve(WORKERS_DIR, `${concern}-system.sentry-borrow.md`);
      const raw = readFileSync(variantPath, "utf8");
      workerCache.set(key, raw);
      return raw;
    } catch {
      // Variant file absent → fall through to baseline. Lets the experiment
      // ship a partial set of variant files (M-X analysis: only 4 of 6
      // workers benefit from the borrows) without requiring all 6.
    }
  }

  const baseline = readFileSync(resolve(WORKERS_DIR, `${concern}-system.md`), "utf8");

  // `diligent` composes: investigation-protocol preamble + the concern's
  // baseline prompt. No per-concern variant files; the preamble overrides the
  // baseline's "use tools sparingly" framing from the top.
  if (variant === "diligent") {
    const composed = `${loadDiligentPreamble()}\n${baseline}`;
    workerCache.set(key, composed);
    return composed;
  }

  workerCache.set(key, baseline);
  return baseline;
}

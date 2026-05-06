import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Loads `.md` prompt files from the sibling `prompts/` directory and
 * substitutes `{{placeholder}}` tokens. Prompts are kept as `.md` per
 * ADR-0015 — never embedded as multi-hundred-line string literals in
 * business logic (the DeepSec failure mode this rule was created to avoid).
 *
 * Path resolution uses `import.meta.url` so the loader works both in dev
 * (running TS source directly per the workspace convention in CLAUDE.md)
 * and in built dist (tsdown copies `.md` files alongside the JS bundle).
 */

const DIR = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = resolve(DIR, "prompts");

type PromptName = "system" | "user-template";

const cache = new Map<PromptName, string>();

function load(name: PromptName): string {
  const cached = cache.get(name);
  if (cached !== undefined) return cached;
  const raw = readFileSync(resolve(PROMPTS_DIR, `${name}.md`), "utf8");
  cache.set(name, raw);
  return raw;
}

export function loadSystemPrompt(): string {
  return load("system");
}

export function loadUserPrompt(vars: {
  diff: string;
  toolFindings: string;
  verifiedAdvisories: string;
  retrievedContext: string;
}): string {
  const template = load("user-template");
  return template
    .replaceAll("{{diff}}", vars.diff)
    .replaceAll("{{tool_findings}}", vars.toolFindings)
    .replaceAll("{{verified_advisories}}", vars.verifiedAdvisories)
    .replaceAll("{{retrieved_context}}", vars.retrievedContext);
}

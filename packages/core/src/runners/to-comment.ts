import { stableCommentId } from "../comment-id.js";
import type { ChangedFile } from "../diff/index.js";
import type { Category, Comment, Tier } from "../schema.js";
import type { ToolFinding } from "./types.js";

/**
 * Map a deterministic-runner `ToolFinding` to a renderable `Comment`. Tier
 * + category come from `mapSeverity()`; sources is a single tool-citation
 * envelope. Stable comment id is content-addressed (re-running on the same
 * diff produces the same id; required for the GitHub PR bot's "update,
 * don't duplicate" semantics per ADR-0013).
 *
 * Lives outside `index.ts` so the orchestration synthesizer can map the
 * scratchpad's flattened findings without importing the package barrel.
 */
export function toComment(f: ToolFinding): Comment {
  const { tier, category } = mapSeverity(f);
  return {
    id: stableCommentId(`tool:${f.source}:${f.file}:${f.line}:${f.ruleId ?? ""}:${f.message}`),
    file: f.file,
    lineStart: f.line,
    lineEnd: f.endLine ?? f.line,
    tier,
    category,
    kind: "assertion",
    claim: f.ruleId ? `${f.source} ${f.ruleId}: ${f.message}` : `${f.source}: ${f.message}`,
    explanation: f.message,
    sources: [
      {
        type: "tool",
        id: f.ruleId ?? f.source,
        title: f.source,
        retrievedAt: new Date().toISOString(),
        // M12 (ADR-0027): leverage detector ships AST evidence so the M10
        // global verifier can substring-check the cited line. SourceSchema's
        // all-or-nothing refinement requires populating the triple together;
        // detectors without evidence leave it undefined and the verifier
        // skips them (no snippet to match).
        ...(f.evidence
          ? { path: f.evidence.path, line: f.evidence.line, snippet: f.evidence.snippet }
          : {}),
      },
    ],
    confidence: 1,
  };
}

export function mapSeverity(f: ToolFinding): { tier: Tier; category: Category } {
  if (f.source === "tsc") {
    return f.severity === "error"
      ? { tier: 1, category: "correctness" }
      : { tier: 2, category: "correctness" };
  }
  if (f.source === "jscpd") {
    return { tier: 3, category: "dedup" };
  }
  if (f.source === "scalability") {
    return { tier: 2, category: "scalability" };
  }
  if (f.source === "deadcode") {
    return { tier: 2, category: "deadcode" };
  }
  if (f.source === "consistency") {
    return { tier: 2, category: "consistency" };
  }
  if (f.source === "leverage") {
    return { tier: 2, category: "leverage" };
  }
  // ADR-0046: react-doctor findings route off the carried `rdCategory`
  // (react-doctor's coarse category), NOT severity. Tiers are category-fixed:
  // Security → Tier 1 (matches the ESLint-security precedent below — the
  // Tier-3 verbose gate must not suppress security), Bugs/Performance → Tier 2,
  // Maintainability/Accessibility → Tier 3. react-doctor's error/warning is
  // kept on the finding for debug but intentionally ignored here.
  if (f.source === "react-doctor") {
    switch (f.rdCategory) {
      case "Security":
        return { tier: 1, category: "security" };
      case "Bugs":
        return { tier: 2, category: "correctness" };
      case "Performance":
        return { tier: 2, category: "scalability" };
      case "Maintainability":
      case "Accessibility":
        return { tier: 3, category: "clarity" };
      default:
        return { tier: 3, category: "clarity" };
    }
  }
  // ADR-0028 §7 / M13: ESLint findings from the Warden-managed security
  // pass carry rule IDs prefixed `security/*` or `no-secrets/*`. Route them
  // to the `security` category at Tier 1 unconditionally — these patterns
  // exist *because* they're security issues; the Tier-3 verbose gate must
  // not be able to suppress them, and the M13 confidence floor's Tier-1
  // bypass guarantees they surface even when sub-agent noise is being
  // curated.
  if (f.source === "eslint" && f.ruleId !== undefined) {
    if (f.ruleId.startsWith("security/") || f.ruleId.startsWith("no-secrets/")) {
      return { tier: 1, category: "security" };
    }
  }
  return f.severity === "error" ? { tier: 2, category: "style" } : { tier: 3, category: "style" };
}

/**
 * Drop findings that don't overlap any added line in the diff. Range-overlap,
 * not point-match: detectors like scalability/deadcode anchor `line` to a
 * construct's start (function signature, first statement) and only fire when
 * an added line is somewhere inside `[line, endLine]`. A point-match here
 * would drop those findings when the diff touched a middle/late line of the
 * construct.
 */
export function scopeToDiff(findings: ToolFinding[], changed: ChangedFile[]): ToolFinding[] {
  const byPath = new Map<string, Set<number>>();
  for (const f of changed) byPath.set(f.path, new Set(f.addedLines));
  return findings.filter((f) => {
    const lines = byPath.get(f.file);
    if (!lines) return false;
    const end = f.endLine ?? f.line;
    for (let l = f.line; l <= end; l++) {
      if (lines.has(l)) return true;
    }
    return false;
  });
}

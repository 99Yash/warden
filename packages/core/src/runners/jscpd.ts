import { createRequire } from "node:module";
import { isAbsolute, relative, resolve as resolvePath } from "node:path";
import type { ToolFinding } from "./types.js";

// jscpd's `dist/index.mjs` uses ESM-style named imports from the `colors/safe`
// CJS module, which Node ESM can't resolve (the `colors` package exports via
// `module.exports = colors` dynamically). Loading via `createRequire` picks
// jscpd's CJS build (`dist/index.js`) instead, which uses plain `require()`
// for `colors/safe` and works correctly. Local issue; tracked by upstream.
const requireCjs = createRequire(import.meta.url);
type DetectClones = (opts: Record<string, unknown>) => Promise<JscpdClone[]>;
interface JscpdLocation {
  line: number;
  column?: number;
}
interface JscpdDuplication {
  sourceId: string;
  start: JscpdLocation;
  end: JscpdLocation;
}
interface JscpdClone {
  duplicationA: JscpdDuplication;
  duplicationB: JscpdDuplication;
}

/**
 * jscpd dedup runner (M5 / ADR-0018). Programmatic API, not a CLI subprocess.
 * Scoped to `changed ∪ selector.candidates` — never repo-wide. The category
 * mapping in `index.ts`'s `mapSeverity()` routes `source: "jscpd"` findings
 * to the `dedup` category that ADR-0012 created two milestones ago.
 *
 * Each clone whose pair touches the diff becomes one finding anchored on the
 * diff side; the other side appears in the message. Clones where neither
 * side is in the diff are dropped — that's the selector's job to enable.
 */

export interface JscpdRunResult {
  findings: ToolFinding[];
  degraded: string[];
}

export async function runJscpd(
  repoRoot: string,
  scopedPaths: string[],
  changedPaths: Set<string>,
): Promise<JscpdRunResult> {
  if (scopedPaths.length === 0) return { findings: [], degraded: [] };

  const absPaths = scopedPaths.map((p) =>
    isAbsolute(p) ? p : resolvePath(repoRoot, p),
  );

  let detectClones: DetectClones;
  try {
    detectClones = (requireCjs("jscpd") as { detectClones: DetectClones }).detectClones;
  } catch (err) {
    return {
      findings: [],
      degraded: [`jscpd: load failed (${formatError(err)})`],
    };
  }

  let clones: JscpdClone[];
  try {
    clones = await detectClones({
      path: absPaths,
      minLines: 5,
      minTokens: 50,
      silent: true,
      gitignore: false,
      reporters: [],
    });
  } catch (err) {
    return {
      findings: [],
      degraded: [`jscpd: detector failed (${formatError(err)})`],
    };
  }

  const findings: ToolFinding[] = [];
  const seen = new Set<string>();

  for (const clone of clones) {
    const aRel = relFromRoot(repoRoot, clone.duplicationA.sourceId);
    const bRel = relFromRoot(repoRoot, clone.duplicationB.sourceId);
    const aChanged = changedPaths.has(aRel);
    const bChanged = changedPaths.has(bRel);
    if (!aChanged && !bChanged) continue;

    const site = aChanged ? clone.duplicationA : clone.duplicationB;
    const other = aChanged ? clone.duplicationB : clone.duplicationA;
    const siteRel = aChanged ? aRel : bRel;
    const otherRel = aChanged ? bRel : aRel;

    const startLine = site.start.line;
    const endLine = site.end.line;
    const dedupKey = `${siteRel}:${startLine}-${endLine}:${otherRel}:${other.start.line}-${other.end.line}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    findings.push({
      source: "jscpd",
      file: siteRel,
      line: startLine,
      column: site.start.column ?? 1,
      endLine,
      severity: "warning",
      message: `Duplicate of ${otherRel}:${other.start.line}-${other.end.line}`,
    });
  }

  return { findings, degraded: [] };
}

function relFromRoot(repoRoot: string, sourceId: string): string {
  const abs = isAbsolute(sourceId) ? sourceId : resolvePath(repoRoot, sourceId);
  return relative(repoRoot, abs).split("\\").join("/");
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message.slice(0, 160);
  return String(err).slice(0, 160);
}

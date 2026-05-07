import type { ExportRef, ImportRef } from "../parser.js";
import type { Evidence } from "../index.js";

/**
 * Direct-importer + direct-import signals (ADR-0018).
 *
 * Inputs are the parsed graph: `path → { imports[], exports[] }`. Module
 * resolutions live on each `ImportRef.resolved`; unresolved/external imports
 * have `resolved: undefined` and don't contribute to the candidate set.
 */

export interface GraphEntry {
  imports: ImportRef[];
  exports: ExportRef[];
}

export type Graph = Map<string, GraphEntry>;

/**
 * Reverse-import index: `resolvedAbsPath → set of paths that import it`.
 * Re-derived per `select()` invocation — cheap, and we want it to reflect
 * the current parsed graph rather than persist its own staleness.
 */
export function deriveReverse(graph: Graph): Map<string, Set<string>> {
  const reverse = new Map<string, Set<string>>();
  for (const [path, entry] of graph) {
    for (const imp of entry.imports) {
      if (!imp.resolved) continue;
      let bucket = reverse.get(imp.resolved);
      if (!bucket) {
        bucket = new Set();
        reverse.set(imp.resolved, bucket);
      }
      bucket.add(path);
    }
  }
  return reverse;
}

/**
 * For each changed file `F`, candidates that import `F`. Reason on the
 * candidate is `imports` (the candidate imports F). Evidence in the
 * candidate is the import-statement line range. One reason per (candidate,
 * target) pair — multiple `import` statements (e.g. one for type, one for
 * value) merge their evidence lines.
 */
export function collectImporterReasons(
  changedAbs: string[],
  graph: Graph,
  reverse: Map<string, Set<string>>,
): Map<string, Array<{ target: string; evidence: Evidence[] }>> {
  const out = new Map<string, Array<{ target: string; evidence: Evidence[] }>>();
  for (const target of changedAbs) {
    const importers = reverse.get(target);
    if (!importers) continue;
    for (const importerPath of importers) {
      const importerEntry = graph.get(importerPath);
      if (!importerEntry) continue;
      const evidence = mergeAdjacent(
        importerEntry.imports
          .filter((i) => i.resolved === target)
          .map((i) => ({ startLine: i.startLine, endLine: i.endLine })),
      );
      let bucket = out.get(importerPath);
      if (!bucket) {
        bucket = [];
        out.set(importerPath, bucket);
      }
      bucket.push({ target, evidence });
    }
  }
  return out;
}

/**
 * For each changed file `F`, candidates that `F` imports. Reason on the
 * candidate is `imported-by` (the candidate is imported by F). Evidence in
 * the candidate is the lines where the symbols `F` consumes are defined,
 * looked up from the candidate's `exports[]`. One reason per (candidate,
 * from) pair — multiple imports of the same module (type + value) merge.
 */
export function collectImportedByReasons(
  changedAbs: string[],
  graph: Graph,
): Map<string, Array<{ from: string; evidence: Evidence[] }>> {
  const out = new Map<string, Array<{ from: string; evidence: Evidence[] }>>();
  for (const from of changedAbs) {
    const fromEntry = graph.get(from);
    if (!fromEntry) continue;
    // Aggregate symbols imported per resolved target so type + value imports
    // collapse into a single reason.
    const symbolsByTarget = new Map<string, Set<string>>();
    for (const imp of fromEntry.imports) {
      if (!imp.resolved) continue;
      let bucket = symbolsByTarget.get(imp.resolved);
      if (!bucket) {
        bucket = new Set();
        symbolsByTarget.set(imp.resolved, bucket);
      }
      for (const s of imp.symbols) bucket.add(s);
    }
    for (const [candidatePath, symbolSet] of symbolsByTarget) {
      const candidateEntry = graph.get(candidatePath);
      const evidence: Evidence[] = [];
      if (candidateEntry && symbolSet.size > 0) {
        for (const exp of candidateEntry.exports) {
          if (symbolSet.has(exp.symbol)) {
            evidence.push({ startLine: exp.startLine, endLine: exp.endLine });
          }
        }
      }
      const merged = mergeAdjacent(evidence);
      let bucket = out.get(candidatePath);
      if (!bucket) {
        bucket = [];
        out.set(candidatePath, bucket);
      }
      bucket.push({ from, evidence: merged });
    }
  }
  return out;
}

function mergeAdjacent(evidence: Evidence[]): Evidence[] {
  if (evidence.length === 0) return evidence;
  const sorted = [...evidence].sort((a, b) => a.startLine - b.startLine);
  const merged: Evidence[] = [];
  for (const e of sorted) {
    const last = merged[merged.length - 1];
    if (last && e.startLine <= last.endLine + 1) {
      last.endLine = Math.max(last.endLine, e.endLine);
    } else {
      merged.push({ ...e });
    }
  }
  return merged;
}

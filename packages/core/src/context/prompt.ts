import { readFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import type { RetrievedChunk, RetrievedContext } from "../schema.js";
import type { ContextCandidate, Evidence, Reason } from "./index.js";

/**
 * Prompt-assembly layer (ADR-0018). The selector emits paths + reasons +
 * evidence ranges; *this* layer reads files and slices the actual code
 * excerpts. Separating ranking from I/O is what lets the v2 embedding-backed
 * selector swap in without touching prompt assembly or jscpd integration.
 *
 * Output shape is the existing `RetrievedContext` that `formatReview`
 * already accepts. Token budget per ADR-0018: ~3-5k tokens of context
 * (evidence ranges only, ±5 lines each, deduped/merged on overlap).
 */

const CONTEXT_PADDING_LINES = 5;

export async function candidatesToRetrievedContext(
  candidates: ContextCandidate[],
  repoRoot: string,
): Promise<RetrievedContext> {
  const chunks: RetrievedChunk[] = [];
  const sameFolderPaths: string[] = [];

  for (const c of candidates) {
    const evidenceBearing = collectEvidence(c.reasons);
    if (evidenceBearing.length === 0) {
      // Same-folder-only candidate — path-only entry, no content.
      sameFolderPaths.push(c.path);
      continue;
    }

    const content = await tryReadFile(resolvePath(repoRoot, c.path));
    if (content === undefined) continue;
    const lines = content.split("\n");
    const merged = mergeRanges(
      evidenceBearing.map(({ evidence }) => paddedRange(evidence, lines.length)),
    );
    const reasonLabel = renderReasonLabel(c.reasons);

    for (const r of merged) {
      const snippet = lines.slice(r.startLine - 1, r.endLine).join("\n");
      chunks.push({
        path: c.path,
        lineStart: r.startLine,
        lineEnd: r.endLine,
        snippet,
        reason: reasonLabel,
        sourceType: "repo_convention",
      });
    }
  }

  return { chunks, sameFolderPaths };
}

function collectEvidence(reasons: Reason[]): Array<{ evidence: Evidence }> {
  const out: Array<{ evidence: Evidence }> = [];
  for (const r of reasons) {
    if (r.kind === "same-folder") continue;
    if (r.evidence) {
      for (const e of r.evidence) out.push({ evidence: e });
    }
  }
  return out;
}

function paddedRange(e: Evidence, totalLines: number): Evidence {
  const startLine = Math.max(1, e.startLine - CONTEXT_PADDING_LINES);
  const endLine = Math.min(totalLines, e.endLine + CONTEXT_PADDING_LINES);
  return { startLine, endLine };
}

function mergeRanges(ranges: Evidence[]): Evidence[] {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort((a, b) => a.startLine - b.startLine);
  const merged: Evidence[] = [];
  for (const r of sorted) {
    const last = merged[merged.length - 1];
    if (last && r.startLine <= last.endLine + 1) {
      last.endLine = Math.max(last.endLine, r.endLine);
    } else {
      merged.push({ ...r });
    }
  }
  return merged;
}

function renderReasonLabel(reasons: Reason[]): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const r of reasons) {
    let label: string;
    switch (r.kind) {
      case "imported-by":
        label = `imported-by ${r.from}`;
        break;
      case "imports":
        label = `imports ${r.target}`;
        break;
      case "symbol-ref":
        label = `symbol-ref ${r.symbol}`;
        break;
      case "semantic":
        label = `semantic similarity=${r.similarity.toFixed(2)}`;
        break;
      case "same-folder":
        continue;
    }
    if (seen.has(label)) continue;
    seen.add(label);
    parts.push(label);
  }
  return parts.join(" | ");
}

async function tryReadFile(absPath: string): Promise<string | undefined> {
  try {
    return await readFile(absPath, "utf8");
  } catch {
    return undefined;
  }
}

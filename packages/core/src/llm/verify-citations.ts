import { open } from "node:fs/promises";
import { resolve as resolvePath, sep as pathSep } from "node:path";
import type { Comment, DegradedEntry, Source } from "../schema.js";

/**
 * Global substring-verifier post-pass (ADR-0021 §3).
 *
 * Runs over every `Comment` after `synthesize()` / `deterministicSynthesize()`
 * and before `applyHardRules()`. For each `Source` whose `{path, line, snippet}`
 * triple is fully populated, read a bounded window of `path` at `line ± DRIFT`,
 * normalize whitespace, and substring-match the snippet. Sources whose triple
 * fails to verify get dropped; Comments left with zero snippet-bearing sources
 * (when they had at least one originally) get dropped entirely.
 *
 * Source-citation triples whose trio is incomplete (`{path, line, snippet}`
 * any-undefined) are *not* asserting a snippet citation — they pass through
 * untouched. This is the all-or-nothing invariant declared by `SourceSchema`'s
 * refinement: only the verifier reads it, and a partial source is treated as
 * "intentionally not snippet-citing."
 *
 * Forensic counts surface as `degraded: { kind: "info", topic: "llm", ... }`
 * entries — one for dropped citations and a separate one for dropped Comments
 * so the count is unambiguous. Empty-result paths emit no degraded entries.
 *
 * Determinism: same input → same output. No timestamps, no random ordering.
 */

const MAX_READ_BYTES = 16_384;
const LINE_DRIFT = 5;

export interface VerifyCitationsInput {
  comments: Comment[];
  repoRoot: string;
}

export interface VerifyCitationsOutput {
  comments: Comment[];
  degraded: DegradedEntry[];
}

export async function verifyCitations(
  input: VerifyCitationsInput,
): Promise<VerifyCitationsOutput> {
  const fileCache = new Map<string, string | null>();
  const out: Comment[] = [];
  let droppedCitations = 0;
  let droppedComments = 0;

  for (const c of input.comments) {
    const snippetSources = c.sources.filter(hasCitationTriple);
    // Comments that never carried snippet citations pass through untouched —
    // they're not citation-asserting, so there's nothing to verify.
    if (snippetSources.length === 0) {
      out.push(c);
      continue;
    }

    const keptSources: Source[] = [];
    let droppedFromThisComment = 0;
    for (const s of c.sources) {
      if (!hasCitationTriple(s)) {
        keptSources.push(s);
        continue;
      }
      const ok = await verifyOne(input.repoRoot, s, fileCache);
      if (ok) {
        keptSources.push(s);
      } else {
        droppedFromThisComment++;
      }
    }
    droppedCitations += droppedFromThisComment;

    // If this Comment had ≥1 snippet-bearing source originally and ends up
    // with 0 verified ones, drop the whole Comment.
    const verifiedSnippetCount = keptSources.filter(hasCitationTriple).length;
    if (verifiedSnippetCount === 0) {
      droppedComments++;
      continue;
    }
    out.push({ ...c, sources: keptSources });
  }

  const degraded: DegradedEntry[] = [];
  if (droppedCitations > 0) {
    degraded.push({
      kind: "info",
      topic: "llm",
      message: `verify-citations: dropped ${droppedCitations} citation${droppedCitations === 1 ? "" : "s"} without verifiable snippet`,
    });
  }
  if (droppedComments > 0) {
    degraded.push({
      kind: "info",
      topic: "llm",
      message: `verify-citations: dropped ${droppedComments} comment${droppedComments === 1 ? "" : "s"} after citation pruning`,
    });
  }

  return { comments: out, degraded };
}

function hasCitationTriple(
  s: Source,
): s is Source & { path: string; line: number; snippet: string } {
  return s.path !== undefined && s.line !== undefined && s.snippet !== undefined;
}

/**
 * Lexical containment check (mirrors `committability.ts:resolveWithinRoot`).
 * A malicious or malformed source could carry an absolute path or `..`
 * segments; reject anything that escapes `repoRoot`. Symlinks inside the
 * repo are not realpath-resolved here — that's a separate hardening pass.
 */
function resolveWithinRoot(repoRoot: string, relativePath: string): string | null {
  if (relativePath.length === 0) return null;
  const rootAbs = resolvePath(repoRoot);
  const candidate = resolvePath(rootAbs, relativePath);
  if (candidate === rootAbs) return candidate;
  if (candidate.startsWith(rootAbs + pathSep)) return candidate;
  return null;
}

async function verifyOne(
  repoRoot: string,
  source: Source & { path: string; line: number; snippet: string },
  cache: Map<string, string | null>,
): Promise<boolean> {
  const trimmed = source.snippet.trim();
  if (trimmed.length === 0) return false;
  const abs = resolveWithinRoot(repoRoot, source.path);
  if (abs === null) return false;

  // Strip a stray `<n>: ` line-number prefix in case a producer accidentally
  // included it from a numbered code block. Mirrors `committability.ts`'s
  // pre-M10 verifier exactly.
  const stripped = trimmed.replace(/^\d+:\s*/, "");
  const norm = normalizeWhitespace(stripped);
  if (norm.length === 0) return false;

  let content = cache.get(abs);
  if (content === undefined) {
    content = await readBoundedFile(abs);
    cache.set(abs, content);
  }
  if (content === null) return false;

  const lines = content.split("\n");
  const start = Math.max(1, source.line - LINE_DRIFT);
  const end = Math.min(lines.length, source.line + LINE_DRIFT);
  for (let i = start; i <= end; i++) {
    const candidate = normalizeWhitespace(lines[i - 1] ?? "");
    if (candidate.length > 0 && candidate.includes(norm)) return true;
  }
  return false;
}

async function readBoundedFile(abs: string): Promise<string | null> {
  try {
    const handle = await open(abs, "r");
    try {
      const stats = await handle.stat();
      const readBytes = Math.min(MAX_READ_BYTES, stats.size);
      const buf = Buffer.alloc(readBytes);
      if (readBytes > 0) {
        await handle.read(buf, 0, readBytes, 0);
      }
      return buf.toString("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

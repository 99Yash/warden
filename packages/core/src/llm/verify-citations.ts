import { createReadStream } from "node:fs";
import { resolve as resolvePath, sep as pathSep } from "node:path";
import { createInterface } from "node:readline";
import type { Comment, DegradedEntry, Source } from "../schema.js";

/**
 * Global substring-verifier post-pass (ADR-0021 §3).
 *
 * Runs over every `Comment` after `synthesize()` / `deterministicSynthesize()`
 * and before `applyHardRules()`. For each `Source` whose `{path, line, snippet}`
 * triple is fully populated, stream `path` line-by-line up to `line + DRIFT`
 * (bounded by `MAX_LINES_READ` for safety), concatenate the `line ± DRIFT`
 * window with single-space separators, normalize whitespace, and substring-
 * match the snippet against the resulting window text. Sources whose triple
 * fails to verify get dropped; Comments left with zero snippet-bearing
 * sources (when they had at least one originally) get dropped entirely.
 *
 * Sources whose `{path, line, snippet}` trio is fully undefined pass through
 * untouched — they are not asserting a snippet citation. Partial triples
 * (any-some-some-none combination) cannot reach this stage: `SourceSchema`'s
 * `.refine()` rejects them at parse time per the all-or-nothing invariant.
 *
 * Forensic counts surface as `degraded: { kind: "info", topic: "llm", ... }`
 * entries — one for dropped citations and a separate one for dropped Comments
 * so the count is unambiguous. Empty-result paths emit no degraded entries.
 *
 * Determinism: same input → same output. No timestamps, no random ordering.
 */

const LINE_DRIFT = 5;
/**
 * M11 (ADR-0026 §14): wider drift for `api_def` sources. Real-world `.d.ts`
 * signatures span lines routinely — generics + JSDoc + overload sets — so a
 * per-line match would never find a line containing the whole collapsed
 * signature. 30 covers signatures up to 61 lines wide; real signatures
 * almost always fit. M14 generalized concat-then-match to all source types
 * (single-line snippets are the 1-line degenerate case of multi-line); the
 * wider window stays `api_def`-only because non-`api_def` snippets are
 * line-grained and don't need it.
 */
const API_DEF_DRIFT = 30;
// Hard sanity cap on lines streamed per file. Real source files are well
// below this; the cap exists to keep memory bounded on a pathological input
// (e.g., a minified bundle accidentally fed in as a citation target).
const MAX_LINES_READ = 200_000;

interface FileLines {
  /** Lines 1..n stored in order; lines[i] is the (i+1)-th line of the file. */
  lines: string[];
  /** True when streaming reached EOF (so `lines.length` is the file's length). */
  eof: boolean;
}

export interface VerifyCitationsInput {
  comments: Comment[];
  repoRoot: string;
}

export interface VerifyCitationsOutput {
  comments: Comment[];
  degraded: DegradedEntry[];
}

export async function verifyCitations(input: VerifyCitationsInput): Promise<VerifyCitationsOutput> {
  const fileCache = new Map<string, FileLines | null>();
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
  cache: Map<string, FileLines | null>,
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

  // M14 bug floor: concat-then-substring-match for all source types. M10's
  // per-line match couldn't find snippets whose `normalizeWhitespace` pass
  // collapses across line breaks (any multi-line node text from a producer
  // like the formatter or leverage detector). Single-line snippets are the
  // 1-line degenerate case of multi-line, so one algorithm covers both.
  // Drift constants stay split: api_def needs a wider window for multi-line
  // `.d.ts` signatures (M11 / ADR-0026 §14).
  const drift = source.type === "api_def" ? API_DEF_DRIFT : LINE_DRIFT;
  return verifyWindow(abs, source.line, drift, norm, cache);
}

/**
 * Concatenate the `± drift` window with single-space joins, normalize
 * whitespace, and substring-match the (already normalized) snippet against
 * the resulting window text. False-positive risk is bounded by the window
 * width and the snippet's own token sequence — random matches across
 * unrelated lines require a token order real source code rarely produces.
 */
async function verifyWindow(
  abs: string,
  line: number,
  drift: number,
  normalizedSnippet: string,
  cache: Map<string, FileLines | null>,
): Promise<boolean> {
  const upToLine = line + drift;
  const entry = await ensureLinesUpTo(abs, upToLine, cache);
  if (entry === null) return false;
  const start = Math.max(1, line - drift);
  const end = Math.min(entry.lines.length, line + drift);
  if (end < start) return false;
  const windowText = entry.lines.slice(start - 1, end).join(" ");
  return normalizeWhitespace(windowText).includes(normalizedSnippet);
}

/**
 * Stream `abs` line-by-line into the cache up to (at most) `upToLine` lines,
 * or EOF, or `MAX_LINES_READ` — whichever comes first. The cache is monotonic
 * per file: a later citation that needs more lines triggers a re-stream that
 * supersedes the prior entry; a citation that needs fewer lines reuses what
 * is already cached. Open failures cache `null` so we don't retry the same
 * unreadable file repeatedly.
 */
async function ensureLinesUpTo(
  abs: string,
  upToLine: number,
  cache: Map<string, FileLines | null>,
): Promise<FileLines | null> {
  const target = Math.min(Math.max(upToLine, 1), MAX_LINES_READ);
  const existing = cache.get(abs);
  if (existing === null) return null;
  if (existing !== undefined && (existing.eof || existing.lines.length >= target)) {
    return existing;
  }

  try {
    const stream = createReadStream(abs, { encoding: "utf8" });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    const lines: string[] = [];
    let hitTarget = false;
    try {
      for await (const line of rl) {
        lines.push(line);
        if (lines.length >= target) {
          hitTarget = true;
          break;
        }
      }
    } finally {
      rl.close();
      stream.destroy();
    }
    const entry: FileLines = { lines, eof: !hitTarget };
    cache.set(abs, entry);
    return entry;
  } catch {
    cache.set(abs, null);
    return null;
  }
}

function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

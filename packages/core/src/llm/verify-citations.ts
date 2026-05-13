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
 * (bounded by `MAX_LINES_READ` for safety), normalize whitespace, and
 * substring-match the snippet against any line in `line ± DRIFT`. Sources
 * whose triple fails to verify get dropped; Comments left with zero
 * snippet-bearing sources (when they had at least one originally) get dropped
 * entirely.
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
 * signatures span lines routinely — generics + JSDoc + overload sets — so
 * per-line match (M10's algorithm) would never find a line containing the
 * whole collapsed signature. The `api_def` branch concatenates a
 * `± API_DEF_DRIFT` line window, normalizes whitespace, and substring-
 * matches the (already single-line-normalized) signature once. 30 covers
 * signatures up to 61 lines wide; real signatures almost always fit.
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

export async function verifyCitations(
  input: VerifyCitationsInput,
): Promise<VerifyCitationsOutput> {
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

  // M11 (ADR-0026 §14): `api_def` sources need a wider drift + concat-
  // then-match because `.d.ts` signatures span multiple lines. M10's
  // per-line match is unchanged for every other source type — widening it
  // for non-`api_def` would loosen verification for no benefit.
  if (source.type === "api_def") {
    return verifyApiDef(abs, source.line, norm, cache);
  }

  const upToLine = source.line + LINE_DRIFT;
  const entry = await ensureLinesUpTo(abs, upToLine, cache);
  if (entry === null) return false;

  const start = Math.max(1, source.line - LINE_DRIFT);
  const end = Math.min(entry.lines.length, source.line + LINE_DRIFT);
  for (let i = start; i <= end; i++) {
    const candidate = normalizeWhitespace(entry.lines[i - 1] ?? "");
    if (candidate.length > 0 && candidate.includes(norm)) return true;
  }
  return false;
}

/**
 * `api_def`-branch verification: concatenate the `± API_DEF_DRIFT` window,
 * normalize whitespace, then substring-match. The resolver stores
 * `signature` already collapsed to a single line via the same
 * `normalizeWhitespace` rule, so file-window normalization is reciprocal.
 *
 * False-positive risk is bounded by the tight 61-line window and pinned by
 * the symbol name being part of the signature — random matches across
 * unrelated declarations require a token sequence real `.d.ts` files
 * don't produce.
 */
async function verifyApiDef(
  abs: string,
  line: number,
  normalizedSignature: string,
  cache: Map<string, FileLines | null>,
): Promise<boolean> {
  const upToLine = line + API_DEF_DRIFT;
  const entry = await ensureLinesUpTo(abs, upToLine, cache);
  if (entry === null) return false;
  const start = Math.max(1, line - API_DEF_DRIFT);
  const end = Math.min(entry.lines.length, line + API_DEF_DRIFT);
  if (end < start) return false;
  const windowText = entry.lines.slice(start - 1, end).join(" ");
  return normalizeWhitespace(windowText).includes(normalizedSignature);
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

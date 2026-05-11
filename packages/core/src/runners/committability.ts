import { open } from "node:fs/promises";
import { resolve as resolvePath, sep as pathSep } from "node:path";
import {
  Output,
  getWorkerCheapFallbackModel,
  getWorkerCheapModel,
  streamText,
  type LanguageModel,
} from "@warden/ai";
import { z } from "zod";
import { stableCommentId } from "../comment-id.js";
import type { ChangedFile } from "../diff/index.js";
import { loadCommittabilitySystemPrompt } from "../llm/prompt-loader.js";
import type { Runner, RunnerInput, RunnerOutput } from "../orchestration/runner.js";
import type { Comment, DegradedEntry } from "../schema.js";
import { formatErr } from "./_shared.js";

/**
 * Committability sub-agent (ADR-0021 #2). Cheap-tier LLM (Haiku) reviews the
 * file list of a diff and emits questions[] flagging files whose name,
 * location, or content shape suggests they shouldn't have been committed.
 *
 * Lane discipline (ADR-0021 #3): the sub-agent emits questions, never
 * assertions. Each emitted citation is substring-verified against the cited
 * file before the question lands in the output — unverifiable citations
 * cause the question to be dropped silently (a forensic count surfaces in
 * `degraded` with topic `committability`, kind `info`).
 *
 * Noise pre-filter is gone from this runner as of M9 (ADR-0025): the
 * baseline + JS-profile prune at the diff loader (`diff/prune.ts`) is
 * universal and runs before any runner sees the diff. Committability
 * receives an already-pruned `ChangedFile[]` and only owns the
 * sub-agent + citation-verification surface.
 */

// Sub-agent input: bound the snippet at SNIPPET_LINE_CAP lines built from
// the diff-touched ranges (with ±CONTEXT_LINES surrounding each added line).
// MAX_READ_BYTES caps the file head we read — large files past this offset
// surface their later changed lines as `[truncated; file > N bytes]`.
// Binary files surface as `[binary; size=<N>B]`.
const SNIPPET_LINE_CAP = 20;
const CONTEXT_LINES = 2;
const MAX_READ_BYTES = 16_384;
const BINARY_SNIFF_BYTES = 2048;

// Files whose content is itself sensitive — even an excerpt risks leaking
// secrets to the LLM provider. The path itself is still useful committability
// signal (`.env.local` in source IS the smell), so we transmit path-only.
const SENSITIVE_PATH_PATTERNS: ReadonlyArray<RegExp> = [
  /(^|\/)\.env(\..+)?$/,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /\.crt$/i,
  /(^|\/)id_(rsa|ed25519|dsa|ecdsa)(\.pub)?$/,
  /(^|\/)\.aws\/credentials$/,
  /(^|\/)\.npmrc$/,
  /(^|\/)\.netrc$/,
];

const DEFAULT_TIMEOUT_MS = 45_000;

export interface CommittabilityRunnerInput {
  repoRoot: string;
  changed: ChangedFile[];
  /** Override per-provider timeout (ms). */
  timeoutMs?: number;
}

export interface CommittabilityRunnerOutput {
  questions: Comment[];
  degraded: DegradedEntry[];
}

const SubAgentFindingSchema = z.object({
  path: z.string(),
  line: z.number().int().nonnegative().nullable().optional(),
  snippet: z.string(),
  reason: z.string().min(1),
  severity: z.enum(["info", "warning"]).default("info"),
});

const SubAgentOutputSchema = z.object({
  findings: z.array(SubAgentFindingSchema).default([]),
});

type SubAgentFinding = z.infer<typeof SubAgentFindingSchema>;

export async function runCommittability(
  input: CommittabilityRunnerInput,
): Promise<CommittabilityRunnerOutput> {
  const degraded: DegradedEntry[] = [];

  // The diff-level noise filter (M9 / ADR-0025) has already removed
  // baseline + JS-profile noise before this runner sees the input.
  const candidates = input.changed;
  if (candidates.length === 0) {
    return { questions: [], degraded };
  }

  // Build the per-file sub-agent input. `buildFileInput` returns `null` when
  // the path escapes `repoRoot` (path-traversal guard); other I/O errors
  // surface as `info` degraded entries and the file is dropped from the
  // sub-agent input but not from the diff (other runners still see it).
  const fileInputs: SubAgentFileInput[] = [];
  for (const cf of candidates) {
    try {
      const fileInput = await buildFileInput(input.repoRoot, cf);
      if (fileInput === null) {
        degraded.push({
          kind: "warning",
          topic: "committability",
          message: `committability: dropped ${cf.path} — path escapes repoRoot`,
        });
        continue;
      }
      fileInputs.push(fileInput);
    } catch (err) {
      degraded.push({
        kind: "info",
        topic: "committability",
        message: `committability: skipped ${cf.path} (${formatErr(err)})`,
      });
    }
  }

  if (fileInputs.length === 0) {
    return { questions: [], degraded };
  }

  // Sub-agent call — Anthropic Haiku → Google Flash fallback per ADR-0017.
  const subAgent = await callSubAgent({
    systemPrompt: loadCommittabilitySystemPrompt(),
    userPrompt: renderUserPrompt(fileInputs),
    timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
  if (!subAgent.ok) {
    degraded.push({
      kind: "warning",
      topic: "committability",
      message: `committability: sub-agent failed (${subAgent.error})`,
    });
    return { questions: [], degraded };
  }
  if (subAgent.fellBackToGoogle) {
    degraded.push({
      kind: "warning",
      topic: "committability",
      message: `committability: anthropic failed (${subAgent.fallbackReason}), served from google`,
    });
  }

  // M10 (ADR-0021 §3): committability no longer runs its own internal
  // substring verifier. Findings flow through to `toQuestion()`, which emits
  // them with `{path, line, snippet}` on `sources[]`; the global verifier
  // (`verify-citations.ts`) post-pass after synthesis drops citations whose
  // triple doesn't substring-match the cited file content.
  //
  // The `droppedUnknownPath` guard stays — that's lane integrity (LLM cited
  // a path the diff doesn't touch), not citation accuracy.
  const candidatePaths = new Set(candidates.map((c) => c.path));
  const verified: Comment[] = [];
  let droppedUnknownPath = 0;
  for (const f of subAgent.findings) {
    if (!candidatePaths.has(f.path)) {
      droppedUnknownPath++;
      continue;
    }
    verified.push(toQuestion(f));
  }
  if (droppedUnknownPath > 0) {
    degraded.push({
      kind: "info",
      topic: "committability",
      message: `committability: dropped ${droppedUnknownPath} finding${droppedUnknownPath === 1 ? "" : "s"} citing paths outside the diff`,
    });
  }

  return { questions: verified, degraded };
}

interface SubAgentFileInput {
  path: string;
  sizeBytes: number;
  snippet: string;
  binary: boolean;
}

/**
 * Lexical containment check — given a (possibly absolute / `..`-bearing)
 * path from the diff, return its absolute resolution iff the result stays
 * inside `repoRoot`. Returns `null` on escape so callers degrade rather
 * than reading files the diff shouldn't be naming.
 *
 * Defensive against a malicious or malformed diff containing
 * `--- /etc/passwd` or `--- ../../etc/shadow`. Symlinks inside the repo
 * are not realpath-resolved here — that's a separate (M9+) hardening
 * pass tied to the noise filter's path discipline.
 */
function resolveWithinRoot(repoRoot: string, relativePath: string): string | null {
  if (relativePath.length === 0) return null;
  const rootAbs = resolvePath(repoRoot);
  const candidate = resolvePath(rootAbs, relativePath);
  if (candidate === rootAbs) return candidate;
  if (candidate.startsWith(rootAbs + pathSep)) return candidate;
  return null;
}

function isSensitivePath(p: string): boolean {
  return SENSITIVE_PATH_PATTERNS.some((re) => re.test(p));
}

async function buildFileInput(
  repoRoot: string,
  cf: ChangedFile,
): Promise<SubAgentFileInput | null> {
  const abs = resolveWithinRoot(repoRoot, cf.path);
  if (abs === null) return null;

  // Sensitive paths: path-only signal, no file content transmitted to the
  // LLM provider. The filename itself is still useful committability
  // evidence (`.env.local` in source IS the smell).
  if (isSensitivePath(cf.path)) {
    return {
      path: cf.path,
      sizeBytes: -1,
      snippet: "[sensitive path — content withheld; review the path itself]",
      binary: false,
    };
  }

  // Read only what's needed. `readFile()` would slurp the whole file just to
  // slice the first 16KB; `open()` + bounded `read()` keeps memory + time
  // proportional to the snippet, not the file.
  const handle = await open(abs, "r");
  try {
    const stats = await handle.stat();
    const sizeBytes = stats.size;
    const readBytes = Math.min(MAX_READ_BYTES, sizeBytes);
    const buf = Buffer.alloc(readBytes);
    if (readBytes > 0) {
      await handle.read(buf, 0, readBytes, 0);
    }
    const sniffWindow = buf.subarray(0, Math.min(BINARY_SNIFF_BYTES, readBytes));
    if (sniffWindow.includes(0)) {
      return {
        path: cf.path,
        sizeBytes,
        snippet: `[binary; size=${sizeBytes}B]`,
        binary: true,
      };
    }
    const text = buf.toString("utf8");
    const truncated = readBytes < sizeBytes;
    const snippet = buildDiffScopedSnippet(text, cf.addedLines, truncated, sizeBytes);
    return {
      path: cf.path,
      sizeBytes,
      snippet,
      binary: false,
    };
  } finally {
    await handle.close();
  }
}

/**
 * Build a snippet from the diff-touched line ranges (each added line plus
 * `±CONTEXT_LINES` of surrounding context, with adjacent windows merged).
 * Capped at `SNIPPET_LINE_CAP` lines total.
 *
 * For added (whole-file) diffs this naturally degenerates to "the whole
 * file up to the cap" because `addedLines` covers every line. For modified
 * files this surfaces only the lines being changed, so unrelated header
 * content (potentially including secrets) doesn't leak to the LLM.
 */
function buildDiffScopedSnippet(
  fullText: string,
  addedLines: number[],
  truncated: boolean,
  fileSize: number,
): string {
  if (addedLines.length === 0) {
    return "[deletion-only diff — no added lines to inspect]";
  }
  const allLines = fullText.split("\n");
  const sorted = [...addedLines].sort((a, b) => a - b);
  const windows: Array<{ start: number; end: number }> = [];
  for (const ln of sorted) {
    const start = Math.max(1, ln - CONTEXT_LINES);
    const end = ln + CONTEXT_LINES;
    const last = windows[windows.length - 1];
    if (last && start <= last.end + 1) {
      last.end = Math.max(last.end, end);
    } else {
      windows.push({ start, end });
    }
  }
  const out: string[] = [];
  let lineCount = 0;
  let reachedTruncationBoundary = false;
  for (const w of windows) {
    if (lineCount >= SNIPPET_LINE_CAP) break;
    if (out.length > 0) out.push("...");
    for (let i = w.start; i <= w.end && lineCount < SNIPPET_LINE_CAP; i++) {
      const line = allLines[i - 1];
      if (line === undefined) {
        if (truncated) reachedTruncationBoundary = true;
        break;
      }
      out.push(`${i}: ${line}`);
      lineCount++;
    }
  }
  if (reachedTruncationBoundary) {
    out.push(`... [truncated; file > ${MAX_READ_BYTES}B (size=${fileSize}B)]`);
  }
  return out.join("\n");
}

function renderUserPrompt(files: SubAgentFileInput[]): string {
  const blocks = files.map((f) => {
    const sizeLabel = f.sizeBytes < 0 ? "" : ` (${f.sizeBytes}B${f.binary ? ", binary" : ""})`;
    const header = `### ${f.path}${sizeLabel}`;
    return `${header}\n\`\`\`\n${f.snippet}\n\`\`\``;
  });
  return [
    `# Files in this diff`,
    "",
    `Review the following ${files.length} file${files.length === 1 ? "" : "s"} for committability concerns.`,
    `Each block shows the file path and the diff-touched line ranges. Lines are prefixed with their line number followed by a colon (\`47: ...\`).`,
    `When citing a snippet for a content-based finding, quote ONLY the file content — do not include the \`<n>: \` line-number prefix in your snippet field. The line number goes in the \`line\` field.`,
    "",
    blocks.join("\n\n"),
    "",
    `Emit findings only for files where you're reasonably confident there's a smell. Empty findings is the right answer when nothing fires.`,
  ].join("\n");
}

interface SubAgentOk {
  ok: true;
  findings: SubAgentFinding[];
  fellBackToGoogle: boolean;
  fallbackReason?: string;
}

interface SubAgentErr {
  ok: false;
  error: string;
}

async function callSubAgent(opts: {
  systemPrompt: string;
  userPrompt: string;
  timeoutMs: number;
}): Promise<SubAgentOk | SubAgentErr> {
  const primary = getWorkerCheapModel();
  const first = await tryProvider(primary, opts);
  if (first.ok) {
    return {
      ok: true,
      findings: first.findings,
      fellBackToGoogle: false,
    };
  }
  const fallback = getWorkerCheapFallbackModel();
  if (!fallback) {
    return {
      ok: false,
      error: `anthropic ${first.error}; no google fallback configured`,
    };
  }
  const second = await tryProvider(fallback, opts);
  if (second.ok) {
    return {
      ok: true,
      findings: second.findings,
      fellBackToGoogle: true,
      fallbackReason: first.error,
    };
  }
  return {
    ok: false,
    error: `anthropic ${first.error}; google ${second.error}`,
  };
}

interface ProviderOk {
  ok: true;
  findings: SubAgentFinding[];
}

interface ProviderErr {
  ok: false;
  error: string;
}

async function tryProvider(
  model: LanguageModel,
  opts: { systemPrompt: string; userPrompt: string; timeoutMs: number },
): Promise<ProviderOk | ProviderErr> {
  try {
    const result = streamText({
      model,
      system: opts.systemPrompt,
      prompt: opts.userPrompt,
      output: Output.object({ schema: SubAgentOutputSchema }),
      timeout: { totalMs: opts.timeoutMs },
    });
    // Drain the reasoning stream silently so the SDK doesn't backpressure.
    (async () => {
      try {
        for await (const _ of result.fullStream) {
          // intentionally drained — sub-agent doesn't surface reasoning to UX
        }
      } catch {
        // surfaced via awaited result.output
      }
    })();
    const parsed = await result.output;
    return { ok: true, findings: parsed.findings };
  } catch (err) {
    return { ok: false, error: formatErr(err) };
  }
}

/**
 * `Runner`-contract wrapper (ADR-0023 #3). The diff-level noise filter
 * (M9 / ADR-0025) handles baseline + ecosystem-profile pruning before
 * this runner is invoked, so the wrapper just adapts I/O shapes.
 * `RunnerOutput.questions` is populated; `findings` is empty
 * (committability is a sub-agent, not a deterministic detector).
 */
export const committabilityRunner: Runner = {
  name: "committability",
  async run(input: RunnerInput): Promise<RunnerOutput> {
    const result = await runCommittability({
      repoRoot: input.repoRoot,
      changed: input.changed,
    });
    return {
      name: "committability",
      findings: [],
      questions: result.questions,
      degraded: result.degraded,
      durationMs: 0, // dispatcher overrides
    };
  },
};

function toQuestion(f: SubAgentFinding): Comment {
  const line = f.line != null && f.line > 0 ? f.line : 1;
  // M10 (ADR-0021 §3): grounded citation triple feeds the global verifier
  // post-pass. Content-cited findings carry `{path, line, snippet}`;
  // name-only findings (no `line`) leave the trio undefined so the verifier
  // skips them (there's no snippet to substring-match against).
  const hasContentCitation = f.line != null && f.line > 0 && f.snippet.trim().length > 0;
  return {
    id: stableCommentId(`committability:${f.path}:${line}:${f.reason}`),
    file: f.path,
    lineStart: line,
    lineEnd: line,
    tier: 2,
    category: "committability",
    kind: "question",
    claim: f.reason,
    explanation: f.snippet,
    sources: [
      {
        type: "repo_convention",
        id: "committability-subagent",
        title: f.path,
        retrievedAt: new Date().toISOString(),
        ...(hasContentCitation
          ? { path: f.path, line: f.line as number, snippet: f.snippet }
          : {}),
      },
    ],
    confidence: f.severity === "warning" ? 0.7 : 0.5,
  };
}

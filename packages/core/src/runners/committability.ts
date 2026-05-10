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
 * Pre-filter (Tier-1 hard-skip + ADR-0022 directory-concentration heuristic)
 * runs before any LLM call — catches the catastrophic node_modules-dump case
 * deterministically. The full M9 noise filter at the diff loader will
 * supersede this internal heuristic; until then, committability owns it.
 */

// Tier-1 hard-skip: never-intentional-commit patterns. Applied to every
// changed file before the concentration heuristic runs.
const TIER1_HARD_SKIP_PATTERNS: ReadonlyArray<RegExp> = [
  /(^|\/)\.git\//,
  /(^|\/)\.DS_Store$/,
  /(^|\/)Thumbs\.db$/,
  /\.pyc$/,
  /\.swp$/,
  /(^|\/)\.vscode\/\.history\//,
];

// Concentration heuristic constants per ADR-0022.
const CONCENTRATION_TOP_SHARE = 0.8;
const CONCENTRATION_TOP_FLOOR = 50;
const CONCENTRATION_NO_DOMINATOR_LIMIT = 200;

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

  // Tier-1 hard-skip: drop never-intentional-commit paths.
  const candidates: ChangedFile[] = [];
  let tier1Skipped = 0;
  for (const cf of input.changed) {
    if (TIER1_HARD_SKIP_PATTERNS.some((re) => re.test(cf.path))) {
      tier1Skipped++;
      continue;
    }
    candidates.push(cf);
  }
  if (tier1Skipped > 0) {
    degraded.push({
      kind: "info",
      topic: "committability",
      message: `committability: tier-1 hard-skip filtered ${tier1Skipped} path${tier1Skipped === 1 ? "" : "s"}`,
    });
  }

  if (candidates.length === 0) {
    return { questions: [], degraded };
  }

  // ADR-0022 directory-concentration heuristic. v0 uses `candidates.length`
  // as the proxy for `addedCount` — the parser doesn't surface added-vs-modified
  // status, and the catastrophic case (vendored bulk-add) is overwhelmingly
  // newly-added files anyway. M9's noise filter at the diff loader will plug
  // status-aware counting in when it lands.
  const concentration = analyseConcentration(candidates);
  if (concentration.skip) {
    degraded.push({
      kind: "actionable",
      topic: "committability",
      message: concentration.message,
    });
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

  // Substring-verify every content-based citation; map verified findings to
  // question-shaped Comments. Name-based findings (no `line`) skip verification.
  const candidatePaths = new Set(candidates.map((c) => c.path));
  const verified: Comment[] = [];
  let droppedUnverified = 0;
  let droppedUnknownPath = 0;
  for (const f of subAgent.findings) {
    if (!candidatePaths.has(f.path)) {
      droppedUnknownPath++;
      continue;
    }
    if (f.line != null && f.line > 0) {
      const ok = await verifyCitation(input.repoRoot, f.path, f.line, f.snippet);
      if (!ok) {
        droppedUnverified++;
        continue;
      }
    }
    verified.push(toQuestion(f));
  }
  if (droppedUnverified > 0) {
    degraded.push({
      kind: "info",
      topic: "committability",
      message: `committability: dropped ${droppedUnverified} finding${droppedUnverified === 1 ? "" : "s"} with unverifiable snippet`,
    });
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

interface ConcentrationSkip {
  skip: true;
  message: string;
}

interface ConcentrationKeep {
  skip: false;
}

function analyseConcentration(
  candidates: ChangedFile[],
): ConcentrationSkip | ConcentrationKeep {
  const total = candidates.length;
  const byTopDir = new Map<string, number>();
  for (const cf of candidates) {
    const top = topLevelDir(cf.path);
    byTopDir.set(top, (byTopDir.get(top) ?? 0) + 1);
  }
  let dominator: { name: string; count: number } | undefined;
  for (const [name, count] of byTopDir) {
    if (!dominator || count > dominator.count) dominator = { name, count };
  }
  if (
    dominator &&
    dominator.count > CONCENTRATION_TOP_FLOOR &&
    dominator.count / total > CONCENTRATION_TOP_SHARE
  ) {
    return {
      skip: true,
      message: `committability: skipped sub-agent — ${dominator.count}/${total} changed files concentrated in ${dominator.name}/ (likely vendored bulk-add — consider checking .gitignore for ${dominator.name}/)`,
    };
  }
  if (total > CONCENTRATION_NO_DOMINATOR_LIMIT) {
    return {
      skip: true,
      message: `committability: skipped sub-agent — ${total} changed files post-tier-1 (above ${CONCENTRATION_NO_DOMINATOR_LIMIT} with no dominant directory; consider triaging the diff or filtering by path)`,
    };
  }
  return { skip: false };
}

function topLevelDir(path: string): string {
  const idx = path.indexOf("/");
  return idx === -1 ? "." : path.slice(0, idx);
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

async function verifyCitation(
  repoRoot: string,
  path: string,
  line: number,
  snippet: string,
): Promise<boolean> {
  const trimmed = snippet.trim();
  if (trimmed.length === 0) return false;
  // Defense in depth: even though `path` here is membership-checked against
  // candidatePaths upstream, those originated from the diff and could
  // contain `..` segments or absolute paths in a malicious / malformed
  // input. The same containment check that gates `buildFileInput` runs
  // here.
  const abs = resolveWithinRoot(repoRoot, path);
  if (abs === null) return false;
  // Bounded read: only fetch the relevant line range. Citation snippets
  // are line-anchored — slurping the whole file just to look at line N±5
  // is the same shape Copilot flagged on `buildFileInput`.
  // Strip a stray `<n>: ` line-number prefix in case the sub-agent
  // accidentally echoed it from the prompt back into its `snippet` field.
  // The prompt explicitly tells the LLM not to include the prefix; this is
  // defense-in-depth so a slip doesn't fail an otherwise-valid citation.
  const stripped = trimmed.replace(/^\d+:\s*/, "");
  const norm = normalizeWhitespace(stripped);
  if (norm.length === 0) return false;
  let content: string;
  try {
    const handle = await open(abs, "r");
    try {
      const stats = await handle.stat();
      const readBytes = Math.min(MAX_READ_BYTES, stats.size);
      const buf = Buffer.alloc(readBytes);
      if (readBytes > 0) {
        await handle.read(buf, 0, readBytes, 0);
      }
      content = buf.toString("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    return false;
  }
  const lines = content.split("\n");
  // Allow ±5 line drift — LLMs are not always exact on line numbers.
  const start = Math.max(1, line - 5);
  const end = Math.min(lines.length, line + 5);
  for (let i = start; i <= end; i++) {
    const candidate = normalizeWhitespace(lines[i - 1] ?? "");
    if (candidate.length > 0 && candidate.includes(norm)) return true;
  }
  return false;
}

function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * `Runner`-contract wrapper (ADR-0023 #3). Internal Tier-1 hard-skip +
 * directory-concentration heuristic + cheap-tier sub-agent logic is
 * unchanged — the wrapper just adapts I/O shapes. `RunnerOutput.questions`
 * is populated; `findings` is empty (committability is a sub-agent, not a
 * deterministic detector).
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
      },
    ],
    confidence: f.severity === "warning" ? 0.7 : 0.5,
  };
}

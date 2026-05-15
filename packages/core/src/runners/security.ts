import { open, readFile } from "node:fs/promises";
import { dirname, resolve as resolvePath, sep as pathSep } from "node:path";
import {
  Output,
  getWorkerCheapFallbackModel,
  getWorkerCheapModel,
  stepCountIs,
  streamText,
  type LanguageModel,
  type ToolSet,
} from "@warden/ai";
import { z } from "zod";
import { stableCommentId } from "../comment-id.js";
import type { ChangedFile } from "../diff/index.js";
import { loadSecuritySystemPrompt } from "../llm/prompt-loader.js";
import { makeLookupTypeDefTool } from "../llm/tools/lookup-type-def.js";
import type { Runner, RunnerInput, RunnerOutput } from "../orchestration/runner.js";
import type { Comment, DegradedEntry, Source } from "../schema.js";
import { formatErr } from "./_shared.js";

/**
 * Security sub-agent (ADR-0028 §3, M13). Cheap-tier LLM (Haiku) scans the
 * diff for security concerns the ESLint security detector cannot catch —
 * auth bypasses, missing-auth, parameter manipulation, cross-tenant ID
 * leakage, SSRF, path-traversal in non-canonical sinks, secret-in-log,
 * OAuth callback manipulation.
 *
 * Structural twin of M12's leverage-libraries sub-agent:
 *  - Lane discipline (ADR-0021 §3): emits questions, never assertions;
 *    drops findings whose `path` is outside the diff before they become
 *    Comments (counted into one info-level degraded entry per drop class).
 *  - Citation discipline: each finding's `tool` sources flow through the
 *    existing M10 substring-verifier; uncited findings are dropped before
 *    they become Comments.
 *  - Tool access: M11's `lookupTypeDef` (third consumer after the formatter
 *    and the leverage sub-agent) with its own `stepCountIs(8)` budget.
 *  - Mode gate: dispatch only registers this runner in `review` mode;
 *    `check` stays deterministic per ADR-0011 — no LLM calls.
 *  - No prompt-time dependency preamble — security is library-agnostic;
 *    `lookupTypeDef` resolves library APIs on-demand when a finding hinges
 *    on a library API claim (e.g. "this `validator.escape(x)` actually
 *    escapes").
 *
 * Confidence floor: outputs flow through `applyConfidenceFloor()` in
 * `applyHardRules()` (ADR-0028 §5). Tier-1 findings bypass; Tier-2 / Tier-3
 * findings with `confidence < 0.8` drop silently (env override:
 * `WARDEN_SECURITY_CONFIDENCE_FLOOR`).
 */

const DEFAULT_TIMEOUT_MS = 60_000;
const TOOL_USE_STEP_CAP = 8;
const SNIPPET_LINE_CAP = 24;
const CONTEXT_LINES = 3;
const MAX_READ_BYTES = 24_576;
const BINARY_SNIFF_BYTES = 2048;

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

/**
 * V0 slug vocabulary mirrors the system prompt's slug table. Kept narrow on
 * purpose — M14+ expands based on dogfood evidence of which slugs the
 * Haiku consistently misses.
 */
const SecuritySlugEnum = z.enum([
  "auth-bypass",
  "missing-auth",
  "rce",
  "sql-injection",
  "ssrf",
  "path-traversal",
  "secrets-exposure",
  "insecure-crypto",
  "xss",
  "open-redirect",
]);

/**
 * `tool` sources for security findings carry the same `{path, line, snippet}`
 * triple the leverage detector uses; the M10/M11 global verifier substring-
 * checks it at `line ± 5`. We accept either the bare `tool` shape or M11's
 * `api_def` shape so the LLM can copy `lookupTypeDef`'s `suggestedSource`
 * verbatim when a library API claim is part of the finding.
 */
const ToolSourceSchema = z.object({
  type: z.literal("tool"),
  id: z.string().default("security-sub-agent"),
  title: z.string(),
  retrievedAt: z.string(),
  path: z.string(),
  line: z.number().int().positive(),
  snippet: z.string(),
});

const ApiDefSourceSchema = z.object({
  type: z.literal("api_def"),
  id: z.string(),
  title: z.string(),
  path: z.string(),
  line: z.number().int().positive(),
  snippet: z.string(),
  retrievedAt: z.string(),
});

const SubAgentSourceSchema = z.discriminatedUnion("type", [
  ToolSourceSchema,
  ApiDefSourceSchema,
]);

const SubAgentFindingSchema = z.object({
  slug: SecuritySlugEnum,
  path: z.string(),
  line: z.number().int().positive(),
  tier: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(2),
  confidence: z.number().min(0).max(1).default(0.75),
  claim: z.string().min(1),
  explanation: z.string().min(1),
  suggestedAction: z.string().min(1),
  sources: z.array(SubAgentSourceSchema).default([]),
});

const SubAgentOutputSchema = z.object({
  findings: z.array(SubAgentFindingSchema).default([]),
});

type SubAgentFinding = z.infer<typeof SubAgentFindingSchema>;

export interface SecurityRunnerInput {
  repoRoot: string;
  changed: ChangedFile[];
  /** Override per-provider timeout (ms). */
  timeoutMs?: number;
}

export interface SecurityRunnerOutput {
  questions: Comment[];
  degraded: DegradedEntry[];
}

export async function runSecurity(
  input: SecurityRunnerInput,
): Promise<SecurityRunnerOutput> {
  const degraded: DegradedEntry[] = [];
  const questions: Comment[] = [];

  if (input.changed.length === 0) {
    return { questions, degraded };
  }

  const fileInputs: SubAgentFileInput[] = [];
  for (const cf of input.changed) {
    try {
      const fi = await buildFileInput(input.repoRoot, cf);
      if (fi === null) {
        // Diff path escapes `repoRoot` (malformed or malicious). Mirror
        // leverage-libraries: warn so the operator can see it instead of
        // silently dropping the file from the sub-agent's view.
        degraded.push({
          kind: "warning",
          topic: "security",
          message: `security: dropped ${cf.path} — path escapes repoRoot`,
        });
        continue;
      }
      fileInputs.push(fi);
    } catch (err) {
      degraded.push({
        kind: "info",
        topic: "security",
        message: `security: skipped ${cf.path} (${formatErr(err)})`,
      });
    }
  }
  if (fileInputs.length === 0) {
    return { questions, degraded };
  }

  // The lookupTypeDef tool needs package search roots so pnpm-style
  // workspace packages resolve their own deps; security findings hinging
  // on library API claims (e.g. "does `bcrypt.compare` short-circuit?")
  // benefit from the same M11/M12 resolver path.
  const packageRoots = await discoverPackageRoots(input.repoRoot, input.changed);
  const lookupTool = makeLookupTypeDefTool({
    repoRoot: input.repoRoot,
    packageSearchRoots: packageRoots,
    degraded,
  });
  const tools: ToolSet = { lookupTypeDef: lookupTool };

  const systemPrompt = loadSecuritySystemPrompt();
  const userPrompt = renderUserPrompt(fileInputs);

  const subAgent = await callSubAgent({
    systemPrompt,
    userPrompt,
    tools,
    timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
  if (!subAgent.ok) {
    degraded.push({
      kind: "warning",
      topic: "security",
      message: `security: sub-agent failed (${subAgent.error})`,
    });
    return { questions, degraded };
  }
  if (subAgent.fellBackToGoogle) {
    degraded.push({
      kind: "warning",
      topic: "security",
      message: `security: anthropic failed (${subAgent.fallbackReason ?? "unknown"}), served from google`,
    });
  }

  const changedPaths = new Set(input.changed.map((cf) => cf.path));
  let droppedUnknownPath = 0;
  let droppedUncited = 0;
  for (const f of subAgent.findings) {
    if (!changedPaths.has(f.path)) {
      droppedUnknownPath += 1;
      continue;
    }
    if (f.sources.length === 0) {
      droppedUncited += 1;
      continue;
    }
    questions.push(toQuestion(f));
  }
  if (droppedUnknownPath > 0) {
    degraded.push({
      kind: "info",
      topic: "security",
      message: `security: dropped ${droppedUnknownPath} finding${droppedUnknownPath === 1 ? "" : "s"} citing paths outside the diff`,
    });
  }
  if (droppedUncited > 0) {
    degraded.push({
      kind: "info",
      topic: "security",
      message: `security: dropped ${droppedUncited} uncited finding${droppedUncited === 1 ? "" : "s"}`,
    });
  }

  return { questions, degraded };
}

export const securityRunner: Runner = {
  name: "security",
  async run(input: RunnerInput): Promise<RunnerOutput> {
    const result = await runSecurity({
      repoRoot: input.repoRoot,
      changed: input.changed,
    });
    return {
      name: "security",
      findings: [],
      questions: result.questions,
      degraded: result.degraded,
      durationMs: 0, // dispatcher overrides
    };
  },
};

// ---------------------------------------------------------------------------
// Package-roots discovery (mirrors leverage-libraries' workspace awareness).
// ---------------------------------------------------------------------------

async function discoverPackageRoots(
  repoRoot: string,
  changed: ChangedFile[],
): Promise<string[]> {
  const rootAbs = resolvePath(repoRoot);
  const roots = new Set<string>([rootAbs]);
  for (const cf of changed) {
    const abs = resolveWithinRoot(rootAbs, cf.path);
    if (abs === null) continue;
    const nearest = await findNearestPackageRoot(dirname(abs), rootAbs);
    if (nearest) roots.add(nearest);
  }
  return [...roots];
}

async function findNearestPackageRoot(startDir: string, rootAbs: string): Promise<string | null> {
  let cursor = startDir;
  while (true) {
    try {
      await readFile(resolvePath(cursor, "package.json"), "utf8");
      return cursor;
    } catch {
      // not present here — climb
    }
    if (cursor === rootAbs) return null;
    const parent = dirname(cursor);
    if (parent === cursor) return null;
    if (!parent.startsWith(rootAbs)) return null;
    cursor = parent;
  }
}

function resolveWithinRoot(repoRoot: string, relativePath: string): string | null {
  if (relativePath.length === 0) return null;
  const rootAbs = resolvePath(repoRoot);
  const candidate = resolvePath(rootAbs, relativePath);
  if (candidate === rootAbs) return candidate;
  if (candidate.startsWith(rootAbs + pathSep)) return candidate;
  return null;
}

// ---------------------------------------------------------------------------
// Per-file diff snippet — wider context window than leverage because security
// reasoning often needs to see middleware lines a few rows above the sink.
// ---------------------------------------------------------------------------

interface SubAgentFileInput {
  path: string;
  sizeBytes: number;
  snippet: string;
  binary: boolean;
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

  if (isSensitivePath(cf.path)) {
    return {
      path: cf.path,
      sizeBytes: -1,
      snippet: "[sensitive path — content withheld]",
      binary: false,
    };
  }

  const handle = await open(abs, "r");
  try {
    const stats = await handle.stat();
    const sizeBytes = stats.size;
    const readBytes = Math.min(MAX_READ_BYTES, sizeBytes);
    const buf = Buffer.alloc(readBytes);
    if (readBytes > 0) await handle.read(buf, 0, readBytes, 0);
    const sniff = buf.subarray(0, Math.min(BINARY_SNIFF_BYTES, readBytes));
    if (sniff.includes(0)) {
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
  let reachedTruncation = false;
  for (const w of windows) {
    if (lineCount >= SNIPPET_LINE_CAP) break;
    if (out.length > 0) out.push("...");
    for (let i = w.start; i <= w.end && lineCount < SNIPPET_LINE_CAP; i++) {
      const line = allLines[i - 1];
      if (line === undefined) {
        if (truncated) reachedTruncation = true;
        break;
      }
      out.push(`${i}: ${line}`);
      lineCount++;
    }
  }
  if (reachedTruncation) {
    out.push(`... [truncated; file > ${MAX_READ_BYTES}B (size=${fileSize}B)]`);
  }
  return out.join("\n");
}

function renderUserPrompt(files: SubAgentFileInput[]): string {
  const blocks = files.map((f) => {
    const sizeLabel = f.sizeBytes < 0 ? "" : ` (${f.sizeBytes}B${f.binary ? ", binary" : ""})`;
    return `### ${f.path}${sizeLabel}\n\`\`\`\n${f.snippet}\n\`\`\``;
  });
  return [
    `<diff>`,
    `Review the following ${files.length} file${files.length === 1 ? "" : "s"} for security concerns the ESLint security detector cannot catch.`,
    `Each block shows the file path and the diff-touched line ranges. Lines are prefixed with their line number followed by a colon (\`47: ...\`).`,
    `When citing a snippet in a finding, quote ONLY the file content — do not include the \`<n>: \` line-number prefix. The line number goes in the \`line\` field.`,
    ``,
    blocks.join("\n\n"),
    ``,
    `Only emit findings whose source line + sink line you can cite from the diff. Empty findings is the right answer when nothing fires.`,
    `</diff>`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// LLM call + provider cascade (same shape as leverage-libraries).
// ---------------------------------------------------------------------------

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
  tools: ToolSet;
  timeoutMs: number;
}): Promise<SubAgentOk | SubAgentErr> {
  let primary: LanguageModel;
  try {
    primary = getWorkerCheapModel();
  } catch (err) {
    return { ok: false, error: `anthropic model unavailable (${formatErr(err)})` };
  }
  const first = await tryProvider(primary, opts);
  if (first.ok) {
    return { ok: true, findings: first.findings, fellBackToGoogle: false };
  }
  let fallback: LanguageModel | undefined;
  try {
    fallback = getWorkerCheapFallbackModel();
  } catch {
    fallback = undefined;
  }
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
  opts: { systemPrompt: string; userPrompt: string; tools: ToolSet; timeoutMs: number },
): Promise<ProviderOk | ProviderErr> {
  try {
    const result = streamText({
      model,
      system: opts.systemPrompt,
      prompt: opts.userPrompt,
      tools: opts.tools,
      stopWhen: [stepCountIs(TOOL_USE_STEP_CAP)],
      output: Output.object({ schema: SubAgentOutputSchema }),
      timeout: { totalMs: opts.timeoutMs },
    });
    (async () => {
      try {
        for await (const _ of result.fullStream) {
          // drained — sub-agent doesn't stream reasoning to the UX
        }
      } catch {
        // surfaced via awaited result.output below
      }
    })();
    const parsed = await result.output;
    return { ok: true, findings: parsed.findings };
  } catch (err) {
    return { ok: false, error: formatErr(err) };
  }
}

// ---------------------------------------------------------------------------
// Comment shaping.
// ---------------------------------------------------------------------------

function toQuestion(f: SubAgentFinding): Comment {
  return {
    id: stableCommentId(`security:${f.slug}:${f.path}:${f.line}:${f.claim}`),
    file: f.path,
    lineStart: f.line,
    lineEnd: f.line,
    tier: f.tier,
    category: "security",
    kind: "question",
    // The slug is part of the surface the user sees so they can build a
    // mental map of "what categories of security finding does Warden
    // ship?" — useful for category-level dogfood feedback into M14.
    claim: `[${f.slug}] ${f.claim}`,
    explanation: f.explanation,
    suggestedAction: f.suggestedAction,
    sources: f.sources as Source[],
    confidence: f.confidence,
  };
}

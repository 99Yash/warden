import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import type { DegradedEntry } from "../schema.js";
import { spawnCapture } from "./_shared.js";
import type { ToolFinding } from "./types.js";

/**
 * ADR-0046: the `react-doctor` det-prior. Subprocesses the **published**
 * `react-doctor` CLI (pinned to `REACT_DOCTOR_CLI_VERSION`, via npx-on-demand)
 * with `--json`, parses its `JsonReport`, and folds the diagnostics into the
 * det-priors aggregate as `source: "react-doctor"` `ToolFinding`s. One call
 * yields react-doctor's visitor rules + the `scan()` SAST suite + the
 * base-vs-head finding **delta** (`--scope changed` in review mode).
 *
 * Purely `sourced` (ADR-0044): zero LLM, no questions, single-repo. Ships
 * **default-off** behind `WARDEN_REACT_DOCTOR` (gated at the
 * `det-priors.ts` call site) — eval-gated before the default flips.
 *
 * The subprocess boundary keeps oxc out of warden's dependency tree
 * (ADR-0003 no-binary-matrix); npx fetches react-doctor on demand.
 */

/**
 * Pinned react-doctor CLI version. Module const, not an env knob — the local
 * `JsonReport` schema below mirrors *this* version's contract; bumping the pin
 * and re-verifying the schema is one change. Verified against published
 * `react-doctor@0.5.6` (2026-06-16): `--scope changed|lines`, `--base <ref>`,
 * `--changed-files-from <file>`, `--no-telemetry`, `--json-compact` all present;
 * `--scope changed` emits a schemaVersion-2 "baseline" (PR-introduced-only)
 * report. The producer parses v1 + v2 identically (both carry `diagnostics[]`).
 */
const REACT_DOCTOR_CLI_VERSION = "0.5.6";

const REACT_DOCTOR_TIMEOUT_MS = 60_000;

/**
 * Lenient mirror of react-doctor's `core/src/schemas.ts`. We require only the
 * fields warden consumes and tolerate everything else (`plugin`, `help`,
 * `title`, `url`, `offset`, `relatedLocations`, the top-level `projects` /
 * `summary` / `elapsedMilliseconds`, …) so a minor react-doctor release that
 * adds a field doesn't break the parse. `severity` is kept for debug; tiering
 * is category-driven (see `mapSeverity`).
 */
const DiagnosticSchema = z
  .object({
    filePath: z.string(),
    rule: z.string(),
    severity: z.string(),
    category: z.string(),
    message: z.string(),
    line: z.number(),
    column: z.number(),
    endLine: z.number().optional(),
    endColumn: z.number().optional(),
  })
  .passthrough();

const JsonReportSchema = z
  .object({
    // schemaVersion 1 (full/diff/staged) or 2 (baseline, `--scope changed`).
    schemaVersion: z.union([z.literal(1), z.literal(2)]),
    ok: z.boolean(),
    error: z.object({ message: z.string() }).passthrough().nullable().optional(),
    diagnostics: z.array(DiagnosticSchema),
  })
  .passthrough();

type Diagnostic = z.infer<typeof DiagnosticSchema>;

export interface RunReactDoctorInput {
  repoRoot: string;
  changedPaths: string[];
  mode: "check" | "review";
  /**
   * The resolved diff base (ADR-0046 baseRef threading). Present in review
   * mode (`--base <ref>` → true `--scope changed` delta); undefined in check
   * mode, where react-doctor auto-detects working-tree changes.
   */
  baseRef?: string;
}

export interface RunReactDoctorResult {
  findings: ToolFinding[];
  degraded: DegradedEntry[];
}

const EMPTY: RunReactDoctorResult = { findings: [], degraded: [] };

/**
 * The producer never throws — every failure mode (npx miss, timeout, malformed
 * JSON, `report.ok === false`) collapses to one actionable degraded entry so
 * `check` never hard-fails on a missing react-doctor.
 */
export async function runReactDoctor(input: RunReactDoctorInput): Promise<RunReactDoctorResult> {
  if (input.changedPaths.length === 0) return EMPTY;

  let tmpDir: string | undefined;
  try {
    tmpDir = await mkdtemp(join(tmpdir(), "warden-rd-"));
    const changedFilesFile = join(tmpDir, "changed-files.txt");
    await writeFile(changedFilesFile, input.changedPaths.join("\n"), "utf8");

    // `review` → `npx --yes` (fetch-on-demand). `check` → `npx --no-install`
    // (no install prompt; degrade if unavailable) — keeps the fast floor from
    // blocking on an interactive prompt while still never hard-failing check.
    const npxInstallFlag = input.mode === "review" ? "--yes" : "--no-install";
    // `review` → `--scope changed` (only new issues vs base); `check` →
    // `--scope lines` (only changed lines). `--scope full` (whole-project
    // checks incl. dead-code) is deferred to ADR-0038's `xhigh` tier; warden's
    // own `deadcode` detector covers reachability (R1).
    const scope = input.mode === "review" ? "changed" : "lines";
    const argv = [
      npxInstallFlag,
      "--package",
      `react-doctor@${REACT_DOCTOR_CLI_VERSION}`,
      "--",
      "react-doctor",
      "--json",
      "--json-compact",
      "--no-telemetry",
      "--scope",
      scope,
      ...(input.baseRef ? ["--base", input.baseRef] : []),
      "--changed-files-from",
      changedFilesFile,
    ];

    const result = await spawnCapture("npx", argv, {
      cwd: input.repoRoot,
      timeoutMs: REACT_DOCTOR_TIMEOUT_MS,
    });

    if (!result.ok) return { findings: [], degraded: [unavailable()] };

    return await parseReactDoctorStdout(result.stdout, input.repoRoot);
  } catch {
    // Defensive: tmp-file IO or any unexpected throw still degrades cleanly.
    return { findings: [], degraded: [unavailable()] };
  } finally {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Parse react-doctor's `--json` stdout into the producer result. Factored out
 * of `runReactDoctor` so the parse → map → degrade pipeline is testable
 * offline (the smoke feeds synthetic stdout; the real run feeds spawn output).
 *
 * Availability is JSON-parse success, NOT exit code — react-doctor exits 1
 * when it finds issues. A non-JSON stdout (npx "package not found", a usage
 * error) or `report.ok === false` means the tool didn't run → one degraded
 * entry, no findings.
 */
export async function parseReactDoctorStdout(
  stdout: string,
  repoRoot: string,
): Promise<RunReactDoctorResult> {
  let parsed: z.infer<typeof JsonReportSchema>;
  try {
    parsed = JsonReportSchema.parse(JSON.parse(stdout));
  } catch {
    return { findings: [], degraded: [unavailable()] };
  }
  if (parsed.ok === false) {
    return { findings: [], degraded: [unavailable()] };
  }
  const findings = await mapDiagnostics(parsed.diagnostics, repoRoot);
  return { findings, degraded: [] };
}

function unavailable(): DegradedEntry {
  return {
    kind: "actionable",
    topic: "react-doctor",
    message:
      "react-doctor unavailable — React lint + SAST checks skipped; cached after first online run",
  };
}

/**
 * Map react-doctor `Diagnostic`s to `ToolFinding`s, reading each flagged file
 * once to populate the `evidence` snippet (the `leverage` precedent). Drops
 * nothing on category — Accessibility maps to `clarity` per Decision 5;
 * react-doctor emits no dead-code findings at `--scope changed|lines`.
 */
async function mapDiagnostics(
  diagnostics: readonly Diagnostic[],
  repoRoot: string,
): Promise<ToolFinding[]> {
  const lineCache = new Map<string, string[] | null>();
  const findings: ToolFinding[] = [];

  for (const d of diagnostics) {
    const absFile = isAbsolute(d.filePath) ? d.filePath : resolve(repoRoot, d.filePath);
    const file = relative(repoRoot, absFile);

    const snippet = await readSnippet(lineCache, absFile, d.line);

    const finding: ToolFinding = {
      source: "react-doctor",
      file,
      line: d.line,
      column: d.column,
      ...(d.endLine !== undefined ? { endLine: d.endLine } : {}),
      ...(d.endColumn !== undefined ? { endColumn: d.endColumn } : {}),
      severity: normalizeDiagnosticSeverity(d.severity),
      ruleId: d.rule,
      message: d.message,
      rdCategory: d.category,
      ...(snippet !== undefined ? { evidence: { path: file, line: d.line, snippet } } : {}),
    };
    findings.push(finding);
  }

  return findings;
}

function normalizeDiagnosticSeverity(severity: string): ToolFinding["severity"] {
  return severity === "error" || severity === "warning" ? severity : "info";
}

/**
 * Read the flagged line, whitespace-collapsed, so the substring-verifier
 * always matches. On read failure / out-of-range / empty line, returns
 * undefined — the finding still posts, just without a citable snippet (the
 * `tsc`/`eslint` shape).
 */
async function readSnippet(
  cache: Map<string, string[] | null>,
  absFile: string,
  line: number,
): Promise<string | undefined> {
  let lines = cache.get(absFile);
  if (lines === undefined) {
    try {
      lines = (await readFile(absFile, "utf8")).split("\n");
    } catch {
      lines = null;
    }
    cache.set(absFile, lines);
  }
  if (!lines) return undefined;
  const raw = lines[line - 1];
  if (raw === undefined) return undefined;
  const collapsed = raw.replace(/\s+/g, " ").trim();
  return collapsed.length > 0 ? collapsed : undefined;
}

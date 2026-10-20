import { isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";
import type { DegradedEntry } from "../schema.js";
import { spawnCapture } from "./_shared.js";
import type { ToolFinding } from "./types.js";

export interface EslintRunResult {
  findings: ToolFinding[];
  degraded: DegradedEntry[];
}

const LINT_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

export async function runEslint(
  repoRoot: string,
  changedFiles: string[],
): Promise<EslintRunResult> {
  const targets = changedFiles.filter((f) => {
    const dot = f.lastIndexOf(".");
    return dot !== -1 && LINT_EXTS.has(f.slice(dot));
  });

  if (targets.length === 0) {
    return { findings: [], degraded: [] };
  }

  const result = await spawnCapture(
    "npx",
    ["--no-install", "eslint", "--format", "json", "--no-error-on-unmatched-pattern", ...targets],
    { cwd: repoRoot },
  );

  if (!result.ok) {
    return {
      findings: [],
      degraded: [{ kind: "warning", topic: "eslint", message: "eslint: spawn failed" }],
    };
  }

  const findings = parseEslintOutput(result.stdout, repoRoot);
  // ESLint exits 0 (clean), 1 (findings), 2 (fatal). If we got valid JSON
  // out, parsing is the source of truth. Otherwise non-zero exit means
  // the runner failed to execute (npx fetch error, missing binary, etc.).
  const sawJson = result.stdout.includes("[") && parsedOk(result.stdout);
  const degraded: DegradedEntry[] =
    !sawJson && result.exitCode !== 0
      ? [
          {
            kind: "warning",
            topic: "eslint",
            message: `eslint: exit ${result.exitCode ?? "?"} ${result.stderr.trim().slice(0, 200)}`,
          },
        ]
      : [];
  return { findings, degraded };
}

const EslintMessageSchema = z.object({
  ruleId: z.string().nullable(),
  severity: z.number(),
  message: z.string(),
  line: z.number(),
  column: z.number(),
  endLine: z.number().optional(),
  endColumn: z.number().optional(),
});

// `messages` is parsed one entry at a time below, so one odd message does not
// drop the findings of the whole run.
const EslintFileResultSchema = z.object({
  filePath: z.string(),
  messages: z.array(z.unknown()),
});

function parsedOk(stdout: string): boolean {
  const start = stdout.indexOf("[");
  if (start === -1) return false;
  try {
    const v: unknown = JSON.parse(stdout.slice(start));
    return Array.isArray(v);
  } catch {
    return false;
  }
}

function parseEslintOutput(stdout: string, repoRoot: string): ToolFinding[] {
  const start = stdout.indexOf("[");
  if (start === -1) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(stdout.slice(start));
  } catch {
    return [];
  }
  const parsed = z.array(EslintFileResultSchema).safeParse(raw);
  if (!parsed.success) return [];

  const findings: ToolFinding[] = [];
  for (const file of parsed.data) {
    const absFile = isAbsolute(file.filePath) ? file.filePath : resolve(repoRoot, file.filePath);
    const relFile = relative(repoRoot, absFile);
    for (const entry of file.messages) {
      // A message with no position (an ignored-file warning) is not a finding.
      const result = EslintMessageSchema.safeParse(entry);
      if (!result.success) continue;
      const msg = result.data;
      findings.push({
        source: "eslint",
        file: relFile,
        line: msg.line,
        column: msg.column,
        ...(msg.endLine !== undefined ? { endLine: msg.endLine } : {}),
        ...(msg.endColumn !== undefined ? { endColumn: msg.endColumn } : {}),
        severity: msg.severity === 2 ? "error" : "warning",
        ...(msg.ruleId !== null ? { ruleId: msg.ruleId } : {}),
        message: msg.message,
      });
    }
  }
  return findings;
}

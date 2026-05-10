import { isAbsolute, relative, resolve } from "node:path";
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

interface EslintMessage {
  ruleId: string | null;
  severity: 1 | 2;
  message: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
}

interface EslintFileResult {
  filePath: string;
  messages: EslintMessage[];
}

function parsedOk(stdout: string): boolean {
  const start = stdout.indexOf("[");
  if (start === -1) return false;
  try {
    const v = JSON.parse(stdout.slice(start));
    return Array.isArray(v);
  } catch {
    return false;
  }
}

function parseEslintOutput(stdout: string, repoRoot: string): ToolFinding[] {
  const start = stdout.indexOf("[");
  if (start === -1) return [];
  let parsed: EslintFileResult[];
  try {
    parsed = JSON.parse(stdout.slice(start)) as EslintFileResult[];
  } catch {
    return [];
  }

  const findings: ToolFinding[] = [];
  for (const file of parsed) {
    const absFile = isAbsolute(file.filePath) ? file.filePath : resolve(repoRoot, file.filePath);
    const relFile = relative(repoRoot, absFile);
    for (const msg of file.messages) {
      findings.push({
        source: "eslint",
        file: relFile,
        line: msg.line,
        column: msg.column,
        endLine: msg.endLine,
        endColumn: msg.endColumn,
        severity: msg.severity === 2 ? "error" : "warning",
        ruleId: msg.ruleId ?? undefined,
        message: msg.message,
      });
    }
  }
  return findings;
}

import { spawn } from "node:child_process";
import { isAbsolute, relative, resolve } from "node:path";
import type { DegradedEntry } from "../schema.js";
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

  return new Promise((resolveP) => {
    const child = spawn(
      "npx",
      ["--no-install", "eslint", "--format", "json", "--no-error-on-unmatched-pattern", ...targets],
      { cwd: repoRoot, env: process.env, stdio: ["ignore", "pipe", "pipe"] },
    );

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });

    child.on("error", () => {
      resolveP({
        findings: [],
        degraded: [{ kind: "warning", topic: "eslint", message: "eslint: spawn failed" }],
      });
    });

    child.on("close", (code) => {
      const findings = parseEslintOutput(stdout, repoRoot);
      // ESLint exits 0 (clean), 1 (findings), 2 (fatal). If we got valid JSON
      // out, parsing is the source of truth. Otherwise non-zero exit means
      // the runner failed to execute (npx fetch error, missing binary, etc.).
      const sawJson = stdout.includes("[") && findings.length >= 0 && parsedOk(stdout);
      const degraded: DegradedEntry[] =
        !sawJson && code !== 0
          ? [
              {
                kind: "warning",
                topic: "eslint",
                message: `eslint: exit ${code ?? "?"} ${stderr.trim().slice(0, 200)}`,
              },
            ]
          : [];
      resolveP({ findings, degraded });
    });
  });
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

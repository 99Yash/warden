import { isAbsolute, relative, resolve } from "node:path";
import type { DegradedEntry } from "../schema.js";
import { spawnCapture } from "./_shared.js";
import type { ToolFinding } from "./types.js";

export interface TscRunResult {
  findings: ToolFinding[];
  degraded: DegradedEntry[];
}

export async function runTsc(repoRoot: string, tsconfigPaths: string[]): Promise<TscRunResult> {
  if (tsconfigPaths.length === 0) {
    return { findings: [], degraded: [] };
  }

  const results = await Promise.all(tsconfigPaths.map((tsconfig) => runOne(repoRoot, tsconfig)));

  const seen = new Set<string>();
  const findings: ToolFinding[] = [];
  const degraded: DegradedEntry[] = [];

  for (const r of results) {
    if (r.degraded) degraded.push(r.degraded);
    for (const f of r.findings) {
      const key = `${f.file}:${f.line}:${f.column}:${f.ruleId ?? ""}:${f.message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push(f);
    }
  }

  return { findings, degraded };
}

interface OneResult {
  findings: ToolFinding[];
  degraded?: DegradedEntry;
}

async function runOne(repoRoot: string, tsconfig: string): Promise<OneResult> {
  const result = await spawnCapture(
    "npx",
    ["--no-install", "tsc", "-b", "--pretty", "false", "--force", tsconfig],
    { cwd: repoRoot },
  );
  if (!result.ok) {
    return {
      findings: [],
      degraded: {
        kind: "warning",
        topic: "tsc",
        message: `tsc(${relative(repoRoot, tsconfig)}): spawn failed`,
      },
    };
  }
  const findings = parseTscOutput(result.stdout + "\n" + result.stderr, repoRoot);
  return { findings };
}

const DIAG_RE = /^(.+?)\((\d+),(\d+)\): (error|warning|info|message) (TS\d+): (.+)$/;

function parseTscOutput(output: string, repoRoot: string): ToolFinding[] {
  const findings: ToolFinding[] = [];
  for (const raw of output.split("\n")) {
    const line = raw.trimEnd();
    const m = DIAG_RE.exec(line);
    if (!m) continue;
    const [, fileRaw, lineStr, colStr, sevRaw, code, message] = m;
    if (!fileRaw || !lineStr || !colStr || !sevRaw || !code || !message) continue;
    const absFile = isAbsolute(fileRaw) ? fileRaw : resolve(repoRoot, fileRaw);
    const file = relative(repoRoot, absFile);
    const severity = sevRaw === "error" ? "error" : sevRaw === "warning" ? "warning" : "info";
    findings.push({
      source: "tsc",
      file,
      line: Number.parseInt(lineStr, 10),
      column: Number.parseInt(colStr, 10),
      severity,
      ruleId: code,
      message,
    });
  }
  return findings;
}

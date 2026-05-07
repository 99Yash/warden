import { spawn } from "node:child_process";
import type { ExportRef } from "../parser.js";
import type { Evidence } from "../index.js";

/**
 * Symbol-references signal (ADR-0018). For each exported symbol in a changed
 * file, find candidate files that reference it via `git grep -wn`. Word-
 * boundary fixed-string match — fast and good-enough for v1.
 *
 * False positives (symbol appearing in a comment or string literal) only
 * demote the candidate slightly via score, never surface as a finding —
 * AST-verified upgrade deferred to M6 if dogfooding shows precision is too
 * low. (ADR-0018 alternatives.)
 */

export interface SymbolRefHit {
  candidate: string;
  symbol: string;
  evidence: Evidence[];
}

const COMMON_SYMBOL_BLOCKLIST = new Set([
  "default",
  "index",
  "main",
  "type",
  "value",
  "key",
  "data",
  "id",
  "name",
  "props",
  "state",
]);

export async function collectSymbolRefHits(
  repoRoot: string,
  changedRelExports: Map<string, ExportRef[]>,
  changedRelSet: Set<string>,
): Promise<SymbolRefHit[]> {
  const symbols = new Set<string>();
  for (const exports of changedRelExports.values()) {
    for (const exp of exports) {
      if (exp.symbol.length < 3) continue;
      if (COMMON_SYMBOL_BLOCKLIST.has(exp.symbol)) continue;
      symbols.add(exp.symbol);
    }
  }
  if (symbols.size === 0) return [];

  const hits: SymbolRefHit[] = [];
  for (const symbol of symbols) {
    const matches = await gitGrep(repoRoot, symbol);
    const byCandidate = new Map<string, Evidence[]>();
    for (const m of matches) {
      if (changedRelSet.has(m.path)) continue; // exclude changed files themselves
      let bucket = byCandidate.get(m.path);
      if (!bucket) {
        bucket = [];
        byCandidate.set(m.path, bucket);
      }
      bucket.push({ startLine: m.line, endLine: m.line });
    }
    for (const [candidate, evidence] of byCandidate) {
      hits.push({ candidate, symbol, evidence: mergeAdjacent(evidence) });
    }
  }
  return hits;
}

interface GrepMatch {
  path: string;
  line: number;
}

const SOURCE_GLOBS = ["*.ts", "*.tsx", "*.js", "*.jsx", "*.mjs", "*.cjs"];

function gitGrep(repoRoot: string, symbol: string): Promise<GrepMatch[]> {
  return new Promise((resolveP) => {
    const child = spawn(
      "git",
      ["grep", "-wn", "-F", "--", symbol, ...SOURCE_GLOBS],
      { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.on("error", () => resolveP([]));
    child.on("close", () => {
      const matches: GrepMatch[] = [];
      for (const raw of stdout.split("\n")) {
        if (!raw) continue;
        // Format: path:line:content
        const firstColon = raw.indexOf(":");
        if (firstColon === -1) continue;
        const secondColon = raw.indexOf(":", firstColon + 1);
        if (secondColon === -1) continue;
        const path = raw.slice(0, firstColon);
        const lineStr = raw.slice(firstColon + 1, secondColon);
        const line = Number.parseInt(lineStr, 10);
        if (!Number.isFinite(line)) continue;
        matches.push({ path, line });
      }
      resolveP(matches);
    });
  });
}

function mergeAdjacent(evidence: Evidence[]): Evidence[] {
  if (evidence.length === 0) return evidence;
  const sorted = [...evidence].sort((a, b) => a.startLine - b.startLine);
  const merged: Evidence[] = [];
  for (const e of sorted) {
    const last = merged[merged.length - 1];
    if (last && e.startLine <= last.endLine + 1) {
      last.endLine = Math.max(last.endLine, e.endLine);
    } else {
      merged.push({ ...e });
    }
  }
  return merged;
}

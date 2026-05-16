import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { createInterface } from "node:readline";
import { tool } from "@warden/ai";
import { z } from "zod";
import { isInSkipDir, isSensitivePath } from "./safety.js";

/**
 * M14 (ADR-0030): `grepRepo` tool exposed to review-harness workers.
 *
 * Literal-substring search across the repo. Pattern is taken as-is (no
 * regex escaping needed — the pattern itself is the literal). Results are
 * capped at `MAX_TOTAL_MATCHES` (200); per-file matches capped at
 * `MAX_PER_FILE` so a single very-repetitive file can't exhaust the
 * budget. The cap is the boss's "give up and try a different worker"
 * signal — workers should narrow patterns when truncation appears.
 *
 * File set is sourced from `git ls-files` so `.gitignore` is honored
 * automatically. Falls back to a manual walk with `SKIP_DIRS` when git is
 * unavailable. Either way, secret-deny paths are excluded.
 *
 * Why not ripgrep? Per ADR-0030 §Tools the plan permits either path. v0
 * uses the Node walker for determinism + zero new system dependencies;
 * ripgrep is a future optimization once dogfood shows the Node walker is
 * the latency bottleneck.
 */

const MAX_TOTAL_MATCHES = 200;
const MAX_PER_FILE = 5;
const MAX_SNIPPET_CHARS = 300;
/** Hard line cap per file so a minified bundle can't eat the call. */
const MAX_LINES_PER_FILE = 50_000;
/** Hard byte cap per file at read time (sniffed via size or by truncation). */
const MAX_BYTES_PER_FILE = 2_000_000;

const InputSchema = z.object({
  pattern: z
    .string()
    .min(2)
    .max(200)
    .describe(
      "Literal substring to search for. Case-sensitive. No regex — pass the " +
        "exact characters you want to find. Use a distinctive identifier or " +
        "string literal to avoid burning the 200-result cap on common tokens.",
    ),
});

export interface GrepMatch {
  /** Repo-relative POSIX path. */
  path: string;
  /** 1-indexed line number. */
  line: number;
  /** The matching line, trimmed and snippet-capped. */
  snippet: string;
}

export type GrepRepoResult =
  | {
      ok: true;
      matches: GrepMatch[];
      truncated: boolean;
    }
  | {
      ok: false;
      reason: "empty_pattern" | "list_failed" | "error";
      detail?: string;
    };

export interface MakeGrepRepoToolOptions {
  repoRoot: string;
}

export function makeGrepRepoTool(opts: MakeGrepRepoToolOptions) {
  return tool({
    description: [
      "Search the repo for a literal substring. Returns up to 200 matches",
      "(line + path + snippet). Honors .gitignore via `git ls-files`; skips",
      "secret files (.env, *.pem, etc.) and common build dirs. Use this",
      "BEFORE readFile to narrow which file is worth reading in full. If",
      "the result is truncated, your pattern is too broad — refine to a",
      "more specific identifier or literal.",
    ].join(" "),
    inputSchema: InputSchema,
    execute: async (args: z.infer<typeof InputSchema>): Promise<GrepRepoResult> => {
      const pattern = args.pattern;
      if (pattern.length === 0) {
        return { ok: false, reason: "empty_pattern" };
      }

      let files: string[];
      try {
        files = await listFiles(opts.repoRoot);
      } catch (err) {
        return { ok: false, reason: "list_failed", detail: formatErr(err) };
      }

      const matches: GrepMatch[] = [];
      let truncated = false;

      for (const rel of files) {
        if (matches.length >= MAX_TOTAL_MATCHES) {
          truncated = true;
          break;
        }
        const normalized = rel.replace(/\\/g, "/");
        if (isSensitivePath(normalized)) continue;
        if (isInSkipDir(normalized)) continue;

        const fileMatches = await grepFile(
          resolvePath(opts.repoRoot, rel),
          normalized,
          pattern,
          MAX_TOTAL_MATCHES - matches.length,
        );
        for (const m of fileMatches) {
          matches.push(m);
          if (matches.length >= MAX_TOTAL_MATCHES) break;
        }
      }

      return { ok: true, matches, truncated };
    },
  });
}

async function listFiles(repoRoot: string): Promise<string[]> {
  try {
    return await gitListFiles(repoRoot);
  } catch {
    return manualWalk(repoRoot);
  }
}

function gitListFiles(repoRoot: string): Promise<string[]> {
  return new Promise((resolveP, rejectP) => {
    const child = spawn("git", ["ls-files"], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.on("error", (err) => rejectP(err));
    child.on("close", (code) => {
      if (code !== 0) {
        rejectP(new Error(`git ls-files exited ${code ?? "?"}`));
        return;
      }
      resolveP(
        stdout
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l.length > 0),
      );
    });
  });
}

async function manualWalk(repoRoot: string): Promise<string[]> {
  // Local-scoped to avoid leaking init/walk.ts internals; uses the same
  // SKIP_DIRS via the safety helper so a future change in skip semantics
  // updates both.
  const { readdir } = await import("node:fs/promises");
  const out: string[] = [];
  const stack: Array<{ relDir: string }> = [{ relDir: "" }];
  while (stack.length > 0) {
    const item = stack.pop();
    if (!item) break;
    const absDir = resolvePath(repoRoot, item.relDir);
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try {
      entries = await readdir(absDir, { withFileTypes: true, encoding: "utf8" });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const name = entry.name;
      const childRel = item.relDir ? `${item.relDir}/${name}` : name;
      if (isInSkipDir(childRel)) continue;
      if (entry.isDirectory()) {
        stack.push({ relDir: childRel });
      } else if (entry.isFile()) {
        out.push(childRel);
      }
    }
  }
  return out;
}

async function grepFile(
  abs: string,
  relForReport: string,
  pattern: string,
  remainingBudget: number,
): Promise<GrepMatch[]> {
  const matches: GrepMatch[] = [];
  let lineNo = 0;
  let bytesSeen = 0;
  try {
    const stream = createReadStream(abs, { encoding: "utf8" });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of rl) {
        lineNo += 1;
        bytesSeen += line.length + 1;
        if (lineNo > MAX_LINES_PER_FILE || bytesSeen > MAX_BYTES_PER_FILE) {
          rl.close();
          stream.destroy();
          break;
        }
        if (!line.includes(pattern)) continue;
        matches.push({
          path: relForReport,
          line: lineNo,
          snippet: trimSnippet(line),
        });
        if (matches.length >= MAX_PER_FILE) {
          rl.close();
          stream.destroy();
          break;
        }
        if (matches.length >= remainingBudget) {
          rl.close();
          stream.destroy();
          break;
        }
      }
    } finally {
      rl.close();
      stream.destroy();
    }
  } catch {
    // Unreadable file — silently skip rather than failing the whole call.
    return matches;
  }
  return matches;
}

function trimSnippet(line: string): string {
  const trimmed = line.trim();
  if (trimmed.length <= MAX_SNIPPET_CHARS) return trimmed;
  return trimmed.slice(0, MAX_SNIPPET_CHARS) + "…";
}

function formatErr(err: unknown): string {
  if (err instanceof Error) return err.message.slice(0, 160);
  return String(err).slice(0, 160);
}

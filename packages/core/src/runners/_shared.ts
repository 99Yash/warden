import { spawn, type SpawnOptions } from "node:child_process";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve as resolvePath } from "node:path";
import ts from "typescript";
import type { ChangedFile } from "../diff/index.js";
import type { DegradedEntry } from "../schema.js";

export const SOURCE_EXT_RE = /\.(?:tsx?|jsx?|mjs|cjs)$/;

export type SpawnCaptureResult =
  | { ok: true; stdout: string; stderr: string; exitCode: number | null }
  | { ok: false; error: NodeJS.ErrnoException };

/**
 * Spawn a subprocess, accumulate stdout/stderr, and resolve with a discriminated
 * result. Each runner formats its own degraded message — the shared helper only
 * unifies the boilerplate (pipes, env, on-error vs on-close branching).
 */
export function spawnCapture(
  cmd: string,
  args: string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<SpawnCaptureResult> {
  const spawnOpts: SpawnOptions = {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
  };
  return new Promise((resolveP) => {
    const child = spawn(cmd, args, spawnOpts);
    let stdout = "";
    let stderr = "";
    let settled = false;
    const settle = (result: SpawnCaptureResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolveP(result);
    };
    // ADR-0046: an optional wall-clock cap. The react-doctor det-prior passes
    // 60s so a hung `npx` fetch can't stall the whole review; killing the
    // child surfaces a synthetic ETIMEDOUT the caller degrades on. Callers
    // that omit `timeoutMs` keep the original unbounded behavior.
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          child.kill("SIGKILL");
          const error: NodeJS.ErrnoException = new Error(
            `spawn ${cmd}: timed out after ${opts.timeoutMs}ms`,
          );
          error.code = "ETIMEDOUT";
          settle({ ok: false, error });
        }, opts.timeoutMs)
      : undefined;
    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      settle({ ok: false, error });
    });
    child.on("close", (exitCode) => {
      settle({ ok: true, stdout, stderr, exitCode });
    });
  });
}

export function formatErr(err: unknown): string {
  if (err instanceof Error) return err.message.slice(0, 120);
  return String(err).slice(0, 120);
}

export function anyAddedInRange(
  start: number,
  end: number,
  addedLines: Set<number>,
): boolean {
  if (addedLines.size === 0) return false;
  for (let i = start; i <= end; i++) {
    if (addedLines.has(i)) return true;
  }
  return false;
}

export interface ParsedChangedFile {
  cf: ChangedFile;
  abs: string;
  sf: ts.SourceFile;
  addedLines: Set<number>;
}

export type ParseChangedFileResult =
  | { kind: "ok"; parsed: ParsedChangedFile }
  | { kind: "skip" }
  | { kind: "degraded"; entry: DegradedEntry };

/**
 * Read + parse a single ChangedFile as a TypeScript SourceFile. Returns
 * `"skip"` for non-source extensions or unreadable files; returns
 * `"degraded"` when `ts.createSourceFile` throws so the caller can surface
 * a per-topic warning.
 */
export async function parseChangedSourceFile(
  repoRoot: string,
  cf: ChangedFile,
  topic: string,
): Promise<ParseChangedFileResult> {
  if (!SOURCE_EXT_RE.test(cf.path)) return { kind: "skip" };
  const abs = isAbsolute(cf.path) ? cf.path : resolvePath(repoRoot, cf.path);
  let content: string;
  try {
    content = await readFile(abs, "utf8");
  } catch {
    return { kind: "skip" };
  }
  let sf: ts.SourceFile;
  try {
    sf = ts.createSourceFile(abs, content, ts.ScriptTarget.Latest, true);
  } catch (err) {
    return {
      kind: "degraded",
      entry: {
        kind: "warning",
        topic,
        message: `${topic}: failed to parse ${cf.path} (${formatErr(err)})`,
      },
    };
  }
  return {
    kind: "ok",
    parsed: { cf, abs, sf, addedLines: new Set(cf.addedLines) },
  };
}

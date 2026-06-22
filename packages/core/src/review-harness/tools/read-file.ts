import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { tool } from "@warden/ai";
import { z } from "zod";
import { isGitIgnored, isInSkipDir, isSensitivePath, resolveWithinRoot } from "./safety.js";

/**
 * M14 (ADR-0030): `readFile` tool exposed to review-harness workers.
 *
 * Workers use this to read a file the boss scoped them to. The tool is
 * deliberately repo-scoped — it cannot read outside `repoRoot`, cannot
 * return secret-file contents (.env, *.pem, id_rsa, etc.), and skips
 * gitignored paths so a worker can't be tricked into exfiltrating build
 * artifacts or local-only configs.
 *
 * Output is a bounded window of at most `WINDOW_CAP` lines (default 1000).
 * Reading is paginated: `offset` (1-based start line) + `limit` (window
 * size) let a worker walk a large file in fixed-size windows instead of
 * only ever seeing its head. When more lines follow the returned window the
 * result carries `truncated: true` and a marker naming the exact next
 * `offset` to continue from — earlier this just said "grepRepo then readFile
 * again", but the second call had the same head-only cap, so lines past 1000
 * were unreachable. `grepRepo` is still the right move to *locate* a region;
 * `offset` is how you then *read through* it.
 *
 * Return shape is a discriminated union; errors do NOT throw. The boss
 * receives `{ ok: false, reason }` and can route a different worker. This
 * mirrors the M11 `lookupTypeDef` shape and keeps the streamText tool-use
 * loop deterministic.
 */

const WINDOW_CAP = 1000;

const InputSchema = z.object({
  path: z
    .string()
    .min(1)
    .describe(
      "Repo-relative POSIX path to the file. Absolute paths are accepted iff they " +
        "resolve inside the repo root; any path that escapes the root via .. is " +
        "rejected. Examples: 'packages/core/src/schema.ts', 'README.md'.",
    ),
  offset: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      "1-based line number to start reading from. Default 1 (top of file). " +
        "When a previous read returned `truncated: true`, pass its `nextOffset` " +
        "here to continue through a large file.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(WINDOW_CAP)
    .optional()
    .describe(
      `Max lines to return in this window (1-${WINDOW_CAP}, default ${WINDOW_CAP}). ` +
        "Smaller windows keep context lean when you only need a known span.",
    ),
});

export type ReadFileResult =
  | {
      ok: true;
      path: string;
      content: string;
      /** 1-based line number of the first returned line. */
      startLine: number;
      /** 1-based line number of the last returned line (startLine-1 if empty). */
      endLine: number;
      /** Number of lines in this window. */
      lineCount: number;
      /** True when more lines follow `endLine`. */
      truncated: boolean;
      /** When `truncated`, the `offset` to pass next to continue. */
      nextOffset?: number;
    }
  | {
      ok: false;
      reason: "outside_root" | "sensitive_path" | "gitignored" | "not_found" | "read_error";
      path: string;
      detail?: string;
    };

export interface MakeReadFileToolOptions {
  repoRoot: string;
}

export function makeReadFileTool(opts: MakeReadFileToolOptions) {
  return tool({
    description: [
      "Read a file from the repo by relative path. Returns a window of up to",
      "1000 lines starting at `offset` (default line 1). If more lines follow,",
      "the result has `truncated: true` and a `nextOffset` — call again with",
      "`offset: nextOffset` to page through a large file (logs, long modules).",
      "Secret files (.env, *.pem, id_rsa, *.key), files outside the repo root,",
      "and gitignored files are rejected with a structured reason — use",
      "the reason to decide whether to back off or pick a different path.",
      "Use BEFORE asserting facts about code in a file you weren't scoped",
      "to; copy only verified snippets into your findings.",
    ].join(" "),
    inputSchema: InputSchema,
    execute: async (args: z.infer<typeof InputSchema>): Promise<ReadFileResult> => {
      const abs = resolveWithinRoot(opts.repoRoot, args.path);
      if (abs === null) {
        return { ok: false, reason: "outside_root", path: args.path };
      }

      // Normalize the repo-relative form for sensitivity checks. We compare
      // against the original input (POSIX-style), not the resolved absolute
      // path — sensitivity patterns are repo-relative by design.
      const relForChecks = args.path.replace(/^\.\//, "").replace(/\\/g, "/");

      if (isSensitivePath(relForChecks)) {
        return { ok: false, reason: "sensitive_path", path: relForChecks };
      }

      if (isInSkipDir(relForChecks)) {
        return { ok: false, reason: "gitignored", path: relForChecks };
      }

      if (await isGitIgnored(opts.repoRoot, relForChecks)) {
        return { ok: false, reason: "gitignored", path: relForChecks };
      }

      const offset = args.offset ?? 1;
      const limit = args.limit ?? WINDOW_CAP;
      return readBounded(abs, relForChecks, offset, limit);
    },
  });
}

async function readBounded(
  abs: string,
  relForReport: string,
  offset: number,
  limit: number,
): Promise<ReadFileResult> {
  const window = Math.min(limit, WINDOW_CAP);
  const lines: string[] = [];
  let lineNo = 0; // 1-based number of the last line seen
  let truncated = false;
  let opened = false;
  try {
    const stream = createReadStream(abs, { encoding: "utf8" });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of rl) {
        opened = true;
        lineNo += 1;
        if (lineNo < offset) continue; // skip to the requested window
        if (lines.length >= window) {
          // We've filled the window and there's at least one more line.
          truncated = true;
          rl.close();
          stream.destroy();
          break;
        }
        lines.push(line);
      }
    } finally {
      rl.close();
      stream.destroy();
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT" || code === "EISDIR") {
      return { ok: false, reason: "not_found", path: relForReport };
    }
    return {
      ok: false,
      reason: "read_error",
      path: relForReport,
      detail: formatErr(err),
    };
  }

  // Distinguish "not_found" from "empty file" — a stream that never emitted
  // a line + no error means an empty file (ok: true, content: "").
  if (!opened && lines.length === 0) {
    return {
      ok: true,
      path: relForReport,
      content: "",
      startLine: offset,
      endLine: offset - 1,
      lineCount: 0,
      truncated: false,
    };
  }

  const startLine = offset;
  const endLine = offset + lines.length - 1;
  const nextOffset = endLine + 1;
  const marker = `[lines ${startLine}–${endLine} of ${relForReport}; more follow — call readFile with offset: ${nextOffset} to continue]`;
  const content = truncated ? lines.join("\n") + "\n" + marker : lines.join("\n");
  return {
    ok: true,
    path: relForReport,
    content,
    startLine,
    endLine,
    lineCount: lines.length,
    truncated,
    ...(truncated ? { nextOffset } : {}),
  };
}

function formatErr(err: unknown): string {
  if (err instanceof Error) return err.message.slice(0, 160);
  return String(err).slice(0, 160);
}

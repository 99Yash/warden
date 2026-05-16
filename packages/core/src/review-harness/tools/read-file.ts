import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { tool } from "@warden/ai";
import { z } from "zod";
import {
  isGitIgnored,
  isInSkipDir,
  isSensitivePath,
  resolveWithinRoot,
} from "./safety.js";

/**
 * M14 (ADR-0030): `readFile` tool exposed to review-harness workers.
 *
 * Workers use this to read a file the boss scoped them to. The tool is
 * deliberately repo-scoped — it cannot read outside `repoRoot`, cannot
 * return secret-file contents (.env, *.pem, id_rsa, etc.), and skips
 * gitignored paths so a worker can't be tricked into exfiltrating build
 * artifacts or local-only configs.
 *
 * Output is capped at `LINE_CAP` lines (default 1000) with a truncation
 * marker the worker can react to ("file longer than 1000 lines —
 * `readFile` truncated"). Workers needing more should call `grepRepo` to
 * narrow first, then `readFile` on the same path; the cap is the same on
 * the second call. v0 has no offset/length pagination — keeping the
 * surface narrow per ADR-0030 §Tools.
 *
 * Return shape is a discriminated union; errors do NOT throw. The boss
 * receives `{ ok: false, reason }` and can route a different worker. This
 * mirrors the M11 `lookupTypeDef` shape and keeps the streamText tool-use
 * loop deterministic.
 */

const LINE_CAP = 1000;
const TRUNCATION_MARKER =
  "[truncated at 1000 lines — call grepRepo to narrow then readFile again]";

const InputSchema = z.object({
  path: z
    .string()
    .min(1)
    .describe(
      "Repo-relative POSIX path to the file. Absolute paths are accepted iff they " +
        "resolve inside the repo root; any path that escapes the root via .. is " +
        "rejected. Examples: 'packages/core/src/schema.ts', 'README.md'.",
    ),
});

export type ReadFileResult =
  | {
      ok: true;
      path: string;
      content: string;
      lineCount: number;
      truncated: boolean;
    }
  | {
      ok: false;
      reason:
        | "outside_root"
        | "sensitive_path"
        | "gitignored"
        | "not_found"
        | "read_error";
      path: string;
      detail?: string;
    };

export interface MakeReadFileToolOptions {
  repoRoot: string;
}

export function makeReadFileTool(opts: MakeReadFileToolOptions) {
  return tool({
    description: [
      "Read a file from the repo by relative path. Returns up to 1000 lines",
      "of content with a truncation marker if the file is longer. Secret",
      "files (.env, *.pem, id_rsa, *.key), files outside the repo root,",
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

      return readBounded(abs, relForChecks);
    },
  });
}

async function readBounded(abs: string, relForReport: string): Promise<ReadFileResult> {
  const lines: string[] = [];
  let truncated = false;
  let opened = false;
  try {
    const stream = createReadStream(abs, { encoding: "utf8" });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of rl) {
        opened = true;
        if (lines.length >= LINE_CAP) {
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
    // Re-stat would tell us empty vs missing; cheaper to attempt the read
    // a second time only if needed. For v0 we assume the open succeeded
    // (no throw from createReadStream above) and the file was empty.
    return { ok: true, path: relForReport, content: "", lineCount: 0, truncated: false };
  }

  const content = truncated
    ? lines.join("\n") + "\n" + TRUNCATION_MARKER
    : lines.join("\n");
  return {
    ok: true,
    path: relForReport,
    content,
    lineCount: lines.length,
    truncated,
  };
}

function formatErr(err: unknown): string {
  if (err instanceof Error) return err.message.slice(0, 160);
  return String(err).slice(0, 160);
}

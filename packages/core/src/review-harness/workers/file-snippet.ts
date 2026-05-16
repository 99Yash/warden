import { open } from "node:fs/promises";
import type { ChangedFile } from "../../diff/index.js";
import {
  isSensitivePath,
  resolveWithinRoot,
} from "../tools/safety.js";

/**
 * Renders a diff-scoped snippet for a single ChangedFile, mirroring the
 * shape M12/M13 sub-agents used: each added-line window is shown with
 * `CONTEXT_LINES` of surrounding context, line-number-prefixed, capped at
 * `SNIPPET_LINE_CAP` total lines. The worker can still call `readFile` for
 * more — but for ~80% of dispatched files this snippet is enough to
 * reason about the diff without a tool round-trip.
 *
 * Defers to the same path-safety constants the worker tools enforce —
 * sensitive files are surfaced as a placeholder ("[sensitive path —
 * content withheld]") so the worker knows the file exists but doesn't
 * receive its contents.
 */

const SNIPPET_LINE_CAP = 24;
const CONTEXT_LINES = 2;
const MAX_READ_BYTES = 32_768;
const BINARY_SNIFF_BYTES = 2048;

export interface FileSnippet {
  path: string;
  sizeBytes: number;
  snippet: string;
  binary: boolean;
}

export async function buildFileSnippet(
  repoRoot: string,
  cf: ChangedFile,
): Promise<FileSnippet | null> {
  const abs = resolveWithinRoot(repoRoot, cf.path);
  if (abs === null) return null;

  if (isSensitivePath(cf.path)) {
    return {
      path: cf.path,
      sizeBytes: -1,
      snippet: "[sensitive path — content withheld]",
      binary: false,
    };
  }

  const handle = await open(abs, "r");
  try {
    const stats = await handle.stat();
    const sizeBytes = stats.size;
    const readBytes = Math.min(MAX_READ_BYTES, sizeBytes);
    const buf = Buffer.alloc(readBytes);
    if (readBytes > 0) await handle.read(buf, 0, readBytes, 0);
    const sniff = buf.subarray(0, Math.min(BINARY_SNIFF_BYTES, readBytes));
    if (sniff.includes(0)) {
      return {
        path: cf.path,
        sizeBytes,
        snippet: `[binary; size=${sizeBytes}B]`,
        binary: true,
      };
    }
    const text = buf.toString("utf8");
    const truncated = readBytes < sizeBytes;
    const snippet = renderSnippet(text, cf.addedLines, truncated, sizeBytes);
    return {
      path: cf.path,
      sizeBytes,
      snippet,
      binary: false,
    };
  } finally {
    await handle.close();
  }
}

function renderSnippet(
  fullText: string,
  addedLines: number[],
  truncated: boolean,
  fileSize: number,
): string {
  if (addedLines.length === 0) {
    return "[deletion-only diff — no added lines to inspect]";
  }
  const allLines = fullText.split("\n");
  const sorted = [...addedLines].sort((a, b) => a - b);
  const windows: Array<{ start: number; end: number }> = [];
  for (const ln of sorted) {
    const start = Math.max(1, ln - CONTEXT_LINES);
    const end = ln + CONTEXT_LINES;
    const last = windows[windows.length - 1];
    if (last && start <= last.end + 1) {
      last.end = Math.max(last.end, end);
    } else {
      windows.push({ start, end });
    }
  }
  const out: string[] = [];
  let lineCount = 0;
  let reachedTruncation = false;
  for (const w of windows) {
    if (lineCount >= SNIPPET_LINE_CAP) break;
    if (out.length > 0) out.push("...");
    for (let i = w.start; i <= w.end && lineCount < SNIPPET_LINE_CAP; i++) {
      const line = allLines[i - 1];
      if (line === undefined) {
        if (truncated) reachedTruncation = true;
        break;
      }
      out.push(`${i}: ${line}`);
      lineCount++;
    }
  }
  if (reachedTruncation || (truncated && lineCount >= SNIPPET_LINE_CAP)) {
    out.push(`... [truncated; file > ${MAX_READ_BYTES}B (size=${fileSize}B)]`);
  }
  return out.join("\n");
}

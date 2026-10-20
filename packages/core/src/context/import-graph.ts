import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { and, db, eq, importGraph } from "@warden/db";
import { z } from "zod";
import { errnoCode } from "../guards.js";
import { sha256Hex } from "../hash.js";
import { plural } from "../plural.js";
import type { DegradedEntry } from "../schema.js";
import type { ExportRef, ImportRef, SourceParser } from "./parser.js";
import type { Graph, GraphEntry } from "./signals/imports.js";

/**
 * Active import graph for the working tree being reviewed (ADR-0018, issue
 * #62). Read by the context selector and the deadcode detector. Inside
 * `runDetPriors` they share one load, so both read the same snapshot (see
 * `ImportGraphLoader`). Called without the shared loader, each one loads the
 * graph on its own.
 *
 * Source identity is established per load, never remembered: every tracked
 * source file is read and hashed from disk, and its `import_graph` row is
 * looked up only by `(path, that hash)`. A clean `git status` is not evidence that
 * a previously stored hash is current — a commit, checkout, or reset changes
 * content without leaving the file "modified". Hashing every file costs about
 * as much as asking git's index (~0.3s on a 10k-file repo). The parse stays
 * cached per `(path, sha)`. On a warm cache, import resolution is the main
 * cost (~2.0s on a 10k-file repo).
 *
 * The loader trusts only what the file's own bytes determine. A row also
 * stores `ImportRef.resolved` from the parse, but that target depends on other
 * files (a new `b.ts` shadows `b/index.ts`, a target moves to `.tsx`) and on
 * tsconfig. So it is re-resolved against today's tree on every load, and the
 * stored value is never used.
 *
 * Rows for other snapshots stay in `import_graph` but never become active:
 * the graph contains only paths in today's `git ls-files`, each bound to the
 * hash of the bytes read today. Files that cannot be read are reported by path
 * and left out of the graph rather than falling back to an older row.
 *
 * A tracked path that is missing on disk (ENOENT) is not always a deletion.
 * Git classifies it: an unstaged deletion is left out silently; a
 * skip-worktree entry outside a sparse checkout is counted, because the graph
 * is then incomplete; anything git still sees as present (a dangling symlink)
 * is unreadable.
 */

const BATCH_SIZE = 20;
const SOURCE_EXT_RE = /\.(?:tsx?|jsx?|mjs|cjs)$/;
const MAX_LISTED_PATHS = 10;
const MAX_STDERR_CHARS = 2000;

export interface ImportGraphSnapshot {
  /**
   * Repo-relative source files present in the snapshot (tracked and on disk),
   * in `git ls-files` order.
   */
  files: string[];
  /**
   * Absolute path → parsed entry, for every snapshot file that parsed.
   * Iterates in `git ls-files` order on every load.
   */
  graph: Graph;
  /** Parse-cache counters for this load. */
  stats: { reused: number; parsed: number; parseErrors: number };
  /** Repo-relative paths that could not be read or hashed; excluded from `graph`. */
  unreadable: string[];
  /**
   * Repo-relative tracked paths absent on disk because they are outside the
   * sparse checkout (skip-worktree); excluded from `graph`.
   */
  outsideSparse: string[];
  degraded: DegradedEntry[];
}

/**
 * Returns one review's snapshot. `runDetPriors` passes the same memoized
 * loader to the context selector and the deadcode detector, so a review loads
 * the graph at most once, with one parser, and both read the same tree.
 */
export type ImportGraphLoader = () => Promise<ImportGraphSnapshot>;

export async function loadImportGraph(input: {
  repoRoot: string;
  parser: SourceParser;
  /** Topic + message prefix for degraded entries (`context`, `deadcode`). */
  topic: string;
}): Promise<ImportGraphSnapshot> {
  const { repoRoot, parser, topic } = input;
  const tracked = (await gitLsFiles(repoRoot, [])).filter((f) => SOURCE_EXT_RE.test(f));

  const stats = { reused: 0, parsed: 0, parseErrors: 0 };
  // Results land by `tracked` index, not by read completion, so `files`,
  // `unreadable`, and the graph share one order (git's byte order) on every
  // load of the same tree. Consumers (the deadcode example callsite, the
  // selector's reason order and same-folder cap) depend on it.
  const status: ("read" | "unreadable" | "absent" | undefined)[] = [];
  const entries: (GraphEntry | undefined)[] = [];

  await runInBatches(tracked, BATCH_SIZE, async (path, index) => {
    const abs = resolvePath(repoRoot, path);
    let bytes: Buffer;
    try {
      bytes = await readFile(abs);
    } catch (err) {
      // A missing path is classified below; any other error is a read failure.
      status[index] = errnoCode(err) === "ENOENT" ? "absent" : "unreadable";
      return;
    }
    status[index] = "read";
    const sha = sha256Hex(bytes);

    const cached = readImportGraphRow(path, sha);
    if (cached) {
      stats.reused++;
      entries[index] = {
        // Drop the stored `resolved` so a target that no longer resolves
        // stays absent instead of inheriting the parse-time value.
        imports: cached.imports.map(({ resolved: _stored, ...imp }) => {
          const resolved = parser.resolve(imp.module, abs);
          return resolved !== undefined ? { ...imp, resolved } : imp;
        }),
        exports: cached.exports,
      };
      return;
    }
    // Parse the same bytes that were hashed, so the stored row can never pair
    // one version's hash with another version's imports.
    try {
      const content = bytes.toString("utf8");
      const [imports, exports] = await Promise.all([
        parser.imports(abs, content),
        parser.exports(abs, content),
      ]);
      insertImportGraphRow(path, sha, imports, exports);
      entries[index] = { imports, exports };
      stats.parsed++;
    } catch {
      stats.parseErrors++;
    }
  });

  // Ask git about missing paths only when a read missed, so a full working
  // tree spends no extra spawn. `-t` tags each path: `R` is an unstaged
  // deletion, `S` is skip-worktree. Git lists neither a skip-worktree entry
  // nor a dangling symlink under `-d`.
  const deleted = new Set<string>();
  const skipWorktree = new Set<string>();
  if (status.includes("absent")) {
    for (const record of await gitLsFiles(repoRoot, ["-t", "-c", "-d"])) {
      const tag = record.slice(0, 2);
      if (tag === "R ") deleted.add(record.slice(2));
      else if (tag === "S ") skipWorktree.add(record.slice(2));
    }
  }

  const files: string[] = [];
  const unreadable: string[] = [];
  const outsideSparse: string[] = [];
  const graph: Graph = new Map();
  for (const [i, path] of tracked.entries()) {
    if (status[i] === "read") files.push(path);
    else if (status[i] === "unreadable") unreadable.push(path);
    else if (status[i] === "absent" && !deleted.has(path)) {
      (skipWorktree.has(path) ? outsideSparse : unreadable).push(path);
    }
    const entry = entries[i];
    if (entry) graph.set(resolvePath(repoRoot, path), entry);
  }

  const degraded: DegradedEntry[] = [];
  if (stats.parsed > 0 && stats.reused === 0) {
    degraded.push({
      kind: "info",
      topic,
      message: `${topic}: cold import-graph build (parsed ${plural(stats.parsed, "file", "files")})`,
    });
  }
  if (stats.parseErrors > 0) {
    degraded.push({
      kind: "info",
      topic,
      message: `${topic}: ${plural(stats.parseErrors, "file", "files")} failed to parse`,
    });
  }
  if (outsideSparse.length > 0) {
    degraded.push({
      kind: "info",
      topic,
      message: `${topic}: ${plural(outsideSparse.length, "tracked source file", "tracked source files")} outside the sparse checkout; left out of the import graph`,
    });
  }
  if (unreadable.length > 0) {
    const listed = unreadable.slice(0, MAX_LISTED_PATHS).join(", ");
    const more =
      unreadable.length > MAX_LISTED_PATHS
        ? ` and ${unreadable.length - MAX_LISTED_PATHS} more`
        : "";
    degraded.push({
      kind: "warning",
      topic,
      message: `${topic}: could not read ${plural(unreadable.length, "source file", "source files")}; left out of the import graph: ${listed}${more}`,
    });
  }

  return { files, graph, stats, unreadable, outsideSparse, degraded };
}

/** Runs `git ls-files -z <args>` and returns the NUL-separated records. */
function gitLsFiles(repoRoot: string, args: string[]): Promise<string[]> {
  return new Promise((resolveP, rejectP) => {
    const child = spawn("git", ["ls-files", "-z", ...args], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    // Decode once at the end: a multi-byte character split across two chunks
    // would turn into U+FFFD if each chunk were decoded on its own, and the
    // corrupted path would then read as deleted.
    const chunks: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => {
      chunks.push(d);
    });
    // Drain stderr so a noisy git cannot block on a full pipe; keep the tail
    // for the error message.
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d: string) => {
      stderr = (stderr + d).slice(-MAX_STDERR_CHARS);
    });
    child.on("error", (err) => rejectP(err));
    child.on("close", (code) => {
      if (code !== 0) {
        const reason = stderr.trim();
        rejectP(new Error(`git ls-files exited ${code ?? "?"}${reason ? `: ${reason}` : ""}`));
        return;
      }
      const stdout = Buffer.concat(chunks).toString("utf8");
      resolveP(stdout.split("\0").filter((l) => l.length > 0));
    });
  });
}

async function runInBatches<T>(
  items: T[],
  batchSize: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  for (let i = 0; i < items.length; i += batchSize) {
    const slice = items.slice(i, i + batchSize);
    await Promise.all(slice.map((item, j) => fn(item, i + j)));
  }
}

function readImportGraphRow(
  filePath: string,
  fileSha: string,
): { imports: ImportRef[]; exports: ExportRef[] } | undefined {
  const row = db()
    .select({
      importsJson: importGraph.importsJson,
      exportsJson: importGraph.exportsJson,
    })
    .from(importGraph)
    .where(and(eq(importGraph.filePath, filePath), eq(importGraph.fileSha, fileSha)))
    .get();
  if (!row) return undefined;
  try {
    // A row that does not match the parser's shape is a cache miss: the
    // caller parses the source again and rewrites the row.
    const imports = z.array(ImportRefSchema).safeParse(JSON.parse(row.importsJson));
    const exports = z.array(ExportRefSchema).safeParse(JSON.parse(row.exportsJson));
    if (!imports.success || !exports.success) return undefined;
    return { imports: imports.data, exports: exports.data };
  } catch {
    return undefined;
  }
}

const ImportRefSchema = z.object({
  module: z.string(),
  resolved: z.string().exactOptional(),
  kind: z.enum(["value", "type"]),
  symbols: z.array(z.string()),
  startLine: z.number(),
  endLine: z.number(),
}) satisfies z.ZodType<ImportRef>;

const ExportRefSchema = z.object({
  symbol: z.string(),
  startLine: z.number(),
  endLine: z.number(),
}) satisfies z.ZodType<ExportRef>;

function insertImportGraphRow(
  filePath: string,
  fileSha: string,
  imports: ImportRef[],
  exports: ExportRef[],
): void {
  // INSERT OR IGNORE — rows are immutable per (path, sha). If a parallel
  // load raced ahead, the existing row is identical content by definition.
  db()
    .insert(importGraph)
    .values({
      filePath,
      fileSha,
      importsJson: JSON.stringify(imports),
      exportsJson: JSON.stringify(exports),
      computedAt: new Date(),
    })
    .onConflictDoNothing()
    .run();
}

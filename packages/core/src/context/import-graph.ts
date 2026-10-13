import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { and, db, eq, importGraph } from "@warden/db";
import type { DegradedEntry } from "../schema.js";
import type { ExportRef, ImportRef, SourceParser } from "./parser.js";
import type { Graph } from "./signals/imports.js";

/**
 * Active import graph for the working tree being reviewed (ADR-0018, issue
 * #62). Shared by the context selector and the deadcode detector so both read
 * the same snapshot.
 *
 * Source identity is established per load, never remembered: every tracked
 * source file is read and hashed from disk, and that hash is the only key used
 * to look up its `import_graph` row. A clean `git status` is not evidence that
 * a previously stored hash is current — a commit, checkout, or reset changes
 * content without leaving the file "modified". Hashing every file costs about
 * as much as asking git's index (~0.3s on a 10k-file repo); the expensive part,
 * the parse, stays cached per `(path, sha)`.
 *
 * A row caches only what the file's own bytes determine. `ImportRef.resolved`
 * also depends on other files (a new `b.ts` shadows `b/index.ts`, a target
 * moves to `.tsx`) and on tsconfig, so it is re-resolved against today's tree
 * on every load and the stored value is never used.
 *
 * Rows for other snapshots stay in `import_graph` but never become active:
 * the graph contains only paths in today's `git ls-files`, each bound to the
 * hash of the bytes read today. Files that cannot be read are reported by path
 * and left out of the graph rather than falling back to an older row.
 */

const BATCH_SIZE = 20;
const SOURCE_EXT_RE = /\.(?:tsx?|jsx?|mjs|cjs)$/;
const MAX_LISTED_PATHS = 10;

export interface ImportGraphSnapshot {
  /** Repo-relative source files present in the snapshot (tracked and on disk). */
  files: string[];
  /** Absolute path → parsed entry, for every snapshot file that parsed. */
  graph: Graph;
  /** Parse-cache counters for this load. */
  stats: { reused: number; parsed: number; parseErrors: number };
  /** Repo-relative paths that could not be read or hashed; excluded from `graph`. */
  unreadable: string[];
  degraded: DegradedEntry[];
}

export async function loadImportGraph(input: {
  repoRoot: string;
  parser: SourceParser;
  /** Topic + message prefix for degraded entries (`context`, `deadcode`). */
  topic: string;
}): Promise<ImportGraphSnapshot> {
  const { repoRoot, parser, topic } = input;
  const tracked = (await gitLsFiles(repoRoot)).filter((f) => SOURCE_EXT_RE.test(f));

  const files: string[] = [];
  const graph: Graph = new Map();
  const stats = { reused: 0, parsed: 0, parseErrors: 0 };
  const unreadable: string[] = [];

  await runInBatches(tracked, BATCH_SIZE, async (path) => {
    const abs = resolvePath(repoRoot, path);
    let bytes: Buffer;
    try {
      bytes = await readFile(abs);
    } catch (err) {
      // Tracked but deleted in the working tree: not part of this snapshot.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      unreadable.push(path);
      return;
    }
    files.push(path);
    const sha = createHash("sha256").update(bytes).digest("hex");

    const cached = readImportGraphRow(path, sha);
    if (cached) {
      stats.reused++;
      graph.set(abs, {
        imports: cached.imports.map((imp) => ({
          ...imp,
          resolved: parser.resolve(imp.module, abs),
        })),
        exports: cached.exports,
      });
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
      graph.set(abs, { imports, exports });
      stats.parsed++;
    } catch {
      stats.parseErrors++;
    }
  });

  files.sort();
  unreadable.sort();

  const degraded: DegradedEntry[] = [];
  if (stats.parsed > 0 && stats.reused === 0) {
    degraded.push({
      kind: "info",
      topic,
      message: `${topic}: cold import-graph build (parsed ${stats.parsed} files)`,
    });
  }
  if (stats.parseErrors > 0) {
    degraded.push({
      kind: "info",
      topic,
      message: `${topic}: ${stats.parseErrors} files failed to parse`,
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
      message: `${topic}: could not read ${unreadable.length} source files; left out of the import graph: ${listed}${more}`,
    });
  }

  return { files, graph, stats, unreadable, degraded };
}

function gitLsFiles(repoRoot: string): Promise<string[]> {
  return new Promise((resolveP, rejectP) => {
    const child = spawn("git", ["ls-files", "-z"], {
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
      resolveP(stdout.split("\0").filter((l) => l.length > 0));
    });
  });
}

async function runInBatches<T>(
  items: T[],
  batchSize: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  for (let i = 0; i < items.length; i += batchSize) {
    const slice = items.slice(i, i + batchSize);
    await Promise.all(slice.map(fn));
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
    return {
      imports: JSON.parse(row.importsJson) as ImportRef[],
      exports: JSON.parse(row.exportsJson) as ExportRef[],
    };
  } catch {
    return undefined;
  }
}

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

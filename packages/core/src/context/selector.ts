import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve as resolvePath, sep } from "node:path";
import type { EmbeddingProvider } from "@warden/ai";
import { and, db, eq, fileState, importGraph } from "@warden/db";
import type { ChangedFile } from "../diff/index.js";
import type { EcosystemContext } from "../ecosystem/index.js";
import type { ChunkStore, EmbeddingStore } from "../indexing/index.js";
import type { DegradedEntry } from "../schema.js";
import {
  MAX_CONTENT_BEARING,
  MAX_REASON_WEIGHT_SUM,
  MAX_SAME_FOLDER_ONLY,
  REASON_WEIGHTS,
} from "./index.js";
import type {
  ContextCandidate,
  ContextSelector,
  Reason,
  SelectorOutput,
} from "./index.js";
import { TsCompilerParser, type ExportRef, type ImportRef, type SourceParser } from "./parser.js";
import {
  collectImportedByReasons,
  collectImporterReasons,
  deriveReverse,
  type Graph,
} from "./signals/imports.js";
import { buildFilesByDir, collectSameFolderReasons } from "./signals/same-folder.js";
import { semanticSignal } from "./signals/semantic.js";
import { collectSymbolRefHits } from "./signals/symbol-refs.js";

/**
 * `CheapSignalsSelector` — the default M5 implementation of `ContextSelector`
 * (ADR-0018). Walks the host repo, builds a parsed-imports graph (cached
 * content-addressed in `import_graph`), runs four signals (direct importers,
 * direct imports, same-folder, symbol-refs), and returns ranked candidates.
 *
 * The whole flow is read-only against the host repo. Every cache read is
 * keyed on `(filePath, fileSha)` so any file change naturally produces a
 * cache miss and a re-parse — no manual invalidation required.
 *
 * Parser resolution order (per `select()` call):
 *   1. `opts.parser` — explicit injection (custom impl, tests).
 *   2. `new TsCompilerParser({ tsconfigPath: opts.tsconfigPath ?? ecosystem.tsconfigPaths[0] })`.
 * Selectors are intended to be cheap to construct and per-review; the
 * `ecosystem` argument carries the host-repo state, so tsconfig discovery
 * stays at the call site rather than freezing into the constructor.
 */

const PARSE_BATCH_SIZE = 20;
const SOURCE_EXT_RE = /\.(?:tsx?|jsx?|mjs|cjs)$/;

export interface CheapSignalsSelectorOptions {
  /** Custom parser. Takes precedence over the tsconfig-based default. */
  parser?: SourceParser;
  /** Override tsconfig path for module resolution. Falls back to `ecosystem.tsconfigPaths[0]`. */
  tsconfigPath?: string;
  /**
   * M6 (ADR-0019 #9): when all three are supplied, the selector adds a
   * semantic signal to the cheap-signals layer. The class name stays
   * `CheapSignalsSelector` because the surface still composes M5's four
   * binary signals — semantic is an additive intensity-scaled layer rather
   * than a replacement.
   */
  embeddingProvider?: EmbeddingProvider | null;
  embeddingStore?: EmbeddingStore | null;
  chunkStore?: ChunkStore | null;
  /** Locked-model id of the index — required when the three above are set. */
  lockedModelId?: string;
  /** Cache-key handle for corpus-side rows (`type=document`). */
  lockedModelVersionForDocument?: string;
}

export class CheapSignalsSelector implements ContextSelector {
  constructor(private readonly opts: CheapSignalsSelectorOptions = {}) {}

  async select(input: {
    repoRoot: string;
    changed: ChangedFile[];
    ecosystem: EcosystemContext;
    diff?: string;
  }): Promise<SelectorOutput> {
    const { repoRoot, changed, ecosystem } = input;
    const degraded: DegradedEntry[] = [];

    const parser =
      this.opts.parser ??
      new TsCompilerParser({
        repoRoot,
        tsconfigPath: this.opts.tsconfigPath ?? ecosystem.tsconfigPaths[0],
      });

    // 1. Source-file universe via `git ls-files`.
    const allFilesRel = (await gitLs(repoRoot, ["ls-files"])).filter((f) =>
      SOURCE_EXT_RE.test(f),
    );
    if (allFilesRel.length === 0) {
      return { candidates: [], degraded };
    }

    // 2. Refresh staleness pointer for git-modified + untracked files.
    let dirtyFiles: string[];
    try {
      dirtyFiles = await gitLs(repoRoot, [
        "ls-files",
        "--modified",
        "--others",
        "--exclude-standard",
      ]);
    } catch {
      dirtyFiles = allFilesRel;
      degraded.push({
        kind: "info",
        topic: "context",
        message: "context: git ls-files --modified failed; falling back to full hash",
      });
    }

    const dirtyFilesFiltered = dirtyFiles.filter((f) => SOURCE_EXT_RE.test(f));
    const dirtyShaByPath = new Map<string, string>();
    for (const path of dirtyFilesFiltered) {
      const abs = resolvePath(repoRoot, path);
      const sha = await safeSha256(abs);
      if (!sha) continue;
      dirtyShaByPath.set(path, sha);
      upsertFileState(path, sha);
    }

    // 3. Build the import graph: lookup (path, sha) → cache; miss → parse + insert.
    const knownState = readFileStateFor(allFilesRel);
    const cacheCounts = { hits: 0, misses: 0, parseErrors: 0 };

    const graph: Graph = new Map();

    // Determine each file's resolved SHA — dirty list trumps file_state row.
    const shaByPath = new Map<string, string>();
    const needsHashing: string[] = [];
    for (const path of allFilesRel) {
      const sha = dirtyShaByPath.get(path) ?? knownState.get(path);
      if (sha) shaByPath.set(path, sha);
      else needsHashing.push(path);
    }
    // First-run case: no file_state rows yet, none dirty (clean tree).
    if (needsHashing.length > 0) {
      degraded.push({
        kind: "info",
        topic: "context",
        message: `context: cold import-graph build (hashing ${needsHashing.length} files)`,
      });
      await runInBatches(needsHashing, PARSE_BATCH_SIZE, async (path) => {
        const abs = resolvePath(repoRoot, path);
        const sha = await safeSha256(abs);
        if (sha) {
          shaByPath.set(path, sha);
          upsertFileState(path, sha);
        }
      });
    }

    // Build graph entries.
    let coldParseCount = 0;
    await runInBatches(allFilesRel, PARSE_BATCH_SIZE, async (path) => {
      const sha = shaByPath.get(path);
      if (!sha) return;
      const cached = readImportGraphRow(path, sha);
      if (cached) {
        cacheCounts.hits++;
        graph.set(resolvePath(repoRoot, path), {
          imports: cached.imports,
          exports: cached.exports,
        });
        return;
      }
      cacheCounts.misses++;
      coldParseCount++;
      const abs = resolvePath(repoRoot, path);
      try {
        const content = await readFile(abs, "utf8");
        const [imports, exports] = await Promise.all([
          parser.imports(abs, content),
          parser.exports(abs, content),
        ]);
        insertImportGraphRow(path, sha, imports, exports);
        graph.set(abs, { imports, exports });
      } catch {
        cacheCounts.parseErrors++;
      }
    });

    if (cacheCounts.misses > 0 && cacheCounts.hits === 0) {
      degraded.push({
        kind: "info",
        topic: "context",
        message: `context: cold import-graph build (parsed ${coldParseCount} files in Ts)`,
      });
    }
    if (cacheCounts.parseErrors > 0) {
      degraded.push({
        kind: "info",
        topic: "context",
        message: `context: ${cacheCounts.parseErrors} files failed to parse`,
      });
    }

    // 4. Reverse import index.
    const reverse = deriveReverse(graph);

    // 5. Run signals.
    const changedRel = changed.map((c) => normalizeRel(c.path));
    const changedRelSet = new Set(changedRel);
    const changedAbs = changedRel.map((p) => resolvePath(repoRoot, p));

    const importerReasons = collectImporterReasons(changedAbs, graph, reverse);
    const importedByReasons = collectImportedByReasons(changedAbs, graph);

    const filesByDir = buildFilesByDir(allFilesRel);
    const sameFolderReasons = collectSameFolderReasons(changedRel, filesByDir);

    const changedExportsByPath = new Map<string, ExportRef[]>();
    for (const path of changedRel) {
      const abs = resolvePath(repoRoot, path);
      const entry = graph.get(abs);
      if (entry) changedExportsByPath.set(path, entry.exports);
    }
    let symbolRefHits: Awaited<ReturnType<typeof collectSymbolRefHits>>;
    try {
      symbolRefHits = await collectSymbolRefHits(repoRoot, changedExportsByPath, changedRelSet);
    } catch {
      symbolRefHits = [];
      degraded.push({
        kind: "warning",
        topic: "context",
        message: "context: git grep failed; symbol-ref signal disabled",
      });
    }

    // 6. Aggregate per-candidate reasons (keyed on absolute path during graph
    //    work, repo-relative paths externally).
    const reasonsByCandidate = new Map<string, Reason[]>();

    const addReasons = (candidatePath: string, reasons: Reason[]) => {
      const rel = pathFromGraphKey(candidatePath, repoRoot);
      if (rel === "" || changedRelSet.has(rel)) return;
      let bucket = reasonsByCandidate.get(rel);
      if (!bucket) {
        bucket = [];
        reasonsByCandidate.set(rel, bucket);
      }
      bucket.push(...reasons);
    };

    for (const [candidateAbs, items] of importerReasons) {
      addReasons(
        candidateAbs,
        items.map(
          (it): Reason => ({
            kind: "imports",
            target: relative(repoRoot, it.target),
            evidence: it.evidence.length > 0 ? it.evidence : undefined,
          }),
        ),
      );
    }
    for (const [candidateAbs, items] of importedByReasons) {
      addReasons(
        candidateAbs,
        items.map(
          (it): Reason => ({
            kind: "imported-by",
            from: relative(repoRoot, it.from),
            evidence: it.evidence.length > 0 ? it.evidence : undefined,
          }),
        ),
      );
    }
    for (const [candidateRel, items] of sameFolderReasons) {
      addReasons(
        candidateRel,
        items.map((it): Reason => ({ kind: "same-folder", sibling: it.sibling })),
      );
    }
    for (const hit of symbolRefHits) {
      addReasons(hit.candidate, [
        { kind: "symbol-ref", symbol: hit.symbol, evidence: hit.evidence },
      ]);
    }

    // 6b. Semantic signal (M6 / ADR-0019 #9). Embedding deps are optional —
    //     when any of them are missing, semantic stays off and the selector
    //     reduces to its M5 behavior. Voyage failure during a configured run
    //     degrades to cheap-signals + a degraded[] entry; never hard-fails.
    const semanticReady =
      this.opts.embeddingProvider != null &&
      this.opts.embeddingStore != null &&
      this.opts.chunkStore != null &&
      typeof this.opts.lockedModelId === "string" &&
      typeof this.opts.lockedModelVersionForDocument === "string" &&
      typeof input.diff === "string" &&
      input.diff.length > 0;
    if (semanticReady) {
      const semantic = await semanticSignal({
        diff: input.diff ?? "",
        embeddingProvider: this.opts.embeddingProvider!,
        embeddingStore: this.opts.embeddingStore!,
        chunkStore: this.opts.chunkStore!,
        repoRoot,
        lockedModelId: this.opts.lockedModelId!,
        lockedModelVersionForDocument: this.opts.lockedModelVersionForDocument!,
      });
      degraded.push(...semantic.degraded);
      for (const [filePath, hit] of semantic.hitsByFile) {
        const rel = filePath.split(sep).join("/");
        if (changedRelSet.has(rel)) continue;
        addReasons(rel, [
          {
            kind: "semantic",
            chunkHash: hit.chunkHash,
            similarity: hit.similarity,
            evidence: [{ startLine: hit.startLine, endLine: hit.endLine }],
          },
        ]);
      }
    }

    // 7. Score + rank.
    const ranked: ContextCandidate[] = [];
    for (const [path, reasons] of reasonsByCandidate) {
      const score = scoreReasons(reasons);
      ranked.push({ path, score, reasons });
    }
    ranked.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));

    // 8. Cap: top-N content-bearing + top-M same-folder-only.
    const contentBearing: ContextCandidate[] = [];
    const sameFolderOnly: ContextCandidate[] = [];
    for (const c of ranked) {
      if (isContentBearing(c)) {
        if (contentBearing.length < MAX_CONTENT_BEARING) contentBearing.push(c);
      } else {
        if (sameFolderOnly.length < MAX_SAME_FOLDER_ONLY) sameFolderOnly.push(c);
      }
    }

    if (changedRel.length > 0 && contentBearing.length === 0 && sameFolderOnly.length === 0) {
      degraded.push({
        kind: "info",
        topic: "context",
        message: "context: zero adjacent files found — falling back to diff-only LLM pass",
      });
    }

    return {
      candidates: [...contentBearing, ...sameFolderOnly],
      degraded,
    };
  }
}

function isContentBearing(c: ContextCandidate): boolean {
  return c.reasons.some((r) => r.kind !== "same-folder");
}

function scoreReasons(reasons: Reason[]): number {
  // ADR-0019 #9: cheap signals are binary (sum unique kinds × weight);
  // semantic is intensity-scaled (weight × max chunk similarity per file).
  // Per-file aggregation already retained the max-similarity hit in the
  // semantic signal step, so we read it directly off the kept reasons.
  const seenKinds = new Set<Reason["kind"]>();
  let sum = 0;
  let maxSemantic = 0;
  for (const r of reasons) {
    if (r.kind === "semantic") {
      if (r.similarity > maxSemantic) maxSemantic = r.similarity;
      continue;
    }
    if (seenKinds.has(r.kind)) continue;
    seenKinds.add(r.kind);
    sum += REASON_WEIGHTS[r.kind];
  }
  if (maxSemantic > 0) sum += REASON_WEIGHTS.semantic * maxSemantic;
  return sum / MAX_REASON_WEIGHT_SUM;
}

function gitLs(repoRoot: string, args: string[]): Promise<string[]> {
  return new Promise((resolveP, rejectP) => {
    const child = spawn("git", args, {
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
        rejectP(new Error(`git ${args.join(" ")} exited ${code ?? "?"}`));
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

async function safeSha256(absPath: string): Promise<string | undefined> {
  try {
    const buf = await readFile(absPath);
    return createHash("sha256").update(buf).digest("hex");
  } catch {
    return undefined;
  }
}

function upsertFileState(filePath: string, sha: string): void {
  db()
    .insert(fileState)
    .values({ filePath, currentSha: sha, observedAt: new Date() })
    .onConflictDoUpdate({
      target: fileState.filePath,
      set: { currentSha: sha, observedAt: new Date() },
    })
    .run();
}

function readFileStateFor(paths: string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (paths.length === 0) return out;
  // Single-shot read of the whole table is simpler than chunked WHERE-IN
  // queries for repos at the scale we target (~10k rows max).
  const rows = db()
    .select({ filePath: fileState.filePath, currentSha: fileState.currentSha })
    .from(fileState)
    .all();
  const lookup = new Set(paths);
  for (const r of rows) {
    if (lookup.has(r.filePath)) out.set(r.filePath, r.currentSha);
  }
  return out;
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
  // process raced ahead, the existing row is identical content by definition.
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

function pathFromGraphKey(key: string, repoRoot: string): string {
  const rel = isAbsolute(key) ? relative(repoRoot, key) : key;
  return rel.split(sep).join("/");
}

function normalizeRel(p: string): string {
  return p.split(sep).join("/");
}

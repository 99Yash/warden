import { isAbsolute, relative, resolve as resolvePath, sep } from "node:path";
import type { EmbeddingProvider } from "@warden/ai";
import type { ChangedFile } from "../diff/index.js";
import type { EcosystemContext } from "../ecosystem/index.js";
import type { ChunkStore, EmbeddingStore } from "../indexing/index.js";
import type { DegradedEntry } from "../schema.js";
import {
  MAX_CONTENT_BEARING,
  MAX_REASON_WEIGHT_SUM,
  MAX_SAME_FOLDER_ONLY,
  REASON_WEIGHTS,
} from "./scoring.js";
import type { ContextCandidate, ContextSelector, Reason, SelectorOutput } from "./index.js";
import {
  loadImportGraph,
  type ImportGraphLoader,
  type ImportGraphSnapshot,
} from "./import-graph.js";
import { TsCompilerParser, type ExportRef, type SourceParser } from "./parser.js";
import {
  collectImportedByReasons,
  collectImporterReasons,
  deriveReverse,
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
 * The whole flow is read-only against the host repo. The graph comes from
 * `loadImportGraph`, which hashes every tracked source file on each call and
 * keys cache reads on `(filePath, fileSha)` — any content change, including
 * one from a commit or checkout on a clean tree, produces a cache miss and a
 * re-parse with no manual invalidation.
 *
 * Graph source (per `select()` call):
 *   1. `input.importGraph` — the review's shared snapshot (`runDetPriors`).
 *      The parser options below are not used, and the caller reports the
 *      snapshot's degraded entries.
 *   2. Otherwise a load of its own, with the parser below:
 *      a. `opts.parser` — explicit injection (custom impl, tests).
 *      b. `new TsCompilerParser({ tsconfigPath: opts.tsconfigPath ?? ecosystem.tsconfigPaths[0] })`.
 * Selectors are intended to be cheap to construct and per-review; the
 * `ecosystem` argument carries the host-repo state, so tsconfig discovery
 * stays at the call site rather than freezing into the constructor.
 */

export interface CheapSignalsSelectorOptions {
  /**
   * Custom parser. Takes precedence over the tsconfig-based default. Not used
   * when `select()` receives a shared `importGraph`.
   */
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
    importGraph?: ImportGraphLoader;
  }): Promise<SelectorOutput> {
    const { repoRoot, changed, ecosystem } = input;
    const degraded: DegradedEntry[] = [];

    // 1–3. Active import graph for the working tree: every tracked source
    //      file is hashed from disk, and only rows for those hashes are used.
    let snapshot: ImportGraphSnapshot;
    if (input.importGraph) {
      snapshot = await input.importGraph();
    } else {
      const tsconfigPath = this.opts.tsconfigPath ?? ecosystem.tsconfigPaths[0];
      const parser =
        this.opts.parser ??
        new TsCompilerParser({
          repoRoot,
          ...(tsconfigPath !== undefined ? { tsconfigPath } : {}),
        });
      snapshot = await loadImportGraph({ repoRoot, parser, topic: "context" });
      degraded.push(...snapshot.degraded);
    }
    if (snapshot.files.length === 0) {
      return { candidates: [], degraded };
    }
    const { graph } = snapshot;

    // 4. Reverse import index.
    const reverse = deriveReverse(graph);

    // 5. Run signals.
    const changedRel = changed.map((c) => normalizeRel(c.path));
    const changedRelSet = new Set(changedRel);
    const changedAbs = changedRel.map((p) => resolvePath(repoRoot, p));

    const importerReasons = collectImporterReasons(changedAbs, graph, reverse);
    const importedByReasons = collectImportedByReasons(changedAbs, graph);

    const filesByDir = buildFilesByDir(snapshot.files);
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
            ...(it.evidence.length > 0 ? { evidence: it.evidence } : {}),
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
            ...(it.evidence.length > 0 ? { evidence: it.evidence } : {}),
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
    const {
      embeddingProvider,
      embeddingStore,
      chunkStore,
      lockedModelId,
      lockedModelVersionForDocument,
    } = this.opts;
    const { diff } = input;
    if (
      embeddingProvider != null &&
      embeddingStore != null &&
      chunkStore != null &&
      lockedModelId !== undefined &&
      lockedModelVersionForDocument !== undefined &&
      diff !== undefined &&
      diff.length > 0
    ) {
      const semantic = await semanticSignal({
        diff,
        embeddingProvider,
        embeddingStore,
        chunkStore,
        repoRoot,
        lockedModelId,
        lockedModelVersionForDocument,
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

function pathFromGraphKey(key: string, repoRoot: string): string {
  const rel = isAbsolute(key) ? relative(repoRoot, key) : key;
  return rel.split(sep).join("/");
}

function normalizeRel(p: string): string {
  return p.split(sep).join("/");
}

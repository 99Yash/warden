import { dirname, resolve as resolvePath } from "node:path";
import { readFile } from "node:fs/promises";
import type { ChangedFile } from "../../diff/index.js";
import type { DegradedEntry } from "../../schema.js";
import type { ReasonedFindingMode } from "../boss-loop.js";
import type { WorkerPromptVariant } from "../prompts/loader.js";
import type {
  Concern,
  WorkerInvocation,
  WorkerInvocationResult,
  WorkerRoute,
} from "../tools/dispatch-worker.js";
import { resolveWithinRoot } from "../tools/safety.js";
import { runWorker } from "./run-worker.js";

/**
 * Builds the `route` function injected into `makeDispatchWorkerTool()`. The
 * dispatch tool descriptor handles input parsing, lane discipline, and
 * scratchpad recording; the route function handles the per-concern
 * routing (currently uniform — every concern goes through `runWorker()`
 * with its own system prompt + tier default) plus harness-scoped
 * dependency wiring (changed-file lookup, package search roots, shared
 * api-claim-verifier collector, leverage-only deps preamble).
 *
 * Why is routing trivial? All 6 workers share the same `streamText`
 * envelope; the per-concern customization (prompt + tier + category)
 * lives in `run-worker.ts` keyed on `invocation.concern`. If a future
 * concern needs a bespoke tool set or output shape, branch here. v0
 * keeps it uniform.
 */

export interface MakeWorkerRouteOptions {
  repoRoot: string;
  /** Det-priors-derived ChangedFile list. Indexed by `path` for O(1) lookup. */
  changed: ChangedFile[];
  /**
   * ADR-0048 §2 review-run id, captured in the route closure and forwarded to
   * every `runWorker()` call so per-worker OTEL spans group under the run's
   * Langfuse trace. Absent → telemetry stays off (no keys / non-harness caller).
   */
  runId?: string;
  /**
   * Mutable shared collector for the `lookupTypeDef` once-per-review
   * "no node_modules/" degraded entry. The same array is passed for every
   * worker so the message is emitted at most once across the whole loop.
   */
  apiClaimDegraded: DegradedEntry[];
  /** Override per-worker timeout (ms). */
  timeoutMs?: number;
  /**
   * Worker prompt variant captured in the route closure and forwarded to
   * every `runWorker()` call. Absent → baseline. Threaded from
   * `BossLoopConfig.workerPromptVariant` via `harness.ts`.
   */
  workerPromptVariant?: WorkerPromptVariant;
  /**
   * ADR-0044 eval seam. Absent/default keeps legacy source-required worker
   * behavior; `allow-empty-sources` lets the eval suite retain reasoned
   * evidence-only worker findings without the full public schema migration.
   */
  reasonedFindingMode?: ReasonedFindingMode;
}

export function makeWorkerRoute(opts: MakeWorkerRouteOptions): WorkerRoute {
  const byPath = new Map<string, ChangedFile>();
  for (const cf of opts.changed) {
    byPath.set(cf.path.replace(/\\/g, "/"), cf);
  }

  let cachedDepsContext: DepsContext | undefined;
  const getDepsContext = async (): Promise<DepsContext> => {
    if (cachedDepsContext) return cachedDepsContext;
    cachedDepsContext = await buildDepsContext(opts.repoRoot, opts.changed);
    return cachedDepsContext;
  };

  return async (invocation: WorkerInvocation): Promise<WorkerInvocationResult> => {
    const dispatched = invocation.files
      .map((p) => byPath.get(p.replace(/\\/g, "/")))
      .filter((cf): cf is ChangedFile => cf !== undefined);

    // Build per-concern preamble. Only `leverage` consults installed deps —
    // every other concern stays preamble-free to keep prompt tokens lean.
    let preamble: string | undefined;
    let packageSearchRoots = [opts.repoRoot];
    if (invocation.concern === "leverage") {
      const ctx = await getDepsContext();
      preamble = ctx.preamble;
      packageSearchRoots = ctx.packageRoots;
    }

    return runWorker({
      ...invocation,
      changed: dispatched,
      packageSearchRoots,
      apiClaimDegraded: opts.apiClaimDegraded,
      ...(opts.runId !== undefined ? { runId: opts.runId } : {}),
      ...(preamble !== undefined ? { preamble } : {}),
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.workerPromptVariant !== undefined
        ? { workerPromptVariant: opts.workerPromptVariant }
        : {}),
      ...(opts.reasonedFindingMode !== undefined
        ? { reasonedFindingMode: opts.reasonedFindingMode }
        : {}),
    });
  };
}

// ---------------------------------------------------------------------------
// Dependency preamble + workspace package search roots.
// ---------------------------------------------------------------------------
//
// Mirrors `runners/leverage-libraries.ts`'s buildDependencyContext: walks
// from each changed file up to the repo root looking for `package.json`
// manifests, unions their dep keys, and exposes the package roots so
// `lookupTypeDef` can search workspace `node_modules/` chains in a pnpm
// monorepo. Lazy-initialized — only built when a `leverage` worker
// dispatches.

interface DepsContext {
  preamble: string;
  dependencies: string[];
  packageRoots: string[];
}

const MANIFEST_DEP_KEYS = ["dependencies", "devDependencies", "peerDependencies"] as const;

async function buildDepsContext(repoRoot: string, changed: ChangedFile[]): Promise<DepsContext> {
  const rootAbs = resolvePath(repoRoot);
  const manifestRoots = new Set<string>([rootAbs]);

  for (const cf of changed) {
    const fileAbs = resolveWithinRoot(rootAbs, cf.path);
    if (fileAbs === null) continue;
    const nearest = await findNearestPackageRoot(dirname(fileAbs), rootAbs);
    if (nearest) manifestRoots.add(nearest);
  }

  const dependencySet = new Set<string>();
  for (const root of manifestRoots) {
    try {
      const raw = await readFile(resolvePath(root, "package.json"), "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      for (const key of MANIFEST_DEP_KEYS) {
        const block = parsed[key];
        if (!block || typeof block !== "object") continue;
        for (const dep of Object.keys(block as Record<string, unknown>)) {
          dependencySet.add(dep);
        }
      }
    } catch {
      // Missing or malformed manifest → ignore.
    }
  }

  const dependencies = [...dependencySet].sort();
  const preamble =
    dependencies.length > 0
      ? `Installed libraries: ${dependencies.join(", ")}`
      : `Installed libraries: (none discovered)`;
  return { preamble, dependencies, packageRoots: [...manifestRoots] };
}

async function findNearestPackageRoot(startDir: string, rootAbs: string): Promise<string | null> {
  let cursor = startDir;
  while (true) {
    try {
      await readFile(resolvePath(cursor, "package.json"), "utf8");
      return cursor;
    } catch {
      // not present here — climb
    }
    if (cursor === rootAbs) return null;
    const parent = dirname(cursor);
    if (parent === cursor) return null;
    if (!parent.startsWith(rootAbs)) return null;
    cursor = parent;
  }
}

// Type re-export so callers that already import `Concern` from tools/ don't
// need a second import path.
export type { Concern };

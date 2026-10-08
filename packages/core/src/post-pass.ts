import { z } from "zod";
import { stableCommentId } from "./comment-id.js";
import { applyConfidenceToKind, demotionsToDegraded } from "./confidence.js";
import { parseUnifiedDiff } from "./diff/index.js";
import { pruneDiff } from "./diff/prune.js";
import { verifyCitations } from "./llm/verify-citations.js";
import { compareByPriority } from "./priority.js";
import {
  anchorInScope,
  commentInScope,
  scopeCommentsToDiff,
} from "./review-harness/comment-scope.js";
import { CommentSchema, type Comment, type CommentSet, type DegradedEntry } from "./schema.js";

/**
 * Mandatory post-pass outside model discretion (ADR-0053 §4). Publication
 * ownership is procedural until the #42 driver publishes only the returned
 * `CommentSet`: the driver runs the lanes, reads their submitted findings
 * from session messages, calls `runPostPass()`, and publishes only the
 * returned `CommentSet`. None of these steps is an MCP tool — a model can
 * decline to call a tool, so a model-invoked gate is not a gate. The only
 * inputs the model controls are the finding objects themselves (`unknown[]`,
 * validated one at a time); the diff, the per-lane scope envelope, and the
 * config are driver-owned.
 *
 * Must not import the harness, boss loop, workers, tools, or anything that
 * makes an LLM call — the smoke asserts this by scanning relative imports.
 */

export const POST_PASS_INPUT_VERSION = 1 as const;

/** CONTEXT.md "volume cap" — default 5, configurable. */
export const DEFAULT_VOLUME_CAP = 5;

export const LaneNameEnum = z.enum(["up", "down", "surface", "judge"]);
export type LaneName = z.infer<typeof LaneNameEnum>;

export const LaneOutputSchema = z.strictObject({
  lane: LaneNameEnum,
  status: z.enum(["ok", "failed"]),
  reason: z.string().optional(),
  // Trusted file-scope envelope (ADR-0053 §4); required, driver-owned.
  scope: z.array(z.string()),
  // Model-owned; validated per finding.
  findings: z.array(z.unknown()),
});
export type LaneOutput = z.infer<typeof LaneOutputSchema>;

export const PostPassLanesSchema = z.strictObject({
  version: z.literal(POST_PASS_INPUT_VERSION),
  lanes: z.array(LaneOutputSchema),
});

// Model-supplied `id` keys are stripped (a plain `z.object` with no `id`
// key), so a model id can never win dedupe — every id is minted below.
export const LaneFindingSchema = CommentSchema.omit({ id: true });

export interface PostPassConfig {
  verbose?: boolean;
  volumeCap?: number;
  securityFloor?: number;
}

export interface PostPassInput {
  repoRoot: string;
  /** Unified diff; pruned exactly like runDetPriors. */
  diff: string;
  lanes: LaneOutput[];
  config?: PostPassConfig;
  extraDegraded?: DegradedEntry[];
}

export async function runPostPass(input: PostPassInput): Promise<CommentSet> {
  const startedAt = Date.now();
  const cap = resolveVolumeCap(input.config?.volumeCap);
  const postPass: DegradedEntry[] = [];

  // 1. Per-finding schema validation. Invalid findings drop, counted per
  // lane. Every id is minted content-addressed without the lane in the
  // key, so byte-identical findings (same file, lines, category, and
  // claim) submitted by two lanes dedupe at step 8.
  const perLane: Comment[][] = [];
  const invalidByLane = new Map<string, number>();
  for (const lane of input.lanes) {
    const kept: Comment[] = [];
    for (const finding of lane.findings) {
      const result = LaneFindingSchema.safeParse(finding);
      if (!result.success) {
        invalidByLane.set(lane.lane, (invalidByLane.get(lane.lane) ?? 0) + 1);
        continue;
      }
      const rest = result.data;
      kept.push({
        ...rest,
        id: stableCommentId(
          `post-pass:${rest.file}:${rest.lineStart}:${rest.lineEnd}:${rest.category}:${rest.claim}`,
        ),
      });
    }
    perLane.push(kept);
  }
  const invalidTotal = [...invalidByLane.values()].reduce((a, b) => a + b, 0);
  if (invalidTotal > 0) {
    const perLaneMsg = [...invalidByLane.entries()].map(([lane, n]) => `${lane}: ${n}`).join(", ");
    postPass.push({
      kind: "info",
      topic: "post-pass",
      message: `post-pass: dropped ${invalidTotal} invalid ${
        invalidTotal === 1 ? "finding" : "findings"
      } (${perLaneMsg})`,
    });
  }

  // 2. Lane scope membership, per lane against its trusted envelope.
  // Both the source paths (`commentInScope`) and the finding's own anchor
  // (`anchorInScope`) must be in scope — sources alone are model-owned, so
  // a sourceless finding or an out-of-scope anchor would otherwise publish
  // on any changed file. Findings from a failed lane are still processed —
  // partial output is evidence, not trusted output.
  const scoped: Comment[] = [];
  const scopedKeptByLane: number[] = [];
  let scopeDropped = 0;
  input.lanes.forEach((lane, i) => {
    const scope = new Set(lane.scope.map((p) => p.replace(/\\/g, "/")));
    let keptCount = 0;
    for (const comment of perLane[i] ?? []) {
      if (commentInScope(comment, scope) && anchorInScope(comment, scope)) {
        scoped.push(comment);
        keptCount += 1;
      } else {
        scopeDropped += 1;
      }
    }
    scopedKeptByLane.push(keptCount);
  });
  // An `ok` lane with non-empty findings that loses all of them to gates
  // 1–2 (schema + scope) is unhealthy — including a mis-encoded scope, which
  // otherwise fails silently. Named per lane for the lane-health entries.
  const unhealthy = input.lanes.flatMap((lane, index) =>
    lane.status === "ok" && lane.findings.length > 0 && (scopedKeptByLane[index] ?? 0) === 0
      ? [{ index, lane: lane.lane, count: lane.findings.length }]
      : [],
  );
  if (scopeDropped > 0) {
    postPass.push({
      kind: "info",
      topic: "post-pass",
      message: `post-pass: dropped ${scopeDropped} ${
        scopeDropped === 1 ? "finding" : "findings"
      } outside the lane scope`,
    });
  }

  // 3. Citation verification over the union.
  const verified = await verifyCitations({ comments: scoped, repoRoot: input.repoRoot });

  // 4. Added-line anchoring — identical derivation to runDetPriors
  // (det-priors.ts:129): parse, then prune, then scope to the pruned set.
  // Zero parsed files means no comment can anchor (e.g. an empty
  // --diff-file) — an actionable entry, not a clean result. A diff that
  // parses to files but prunes to nothing (e.g. only generated noise) is
  // not empty: no entry here, and the prune's own degraded entries are
  // forwarded below so the silence is visible.
  const parsed = parseUnifiedDiff(input.diff);
  if (parsed.length === 0) {
    postPass.push({
      kind: "actionable",
      topic: "diff-source",
      message: "post-pass: empty diff — no comment can anchor; this is NOT a clean result",
    });
  }
  const pruned = pruneDiff(parsed);
  const pruneDegraded = pruned.degraded;
  const changed = pruned.pruned;
  const anchored = scopeCommentsToDiff(verified.comments, changed);
  if (anchored.droppedCount > 0) {
    postPass.push({
      kind: "info",
      topic: "post-pass",
      message: `post-pass: dropped ${anchored.droppedCount} ${
        anchored.droppedCount === 1 ? "comment" : "comments"
      } not anchored to added lines`,
    });
  }

  // 5. Confidence→kind demotion (never drops).
  const demoted = applyConfidenceToKind(
    anchored.comments,
    input.config?.securityFloor !== undefined ? { securityFloor: input.config.securityFloor } : {},
  );
  const demotionEntries = demotionsToDegraded(demoted.demotions);

  // 6. Tier-3 gate, same rule as review-mode applyHardRules.
  const verbose = input.config?.verbose === true;
  const gated = verbose ? demoted.comments : demoted.comments.filter((c) => c.tier !== 3);
  const gatedCount = demoted.comments.length - gated.length;
  if (gatedCount > 0) {
    postPass.push({
      kind: "info",
      topic: "post-pass",
      message: `post-pass: gated ${gatedCount} tier-3 ${
        gatedCount === 1 ? "finding" : "findings"
      } — pass --verbose to surface`,
    });
  }

  // 7. Priority sort.
  const sorted = [...gated].sort(compareByPriority);

  // 8. Dedupe by id, keeping the first (highest-priority) occurrence.
  const seen = new Set<string>();
  const deduped: Comment[] = [];
  let dupeCount = 0;
  for (const c of sorted) {
    if (seen.has(c.id)) {
      dupeCount += 1;
      continue;
    }
    seen.add(c.id);
    deduped.push(c);
  }
  if (dupeCount > 0) {
    postPass.push({
      kind: "info",
      topic: "post-pass",
      message: `post-pass: deduped ${dupeCount} duplicate ${
        dupeCount === 1 ? "finding" : "findings"
      } by id`,
    });
  }

  // 9. Volume cap: every Tier-1 comment is kept; remaining slots go to
  // non-Tier-1 comments in sorted order. Output stays in sorted order.
  const tier1 = deduped.filter((c) => c.tier === 1);
  const rest = deduped.filter((c) => c.tier !== 1);
  const slots = Math.max(0, cap - tier1.length);
  const capped =
    cap === Infinity ? deduped : [...tier1, ...rest.slice(0, slots)].sort(compareByPriority);
  const capDropped = deduped.length - capped.length;
  if (capDropped > 0) {
    postPass.push({
      kind: "info",
      topic: "post-pass",
      message: `post-pass: dropped ${capDropped} ${
        capDropped === 1 ? "finding" : "findings"
      } over the volume cap of ${cap}`,
    });
  }

  const laneHealth = laneHealthEntries(input.lanes, unhealthy);

  return {
    comments: capped,
    metadata: {
      durationMs: Date.now() - startedAt,
      degradedWorkers: [
        ...(input.extraDegraded ?? []),
        ...laneHealth,
        ...postPass,
        ...pruneDegraded,
        ...verified.degraded,
        ...demotionEntries,
      ],
    },
  };
}

/**
 * Slice #42: the lane scope envelope derivation, shared by the post-pass
 * (added-line anchoring) and the driver (the trusted `scope` it hands the
 * post-pass). Changed-file paths from the pruned diff — one helper so the
 * two can never disagree on what "in scope" means.
 */
export function deriveLaneScope(diff: string): string[] {
  return pruneDiff(parseUnifiedDiff(diff)).pruned.map((file) => file.path);
}

/**
 * Slice #42: the core-owned verdict predicate. True iff any `actionable`
 * entry carries topic `lane-health` or `diff-source` — the no-findings
 * contract: no lanes, every lane failed/unhealthy, or an empty diff is
 * not a clean result.
 */
export function isNotClean(result: CommentSet): boolean {
  return result.metadata.degradedWorkers.some(
    (e) => e.kind === "actionable" && (e.topic === "lane-health" || e.topic === "diff-source"),
  );
}

function resolveVolumeCap(volumeCap: number | undefined): number {
  const cap = volumeCap ?? DEFAULT_VOLUME_CAP;
  if (cap === Infinity) return cap;
  if (!Number.isInteger(cap) || cap <= 0) {
    throw new RangeError(
      `post-pass: volumeCap must be a positive integer or Infinity (got ${String(volumeCap)})`,
    );
  }
  return cap;
}

function laneHealthEntries(
  lanes: LaneOutput[],
  unhealthy: { index: number; lane: string; count: number }[],
): DegradedEntry[] {
  if (lanes.length === 0) {
    return [
      {
        kind: "actionable",
        topic: "lane-health",
        message: "no review lanes reported — this is NOT a clean result",
      },
    ];
  }
  const failed = lanes.filter((l) => l.status === "failed");
  if (failed.length === lanes.length) {
    const reasons = failed.map((l) => `${l.lane}: ${l.reason ?? "no reason given"}`).join("; ");
    return [
      {
        kind: "actionable",
        topic: "lane-health",
        message: `all ${lanes.length} review lanes failed — this is NOT a clean result (${reasons})`,
      },
    ];
  }
  if (failed.length === 0 && unhealthy.length === 0) {
    return [];
  }
  const failedIdx = new Set(lanes.flatMap((l, i) => (l.status === "failed" ? [i] : [])));
  const unhealthyIdx = new Set(unhealthy.map((u) => u.index));
  const allCovered = lanes.every((_, i) => failedIdx.has(i) || unhealthyIdx.has(i));
  const parts: string[] = [];
  if (failed.length > 0) {
    parts.push(failed.map((l) => `${l.lane}: ${l.reason ?? "no reason given"}`).join("; "));
  }
  if (unhealthy.length > 0) {
    parts.push(
      unhealthy
        .map(
          (u) =>
            `${u.lane}: all ${u.count} ${u.count === 1 ? "finding" : "findings"} dropped by validation/scope`,
        )
        .join("; "),
    );
  }
  const detail = parts.join("; ");
  if (allCovered) {
    return [
      {
        kind: "actionable",
        topic: "lane-health",
        message: `all ${lanes.length} review lanes failed or unhealthy — this is NOT a clean result (${detail})`,
      },
    ];
  }
  return [
    {
      kind: "warning",
      topic: "lane-health",
      message: `${failed.length + unhealthy.length} of ${lanes.length} review lanes failed or unhealthy (${detail}) — partial results`,
    },
  ];
}

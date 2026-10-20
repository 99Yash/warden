import {
  ReviewFailedError,
  type CommentSet,
  type CostByTier,
  type CostLabelsByTier,
  type DegradedEntry,
  type ReviewInput,
  type ReviewSpend,
  type Tier,
} from "@warden/core";
import pc from "picocolors";

export function formatCommentSet(
  result: CommentSet,
  mode: ReviewInput["config"]["mode"] | "security",
  verbose = false,
): string {
  const lines: string[] = [];

  if (result.comments.length === 0) {
    lines.push(pc.green(`warden ${mode}: no findings.`));
  } else {
    lines.push(
      pc.bold(
        `warden ${mode}: ${result.comments.length} finding${result.comments.length === 1 ? "" : "s"}`,
      ),
    );
    for (const c of result.comments) {
      const sev = tierSwatch(c.tier);
      const loc = pc.cyan(`${c.file}:${c.lineStart}`);
      const cat = pc.dim(`[${c.category}]`);
      lines.push(`${sev} ${loc} ${cat} ${c.claim}`);
    }
  }

  // M14 (ADR-0030) summary line: duration + total cost + per-model
  // breakdown when token usage is available. Check mode skips the cost
  // half — zero LLM calls, zero cost (ADR-0011).
  lines.push(pc.dim(`  ${renderSummaryLine(result)}`));

  // ADR-0021 #7: default mode shows only `actionable`-kind entries (the user
  // can fix these); `--verbose` surfaces warning + info as well. Filtering
  // happens here, not at the core boundary, so JSON consumers always see the
  // unfiltered metadata.
  const visible = verbose
    ? result.metadata.degradedWorkers
    : result.metadata.degradedWorkers.filter((e: DegradedEntry) => e.kind === "actionable");
  if (visible.length > 0) {
    lines.push(pc.yellow(`  degraded: ${visible.map((e) => e.message).join(", ")}`));
  }

  return lines.join("\n");
}

/**
 * The stderr text for a command that failed. The first line is always
 * `warden: <message>`. A failed review (`ReviewFailedError`) adds a second
 * line with the spend known at the failure, so the user sees what the
 * failed run cost:
 *
 *   warden: review-harness boss: … failed (…); Gemini fallback skipped (tools required)
 *   warden: spent before the failure: ≥ $0.42 (gpt-6.1-sol $0.31 · gpt-6-luna $0.11); 1 model request reported no usage; review run run_…
 *
 * The caller keeps the exit code.
 */
export function formatCliError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const lines = [pc.red(`warden: ${message}`)];
  if (err instanceof ReviewFailedError) {
    lines.push(pc.yellow(`warden: ${renderFailureSpend(err.spend)}`));
  }
  return lines.join("\n");
}

/**
 * The spend line of a failed review. `≥` marks a lower bound, as on the
 * summary line. A failure that has no usage at all reads `$0.00`.
 */
function renderFailureSpend(spend: ReviewSpend | undefined): string {
  if (spend === undefined) return "spent before the failure: unknown (the usage could not be read)";
  const cost = spend.costUsd ?? 0;
  const unknown = spend.usageUnknownRequests;
  const amount = cost === 0 ? "$0.00" : formatUsd(cost);
  const breakdown = renderCostBreakdown(spend.costByTier, spend.costLabels);
  const parts = [
    `spent before the failure: ${unknown !== undefined ? `≥ ${amount}` : amount}` +
      (breakdown ? ` (${breakdown})` : ""),
  ];
  if (unknown !== undefined) {
    parts.push(`${unknown} model request${unknown === 1 ? "" : "s"} reported no usage`);
  }
  parts.push(`review run ${spend.runId}`);
  return parts.join("; ");
}

function tierSwatch(tier: Tier): string {
  if (tier === 1) return pc.red("●");
  if (tier === 2) return pc.yellow("●");
  return pc.dim("●");
}

/**
 * "Done in 47.3s · $0.42 (claude-opus-4-8 $0.31 · gpt-5.4-mini $0.08)"
 * ("≥ $0.42" when `metadata.usageUnknownRequests` is set: a lower bound).
 *
 * Falls back to "duration: 4660ms" (the pre-M14 shape) when cost is
 * absent — that's the `warden check` path (no LLM calls) and the
 * empty-diff / no-package-json review path (harness short-circuited).
 *
 * Pricing lives in `packages/core/src/review-harness/harness.ts` —
 * `metadata.costByTier` carries the pre-computed per-tier dollars so we
 * don't duplicate the price table here.
 */
function renderSummaryLine(result: CommentSet): string {
  const wall = formatDuration(result.metadata.durationMs);
  const cost = result.metadata.costUsd;
  if (cost === undefined || cost === 0) {
    return `duration: ${result.metadata.durationMs}ms`;
  }
  const breakdown = renderCostBreakdown(result.metadata.costByTier, result.metadata.costLabels);
  // Some model requests reported no usage: the cost is a lower bound.
  const lowerBound = result.metadata.usageUnknownRequests !== undefined;
  const costStr = lowerBound ? `≥ ${formatUsd(cost)}` : formatUsd(cost);
  return breakdown ? `Done in ${wall} · ${costStr} (${breakdown})` : `Done in ${wall} · ${costStr}`;
}

function renderCostBreakdown(
  costByTier: CostByTier | undefined,
  costLabels: CostLabelsByTier | undefined,
): string {
  if (!costByTier) return "";
  const parts: string[] = [];
  if (costByTier.opus !== undefined) {
    parts.push(`${costLabels?.opus ?? "opus"} ${formatUsd(costByTier.opus)}`);
  }
  if (costByTier.sonnet !== undefined) {
    parts.push(`${costLabels?.sonnet ?? "sonnet"} ${formatUsd(costByTier.sonnet)}`);
  }
  if (costByTier.haiku !== undefined) {
    parts.push(`${costLabels?.haiku ?? "haiku"} ${formatUsd(costByTier.haiku)}`);
  }
  return parts.join(" · ");
}

function formatUsd(n: number): string {
  if (n < 0.01) return `<$0.01`;
  return `$${n.toFixed(2)}`;
}

function formatDuration(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  const seconds = ms / 1_000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remSeconds = Math.round(seconds - minutes * 60);
  return `${minutes}m${remSeconds.toString().padStart(2, "0")}s`;
}

import type {
  CommentSet,
  CostByTier,
  CostLabelsByTier,
  DegradedEntry,
  ReviewInput,
  Tier,
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

function tierSwatch(tier: Tier): string {
  if (tier === 1) return pc.red("●");
  if (tier === 2) return pc.yellow("●");
  return pc.dim("●");
}

/**
 * "Done in 47.3s · $0.42 (claude-opus-4-8 $0.31 · gpt-5.4-mini $0.08)"
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
  const costStr = formatUsd(cost);
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

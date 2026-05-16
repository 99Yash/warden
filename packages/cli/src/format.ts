import type {
  Category,
  CommentSet,
  DegradedEntry,
  ReviewInput,
  Tier,
  TokenUsageByTier,
} from "@warden/core";
import pc from "picocolors";

const PRIORITY_ORDER: Category[] = [
  "correctness",
  "security",
  "vulnerability",
  "contract",
  "scalability",
  "consistency",
  "deadcode",
  "committability",
  "clarity",
  "style",
  "leverage",
  "dedup",
  "tests",
];

export function formatCommentSet(
  result: CommentSet,
  mode: ReviewInput["config"]["mode"],
  verbose = false,
): string {
  const lines: string[] = [];

  if (result.comments.length === 0) {
    lines.push(pc.green(`warden ${mode}: no findings.`));
  } else {
    const sorted = [...result.comments].sort((a, b) => {
      const pa = PRIORITY_ORDER.indexOf(a.category);
      const pb = PRIORITY_ORDER.indexOf(b.category);
      if (pa !== pb) return pa - pb;
      if (a.tier !== b.tier) return a.tier - b.tier;
      return b.confidence - a.confidence;
    });

    lines.push(
      pc.bold(`warden ${mode}: ${result.comments.length} finding${result.comments.length === 1 ? "" : "s"}`),
    );
    for (const c of sorted) {
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
 * "Done in 47.3s · $0.42 (opus-4-6 $0.31 · sonnet-4-6 $0.08 · haiku-4-5 $0.03)"
 *
 * Falls back to "duration: 4660ms" (the pre-M14 shape) when token usage
 * is absent — that's the `warden check` path (no LLM calls) and the
 * empty-diff / no-package-json review path (harness short-circuited).
 */
function renderSummaryLine(result: CommentSet): string {
  const wall = formatDuration(result.metadata.durationMs);
  const cost = result.metadata.costUsd;
  if (cost === undefined || cost === 0) {
    return `duration: ${result.metadata.durationMs}ms`;
  }
  const breakdown = renderCostBreakdown(result.metadata.tokenUsage);
  const costStr = formatUsd(cost);
  return breakdown
    ? `Done in ${wall} · ${costStr} (${breakdown})`
    : `Done in ${wall} · ${costStr}`;
}

function renderCostBreakdown(tokenUsage: TokenUsageByTier | undefined): string {
  if (!tokenUsage) return "";
  const parts: string[] = [];
  if (tokenUsage.opus) parts.push(`opus-4-6 ${formatUsd(tierCost(tokenUsage.opus, "opus"))}`);
  if (tokenUsage.sonnet) parts.push(`sonnet-4-6 ${formatUsd(tierCost(tokenUsage.sonnet, "sonnet"))}`);
  if (tokenUsage.haiku) parts.push(`haiku-4-5 ${formatUsd(tierCost(tokenUsage.haiku, "haiku"))}`);
  return parts.join(" · ");
}

/**
 * Per-tier USD pricing. Mirrors the table in
 * `packages/core/src/review-harness/harness.ts` — if the model lineup
 * changes, update both places. Kept locally so the renderer doesn't have
 * to introspect core internals to print a cost breakdown.
 */
const PRICE_PER_M_TOKENS: Record<"opus" | "sonnet" | "haiku", { input: number; output: number }> = {
  opus: { input: 5, output: 25 },
  sonnet: { input: 3, output: 15 },
  haiku: { input: 1, output: 5 },
};
const CACHE_HIT_PRICE_MULTIPLIER = 0.1;

function tierCost(
  block: { inputTokens: number; outputTokens: number; cachedInputTokens?: number },
  tier: "opus" | "sonnet" | "haiku",
): number {
  const price = PRICE_PER_M_TOKENS[tier];
  const inputCost = (block.inputTokens / 1_000_000) * price.input;
  const cachedCost =
    block.cachedInputTokens !== undefined
      ? (block.cachedInputTokens / 1_000_000) * price.input * CACHE_HIT_PRICE_MULTIPLIER
      : 0;
  const outputCost = (block.outputTokens / 1_000_000) * price.output;
  return inputCost + cachedCost + outputCost;
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

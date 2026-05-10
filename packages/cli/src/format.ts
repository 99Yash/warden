import type { Category, CommentSet, DegradedEntry, ReviewInput, Tier } from "@warden/core";
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

  lines.push(pc.dim(`  duration: ${result.metadata.durationMs}ms`));
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

import { runInit, type InitEvent, type InitOptions } from "@warden/core";
import { configuredEmbeddingProvider, requireProviderApiKey } from "@warden/env";
import pc from "picocolors";
import { createInitRenderer } from "../render.js";

/**
 * `warden init` command (ADR-0019 #5). Validates env up front, delegates
 * to the core orchestrator, and pipes phase events through the renderer
 * for the three-phase walk → chunk → embed UI.
 */

export interface InitCliOpts {
  rebuild?: boolean;
  dryRun?: boolean;
  maxCost?: string;
  json?: boolean;
}

export async function runInitCommand(opts: InitCliOpts, repoRoot: string): Promise<void> {
  // Env first — fails fast (ADR-0008 + ADR-0019 #5), except dry-runs never embed.
  if (!opts.dryRun) {
    requireProviderApiKey(configuredEmbeddingProvider(), "warden init");
  }

  const maxCostUsd = opts.maxCost !== undefined ? parseUsd(opts.maxCost) : undefined;
  const initOpts: InitOptions = {
    rebuild: opts.rebuild === true,
    dryRun: opts.dryRun === true,
    ...(typeof maxCostUsd === "number" ? { maxCostUsd } : {}),
  };

  if (!opts.json) {
    process.stdout.write(pc.dim(`warden init  ${describe(initOpts)}\n`));
  }

  const events: InitEvent[] = [];
  const renderer = !opts.json ? createInitRenderer() : undefined;

  const summary = await runInit({
    repoRoot,
    options: initOpts,
    emit: (event) => {
      events.push(event);
      renderer?.handle(event);
    },
  });

  if (opts.json) {
    process.stdout.write(JSON.stringify({ summary, events }, null, 2) + "\n");
    return;
  }

  if (summary.abortedForCost) {
    process.exitCode = 2;
  }
}

function describe(opts: InitOptions): string {
  const parts: string[] = [];
  if (opts.rebuild) parts.push("rebuild");
  if (opts.dryRun) parts.push("dry-run");
  if (typeof opts.maxCostUsd === "number") parts.push(`max-cost $${opts.maxCostUsd.toFixed(2)}`);
  if (parts.length === 0) return "(walk → chunk → embed)";
  return parts.join(", ");
}

function parseUsd(raw: string): number {
  const cleaned = raw.replace(/^\$/, "").trim();
  const n = Number.parseFloat(cleaned);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`--max-cost must be a non-negative number; got "${raw}"`);
  }
  return n;
}

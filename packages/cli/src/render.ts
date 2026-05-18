import type { DegradedEntry, InitEvent } from "@warden/core";
import logUpdate from "log-update";
import pc from "picocolors";

/**
 * Streaming renderer for the M4 review pipeline + M6 init pipeline. Stays
 * out of `@warden/core` per ADR-0013 (core is I/O-pure); this file owns
 * all stdout writes for the phase log and init progress.
 */

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;
const TAIL_LINES = 3;

export interface PhaseRenderer {
  startLlmPhase(label: string): void;
  appendReasoning(delta: string): void;
  completeLlmPhase(summary: string): void;
  fail(message: string): void;
  /**
   * Ends the current active region with a non-failure notice (e.g. provider
   * fallback engaged). The next `startLlmPhase` will open a fresh region.
   */
  note(message: string): void;
}

export function createPhaseRenderer(): PhaseRenderer {
  let frame = 0;
  let activeLabel = "";
  let reasoningBuffer = "";
  let interval: NodeJS.Timeout | undefined;

  function paint(): void {
    const spinner = pc.cyan(SPINNER_FRAMES[frame % SPINNER_FRAMES.length] ?? "⠋");
    const lines = [`  ${spinner} ${activeLabel}`];
    for (const t of lastNLines(reasoningBuffer, TAIL_LINES)) {
      lines.push(pc.dim(`     ▸ ${t}`));
    }
    logUpdate(lines.join("\n"));
  }

  function tick(): void {
    frame++;
    paint();
  }

  return {
    startLlmPhase(label) {
      activeLabel = label;
      reasoningBuffer = "";
      frame = 0;
      paint();
      interval = setInterval(tick, SPINNER_INTERVAL_MS);
    },
    appendReasoning(delta) {
      reasoningBuffer += delta;
      paint();
    },
    completeLlmPhase(summary) {
      if (interval) clearInterval(interval);
      interval = undefined;
      logUpdate(`  ${pc.green("✓")} ${activeLabel} ${pc.dim(`— ${summary}`)}`);
      logUpdate.done();
    },
    fail(message) {
      if (interval) clearInterval(interval);
      interval = undefined;
      logUpdate(`  ${pc.red("✗")} ${activeLabel} ${pc.dim(`— ${message}`)}`);
      logUpdate.done();
    },
    note(message) {
      if (interval) clearInterval(interval);
      interval = undefined;
      logUpdate(`  ${pc.yellow("!")} ${activeLabel} ${pc.dim(`— ${message}`)}`);
      logUpdate.done();
    },
  };
}

/**
 * Naive sentence-ish splitter for reasoning text. Reasoning tokens often
 * arrive as paragraphs with periods/newlines as natural break points; this
 * is good enough for "show last few thoughts" without a real NLP tokenizer.
 */
function lastNLines(text: string, n: number): string[] {
  if (!text) return [];
  const lines = text
    .split(/[\n.!?]/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  return lines.slice(-n).map((l) => truncate(l, 120));
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * Renders the limitation banner above the phase log for `warden review`
 * (ADR-0019 #7, refined per ADR-0021 #5/#7). One dim yellow line; auto-
 * disappears when no `actionable`-kind entry mentions a banner topic. Not
 * suppressible — banner reflects pipeline state the user should see before
 * trusting the comment set.
 *
 *  - `context` / `embeddings`: index missing / stale — fix with
 *    `warden init` / `warden init --rebuild`.
 *  - `diff-source`: git itself failed (e.g. `--base` resolved to an
 *    unknown ref). Without this, a bogus `--base` produces an empty-diff
 *    "all clear" review with the failure buried in `--json` metadata.
 *    Repo-audit 2026-05-18 #3.
 *
 * Reads the discriminated `kind` field instead of substring-matching on
 * message prefixes. The first matching entry wins (banner is single-line).
 */
const BANNER_TOPICS: ReadonlySet<string> = new Set([
  "context",
  "embeddings",
  "diff-source",
]);

export function renderBannerLine(degraded: DegradedEntry[]): string | null {
  for (const entry of degraded) {
    if (entry.kind === "actionable" && BANNER_TOPICS.has(entry.topic)) {
      return pc.yellow(`! ${entry.message.replace(/^(?:context|diff):\s*/, "")}`);
    }
  }
  return null;
}

/**
 * `warden init` renderer (ADR-0019 #5). Three phases visible to the user
 * — walk → chunk → embed. Pre-flight estimate panel surfaces before
 * Phase 3; observed-throughput ETA refreshes during Phase 3.
 */
export interface InitRenderer {
  handle(event: InitEvent): void;
}

export function createInitRenderer(): InitRenderer {
  let phase: "walk" | "chunk" | "embed" | "done" | "idle" = "idle";
  let frame = 0;
  let interval: NodeJS.Timeout | undefined;
  let label = "";
  let detail = "";

  const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

  function paint(): void {
    if (phase === "idle" || phase === "done") return;
    const spin = pc.cyan(SPINNER[frame % SPINNER.length] ?? "⠋");
    const lines = [`  ${spin} ${label}`];
    if (detail) lines.push(pc.dim(`     ▸ ${detail}`));
    logUpdate(lines.join("\n"));
  }

  function startPhase(name: "walk" | "chunk" | "embed", initialLabel: string): void {
    if (interval) clearInterval(interval);
    phase = name;
    label = initialLabel;
    detail = "";
    frame = 0;
    paint();
    interval = setInterval(() => {
      frame++;
      paint();
    }, 80);
  }

  function finishPhase(name: "walk" | "chunk" | "embed", summary: string): void {
    if (interval) clearInterval(interval);
    interval = undefined;
    logUpdate(`  ${pc.green("✓")} ${name} ${pc.dim(`— ${summary}`)}`);
    logUpdate.done();
    phase = "idle";
  }

  return {
    handle(event) {
      switch (event.type) {
        case "phase-start":
          startPhase(event.phase, `${event.phase}…`);
          break;
        case "walk-complete":
          finishPhase(
            "walk",
            `${event.fileCount} files · ${event.totalLoc.toLocaleString()} LOC${event.usedFallback ? " (fs fallback)" : ""}`,
          );
          break;
        case "estimate":
          renderEstimate(event.estimate, event.abortedForCost);
          break;
        case "chunk-progress":
          if (phase === "chunk") {
            label = `chunking… ${event.processedFiles}/${event.totalFiles}`;
            detail = `${event.chunkCount} chunks so far`;
            paint();
          }
          break;
        case "chunk-complete":
          finishPhase("chunk", `${event.chunkCount} chunks${event.cachedHits ? ` · ${event.cachedHits} cached` : ""}`);
          break;
        case "embed-progress":
          if (phase === "embed") {
            label = `embedding… ${event.completed}/${event.total} batches`;
            const eta = estimateEta(event.completed, event.total, event.elapsedMs);
            const tokensFmt =
              event.promptTokensSoFar > 0 ? ` · ${formatTokens(event.promptTokensSoFar)} tokens` : "";
            detail = eta ? `~${eta} remaining${tokensFmt}` : tokensFmt.trim();
            paint();
          }
          break;
        case "embed-complete":
          finishPhase(
            "embed",
            `${event.newlyEmbedded} new · ${event.cachedHits} cached${event.failed > 0 ? ` · ${event.failed} failed` : ""}`,
          );
          break;
        case "soft-notice":
          process.stdout.write(`  ${pc.yellow("!")} ${pc.dim(event.reason)}\n`);
          break;
        case "phase-degraded":
          process.stdout.write(`  ${pc.yellow("!")} ${pc.dim(event.reason)}\n`);
          break;
        case "complete": {
          const s = event.summary;
          const lines = [
            `  ${pc.green("✓")} Index ready in ${(s.durationMs / 1000).toFixed(1)}s`,
            pc.dim(`     ─ ${s.files.toLocaleString()} files · ${s.chunks.toLocaleString()} chunks`),
          ];
          if (s.dryRun) {
            lines.push(pc.dim(`     ─ dry-run: skipped embedding`));
          } else if (s.abortedForCost) {
            lines.push(pc.yellow(`     ─ aborted before Phase 3 (estimate exceeded --max-cost)`));
          } else {
            lines.push(
              pc.dim(
                `     ─ ${s.cachedChunks.toLocaleString()} cached · ${s.newlyEmbedded.toLocaleString()} newly embedded${s.failedEmbeds > 0 ? ` · ${s.failedEmbeds} failed` : ""}`,
              ),
            );
            if (s.promptTokens > 0) {
              lines.push(pc.dim(`     ─ ${formatTokens(s.promptTokens)} tokens`));
            }
          }
          process.stdout.write(lines.join("\n") + "\n");
          phase = "done";
          break;
        }
      }
    },
  };
}

function renderEstimate(
  estimate: { estimatedChunks: number; estimatedNewChunks: number; estimatedTokens: number; estimatedUsd: number; estimatedSeconds: number },
  abortedForCost: boolean,
): void {
  const head = abortedForCost ? pc.red("Estimate exceeds --max-cost:") : pc.bold("Estimated work:");
  const eta = estimate.estimatedSeconds === 0 ? "instant" : `~${estimate.estimatedSeconds}s`;
  const tokens = formatTokens(estimate.estimatedTokens);
  const usd = `$${estimate.estimatedUsd.toFixed(2)}`;
  const lines = [
    `  ${head}`,
    `    Chunking      ≈ ${estimate.estimatedChunks.toLocaleString()} chunks`,
    `    Embedding     ${eta} ETA · ≈ ${tokens} tokens · ≈ ${usd}`,
  ];
  if (estimate.estimatedNewChunks < estimate.estimatedChunks) {
    lines.push(pc.dim(`    (${(estimate.estimatedChunks - estimate.estimatedNewChunks).toLocaleString()} chunks already cached)`));
  }
  process.stdout.write(lines.join("\n") + "\n");
}

function estimateEta(completed: number, total: number, elapsedMs: number): string | null {
  if (completed === 0 || total === 0) return null;
  const remaining = total - completed;
  if (remaining <= 0) return null;
  const msPer = elapsedMs / completed;
  const etaMs = msPer * remaining;
  if (etaMs < 1000) return "<1s";
  if (etaMs < 60_000) return `${Math.ceil(etaMs / 1000)}s`;
  return `${Math.ceil(etaMs / 60_000)}m`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

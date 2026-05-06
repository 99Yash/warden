import logUpdate from "log-update";
import pc from "picocolors";

/**
 * Streaming renderer for the M4 review pipeline (grilling Q5 / H2 — phase log
 * + reasoning-tail UX). Stays out of `@warden/core` per ADR-0013 (core is
 * I/O-pure); this file owns all stdout writes for the LLM phase.
 *
 * Design:
 *  - The active LLM phase renders as a spinner-prefixed label plus the last
 *    N lines of reasoning tokens, dim, indented. Replaced in place via
 *    `log-update`.
 *  - When the phase completes, the log-update region is finalized to a
 *    `✓ label — summary` line and detached so subsequent output appends
 *    below it normally.
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

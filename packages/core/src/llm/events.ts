/**
 * Streaming events surfaced to the CLI renderer (the phase-log + reasoning-tail
 * UX from the M4 grilling Q5 decision). Core stays I/O-pure per ADR-0013 —
 * these events are emitted via callback, never written to stdout.
 */

export type FormatterEvent =
  | { type: "phase-start"; phase: "llm"; provider: "anthropic" | "google"; modelId: string }
  | { type: "reasoning-delta"; text: string }
  | { type: "phase-complete"; phase: "llm"; revisedCount: number; questionCount: number; durationMs: number }
  | { type: "phase-degraded"; phase: "llm"; reason: string }
  | { type: "fallback-engaged"; from: string; to: string; reason: string };

export type FormatterListener = (event: FormatterEvent) => void;

import type { CommentSet } from "./schema.js";

export * from "./schema.js";

export interface ReviewConfig {
  /** Which pipeline shape to run. `check` skips the LLM formatter; `review` runs the full pipeline. */
  mode: "check" | "review";
}

export interface ReviewInput {
  /** Unified diff text. Empty string means "review the working tree as-is" (handled by future ecosystem detector). */
  diff: string;
  /** Absolute path to the repo root. */
  repoRoot: string;
  config: ReviewConfig;
}

/**
 * Pure entry point for Warden's review pipeline. **I/O-pure** per ADR-0013:
 * no argv, no stdout, no platform-specific imports, no persistent connections.
 * All input arrives via `ReviewInput`; all output is the returned `CommentSet`.
 *
 * Future bot wrappers (GitHub PR bot, Slack bot, ClickUp integration) call
 * this exact function — the signature is the load-bearing contract for
 * `apps/*` deployments.
 *
 * M1 stub. M2 wires ecosystem detection + TSC/ESLint runners.
 * M3 adds `npm audit` + OSV.dev verification. M4 adds the LLM formatter.
 */
export async function review(_input: ReviewInput): Promise<CommentSet> {
  const startedAt = Date.now();
  return {
    comments: [],
    metadata: {
      durationMs: Date.now() - startedAt,
      degradedWorkers: [],
    },
  };
}

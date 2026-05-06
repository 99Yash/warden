#!/usr/bin/env node
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  resolveDiff,
  review,
  type FormatterEvent,
  type ReviewConfig,
  type ResolvedDiff,
} from "@warden/core";
import { wardenEnv } from "@warden/env";
import { Command } from "commander";
import pc from "picocolors";
import { formatCommentSet } from "./format.js";
import { createPhaseRenderer } from "./render.js";

function findUp(filename: string): string | undefined {
  let dir = process.cwd();
  while (true) {
    const candidate = resolve(dir, filename);
    if (existsSync(candidate)) return candidate;
    const parent = resolve(dir, "..");
    if (parent === dir) return undefined;
    dir = parent;
  }
}

// Node 22+ ships process.loadEnvFile natively; loaded before @warden/env is read.
const envPath = findUp(".env");
if (envPath) process.loadEnvFile(envPath);

function findRepoRoot(): string {
  const pnpmWs = findUp("pnpm-workspace.yaml");
  if (pnpmWs) return resolve(pnpmWs, "..");
  const pkg = findUp("package.json");
  if (pkg) return resolve(pkg, "..");
  return process.cwd();
}

const program = new Command();

program
  .name("warden")
  .description(
    "AI code review CLI — runs deterministic tooling, verifies external claims through citable sources, and uses an LLM as a triage layer.",
  )
  .version("0.0.1");

interface CommonOpts {
  json?: boolean;
  base?: string;
  stdin?: boolean;
  verbose?: boolean;
}

async function runReview(mode: ReviewConfig["mode"], opts: CommonOpts): Promise<void> {
  // Validate env at startup even for `check`, so M2+ doesn't surprise the user
  // by failing on first LLM call. ADR-0008's "fail fast at scaffold time."
  wardenEnv();

  const repoRoot = findRepoRoot();
  const { diff, description } = await acquireDiff(repoRoot, mode, opts);

  if (!opts.json) {
    process.stdout.write(pc.dim(`warden ${mode}  ${description}\n`));
  }

  const renderer = !opts.json && mode === "review" ? createPhaseRenderer() : undefined;

  const emit = renderer
    ? (event: FormatterEvent) => {
        switch (event.type) {
          case "phase-start":
            renderer.startLlmPhase(`drafting review (${event.provider}/${event.modelId})`);
            break;
          case "reasoning-delta":
            renderer.appendReasoning(event.text);
            break;
          case "phase-complete":
            renderer.completeLlmPhase(
              `${event.revisedCount} revisions, ${event.questionCount} question${event.questionCount === 1 ? "" : "s"} (${event.durationMs}ms)`,
            );
            break;
          case "phase-degraded":
            renderer.fail(event.reason);
            break;
          case "fallback-engaged":
            // Provider switch — the cascade is recovering, not failing. The
            // next phase-start event opens a fresh spinner under the new
            // provider; here we just close the current region with a yellow
            // notice. (Caught by M4 dogfood: previous version called
            // renderer.fail() which misleadingly painted a red ✗.)
            renderer.note(`${event.from} → ${event.to} (${event.reason})`);
            break;
        }
      }
    : undefined;

  const result = await review({
    diff,
    repoRoot,
    config: { mode, verbose: opts.verbose === true },
    emit,
  });

  if (opts.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }

  process.stdout.write("\n" + formatCommentSet(result, mode) + "\n");
}

async function acquireDiff(
  repoRoot: string,
  mode: ReviewConfig["mode"],
  opts: CommonOpts,
): Promise<ResolvedDiff> {
  if (opts.stdin === true) {
    const diff = await readAllStdin();
    return { diff, description: "stdin" };
  }
  return resolveDiff({ repoRoot, mode, baseRef: opts.base });
}

function readAllStdin(): Promise<string> {
  return new Promise((resolveP, rejectP) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolveP(data));
    process.stdin.on("error", rejectP);
  });
}

const sharedOpts = (cmd: Command): Command =>
  cmd
    .option("--json", "Emit machine-readable JSON output instead of pretty CLI.")
    .option(
      "--base <ref>",
      "Override the base ref for the diff (default: uncommitted in check, vs default-branch in review).",
    )
    .option("--stdin", "Read the unified diff from stdin instead of running git.")
    .option("--verbose", "Surface tier-3 (style/dedup) findings; suppressed by default.");

sharedOpts(
  program
    .command("check")
    .description(
      "Fast deterministic-only review (TSC + ESLint + npm audit + OSV verification). No LLM call. Suitable for pre-commit / CI gating.",
    ),
).action(async (opts: CommonOpts) => {
  await runReview("check", opts);
});

sharedOpts(
  program
    .command("review")
    .description(
      "Full pipeline: deterministic checks + LLM formatter that triages findings, writes citations, and orders comments by review priority.",
    ),
).action(async (opts: CommonOpts) => {
  await runReview("review", opts);
});

program.parseAsync(process.argv).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(pc.red(`warden: ${message}\n`));
  process.exit(1);
});

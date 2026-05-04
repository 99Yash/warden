#!/usr/bin/env node
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { review, type ReviewConfig } from "@warden/core";
import { wardenEnv } from "@warden/env";
import { Command } from "commander";
import pc from "picocolors";
import { formatCommentSet } from "./format.js";

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
}

async function runReview(mode: ReviewConfig["mode"], opts: CommonOpts): Promise<void> {
  // Validate env at startup even for `check`, so M2+ doesn't surprise the user
  // by failing on first LLM call. ADR-0008's "fail fast at scaffold time."
  wardenEnv();

  const result = await review({
    diff: "",
    repoRoot: findRepoRoot(),
    config: { mode },
  });

  if (opts.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }

  process.stdout.write(formatCommentSet(result, mode) + "\n");
}

program
  .command("check")
  .description(
    "Fast deterministic-only review (TSC + ESLint + npm audit + OSV verification). No LLM call. Suitable for pre-commit / CI gating.",
  )
  .option("--json", "Emit machine-readable JSON output instead of pretty CLI.")
  .action(async (opts: CommonOpts) => {
    await runReview("check", opts);
  });

program
  .command("review")
  .description(
    "Full pipeline: deterministic checks + LLM formatter that triages findings, writes citations, and orders comments by review priority.",
  )
  .option("--json", "Emit machine-readable JSON output instead of pretty CLI.")
  .action(async (opts: CommonOpts) => {
    await runReview("review", opts);
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(pc.red(`warden: ${message}\n`));
  process.exit(1);
});

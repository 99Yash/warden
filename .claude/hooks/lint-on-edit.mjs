#!/usr/bin/env node
// Edit-time half of `pnpm lint` (the root `.oxlintrc.json`). Ported from alfred.
//
// Runs the repo's own oxlint, with the root config, on the one file an edit just
// wrote, so a rule speaks at the moment of the mistake instead of in CI. It
// reports every diagnostic the config fires: every rule there is at "error" and
// the tree is at zero, so each one is a diagnostic `pnpm lint` will reject. A
// rule added to the config is reported here with no table to keep in step.
//
// Advisory only. It runs after the write, so it cannot block it, and it always
// exits 0. It prints nothing when the file is clean, when the file is not
// `.ts`/`.tsx`/`.mts` under the repo, when the file does not parse yet, or when
// oxlint is missing, slow, or prints output it cannot read.
//
// Reads PostToolUse JSON on stdin, prints hookSpecificOutput JSON, exits 0.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative } from "node:path";

// Advisory: a bug in this file must not surface as a hook error on every edit.
process.on("uncaughtException", () => process.exit(0));

const ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();

// The root config sets `options.typeAware`, so this run includes the type-aware
// rules; tsgolint builds the program for the one file's tsconfig. Past this,
// give up silently rather than stall the session.
const TIMEOUT_MS = 5_000;

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

let payload = {};

try {
  payload = JSON.parse(readStdin() || "{}");
} catch {
  process.exit(0);
}

const filePath = String(payload.tool_input?.file_path ?? "");

if (!filePath.startsWith(`${ROOT}/`) || !/\.(tsx?|mts)$/.test(filePath)) process.exit(0);

if (!existsSync(filePath)) process.exit(0);

// Lint from the checkout that owns the file, not from the session root. An agent
// worktree under `.claude/worktrees/<name>/` is its own checkout. From the main
// root its files sit at `.claude/worktrees/<name>/packages/...`, so `overrides`
// globs such as `packages/env/src/**` miss them and allowed code reads as an
// error. `git rev-parse --show-toplevel` returns the worktree root for them.
const top = spawnSync("git", ["-C", dirname(filePath), "rev-parse", "--show-toplevel"], {
  encoding: "utf8",
  timeout: TIMEOUT_MS,
});

const repoRoot = top.status === 0 && top.stdout.trim() ? top.stdout.trim() : ROOT;

const CONFIG = join(repoRoot, ".oxlintrc.json");

const OXLINT = [repoRoot, ROOT]
  .map((dir) => join(dir, "node_modules", ".bin", "oxlint"))
  .find((bin) => existsSync(bin));

if (!OXLINT || !existsSync(CONFIG)) process.exit(0);

// git prints the real path; the payload path can go through a symlink.
const rel = relative(realpathSync(repoRoot), realpathSync(filePath));

if (rel.startsWith("..")) process.exit(0);

// The same config as `pnpm lint`, from that checkout's root, so `overrides`
// globs and `ignorePatterns` resolve as they do there.
const run = spawnSync(
  OXLINT,
  ["--config", CONFIG, "--no-error-on-unmatched-pattern", "--format", "json", rel],
  { cwd: repoRoot, encoding: "utf8", timeout: TIMEOUT_MS },
);

if (run.error || !run.stdout) process.exit(0);

let report;

try {
  report = JSON.parse(run.stdout.slice(run.stdout.indexOf("{")));
} catch {
  process.exit(0);
}

// A diagnostic with no rule `code` is a parse failure. A half-written file has
// one, and the compiler already reports it, so it is not a lint finding.
const diagnostics = (Array.isArray(report?.diagnostics) ? report.diagnostics : []).filter(
  (d) => d?.code,
);

if (diagnostics.length === 0) process.exit(0);

/** `anti-slop(no-reflect-apply)` is spelled `anti-slop/no-reflect-apply` in config and disable comments. */
const ruleId = (code) => String(code ?? "").replace(/^([\w-]+)\((.+)\)$/, "$1/$2");

const lines = diagnostics.map((d) => {
  const at = d.labels?.[0]?.span?.line;

  return `- \`${ruleId(d.code)}\`${at ? ` (line ${at})` : ""}: ${String(d.message ?? "").trim()}`;
});

const body = [
  `# \`pnpm lint\` will reject \`${rel}\``,
  `oxlint with the root \`.oxlintrc.json\` reports ${diagnostics.length} diagnostic(s) on the file you just wrote. Fix them, or add \`// oxlint-disable-next-line <rule> -- <reason>\` if the exception is deliberate.`,
  ``,
  ...lines,
].join("\n");

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: body },
  }),
);

#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  PostPassLanesSchema,
  isNotClean,
  resolveDiff,
  review,
  runPostPass,
  security as securityReview,
  shutdownObservability,
  type CommentSet,
  type FormatterEvent,
  type ReviewConfig,
  type ResolvedDiff,
} from "@warden/core";
import {
  configuredReviewLlmProviders,
  loadWardenRuntime,
  requireAnyProviderApiKey,
} from "@warden/env";
import { startMcpServer } from "@warden/mcp";
import { Command } from "commander";
import pc from "picocolors";
import { runInitCommand } from "./commands/init.js";
import { runSetupCommand, type SetupCliOpts } from "./commands/setup.js";
import { formatCommentSet } from "./format.js";
import { createPhaseRenderer, renderBannerLine } from "./render.js";
import { runOpencodeReview } from "./opencode/drive.js";

function findUp(filename: string): string | undefined {
  let dir = process.cwd();
  while (true) {
    const candidate = resolve(dir, filename);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- probes fixed Warden filenames while walking cwd ancestors.
    if (existsSync(candidate)) return candidate;
    const parent = resolve(dir, "..");
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function findRepoRoot(): string {
  const pnpmWs = findUp("pnpm-workspace.yaml");
  if (pnpmWs) return resolve(pnpmWs, "..");
  const git = findUp(".git");
  if (git) return resolve(git, "..");
  const pkg = findUp("package.json");
  if (pkg) return resolve(pkg, "..");
  return process.cwd();
}

const program = new Command();

program
  .name("warden")
  .description(
    "AI code review CLI — runs deterministic tooling in parallel, dispatches LLM workers per concern, and ships only citation-verified findings.",
  )
  .version("0.0.1");

interface CommonOpts {
  json?: boolean;
  base?: string;
  stdin?: boolean;
  verbose?: boolean;
  deep?: boolean;
}

async function runReview(mode: ReviewConfig["mode"], opts: CommonOpts): Promise<void> {
  const repoRoot = findRepoRoot();
  loadWardenRuntime({ repoRoot });
  if (mode === "review") {
    requireAnyProviderApiKey(configuredReviewLlmProviders(), "warden review");
  }

  const resolved = await acquireDiff(repoRoot, mode, opts);
  const { diff, description, baseRef, degraded: diffDegraded } = resolved;

  if (!opts.json) {
    process.stdout.write(pc.dim(`warden ${mode}  ${description}\n`));
  }

  // ADR-0019 #7: limitation banner — rendered once after `review()` returns,
  // above the formatted comment set, when the index is missing / stale / behind.
  // The banner string lives in `result.metadata.degradedWorkers`. (Skipped on
  // --json — JSON consumers read it from the structured metadata directly.)
  const renderer = !opts.json && mode === "review" ? createPhaseRenderer() : undefined;

  // M14 (ADR-0030): the boss-loop emits the same FormatterEvent shape the
  // M4 formatter did, so the existing phase-log renderer works unchanged
  // — phase-start opens a spinner (now labeled "review harness boss
  // loop"), reasoning-delta streams Opus's thinking, phase-complete
  // closes with a comment count. The summary line (cost + duration) is
  // rendered by `formatCommentSet()` after the boss-loop returns.
  const emit = renderer
    ? (event: FormatterEvent) => {
        switch (event.type) {
          case "phase-start":
            renderer.startLlmPhase(`review harness boss loop (${event.provider}/${event.modelId})`);
            break;
          case "reasoning-delta":
            renderer.appendReasoning(event.text);
            break;
          case "phase-complete":
            renderer.completeLlmPhase(
              `${event.questionCount} question${event.questionCount === 1 ? "" : "s"} drafted (${event.durationMs}ms)`,
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
    config: {
      mode,
      verbose: opts.verbose === true,
      ...(mode === "review" && opts.deep === true ? { deep: true } : {}),
    },
    emit,
    ...(diffDegraded && diffDegraded.length > 0 ? { extraDegraded: diffDegraded } : {}),
    // ADR-0046: forward the resolved base so the react-doctor det-prior can
    // drive its `--scope changed` delta against the same base warden diffed.
    diffBase: { ...(baseRef !== undefined ? { baseRef } : {}), description },
  });

  // Issue #29: if the harness flagged that every review worker errored, the
  // empty result is a false-clean, not a passing review. Signal non-zero so
  // CI / scripts don't treat the silent failure as success. Applies to both
  // the JSON and pretty output paths.
  const allWorkersFailed = result.metadata.degradedWorkers.some(
    (e) => e.kind === "actionable" && e.topic === "worker-health",
  );
  if (allWorkersFailed) process.exitCode = 1;

  if (writeJsonResult(result, opts)) return;

  if (mode === "review") {
    const bannerLine = renderBannerLine(result.metadata.degradedWorkers);
    if (bannerLine) {
      process.stdout.write("\n" + bannerLine + "\n");
    }
  }

  process.stdout.write("\n" + formatCommentSet(result, mode, opts.verbose === true) + "\n");
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
    .option(
      "--verbose",
      "Surface tier-3 (style/dedup) findings and expand the npm-audit summary to per-advisory comments; both suppressed by default.",
    );

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
      "Full 3-phase review: deterministic priors → Opus boss dispatches per-concern Sonnet/Haiku workers → citation verify. Orders comments by review priority.",
    ),
)
  .option("--deep", "Also run the dedicated M18 deep-security harness.")
  .action(async (opts: CommonOpts) => {
    await runReview("review", opts);
  });

sharedOpts(
  program
    .command("security")
    .description(
      "Focused deep-security review. Runs the M18 security triage gate and dedicated security harness.",
    ),
).action(async (opts: CommonOpts) => {
  await runSecurity(opts);
});

program
  .command("post-pass")
  .description(
    "Deterministic post-pass over externally-driven lane findings. No LLM call. Emits the canonical CommentSet.",
  )
  .option("--lanes <path>", "Path to the lanes JSON ({version, lanes}), or - for stdin.")
  .option("--diff-file <path>", "Read the unified diff from a literal file instead of git.")
  .option(
    "--base <ref>",
    "Override the base ref for the git-resolved diff (rejected together with --diff-file).",
  )
  .option("--json", "Emit machine-readable JSON output instead of pretty CLI.")
  .option("--verbose", "Keep tier-3 (style/dedup) findings; gated by default.")
  .option("--volume-cap <n>", "Maximum comments to emit; Tier-1 always kept. Default 5.")
  .action(async (opts: PostPassOpts) => {
    await runPostPassCommand(opts);
  });

program
  .command("opencode-review")
  .description(
    "Run the down lane in OpenCode, build the trusted lane envelope, and publish only the runPostPass CommentSet. No warden provider key needed.",
  )
  .option(
    "--base <ref>",
    "Override the base ref for the diff (default: vs default-branch, like review).",
  )
  .option(
    "--model <provider/model#variant>",
    "Lane model override (default: the lane spec's strong-tier default).",
  )
  .option("--json", "Emit machine-readable JSON output instead of pretty CLI.")
  .option("--verbose", "Keep tier-3 (style/dedup) findings; gated by default.")
  .option("--volume-cap <n>", "Maximum comments to emit; Tier-1 always kept. Default 5.")
  .option(
    "--lanes-out <path>",
    "Write the lane envelope JSON here (audit / replay through warden post-pass).",
  )
  .option("--timeout <seconds>", "Kill the OpenCode child after N seconds. Default 900.")
  .option(
    "--mcp-timeout <seconds>",
    "Wait up to N seconds for the warden MCP server to connect. Default 30.",
  )
  .action(async (opts: OpencodeReviewOpts) => {
    await runOpencodeReviewCommand(opts);
  });

program
  .command("mcp")
  .description("Start Warden's MCP tool-provider over stdio. Stdout is reserved for JSON-RPC.")
  .action(async () => {
    const repoRoot = findRepoRoot();
    loadWardenRuntime({ repoRoot });
    // Do not use sharedOpts, runReview, or the phase renderer here: stdin and
    // stdout belong exclusively to the MCP transport, not diff input or logs.
    await startMcpServer({ repoRoot });
    // Post-session continuation: startMcpServer now only resolves after the
    // session actually ends (client EOF drains in-flight calls, then the
    // server closes), so this marker doubles as the smoke's observable proof
    // that post-session cleanup runs.
    process.stderr.write("warden mcp: session ended\n");
  });

program
  .command("setup [target]")
  .description(
    "Create Warden's global config/env templates and report provider readiness. Use `warden setup project` for a repo-level config override.",
  )
  .option("--check", "Only report config/env/provider readiness; do not write files.")
  .option("--project", "Also create warden.jsonc in the current repository.")
  .option("--json", "Emit machine-readable JSON output instead of pretty CLI.")
  .action(async (target: string | undefined, opts: SetupCliOpts) => {
    if (target !== undefined && target !== "project") {
      throw new Error(`Unknown setup target "${target}". Did you mean "warden setup project"?`);
    }
    const repoRoot = findRepoRoot();
    await runSetupCommand(
      {
        ...opts,
        project: opts.project === true || target === "project",
      },
      repoRoot,
    );
  });

program
  .command("init")
  .description(
    "Build (or refresh) the embedding-backed context index used by `warden review`. Walk → chunk → embed; idempotent re-runs hit the cache.",
  )
  .option(
    "--rebuild",
    "Drop the locked-model embeddings and re-embed under the current default SKU.",
  )
  .option("--dry-run", "Run Phases 1+2 (walk + chunk) and print the estimate; skip Voyage calls.")
  .option(
    "--max-cost <usd>",
    "Abort before Phase 3 (embedding) if the estimate exceeds this USD value.",
  )
  .option("--json", "Emit structured event log + summary instead of the phase-log UI.")
  .action(
    async (opts: { rebuild?: boolean; dryRun?: boolean; maxCost?: string; json?: boolean }) => {
      const repoRoot = findRepoRoot();
      loadWardenRuntime({ repoRoot });
      await runInitCommand(opts, repoRoot);
    },
  );

program.parseAsync(process.argv).then(
  // ADR-0048 §3 — force-flush the OTEL→Langfuse exporter before the
  // short-lived CLI process exits, or in-flight spans are lost. No-op when
  // telemetry never started (no Langfuse keys).
  () => shutdownObservability(),
  async (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(pc.red(`warden: ${message}\n`));
    await shutdownObservability();
    process.exit(1);
  },
);

async function runSecurity(opts: CommonOpts): Promise<void> {
  const repoRoot = findRepoRoot();
  loadWardenRuntime({ repoRoot });
  const resolved = await acquireDiff(repoRoot, "review", opts);
  const { diff, description, degraded: diffDegraded } = resolved;

  if (!opts.json) {
    process.stdout.write(pc.dim(`warden security  ${description}\n`));
  }

  const result = await securityReview({
    diff,
    repoRoot,
    config: { mode: "security", verbose: opts.verbose === true },
    ...(diffDegraded && diffDegraded.length > 0 ? { extraDegraded: diffDegraded } : {}),
  });

  if (writeJsonResult(result, opts)) return;

  process.stdout.write("\n" + formatCommentSet(result, "security", opts.verbose === true) + "\n");
}

interface OpencodeReviewOpts {
  base?: string;
  model?: string;
  json?: boolean;
  verbose?: boolean;
  volumeCap?: string;
  lanesOut?: string;
  timeout?: string;
  mcpTimeout?: string;
}

/**
 * Slice #42 / ADR-0053 §4: the driven path. All lane logic lives in
 * `opencode/drive.ts`; this handler only parses flags.
 */
async function runOpencodeReviewCommand(opts: OpencodeReviewOpts): Promise<void> {
  const repoRoot = findRepoRoot();
  loadWardenRuntime({ repoRoot });

  let volumeCap: number | undefined;
  if (opts.volumeCap !== undefined) {
    const n = Number(opts.volumeCap);
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error(
        `opencode-review: --volume-cap must be a positive integer (got "${opts.volumeCap}")`,
      );
    }
    volumeCap = n;
  }
  let timeoutSecs: number | undefined;
  if (opts.timeout !== undefined) {
    const n = Number(opts.timeout);
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error(
        `opencode-review: --timeout must be a positive number (got "${opts.timeout}")`,
      );
    }
    timeoutSecs = n;
  }
  let mcpTimeoutSecs: number | undefined;
  if (opts.mcpTimeout !== undefined) {
    const n = Number(opts.mcpTimeout);
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error(
        `opencode-review: --mcp-timeout must be a positive number (got "${opts.mcpTimeout}")`,
      );
    }
    mcpTimeoutSecs = n;
  }

  await runOpencodeReview({
    repoRoot,
    ...(opts.base !== undefined ? { baseRef: opts.base } : {}),
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    ...(opts.json !== undefined ? { json: opts.json } : {}),
    ...(opts.verbose !== undefined ? { verbose: opts.verbose } : {}),
    ...(volumeCap !== undefined ? { volumeCap } : {}),
    ...(opts.lanesOut !== undefined ? { lanesOut: opts.lanesOut } : {}),
    ...(timeoutSecs !== undefined ? { timeoutSecs } : {}),
    ...(mcpTimeoutSecs !== undefined ? { mcpTimeoutSecs } : {}),
  });
}

function writeJsonResult(result: CommentSet, opts: { json?: boolean }): boolean {
  if (!opts.json) return false;
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  return true;
}

interface PostPassOpts {
  lanes?: string;
  diffFile?: string;
  base?: string;
  json?: boolean;
  verbose?: boolean;
  volumeCap?: string;
}

/**
 * Slice #41 / ADR-0053 §4: the driver step. Reads externally-driven lane
 * findings, runs the mandatory post-pass, and publishes only its
 * `CommentSet`. Deterministic — no provider key required. Not an MCP tool.
 */
async function runPostPassCommand(opts: PostPassOpts): Promise<void> {
  const repoRoot = findRepoRoot();
  loadWardenRuntime({ repoRoot });

  if (opts.lanes === undefined) {
    throw new Error("post-pass: --lanes <path|-> is required");
  }
  const raw =
    opts.lanes === "-" ? await readAllStdin() : readFileSync(resolve(repoRoot, opts.lanes), "utf8");
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error("post-pass: lanes input is not valid JSON", { cause: err });
  }
  const lanesParsed = PostPassLanesSchema.safeParse(json);
  if (!lanesParsed.success) {
    const problems = lanesParsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(`post-pass: lanes input failed PostPassLanesSchema validation: ${problems}`);
  }

  if (opts.diffFile !== undefined && opts.base !== undefined) {
    throw new Error("post-pass: --diff-file and --base are mutually exclusive");
  }
  let diff: string;
  let extraDegraded: ResolvedDiff["degraded"];
  if (opts.diffFile !== undefined) {
    diff = readFileSync(resolve(repoRoot, opts.diffFile), "utf8");
  } else {
    const resolved = await resolveDiff({ repoRoot, mode: "review", baseRef: opts.base });
    diff = resolved.diff;
    extraDegraded = resolved.degraded;
  }

  let volumeCap: number | undefined;
  if (opts.volumeCap !== undefined) {
    const n = Number(opts.volumeCap);
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error(
        `post-pass: --volume-cap must be a positive integer (got "${opts.volumeCap}")`,
      );
    }
    volumeCap = n;
  }

  const verbose = opts.verbose === true;
  const result = await runPostPass({
    repoRoot,
    diff,
    lanes: lanesParsed.data.lanes,
    config: {
      verbose,
      ...(volumeCap !== undefined ? { volumeCap } : {}),
    },
    ...(extraDegraded && extraDegraded.length > 0 ? { extraDegraded } : {}),
  });

  // Issue #29 parity: a false-clean (no lanes, every lane failed, or an
  // empty diff that anchored nothing) must not look like success. Only
  // `lane-health` and `diff-source` gate the exit — other actionable
  // entries (e.g. `noise-filter`) fire on normal runs.
  if (isNotClean(result)) {
    process.exitCode = 1;
  }

  if (writeJsonResult(result, opts)) return;
  process.stdout.write("\n" + formatCommentSet(result, "review", verbose) + "\n");
}

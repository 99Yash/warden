/**
 * Offline smoke for the git subprocess environment (ADR-0054 amendment
 * 2026-10-20). Every `git` child gets `gitProcessEnv()` from `@warden/env`:
 * the deterministic set plus a named list of git keys. A provider key in the
 * parent process must not reach git or a program that git starts.
 *
 * The smoke builds a temporary repo and puts a `git` shim first on PATH. The
 * shim writes its argv and `env` to a log file, then runs the real git. The
 * repo also has a textconv driver that writes `env` to a log, so the smoke
 * sees the environment of a program that git itself starts from config.
 *
 * Asserts:
 *   1. Control: the shim, started with the full parent env, logs the fake
 *      key. This proves that the probe can see a leak.
 *   2. `resolveDiff` (`--base`, auto-detected base, and `check` mode) gives
 *      the same diff as a direct git call with the full env.
 *   3. `isGitIgnored`, `walkRepo`, `loadImportGraph`, `collectSymbolRefHits`,
 *      and the grepRepo tool still work through their git calls.
 *   4. Each warden git call is logged; no shim log and no textconv log
 *      contains a fake key value.
 *   5. HOME (global `core.excludesFile`) and GIT_CONFIG_KEY_<n> reach git.
 *
 * No network calls. Needs `git` and `/bin/sh`.
 *
 * Usage:
 *   pnpm --filter @warden/cli smoke:git-env
 */

import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const ROOT = resolve(tmpdir(), `warden-git-env-${process.pid}`);
const REPO = resolve(ROOT, "repo");
const HOME_DIR = resolve(ROOT, "home");
const SHIM_DIR = resolve(ROOT, "bin");
const LOG_DIR = resolve(ROOT, "logs");
const LEAK_MARKER = "WARDEN_SMOKE_LEAK";

rmSync(ROOT, { recursive: true, force: true });
for (const dir of [REPO, HOME_DIR, SHIM_DIR, LOG_DIR]) mkdirSync(dir, { recursive: true });

const realGit = execFileSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
if (!realGit.startsWith("/")) {
  process.stdout.write(`  ✗ no git binary on PATH (got "${realGit}")\n`);
  process.exit(1);
}

// Fake secrets in the parent env. Each value carries LEAK_MARKER.
process.env["ANTHROPIC_API_KEY"] = `sk-ant-${LEAK_MARKER}-anthropic`;
process.env["OPENAI_API_KEY"] = `sk-${LEAK_MARKER}-openai`;
process.env["VOYAGE_API_KEY"] = `pa-${LEAK_MARKER}-voyage`;
process.env["GITHUB_TOKEN"] = `ghp_${LEAK_MARKER}`;
process.env["CUSTOM_SECRET"] = LEAK_MARKER;

// A hermetic home: the global config sets core.excludesFile, so a match on
// `global-ignored.txt` proves that HOME reached git.
for (const key of ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "XDG_CONFIG_HOME", "GIT_DIR"]) {
  delete process.env[key];
}
process.env["HOME"] = HOME_DIR;
process.env["GIT_CONFIG_NOSYSTEM"] = "1";
writeFileSync(resolve(HOME_DIR, "global-ignore"), "global-ignored.txt\n");
writeFileSync(
  resolve(HOME_DIR, ".gitconfig"),
  `[core]\n\texcludesFile = ${resolve(HOME_DIR, "global-ignore")}\n`,
);
process.env["GIT_CONFIG_COUNT"] = "1";
process.env["GIT_CONFIG_KEY_0"] = "warden.smokemarker";
process.env["GIT_CONFIG_VALUE_0"] = "passed";
process.env["WARDEN_CACHE_PATH"] = resolve(ROOT, "cache.sqlite");

const shim = resolve(SHIM_DIR, "git");
writeFileSync(
  shim,
  [
    "#!/bin/sh",
    `log="${LOG_DIR}/call-$$.log"`,
    `printf 'ARGV %s\\n' "$*" > "$log"`,
    `env >> "$log"`,
    `exec "${realGit}" "$@"`,
    "",
  ].join("\n"),
);
chmodSync(shim, 0o755);

const textconv = resolve(SHIM_DIR, "envdump-textconv");
writeFileSync(
  textconv,
  ["#!/bin/sh", `env > "${LOG_DIR}/textconv-$$.log"`, `cat "$1"`, ""].join("\n"),
);
chmodSync(textconv, 0o755);

let failed = 0;
function assert(cond: boolean, msg: string): void {
  process.stdout.write(`  ${cond ? "✓" : "✗"} ${msg}\n`);
  if (!cond) failed++;
}

function readLogs(prefix: string): string[] {
  return readdirSync(LOG_DIR)
    .filter((name) => name.startsWith(prefix))
    .map((name) => readFileSync(resolve(LOG_DIR, name), "utf8"));
}

function clearLogs(): void {
  for (const name of readdirSync(LOG_DIR)) rmSync(resolve(LOG_DIR, name));
}

/** Repo setup and the expected diff: the real git with the full parent env. */
function directGit(args: string[]): string {
  return execFileSync(realGit, args, { cwd: REPO, env: process.env, encoding: "utf8" });
}

process.stdout.write(`\n[1] control: the shim sees a leak when the full env reaches it\n`);
execFileSync(shim, ["--version"], { env: process.env, stdio: "ignore" });
const control = readLogs("call-");
assert(
  control.length === 1 && control.some((log) => log.includes(LEAK_MARKER)),
  "a shim started with the full parent env logs the fake key",
);
clearLogs();

// Fixture repo. main: a.ts exports a symbol, b.ts uses it. feature: changes.
directGit(["init", "-q", "-b", "main"]);
directGit(["config", "user.name", "Warden Smoke"]);
directGit(["config", "user.email", "smoke@warden.invalid"]);
directGit(["config", "commit.gpgsign", "false"]);
directGit(["config", "diff.envdump.textconv", textconv]);
writeFileSync(resolve(REPO, ".gitattributes"), "*.txt diff=envdump\n");
writeFileSync(resolve(REPO, ".gitignore"), "ignored.log\n");
writeFileSync(
  resolve(REPO, "a.ts"),
  "export function wardenSmokeSymbol(): number {\n  return 1;\n}\n",
);
writeFileSync(
  resolve(REPO, "b.ts"),
  'import { wardenSmokeSymbol } from "./a";\n\nwardenSmokeSymbol();\n',
);
writeFileSync(resolve(REPO, "notes.txt"), "one\n");
directGit(["add", "."]);
directGit(["commit", "-q", "-m", "base"]);
directGit(["checkout", "-q", "-b", "feature"]);
writeFileSync(
  resolve(REPO, "a.ts"),
  "export function wardenSmokeSymbol(): number {\n  return 2;\n}\n",
);
writeFileSync(resolve(REPO, "notes.txt"), "one\ntwo\n");
directGit(["commit", "-q", "-am", "feature"]);

const DIFF_FLAGS = ["diff", "--no-ext-diff", "--no-color", "--src-prefix=a/", "--dst-prefix=b/"];
const expectedReview = directGit([...DIFF_FLAGS, "main...HEAD"]);
clearLogs();

// The shim goes first on PATH only after the setup, so the setup is not logged.
process.env["PATH"] = `${SHIM_DIR}:${process.env["PATH"] ?? ""}`;

const { resolveDiff } = await import("@warden/core/diff/source");
const { isGitIgnored } = await import("@warden/core/review-harness/tools/safety");
const { walkRepo } = await import("@warden/core/init/walk");
const { loadImportGraph } = await import("@warden/core/context/import-graph");
const { collectSymbolRefHits } = await import("@warden/core/context/signals/symbol-refs");
const { makeGrepRepoTool } = await import("@warden/core/review-harness/tools/grep-repo");
const { TsCompilerParser } = await import("@warden/core");

process.stdout.write(`\n[2] resolveDiff output does not change\n`);
assert(expectedReview.includes("+two"), "the expected diff has the textconv content");
const withBase = await resolveDiff({ repoRoot: REPO, mode: "review", baseRef: "main" });
assert(withBase.diff === expectedReview, "--base main gives the direct-git diff");
assert(withBase.degraded === undefined, "--base main has no degraded entry");
const autoBase = await resolveDiff({ repoRoot: REPO, mode: "review" });
assert(autoBase.baseRef === "main", `auto-detected base is main (got ${autoBase.baseRef})`);
assert(autoBase.diff === expectedReview, "auto-detected base gives the direct-git diff");

writeFileSync(resolve(REPO, "notes.txt"), "one\ntwo\nthree\n");
const checkMode = await resolveDiff({ repoRoot: REPO, mode: "check" });
const textconvLogs = readLogs("textconv-");
const callLogs = readLogs("call-");
const expectedCheck = directGit([...DIFF_FLAGS, "HEAD"]);
assert(expectedCheck.includes("+three"), "the expected check diff has the working-tree line");
assert(checkMode.diff === expectedCheck, "check mode gives the direct-git diff");

process.stdout.write(`\n[3] the other git call sites still work\n`);
assert(await isGitIgnored(REPO, "ignored.log"), "isGitIgnored: repo .gitignore match");
assert(!(await isGitIgnored(REPO, "notes.txt")), "isGitIgnored: tracked file is not ignored");
assert(
  await isGitIgnored(REPO, "global-ignored.txt"),
  "isGitIgnored: global core.excludesFile match (HOME reached git)",
);
const walked = await walkRepo(REPO);
assert(!walked.usedFallback, "walkRepo used git ls-files, not the manual walk");
assert(walked.files.has("a.ts") && walked.files.has("b.ts"), "walkRepo lists a.ts and b.ts");
const graph = await loadImportGraph({
  repoRoot: REPO,
  parser: new TsCompilerParser({ repoRoot: REPO }),
  topic: "context",
});
assert(
  graph.files.includes("a.ts") && graph.files.includes("b.ts"),
  "loadImportGraph lists a.ts and b.ts",
);
const hits = await collectSymbolRefHits(
  REPO,
  new Map([["a.ts", [{ symbol: "wardenSmokeSymbol", startLine: 1, endLine: 3 }]]]),
  new Set(["a.ts"]),
);
assert(
  hits.some((hit) => hit.candidate === "b.ts"),
  "collectSymbolRefHits finds b.ts through git grep",
);
const grepRepo = makeGrepRepoTool({ repoRoot: REPO });
const execute = grepRepo.execute;
if (execute === undefined) {
  assert(false, "grepRepo tool exposes execute()");
} else {
  const grepped = await execute(
    { pattern: "wardenSmokeSymbol" },
    { toolCallId: "smoke", messages: [] },
  );
  if (Symbol.asyncIterator in grepped) {
    assert(false, "grepRepo returns one result, not a stream");
  } else {
    assert(
      grepped.ok && grepped.matches.some((m) => m.path === "b.ts"),
      "grepRepo finds b.ts after git ls-files",
    );
  }
}

process.stdout.write(`\n[4] no fake key reaches git or a program that git starts\n`);
const allCalls = readLogs("call-");
const argvOf = (log: string): string => log.split("\n", 1)[0] ?? "";
for (const sub of ["diff", "rev-parse", "symbolic-ref", "check-ignore", "ls-files", "grep"]) {
  assert(
    allCalls.some((log) => argvOf(log).startsWith(`ARGV ${sub} `)),
    `a warden git call ran: git ${sub}`,
  );
}
assert(callLogs.length > 0 && textconvLogs.length > 0, "resolveDiff ran git and its textconv");
assert(
  allCalls.every((log) => !log.includes(LEAK_MARKER)),
  `no git call env has a fake key (${allCalls.length} calls)`,
);
assert(
  textconvLogs.every((log) => !log.includes(LEAK_MARKER)),
  `no textconv env has a fake key (${textconvLogs.length} runs)`,
);

process.stdout.write(`\n[5] the allowlisted git keys reach git\n`);
assert(
  allCalls.every((log) => log.includes(`\nHOME=${HOME_DIR}\n`)),
  "HOME reaches every git call",
);
assert(
  allCalls.every(
    (log) =>
      log.includes("\nGIT_CONFIG_KEY_0=warden.smokemarker\n") &&
      log.includes("\nGIT_CONFIG_VALUE_0=passed\n"),
  ),
  "GIT_CONFIG_KEY_0 / GIT_CONFIG_VALUE_0 reach every git call",
);

rmSync(ROOT, { recursive: true, force: true });

process.stdout.write(`\n${failed === 0 ? "PASS" : `FAIL (${failed})`}\n`);
process.exit(failed === 0 ? 0 : 1);

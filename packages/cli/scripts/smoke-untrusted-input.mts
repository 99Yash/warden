/**
 * ADR-0054 (issue #52): untrusted-input containment smoke. No LLM, no
 * network, no OpenCode. Covers the secret guard rules, the post-pass drop,
 * the materializer's shared secret-file globs, the nested-AGENTS.md diff
 * reader, the base-ref check, and the driver-owned lane message.
 *
 * Every credential sample is built at run time, so this file holds no
 * token-shaped literal for a secret scanner to flag.
 *
 * Usage: pnpm --filter @warden/cli smoke:untrusted-input
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  CREDENTIAL_RULES,
  READ_SECRET_FILE_GLOBS,
  GIT_METADATA_GLOBS,
  assertPlainBaseRef,
  SECRET_FILE_RULE_ID,
  isSecretFilePath,
  isNotClean,
  parseUnifiedDiff,
  resolveDiff,
  runPostPass,
  screenFinding,
} from "@warden/core";
import {
  buildLaneMessage,
  driveOpencodeLane,
  laneInstructionFileGate,
  nestedAgentsMdChanges,
} from "../src/opencode/drive.js";
import { laneSymlinkGate } from "../src/opencode/symlink-gate.js";
import { DOWN_LANE_SPEC, materializeLane } from "../src/opencode/materialize.js";

let failed = 0;
function assert(cond: unknown, msg: string): void {
  if (cond) {
    process.stdout.write(`  ✓ ${msg}\n`);
  } else {
    process.stdout.write(`  ✗ ${msg}\n`);
    failed++;
  }
}

const TMP = mkdtempSync(resolve(tmpdir(), "warden-untrusted-input-"));

try {
  // ---------------------------------------------------------------------------
  // [1] Credential rules: one positive sample per rule, plus near misses.
  // ---------------------------------------------------------------------------
  process.stdout.write("\n[1] credential rules\n");
  const samples: Record<string, string> = {
    "pem-private-key": "-----BEGIN " + "RSA PRIVATE KEY-----",
    "aws-access-key-id": "AKIA" + "Q".repeat(16),
    "github-token": "ghp_" + "a1".repeat(18),
    "anthropic-api-key": "sk-" + "ant-" + "x".repeat(24),
    "openai-api-key": "sk-" + "proj-" + "y".repeat(24),
    "slack-token": "xox" + "b-" + "1".repeat(12),
    "slack-app-token": "xapp-" + "1-ABC-123-" + "s".repeat(24),
    "slack-webhook": "https://hooks.slack.com/" + "services/T123/B456/" + "s".repeat(24),
    "gitlab-token": "glpat-" + "g".repeat(24),
    "huggingface-token": "hf_" + "h".repeat(24),
    "stripe-webhook-secret": "whsec_" + "s".repeat(24),
    "url-credentials": "postgres://" + "user:password@localhost/db",
    "basic-authorization":
      "AUTHORIZATION: basic " + Buffer.from("user:password").toString("base64"),
    "cloudflare-api-token": "cf-aig-authorization: Bearer " + "c".repeat(40),
    "stripe-live-key": "sk" + "_live_" + "z".repeat(20),
    "google-api-key": "AIza" + "w".repeat(35),
    "npm-token": "npm_" + "n".repeat(36),
    jwt: "eyJ" + "h".repeat(12) + ".eyJ" + "p".repeat(12) + "." + "s".repeat(12),
  };
  assert(
    CREDENTIAL_RULES.every((rule) => samples[rule.id] !== undefined),
    `every rule has a sample (${CREDENTIAL_RULES.length} rules)`,
  );
  for (const rule of CREDENTIAL_RULES) {
    const sample = samples[rule.id] as string;
    assert(
      screenFinding({ claim: `value: ${sample}` })?.rule === rule.id,
      `${rule.id} matches its sample`,
    );
  }
  const nearMisses = [
    "sha256 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    "commit aac8a82 and id nanoid_V1StGXR8_Z5jdHi6B-myT",
    "the sk- prefix and the ghp_ prefix are documented",
    "-----BEGIN PUBLIC KEY-----",
    "process.env.OPENAI_API_KEY",
  ];
  for (const text of nearMisses) {
    assert(screenFinding({ claim: text }) === undefined, `no match: ${JSON.stringify(text)}`);
  }
  assert(
    screenFinding({ claim: "-----BEGIN " + "PGP PRIVATE KEY BLOCK-----" })?.rule ===
      "pem-private-key",
    "PGP private key header is blocked",
  );
  assert(
    screenFinding({ claim: "CF_AIG_TOKEN=" + "c".repeat(40) })?.rule === "cloudflare-api-token",
    "gateway token assignment is blocked",
  );
  for (const plain of ["a:b", "a:", ":"])
    assert(
      screenFinding({ claim: `AUTHORIZATION: basic ${Buffer.from(plain).toString("base64")}` })
        ?.rule === "basic-authorization",
      "short valid Basic credentials are blocked",
    );

  // ---------------------------------------------------------------------------
  // [2] Secret-file paths: the same globs the materializer denies to `read`.
  // ---------------------------------------------------------------------------
  process.stdout.write("\n[2] secret-file paths\n");
  const pathCases: Array<[string, boolean]> = [
    [".env", true],
    ["packages/api/.env", true],
    [".env.local", true],
    ["config/.ENV", true], // case-insensitive, unlike the host matcher
    ["config/prod.env", true],
    ["src/config.env.ts", true], // over-block, fail closed (#52 comment §2)
    [".env.example", false],
    [".env.sample", false],
    [".env.local.example", false],
    ["packages/api/.env.local.sample", false],
    ["apps/web/.env.example", false],
    ["src/env.ts", false],
    ["docs/environment.md", false],
    [".git/config", true],
    ["nested/.git/config", true],
    [".git/.env.example", true],
    ["nested/.git/.env.example", true],
    ["/repo/.git/config", true],
    ["nested\\.git\\config", true],
    ["src/git/config.ts", false],
    [".npmrc", true],
    ["pkg/.npmrc", true],
    [".dev.vars", true],
    ["pkg/.dev.vars.preview", true],
    [".envrc", true],
    ["pkg/.envrc", true],
    ["id_rsa", true],
    ["keys/id_ed25519", true],
    ["cert.pem", true],
    ["cert.key", true],
    ["cert.p12", true],
    ["cert.pfx", true],
    [".aws/credentials", true],
    [".netrc", true],
    ["service.credentials.json", true],
    [".ssh/config", true],
    [".ssh/.env.sample", true],
    ["package.json", false],
    ["src/key.ts", false],
  ];
  for (const [path, expected] of pathCases) {
    assert(isSecretFilePath(path) === expected, `isSecretFilePath(${path}) === ${expected}`);
  }
  assert(
    screenFinding({ file: "src/a.ts", sources: [{ path: "src/a.ts" }, { path: ".env" }] })?.rule ===
      SECRET_FILE_RULE_ID,
    "a second source that cites .env matches the secret-file rule",
  );
  assert(
    screenFinding({ claim: "read .env for the key" }) === undefined,
    "the word .env in prose is not a citation",
  );
  const config = JSON.parse(
    materializeLane(DOWN_LANE_SPEC, {
      charter: "# c\n\n```includes\nm.md :: # M\n```\n",
      sources: new Map([["m.md", "# M\nbody\n"]]),
    }).configJson,
  ) as { agents: Record<string, { permissions: Array<Record<string, string>> }> };
  const readRules = (config.agents[DOWN_LANE_SPEC.agentId]?.permissions ?? []).filter(
    (r) => r["action"] === "read" && r["resource"] !== "*",
  );
  function readDenied(path: string): boolean {
    let denied = false;
    for (const rule of readRules) {
      const pattern = rule["resource"]!.split("*")
        .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*");
      if (new RegExp(`^${pattern}$`).test(path)) denied = rule["effect"] === "deny";
    }
    return denied;
  }
  for (const [path] of pathCases) {
    assert(
      !readDenied(path) || isSecretFilePath(path),
      `publication covers read-denied path ${path}`,
    );
  }
  assert(
    !readDenied("service.credentials.json") && isSecretFilePath("service.credentials.json"),
    "publication policy is broader than read deny",
  );
  assert(
    !readDenied(".env.sample") && !readDenied(".env.local.example"),
    "read permits template examples",
  );
  assert(
    screenFinding({ file: ".env.local.example", claim: samples["gitlab-token"] })?.rule ===
      "gitlab-token",
    "template allow never allows a credential value",
  );
  assert(
    JSON.stringify(readRules) ===
      JSON.stringify([
        ...READ_SECRET_FILE_GLOBS.deny.map((resource) => ({
          action: "read",
          resource,
          effect: "deny",
        })),
        ...READ_SECRET_FILE_GLOBS.allow.map((resource) => ({
          action: "read",
          resource,
          effect: "allow",
        })),
        ...GIT_METADATA_GLOBS.map((resource) => ({ action: "read", resource, effect: "deny" })),
      ]),
    "the materializer emits the shared globs in the same order",
  );

  // ---------------------------------------------------------------------------
  // [3] Post-pass drop: the guard runs before every other gate.
  // ---------------------------------------------------------------------------
  process.stdout.write("\n[3] post-pass secret guard\n");
  writeFileSync(resolve(TMP, "a.ts"), "export const a = 1;\n");
  const diff = [
    "diff --git a/a.ts b/a.ts",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -0,0 +1 @@",
    "+export const a = 1;",
    "",
  ].join("\n");
  const token = "AKIA" + "R".repeat(16);
  const checkoutAuth = `AUTHORIZATION: basic ${Buffer.from("x-access-token:" + "ghs_" + "q".repeat(36)).toString("base64")}`;
  assert(
    screenFinding({ claim: checkoutAuth })?.rule === "basic-authorization",
    "Basic checkout auth is blocked without decoding its value",
  );
  assert(
    screenFinding({ sources: [{ path: ".git/config", snippet: checkoutAuth }] })?.rule ===
      SECRET_FILE_RULE_ID,
    "Git credential citations are blocked even when the value is encoded",
  );
  const base = {
    file: "a.ts",
    lineStart: 1,
    lineEnd: 1,
    tier: 2,
    category: "correctness",
    kind: "assertion",
    explanation: "e",
    confidence: 0.9,
    sources: [
      {
        type: "tool",
        retrievedAt: "2026-10-13T00:00:00.000Z",
        path: "a.ts",
        line: 1,
        snippet: "export const a = 1;",
      },
    ],
  };
  const result = await runPostPass({
    repoRoot: TMP,
    diff,
    lanes: [
      {
        lane: "down",
        status: "ok",
        scope: ["a.ts"],
        findings: [
          { ...base, claim: "clean finding" },
          { ...base, claim: `leaks ${token}` },
          {
            ...base,
            claim: "cites the env file",
            sources: [
              ...base.sources,
              {
                type: "tool",
                retrievedAt: "2026-10-13T00:00:00.000Z",
                path: ".env",
                line: 1,
                snippet: "KEY=1",
              },
            ],
          },
        ],
      },
    ],
  });
  assert(
    result.comments.length === 1 && result.comments[0]?.claim === "clean finding",
    "only the clean finding publishes",
  );
  const guardEntries = result.metadata.degradedWorkers.filter((d) => d.topic === "secret-guard");
  assert(
    guardEntries.length === 2 && guardEntries.every((d) => d.kind === "actionable"),
    "two actionable secret-guard entries",
  );
  assert(
    guardEntries.some((d) => d.message.includes("rule aws-access-key-id")) &&
      guardEntries.some((d) => d.message.includes(`rule ${SECRET_FILE_RULE_ID}`)),
    "the entries name each rule",
  );
  assert(!JSON.stringify(result).includes(token), "the value appears nowhere in the CommentSet");
  assert(isNotClean(result), "a guard drop is not clean even when a good finding publishes");

  const replay = await runPostPass({
    repoRoot: TMP,
    diff,
    lanes: [
      {
        lane: "down",
        status: "ok",
        scope: ["a.ts"],
        findings: [
          { ...base, claim: "clean finding" },
          { secretGuard: "aws-access-key-id" },
          { secretGuard: SECRET_FILE_RULE_ID },
        ],
      },
    ],
  });
  const replayEntries = replay.metadata.degradedWorkers.filter((d) => d.topic === "secret-guard");
  assert(
    JSON.stringify(replay.comments) === JSON.stringify(result.comments) &&
      replayEntries.length === guardEntries.length &&
      replayEntries.every(
        (d, i) =>
          d.kind === "actionable" &&
          d.message.includes(`rule ${i === 0 ? "aws-access-key-id" : SECRET_FILE_RULE_ID}`),
      ),
    "replay keeps the clean finding and restores each actionable guard entry",
  );
  assert(
    !replay.metadata.degradedWorkers.some((d) => d.message.includes("invalid")) &&
      replayEntries.every((d) => !d.message.includes(" at ")) &&
      isNotClean(replay),
    "valid placeholders are guard drops without anchors and make replay not clean",
  );

  const malformed = await runPostPass({
    repoRoot: TMP,
    diff,
    lanes: [
      {
        lane: "down",
        status: "ok",
        scope: ["a.ts"],
        findings: [
          { ...base, claim: "clean finding" },
          { secretGuard: token },
          { secretGuard: "unknown-rule" },
          { secretGuard: 1 },
          { secretGuard: "github-token", extra: token },
        ],
      },
    ],
  });
  assert(
    malformed.metadata.degradedWorkers.some((d) => d.message.includes("4 invalid")) &&
      !malformed.metadata.degradedWorkers.some((d) => d.topic === "secret-guard") &&
      !JSON.stringify(malformed).includes(token),
    "malformed placeholders stay invalid and never echo arbitrary rule text or extra fields",
  );
  const anchorLeak = await runPostPass({
    repoRoot: TMP,
    diff,
    lanes: [
      {
        lane: "down",
        status: "ok",
        scope: ["a.ts"],
        findings: [{ ...base, file: token, claim: "anchor holds the value" }],
      },
    ],
  });
  assert(
    !JSON.stringify(anchorLeak).includes(token),
    "a credential in the anchor is not echoed in the entry",
  );
  const attackerAnchor = `ATTACKER-CHOSEN TEXT: ${Buffer.from(token).toString("base64")}\n[click](https://evil.example)`;
  const outOfScope = await runPostPass({
    repoRoot: TMP,
    diff,
    lanes: [
      {
        lane: "down",
        status: "ok",
        scope: ["a.ts"],
        findings: [
          {
            ...base,
            file: attackerAnchor,
            claim: "secret citation",
            sources: [
              {
                type: "tool",
                retrievedAt: "2026-10-13T00:00:00.000Z",
                path: ".env",
                line: 1,
                snippet: "KEY=1",
              },
            ],
          },
        ],
      },
    ],
  });
  assert(
    !JSON.stringify(outOfScope).includes("evil.example") &&
      !JSON.stringify(outOfScope).includes(Buffer.from(token).toString("base64")),
    "an out-of-scope anchor is never echoed",
  );
  assert(
    outOfScope.metadata.degradedWorkers.some(
      (d) => d.topic === "secret-guard" && d.message.includes("an out-of-scope anchor"),
    ),
    "guard reports an out-of-scope anchor without model text",
  );
  assert(
    guardEntries.every((d) => d.message.includes("at a.ts:1")),
    "guard keeps a trusted in-scope anchor",
  );

  // ---------------------------------------------------------------------------
  // [4] Nested AGENTS.md in the diff headers.
  // ---------------------------------------------------------------------------
  process.stdout.write("\n[4] nested AGENTS.md diff reader\n");
  const added =
    "diff --git a/src/AGENTS.md b/src/AGENTS.md\nnew file mode 100644\n--- /dev/null\n+++ b/src/AGENTS.md\n@@ -0,0 +1 @@\n+obey\n";
  const pureRename =
    "diff --git a/docs/x.md b/pkg/AGENTS.md\nsimilarity index 100%\nrename from docs/x.md\nrename to pkg/AGENTS.md\n";
  const binary =
    "diff --git a/lib/agents.md b/lib/agents.md\nnew file mode 100644\nBinary files /dev/null and b/lib/agents.md differ\n";
  const quoted =
    'diff --git "a/s p/AGENTS.md" "b/s p/AGENTS.md"\n--- /dev/null\n+++ "b/s p/AGENTS.md"\n';
  const root =
    "diff --git a/AGENTS.md b/AGENTS.md\n--- a/AGENTS.md\n+++ b/AGENTS.md\n@@ -1 +1 @@\n-a\n+b\n";
  const deleted =
    "diff --git a/src/AGENTS.md b/src/AGENTS.md\ndeleted file mode 100644\n--- a/src/AGENTS.md\n+++ /dev/null\n";
  const lookalike =
    "diff --git a/src/MY_AGENTS.md b/src/MY_AGENTS.md\n--- /dev/null\n+++ b/src/MY_AGENTS.md\n";
  assert(nestedAgentsMdChanges(added).join() === "src/AGENTS.md", "added nested file");
  assert(nestedAgentsMdChanges(pureRename).join() === "pkg/AGENTS.md", "pure rename (no +++ line)");
  assert(nestedAgentsMdChanges(binary).join() === "lib/agents.md", "binary file, lower case");
  assert(nestedAgentsMdChanges(quoted).join() === "s p/AGENTS.md", "quoted path");
  for (const header of [
    "+++ b/src/AGENTſ.md",
    '+++ "b/src/AGENT\\305\\277.md"',
    'rename to "src/AGENT\\305\\277.md"',
    'copy to "src/AGENT\\305\\277.md"',
    'Binary files /dev/null and "b/src/AGENT\\305\\277.md" differ',
  ])
    assert(
      nestedAgentsMdChanges(header).join() === "src/AGENTſ.md",
      "long-s alias is gated after Git path decoding",
    );
  assert(
    nestedAgentsMdChanges(root).length === 0,
    "root AGENTS.md is out of scope (project config off)",
  );
  assert(nestedAgentsMdChanges(deleted).length === 0, "a deleted file cannot load");
  assert(nestedAgentsMdChanges(lookalike).length === 0, "MY_AGENTS.md is not AGENTS.md");
  assert(
    laneInstructionFileGate(added + pureRename)?.includes("pkg/AGENTS.md, src/AGENTS.md") === true,
    "the gate reason names each file, sorted",
  );
  assert(laneInstructionFileGate(root) === undefined, "no gate for the root file");
  const aliasRepo = resolve(TMP, "alias-repo");
  mkdirSync(resolve(aliasRepo, "src"), { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: aliasRepo });
  writeFileSync(resolve(aliasRepo, "src/AGENTſ.md"), "alias guidance\n");
  execFileSync("git", ["add", "."], { cwd: aliasRepo });
  for (const quotePath of ["true", "false"]) {
    const actualDiff = execFileSync(
      "git",
      ["-c", `core.quotePath=${quotePath}`, "diff", "--cached"],
      { cwd: aliasRepo, encoding: "utf8" },
    );
    assert(
      nestedAgentsMdChanges(actualDiff).join() === "src/AGENTſ.md",
      `real Git quotePath=${quotePath} gates the alias`,
    );
  }

  // ---------------------------------------------------------------------------
  // [5] Base ref and lane message: driver-owned values only.
  // ---------------------------------------------------------------------------
  process.stdout.write("\n[5] base ref and lane message\n");
  for (const ok of ["main", "origin/main", "HEAD~1", "HEAD^", "v1.2.3", "a".repeat(40), "@"]) {
    let threw = false;
    try {
      assertPlainBaseRef(ok);
    } catch {
      threw = true;
    }
    assert(!threw, `plain ref accepted: ${ok}`);
  }
  for (const bad of ["--output=/tmp/x", "main..evil", 'main"}', "main ignore", "HEAD@{1}", ""]) {
    let threw = false;
    try {
      assertPlainBaseRef(bad);
    } catch {
      threw = true;
    }
    assert(threw, `ref rejected: ${JSON.stringify(bad)}`);
  }
  const message = buildLaneMessage("origin/main");
  assert(
    message.includes("origin/main") && !message.includes("diff --git"),
    "the lane message holds the base ref and no diff text",
  );

  // Exercise core directly: the MCP caller bypasses the driver.
  execFileSync("git", ["init", "-q"], { cwd: TMP });
  execFileSync("git", ["add", "a.ts"], { cwd: TMP });
  execFileSync(
    "git",
    ["-c", "user.name=smoke", "-c", "user.email=smoke@example.invalid", "commit", "-qm", "fixture"],
    { cwd: TMP },
  );
  const outputPath = resolve(TMP, "option-output");
  for (const bad of [`--output=${outputPath}`, "-main", "main..evil", "main ignore", ""]) {
    let rejected = false;
    try {
      await resolveDiff({ repoRoot: TMP, mode: "review", baseRef: bad });
    } catch {
      rejected = true;
    }
    assert(rejected, `core rejects base ref: ${JSON.stringify(bad)}`);
  }
  assert(
    !existsSync(outputPath) &&
      !existsSync(`${outputPath}..HEAD`) &&
      !existsSync(`${outputPath}...HEAD`),
    "a base ref cannot create a git output file",
  );
  const valid = await resolveDiff({ repoRoot: TMP, mode: "review", baseRef: "HEAD" });
  assert(valid.diff === "" && !valid.degraded, "valid base still resolves in core");
  writeFileSync(resolve(TMP, "a.ts"), "export const a = 2;\n");
  const working = await resolveDiff({ repoRoot: TMP, mode: "check" });
  assert(
    working.diff.includes("+export const a = 2;") && !working.degraded,
    "Git option delimiter preserves working-tree diffs",
  );
  execFileSync("git", ["add", "a.ts"], { cwd: TMP });
  execFileSync(
    "git",
    ["-c", "user.name=smoke", "-c", "user.email=smoke@example.invalid", "commit", "-qm", "change"],
    { cwd: TMP },
  );
  const previous = await resolveDiff({ repoRoot: TMP, mode: "review", baseRef: "HEAD~1" });
  assert(
    previous.diff.includes("+export const a = 2;") && !previous.degraded,
    "Git option delimiter preserves commit-base diffs",
  );
  const emptyTree = execFileSync("git", ["mktree"], {
    cwd: TMP,
    input: "",
    encoding: "utf8",
  }).trim();
  const tree = await resolveDiff({ repoRoot: TMP, mode: "review", baseRef: emptyTree });
  assert(
    tree.diff.includes("+export const a = 2;") && !tree.degraded,
    "Git option delimiter preserves tree-base diffs",
  );

  // Operator Git settings must not change the paths consumed by the gates.
  mkdirSync(resolve(TMP, "b"));
  writeFileSync(resolve(TMP, "AGENTS.md"), "root guidance\n");
  writeFileSync(resolve(TMP, "b/AGENTS.md"), "nested guidance\n");
  execFileSync("git", ["add", "AGENTS.md", "b/AGENTS.md"], { cwd: TMP });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=smoke",
      "-c",
      "user.email=smoke@example.invalid",
      "commit",
      "-qm",
      "guidance",
    ],
    { cwd: TMP },
  );
  const externalMarker = resolve(TMP, "external-diff-ran");
  const externalDiff = resolve(TMP, "external-diff");
  writeFileSync(externalDiff, `#!/bin/sh\ntouch '${externalMarker}'\nprintf 'external diff\\n'\n`, {
    mode: 0o755,
  });
  for (const config of ["diff.noprefix", "diff.mnemonicPrefix"]) {
    execFileSync("git", ["config", config, "true"], { cwd: TMP });
    const pinned = await resolveDiff({ repoRoot: TMP, mode: "review", baseRef: "HEAD~1" });
    assert(
      nestedAgentsMdChanges(pinned.diff).join() === "b/AGENTS.md",
      `${config}: gate detects the nested b/AGENTS.md and excludes the root file`,
    );
    assert(
      parseUnifiedDiff(pinned.diff)
        .map((file) => file.path)
        .sort()
        .join() === "AGENTS.md,b/AGENTS.md",
      `${config}: parser receives canonical paths`,
    );
    const gated = await driveOpencodeLane({
      repoRoot: TMP,
      baseRef: "HEAD~1",
      opencodeBin: resolve(TMP, "must-not-start"),
    });
    assert(
      !gated.runSpawned && gated.lanes[0]?.reason?.startsWith("untrusted instruction file:"),
      `${config}: driver blocks before OpenCode starts`,
    );
    execFileSync("git", ["config", "--unset", config], { cwd: TMP });
  }
  execFileSync("git", ["config", "color.ui", "always"], { cwd: TMP });
  const noColor = await resolveDiff({ repoRoot: TMP, mode: "review", baseRef: "HEAD~1" });
  assert(!noColor.diff.includes("\u001b"), "diff has no color codes with color.ui=always");
  execFileSync("git", ["config", "diff.external", externalDiff], { cwd: TMP });
  const noExternal = await resolveDiff({ repoRoot: TMP, mode: "review", baseRef: "HEAD~1" });
  assert(
    noExternal.diff.includes("+++ b/b/AGENTS.md"),
    "external diff config cannot replace canonical diff headers",
  );
  assert(!existsSync(externalMarker), "operator external diff command never runs");
  execFileSync("git", ["config", "--unset", "diff.external"], { cwd: TMP });

  // Real Git modes + real filesystem links: include aliases and pure renames.
  process.stdout.write("\n[6] unsafe symlink gate\n");
  const repo = resolve(TMP, "symlinks");
  mkdirSync(resolve(repo, "src"), { recursive: true });
  const git = (...args: string[]): string =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.name", "smoke");
  git("config", "user.email", "smoke@example.invalid");
  writeFileSync(resolve(repo, "src/a.ts"), "export const a = 0;\n");
  symlinkSync(".git", resolve(repo, "metadata"));
  symlinkSync(TMP, resolve(repo, "external-dir"));
  symlinkSync(resolve(TMP, "missing-dir"), resolve(repo, "broken-external"));
  symlinkSync(".git/missing", resolve(repo, "broken-metadata"));
  symlinkSync("a.ts", resolve(repo, "src/move-me"));
  git("add", "-A");
  git("commit", "-qm", "base");
  const baseCommit = git("rev-parse", "HEAD").trim();
  const cases: Array<[string, string, boolean]> = [
    ["external", "/proc/self/environ", true],
    ["relative-escape", "../../outside.env", true],
    ["prefix-sibling", `${repo}-sibling/missing`, true],
    ["git-config", "../.git/config", true],
    ["nested-git", "../nested/.git/config", true],
    ["git-chain", "../metadata/config", true],
    ["external-chain", "../external-dir/missing", true],
    ["broken-external-chain", "../broken-external/file", true],
    ["broken-git-chain", "../broken-metadata", true],
    ["safe", "a.ts", false],
    ["safe-dangling", "not-created.ts", false],
    ["safe-absolute", resolve(repo, "src/a.ts"), false],
    ["s p\t雪", "/proc/self/environ", true],
  ];
  for (const [name, target, blocked] of cases) {
    const path = `src/${name}`;
    symlinkSync(target, resolve(repo, path));
    git("add", "--", path);
    const diff = git("diff", "--cached", baseCommit);
    assert(diff.includes("new file mode 120000"), `Git marks ${JSON.stringify(name)} as a symlink`);
    assert(
      (laneSymlinkGate(diff, repo) !== undefined) === blocked,
      `gate ${blocked ? "blocks" : "allows"} ${JSON.stringify(name)}`,
    );
    git("reset", "-q", baseCommit, "--", path);
    rmSync(resolve(repo, path));
  }
  symlinkSync("loop", resolve(repo, "src/loop"));
  git("add", "src/loop");
  assert(
    laneSymlinkGate(git("diff", "--cached", baseCommit), repo) !== undefined,
    "cyclic links fail closed",
  );
  git("reset", "-q", baseCommit, "--", "src/loop");
  rmSync(resolve(repo, "src/loop"));

  // A moved link has no mode header or hunk; its relative target can escape.
  git("mv", "src/move-me", "moved");
  rmSync(resolve(repo, "moved"));
  symlinkSync("../outside.env", resolve(repo, "moved"));
  git("add", "moved");
  assert(
    laneSymlinkGate(git("diff", "--cached", baseCommit), repo) !== undefined,
    "changed link target fails closed",
  );
  git("reset", "--hard", "-q", baseCommit);
  git("mv", "src/move-me", "moved");
  // Same target bytes, but a base link at the destination resolves outside.
  rmSync(resolve(repo, "moved"));
  symlinkSync("../outside.env", resolve(repo, "moved"));
  // Keep the pure-rename diff and check the checkout, as the driver does.
  const renameDiff = git("diff", "--cached", baseCommit);
  assert(
    renameDiff.includes("rename to moved") && !renameDiff.includes("+++"),
    "fixture is a pure rename without a hunk",
  );
  assert(laneSymlinkGate(renameDiff, repo) !== undefined, "pure rename checks the live link");
  git("reset", "--hard", "-q", baseCommit);

  symlinkSync("../.git/config", resolve(repo, "src/x"));
  git("add", "src/x");
  const linkDiff = git("diff", "--cached", baseCommit);
  rmSync(resolve(repo, "src/x"));
  assert(laneSymlinkGate(linkDiff, repo) !== undefined, "missing mode-120000 link fails closed");
  writeFileSync(resolve(repo, "src/x"), "ordinary file\n");
  assert(laneSymlinkGate(linkDiff, repo) !== undefined, "replaced mode-120000 link fails closed");
  rmSync(resolve(repo, "src/x"));
  symlinkSync("../.git/config", resolve(repo, "src/x"));
  git("commit", "-qm", "unsafe link");
  const lanesOut = resolve(TMP, "symlink-lanes.json");
  const driven = await driveOpencodeLane({
    repoRoot: repo,
    baseRef: baseCommit,
    lanesOut,
    opencodeBin: resolve(TMP, "must-not-start"),
  });
  assert(
    !driven.runSpawned && driven.lanes[0]?.reason?.startsWith("unsafe symlink:"),
    "driver blocks before OpenCode serve or run starts",
  );
  assert(
    driven.result.metadata.degradedWorkers.some(
      (d) => d.kind === "actionable" && d.topic === "lane-health",
    ),
    "symlink rejection is actionable, never clean",
  );
  assert(existsSync(lanesOut), "blocked run writes the failed lanes envelope");
} catch (err) {
  assert(false, `smoke threw: ${err instanceof Error ? err.stack : String(err)}`);
} finally {
  rmSync(TMP, { recursive: true, force: true });
}

if (failed > 0) {
  process.stdout.write(`\n${failed} assertion(s) failed\n`);
  process.exit(1);
}
process.stdout.write("\nall assertions passed\n");

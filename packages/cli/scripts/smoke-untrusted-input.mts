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
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  CREDENTIAL_RULES,
  assertPlainBaseRef,
  SECRET_FILE_RULE_ID,
  isSecretFilePath,
  resolveDiff,
  runPostPass,
  screenFinding,
} from "@warden/core";
import {
  buildLaneMessage,
  laneInstructionFileGate,
  nestedAgentsMdChanges,
} from "../src/opencode/drive.js";
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
    ["apps/web/.env.example", false],
    ["src/env.ts", false],
    ["docs/environment.md", false],
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
  assert(
    JSON.stringify(readRules) ===
      JSON.stringify([
        { action: "read", resource: "*.env", effect: "deny" },
        { action: "read", resource: "*.env.*", effect: "deny" },
        { action: "read", resource: "*.env.example", effect: "allow" },
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

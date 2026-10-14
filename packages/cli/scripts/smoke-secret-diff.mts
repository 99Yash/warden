/** ADR-0054 §8: safe credential findings survive lane failure and replay. No model or network. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommentSetSchema, review, runDetPriors, runPostPass, runSecretDiff } from "@warden/core";

const repoRoot = mkdtempSync(join(tmpdir(), "warden-secret-diff-"));
const token = "ghp_" + "a1".repeat(18);
const secondToken = "glpat-" + "z".repeat(24);
function diffFor(lines: string[], file = "src/a.ts", start = 1): string {
  return [
    `diff --git a/${file} b/${file}`,
    "--- /dev/null",
    `+++ b/${file}`,
    `@@ -0,0 +${start},${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
    "",
  ].join("\n");
}
try {
  const diff = diffFor(
    [`const key = '${token}';`, `const other = '${secondToken}';`],
    "node_modules/vendor/key.js",
    9,
  );
  const scan = runSecretDiff(diff);
  assert.deepEqual(
    scan.map((f) => [f.file, f.line, f.ruleId]),
    [
      ["node_modules/vendor/key.js", 9, "github-token"],
      ["node_modules/vendor/key.js", 10, "gitlab-token"],
    ],
  );
  assert(scan.every((f) => f.evidence === undefined));
  assert(!JSON.stringify(scan).includes(token));
  const publish = (lanes: Parameters<typeof runPostPass>[0]["lanes"]) =>
    runPostPass({ repoRoot, diff, lanes, config: { volumeCap: 1 } });
  const empty = await publish([{ lane: "down", status: "ok", scope: [], findings: [] }]);
  const failed = await publish([
    { lane: "down", status: "failed", reason: "fixture", scope: [], findings: [] },
  ]);
  const replay = await publish([
    { lane: "down", status: "ok", scope: [], findings: [{ secretGuard: "github-token" }] },
  ]);
  for (const result of [empty, failed, replay, await publish([])]) {
    assert.equal(result.comments.length, 2);
    assert(result.comments.every((c) => c.tier === 1 && c.category === "security"));
    assert(CommentSetSchema.safeParse(result).success);
    assert(!JSON.stringify(result).includes(token));
    assert(!JSON.stringify(result).includes(secondToken));
    assert(result.comments.every((c) => c.sources.every((s) => s.snippet === undefined)));
    assert.deepEqual(
      result.comments.map((c) => c.id),
      empty.comments.map((c) => c.id),
    );
  }
  const unrelated = await runPostPass({
    repoRoot,
    diff: diffFor(["const safe = 1;"]),
    lanes: [
      {
        lane: "down",
        status: "ok",
        scope: ["src/a.ts"],
        findings: [{ secretGuard: "github-token" }],
      },
    ],
  });
  assert.equal(
    unrelated.comments.length,
    0,
    "a lane marker cannot invent a deterministic credential finding",
  );
  const mixed = [
    `diff --git a/${token} b/${token}`,
    `--- a/${token}`,
    `+++ b/${token}`,
    "@@ -1,3 +1,3 @@",
    `-${token}`,
    ` ${token}`,
    "+const safe = 1;",
    ` ${token}`,
    "",
  ].join("\n");
  assert.equal(
    runSecretDiff(mixed).length,
    0,
    "headers, removed lines, and context are not scanned",
  );
  assert.equal(
    runSecretDiff(diffFor([token], `keys/${token}.ts`)).length,
    0,
    "credential-bearing paths are not published",
  );
  const env = runSecretDiff(diffFor(["SETTING=1", `KEY=${token}`], ".env"));
  assert.deepEqual(
    env.map((f) => f.ruleId),
    ["sensitive-file-in-diff", "github-token"],
  );
  const envResult = await runPostPass({
    repoRoot,
    diff: diffFor([`KEY=${token}`], ".env"),
    lanes: [],
  });
  assert.equal(
    envResult.comments.length,
    2,
    "a committed env and credential both publish without their value",
  );
  assert(!JSON.stringify(envResult).includes(token));
  const template = runSecretDiff(diffFor([`KEY=${token}`], ".env.local.example"));
  assert.deepEqual(
    template.map((f) => f.ruleId),
    ["github-token"],
    "template allow does not suppress credential detection",
  );
  const quoted = [
    'diff --git "a/s p/\\303\\251.ts" "b/s p/\\303\\251.ts"',
    '+++ "b/s p/\\303\\251.ts"',
    "@@ -0,0 +12 @@",
    `+${token}`,
    "",
  ].join("\n");
  assert.deepEqual(
    runSecretDiff(quoted).map((f) => [f.file, f.line]),
    [["s p/é.ts", 12]],
  );
  const payloadHeader = diffFor([`++ ${token}`, "const safe = 1;"], "src/a.ts");
  assert.deepEqual(
    runSecretDiff(payloadHeader).map((f) => [f.file, f.line]),
    [["src/a.ts", 1]],
    "+++ payload is data, not a path header",
  );
  const det = await runDetPriors({ repoRoot, diff, mode: "check", selector: null });
  assert.equal(det.findings.filter((f) => f.source === "secret-diff").length, 2);
  for (const mode of ["check", "review"] as const) {
    const result = await review({ repoRoot, diff, selector: null, config: { mode } });
    assert.equal(
      result.comments.length,
      2,
      `${mode} without package.json keeps the independent findings`,
    );
    assert(!JSON.stringify(result.comments).includes(token));
  }
  writeFileSync(
    join(repoRoot, "package.json"),
    JSON.stringify({ name: "fixture", version: "0.0.1" }),
  );
  const pruned = await review({ repoRoot, diff, selector: null, config: { mode: "review" } });
  assert.equal(pruned.comments.length, 2, "all-pruned review keeps the findings without a model");
  assert.equal(pruned.metadata.runId, undefined);
  for (const plain of ["a:b", "a:", ":"])
    assert.equal(
      runSecretDiff(diffFor([`AUTHORIZATION: basic ${Buffer.from(plain).toString("base64")}`]))[0]
        ?.ruleId,
      "basic-authorization",
    );
  const noHunks = [
    "diff --git a/.env b/.env\nnew file mode 100644\nindex e69de29..e69de29\n",
    "diff --git a/config.txt b/.env\nsimilarity index 100%\nrename from config.txt\nrename to .env\n",
    'diff --git "a/s p/cert.pem" "b/s p/cert.pem"\nnew file mode 100644\nBinary files /dev/null and "b/s p/cert.pem" differ\n',
  ];
  for (const diff of noHunks) {
    const result = await runPostPass({
      repoRoot,
      diff,
      lanes: [{ lane: "down", status: "ok", scope: [], findings: [] }],
    });
    assert.equal(result.comments.length, 1, "sensitive paths publish without a text hunk");
    assert.equal(result.comments[0]?.lineStart, 0);
    assert.equal(result.comments[0]?.lineEnd, 0);
    assert(CommentSetSchema.safeParse(result).success);
  }
  assert.equal(
    runSecretDiff("diff --git a/.env b/.env\ndeleted file mode 100644\n").length,
    0,
    "a deleted sensitive file is not reported",
  );
  const headerRepo = join(repoRoot, "header-repo");
  mkdirSync(join(headerRepo, "s b"), { recursive: true });
  writeFileSync(join(headerRepo, "s b/cert.pem"), "");
  execFileSync("git", ["init", "-q"], { cwd: headerRepo });
  execFileSync("git", ["add", "."], { cwd: headerRepo });
  const actualHeader = execFileSync("git", ["diff", "--cached"], {
    cwd: headerRepo,
    encoding: "utf8",
  });
  assert.deepEqual(
    runSecretDiff(actualHeader).map((f) => [f.file, f.line]),
    [["s b/cert.pem", 0]],
    "real Git unquoted spaces cannot change the file anchor",
  );
  process.stdout.write("all secret-diff assertions passed\n");
} finally {
  rmSync(repoRoot, { recursive: true, force: true });
}

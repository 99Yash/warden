import { db, securityRuns } from "@warden/db";
import { parseUnifiedDiff, type ChangedFile } from "../diff/index.js";
import { verifyCitations } from "../llm/verify-citations.js";
import { runDetPriors, type DetPriors } from "../review-harness/det-priors.js";
import type { DegradedEntry } from "../schema.js";
import { evaluateTriageGate, isSecuritySensitivePath } from "./triage-gate.js";
import type { SecurityHarnessInput, SecurityHarnessOutput } from "./types.js";

export async function runSecurityHarness(
  input: SecurityHarnessInput,
): Promise<SecurityHarnessOutput> {
  const startedAt = Date.now();
  if (!input.detPriors) {
    const parsed = input.diff ? parseUnifiedDiff(input.diff) : [];
    if (canFastSkipBeforeDetPriors(parsed)) {
      const degraded = await recordSecurityRun({
        mode: input.config.mode,
        commentsEmitted: 0,
      });
      return {
        comments: [],
        metadata: {
          durationMs: Date.now() - startedAt,
          degradedWorkers: [
            ...degraded,
            {
              kind: "info",
              topic: "security",
              message:
                "Deep security analysis skipped — no security det findings; no security-sensitive path matches",
            },
          ],
        },
      };
    }
  }

  const detPriors =
    input.detPriors ??
    (await runSecurityDetPriors({
      diff: input.diff,
      repoRoot: input.repoRoot,
    }));

  const gate = evaluateTriageGate({ detPriors });
  if (!gate.proceed) {
    const recordDegraded = await recordSecurityRun({
      mode: input.config.mode,
      commentsEmitted: 0,
    });
    return {
      comments: [],
      metadata: {
        durationMs: Date.now() - startedAt,
        degradedWorkers: [
          ...detPriors.degraded,
          ...recordDegraded,
          {
            kind: "info",
            topic: "security",
            message: `Deep security analysis skipped — ${gate.reason}`,
          },
        ],
      },
    };
  }

  // Foundation slice: the deterministic gate is now wired. Plan/worker/synth
  // phases land next; keep the result shape stable and verifier in place so
  // CLI composition can be implemented against the real M18 boundary.
  const verified = await verifyCitations({
    comments: [],
    repoRoot: input.repoRoot,
  });

  const degraded: DegradedEntry[] = [
    ...detPriors.degraded,
    {
      kind: "info",
      topic: "security",
      message:
        `Deep security analysis gate passed ` +
        `(${gate.securitySignalCount} security signal${gate.securitySignalCount === 1 ? "" : "s"}, ` +
        `${gate.sensitivePathCount} sensitive path${gate.sensitivePathCount === 1 ? "" : "s"}); ` +
        `plan/worker/synth phases are not implemented yet`,
    },
    ...verified.degraded,
  ];
  degraded.unshift(
    ...(await recordSecurityRun({
      mode: input.config.mode,
      commentsEmitted: verified.comments.length,
    })),
  );

  return {
    comments: verified.comments,
    metadata: {
      durationMs: Date.now() - startedAt,
      degradedWorkers: degraded,
    },
  };
}

async function recordSecurityRun(input: {
  mode: "security" | "review-deep";
  commentsEmitted: number;
}): Promise<DegradedEntry[]> {
  try {
    db()
      .insert(securityRuns)
      .values({
        mode: input.mode,
        modelBoss: "claude-opus-4-7",
        modelWorkerStrong: "claude-sonnet-4-6",
        modelWorkerCheap: "claude-haiku-4-5-20251001",
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        commentsEmitted: input.commentsEmitted,
      })
      .run();
    return [];
  } catch (err) {
    return [
      {
        kind: "warning",
        topic: "security",
        message: `security run record failed (${formatErr(err)})`,
      },
    ];
  }
}

function canFastSkipBeforeDetPriors(changed: ChangedFile[]): boolean {
  if (changed.length === 0) return true;
  if (changed.some((file) => isSecuritySensitivePath(file.path))) return false;
  return changed.every((file) => isDocumentationPath(file.path));
}

function isDocumentationPath(path: string): boolean {
  const lower = path.toLowerCase();
  return (
    lower.endsWith(".md") ||
    lower.endsWith(".mdx") ||
    lower.endsWith(".txt") ||
    lower.startsWith("docs/")
  );
}

function formatErr(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 160) : String(err).slice(0, 160);
}

async function runSecurityDetPriors(input: {
  diff: string;
  repoRoot: string;
}): Promise<DetPriors> {
  return runDetPriors({
    diff: input.diff,
    repoRoot: input.repoRoot,
    mode: "check",
    selector: null,
  });
}

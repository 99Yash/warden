import type { DetPriors } from "../review-harness/det-priors.js";
import type { CommentSet } from "../schema.js";

export type SecurityHarnessMode = "security" | "review-deep";

export interface SecurityHarnessConfig {
  mode: SecurityHarnessMode;
  verbose?: boolean;
}

export interface SecurityHarnessInput {
  diff: string;
  repoRoot: string;
  config: SecurityHarnessConfig;
  detPriors?: DetPriors;
}

export type SecurityHarnessOutput = CommentSet;

export interface TriageGateInput {
  detPriors: Pick<DetPriors, "changed" | "findings" | "vulnComments">;
}

export type TriageGateResult =
  | {
      proceed: true;
      securitySignalCount: number;
      sensitivePathCount: number;
    }
  | {
      proceed: false;
      reason: string;
      securitySignalCount: number;
      sensitivePathCount: number;
    };

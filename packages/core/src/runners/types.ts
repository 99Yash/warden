export type FindingSeverity = "error" | "warning" | "info";

/**
 * Discriminator across all deterministic worker outputs. M3 had `tsc`+`eslint`;
 * M5 added `jscpd`; M7 (ADR-0021 #1) adds `scalability`, `deadcode`,
 * `consistency` for the three new detector workers.
 */
export interface ToolFinding {
  source: "tsc" | "eslint" | "jscpd" | "scalability" | "deadcode" | "consistency";
  file: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  severity: FindingSeverity;
  ruleId?: string;
  message: string;
}

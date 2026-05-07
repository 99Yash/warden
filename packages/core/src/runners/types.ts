export type FindingSeverity = "error" | "warning" | "info";

export interface ToolFinding {
  source: "tsc" | "eslint" | "jscpd";
  file: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  severity: FindingSeverity;
  ruleId?: string;
  message: string;
}

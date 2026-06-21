export type FindingSeverity = "error" | "warning" | "info";

/**
 * Discriminator across all deterministic worker outputs. M3 had `tsc`+`eslint`;
 * M5 added `jscpd`; M7 (ADR-0021 #1) adds `scalability`, `deadcode`,
 * `consistency` for the three new detector workers. M12 (ADR-0027) adds
 * `leverage` for the bounded stdlib idiom-miss detector. ADR-0046 adds
 * `react-doctor` for the subprocessed `react-doctor` CLI det-prior.
 *
 * `evidence` is an optional `{path, line, snippet}` triple that snippet-citing
 * detectors (leverage + react-doctor) populate so the global verifier
 * (`verify-citations.ts`) can substring-check the cited line. `toComment()`
 * copies the triple into the emitted `Source` envelope when present.
 */
export interface ToolFinding {
  source:
    | "tsc"
    | "eslint"
    | "jscpd"
    | "scalability"
    | "deadcode"
    | "consistency"
    | "leverage"
    | "react-doctor";
  file: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  severity: FindingSeverity;
  ruleId?: string;
  message: string;
  /**
   * ADR-0046: react-doctor's coarse category (`Security` | `Bugs` |
   * `Performance` | `Maintainability` | `Accessibility`). Carried only on
   * `source === "react-doctor"` findings so `mapSeverity()` and
   * `routeFindingToConcern()` can route off it without string-packing the
   * `ruleId`. Undefined for every other source.
   */
  rdCategory?: string;
  evidence?: {
    path: string;
    /** 1-indexed; must satisfy SourceSchema's positive line invariant. */
    line: number;
    snippet: string;
  };
}

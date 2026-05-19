export { runSecurityHarness } from "./harness.js";
export {
  evaluateTriageGate,
  isSecuritySensitivePath,
  SECURITY_SENSITIVE_PATTERNS,
} from "./triage-gate.js";
export type {
  SecurityHarnessConfig,
  SecurityHarnessInput,
  SecurityHarnessMode,
  SecurityHarnessOutput,
  TriageGateInput,
  TriageGateResult,
} from "./types.js";

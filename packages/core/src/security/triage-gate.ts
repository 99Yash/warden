import type { ToolFinding } from "../runners/types.js";
import type { TriageGateInput, TriageGateResult } from "./types.js";

export const SECURITY_SENSITIVE_PATTERNS = [
  "**/{auth,login,signin,signup,session,oauth}/**",
  "**/api/**",
  "**/routes/**",
  "**/middleware/**",
  "**/crypto/**",
  "**/encrypt/**",
  "**/db/**",
  "**/database/**",
  "**/queries/**",
  "**/migrations/**",
  "**/*.sql",
  "**/package-lock.json",
  "**/pnpm-lock.yaml",
  "**/yarn.lock",
  "**/.env*",
] as const;

export function evaluateTriageGate(input: TriageGateInput): TriageGateResult {
  const securitySignalCount =
    input.detPriors.vulnComments.length + input.detPriors.findings.filter(isSecurityFinding).length;
  const sensitivePathCount = input.detPriors.changed.filter((file) =>
    isSecuritySensitivePath(file.path),
  ).length;

  if (securitySignalCount > 0 || sensitivePathCount > 0) {
    return { proceed: true, securitySignalCount, sensitivePathCount };
  }

  return {
    proceed: false,
    reason: "no security det findings; no security-sensitive path matches",
    securitySignalCount,
    sensitivePathCount,
  };
}

export function isSecuritySensitivePath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/").toLowerCase();
  const base = normalized.split("/").pop() ?? normalized;
  if (base === "package-lock.json" || base === "pnpm-lock.yaml" || base === "yarn.lock") {
    return true;
  }
  if (base.startsWith(".env")) return true;
  if (normalized.endsWith(".sql")) return true;

  const segments = normalized.split("/").filter(Boolean);
  const sensitiveDirs = new Set([
    "auth",
    "login",
    "signin",
    "signup",
    "session",
    "oauth",
    "api",
    "routes",
    "middleware",
    "crypto",
    "encrypt",
    "db",
    "database",
    "queries",
    "migrations",
  ]);
  return segments.some((segment) => sensitiveDirs.has(segment));
}

function isSecurityFinding(finding: ToolFinding): boolean {
  if (finding.source !== "eslint") return false;
  return (
    finding.ruleId?.startsWith("security/") === true ||
    finding.ruleId?.startsWith("no-secrets/") === true
  );
}

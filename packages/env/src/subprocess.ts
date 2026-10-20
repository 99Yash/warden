/**
 * ADR-0054: repo-controlled tools receive only execution settings, never
 * provider/CI secrets, user config paths, or runtime hooks such as NODE_OPTIONS.
 * This reduces inherited authority; it is not a filesystem or OS sandbox.
 */
const DETERMINISTIC_ENV_KEYS = [
  "PATH",
  "SystemRoot",
  "WINDIR",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "WARDEN_REACT_DOCTOR",
  "WARDEN_CACHE_PATH",
] as const;

export function deterministicProcessEnv(
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const entries: Array<[string, string]> = [];
  for (const key of DETERMINISTIC_ENV_KEYS) {
    const value = source[key];
    if (value !== undefined) entries.push([key, value]);
  }
  return Object.fromEntries(entries);
}

/** Apply the same policy for directly launched `warden mcp` sessions. */
export function restrictProcessToDeterministicEnv(): void {
  const env = deterministicProcessEnv();
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, env);
}

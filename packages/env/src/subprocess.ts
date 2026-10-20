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

/**
 * ADR-0054 amendment 2026-10-20: the keys that `git` needs in addition to the
 * deterministic set. Each key is a location or a transport setting, never a
 * provider credential. Git runs config-defined programs (`core.fsmonitor`,
 * textconv drivers, credential helpers, `core.sshCommand`), and each of them
 * inherits this environment, so the list stays closed. Sources:
 * https://git-scm.com/docs/git#_environment_variables and
 * https://git-scm.com/docs/git-config#ENVIRONMENT.
 */
const GIT_ENV_KEYS = [
  // Global config (`$HOME/.gitconfig`, `$XDG_CONFIG_HOME/git/config`) and the
  // default `core.excludesFile` (`$XDG_CONFIG_HOME/git/ignore`, else
  // `$HOME/.config/git/ignore`). `isGitIgnored` depends on the global ignore
  // file, and `safe.directory` is read only from protected (system, global,
  // command) config: https://git-scm.com/docs/git-config#FILES,
  // https://git-scm.com/docs/git-config#Documentation/git-config.txt-safedirectory.
  "HOME",
  "XDG_CONFIG_HOME",
  // Git for Windows sets HOME from HOMEDRIVE + HOMEPATH, else from
  // USERPROFILE, when HOME is not set (`setup_windows_environment` in
  // https://github.com/git/git/blob/master/compat/mingw.c).
  "HOMEDRIVE",
  "HOMEPATH",
  "USERPROFILE",
  // Repository location. Git exports these to hooks, so `warden check` that
  // runs from a pre-commit hook must read the same repository and index:
  // https://git-scm.com/docs/git#Documentation/git.txt-GITDIR and
  // https://git-scm.com/docs/githooks.
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  // Repository discovery limits:
  // https://git-scm.com/docs/git#Documentation/git.txt-GITCEILINGDIRECTORIES.
  "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
  // The operator's choice of config files:
  // https://git-scm.com/docs/git#Documentation/git.txt-GITCONFIGGLOBAL.
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_NOSYSTEM",
  // Config from the environment, for example `safe.directory` in a container.
  // The numbered GIT_CONFIG_KEY_<n> / GIT_CONFIG_VALUE_<n> pairs match
  // GIT_CONFIG_PAIR_KEY below:
  // https://git-scm.com/docs/git-config#Documentation/git-config.txt-GITCONFIGCOUNT.
  "GIT_CONFIG_COUNT",
  // Warden's git calls are local, but in a partial clone `git diff` fetches
  // a missing blob from the promisor remote on demand
  // (https://git-scm.com/docs/partial-clone). An SSH remote needs the agent
  // socket and the operator's SSH command for that fetch:
  // https://git-scm.com/docs/git#Documentation/git.txt-GITSSHCOMMAND.
  "SSH_AUTH_SOCK",
  "GIT_SSH_COMMAND",
  "GIT_SSH",
] as const;

const GIT_CONFIG_PAIR_KEY = /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/;

/**
 * The environment for every `git` child: `deterministicProcessEnv()` plus
 * `GIT_ENV_KEYS` and the GIT_CONFIG_KEY_<n> / GIT_CONFIG_VALUE_<n> pairs.
 * Provider keys, CI tokens, and Node hooks do not reach git or the programs
 * that git starts. The locale keys come from the deterministic set; Warden
 * parses only output that git does not translate (diff headers, `ls-files`,
 * `grep -n`, `rev-parse`, `symbolic-ref`, exit codes).
 */
export function gitProcessEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env = deterministicProcessEnv(source);
  for (const key of GIT_ENV_KEYS) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && GIT_CONFIG_PAIR_KEY.test(key)) env[key] = value;
  }
  return env;
}

/** Apply the same policy for directly launched `warden mcp` sessions. */
export function restrictProcessToDeterministicEnv(): void {
  const env = deterministicProcessEnv();
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, env);
}

import { createRequire } from "node:module";
import { isAbsolute, relative, resolve } from "node:path";
import type { DegradedEntry } from "../schema.js";
import type { ToolFinding } from "./types.js";

/**
 * ESLint security detector (ADR-0028 §2, M13). Runs a **second** ESLint
 * invocation independent of the user's eslint config — uses Warden-pinned
 * `eslint` + `eslint-plugin-security` + `eslint-plugin-no-secrets`, all
 * declared in `@warden/core`'s own dependencies. The user's repo does NOT
 * need an ESLint config (or even ESLint at all) for this pass to run.
 *
 * Implementation choice: call the ESLint Node API directly rather than
 * shelling out to a temp config + binary. Two reasons: (a) the Warden-
 * managed flat config bundles plugin instances that must resolve relative
 * to `@warden/core`'s own `node_modules/`, which is brittle to express via
 * a file written to `os.tmpdir()` (option A in the plan) and a hassle to
 * thread through tsdown asset copying (option C); (b) the Node API surfaces
 * structured results directly so we don't parse `npx` stdout. ADR-0013's
 * I/O-purity rule is about not reading `process.argv` / writing
 * `process.stdout`, not about avoiding library calls — calling
 * `new ESLint(...)` is the same boundary posture as shelling out to it.
 *
 * Rule prefixes (`security/*`, `no-secrets/*`) are surfaced verbatim in
 * `ToolFinding.ruleId`; `to-comment.ts` routes them to
 * `{ category: "security", tier: 1 }` regardless of ESLint's own severity
 * (per ADR-0028 §7 + "Tier-1 ESLint mapping is unconditional" — these
 * patterns exist *because* they are security issues; relegating any to
 * Tier 2/3 invites the Tier-3 verbose gate to suppress them).
 *
 * Tier-1 routing also means each finding bypasses the M13 confidence floor
 * unconditionally — clear-cut security patterns surface regardless of
 * sub-agent-noise volume control.
 */

export interface EslintSecurityRunResult {
  findings: ToolFinding[];
  degraded: DegradedEntry[];
}

const LINT_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const TS_EXTS = new Set([".ts", ".tsx"]);

// CJS plugins live in our deps. `createRequire` resolves them through Node's
// usual resolution from this module's URL, which is the right scope — they
// must come from `@warden/core`'s declared dependencies, not the user's.
const requireFromHere = createRequire(import.meta.url);

interface ESLintMessage {
  ruleId: string | null;
  severity: 1 | 2;
  message: string;
  line?: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
  fatal?: boolean;
}

interface ESLintLintResult {
  filePath: string;
  messages: ESLintMessage[];
}

interface ESLintLike {
  lintFiles(patterns: string | string[]): Promise<ESLintLintResult[]>;
}

interface ESLintClass {
  new (options: unknown): ESLintLike;
}

export async function runEslintSecurity(
  repoRoot: string,
  changedFiles: string[],
): Promise<EslintSecurityRunResult> {
  const targets = changedFiles.filter((f) => {
    const dot = f.lastIndexOf(".");
    return dot !== -1 && LINT_EXTS.has(f.slice(dot));
  });

  if (targets.length === 0) {
    return { findings: [], degraded: [] };
  }

  let eslint: ESLintLike;
  try {
    eslint = createSecurityEslint(repoRoot);
  } catch (err) {
    return {
      findings: [],
      degraded: [
        {
          kind: "warning",
          topic: "eslint-security",
          message: `eslint-security: setup failed (${formatErr(err)})`,
        },
      ],
    };
  }

  let results: ESLintLintResult[];
  try {
    // ESLint's `lintFiles` expects either paths or globs. We've already
    // filtered to lintable extensions and the constructor sets
    // `errorOnUnmatchedPattern: false`, so missing files (e.g. a renamed
    // file that no longer exists at this path) degrade silently.
    results = await eslint.lintFiles(targets);
  } catch (err) {
    return {
      findings: [],
      degraded: [
        {
          kind: "warning",
          topic: "eslint-security",
          message: `eslint-security: lint failed (${formatErr(err)})`,
        },
      ],
    };
  }

  const findings: ToolFinding[] = [];
  const degraded: DegradedEntry[] = [];
  for (const file of results) {
    const absFile = isAbsolute(file.filePath) ? file.filePath : resolve(repoRoot, file.filePath);
    const relFile = relative(repoRoot, absFile);
    for (const msg of file.messages) {
      const ruleId = msg.ruleId ?? undefined;
      // Fatal parse errors emit `ruleId: null` plus `fatal: true`. The
      // Warden-managed pass doesn't know the user's tsconfig, so a TS file
      // using project-specific syntax (decorators, paths) may not parse —
      // surface once per file as info, don't pollute findings.
      if (msg.fatal === true || ruleId === null || ruleId === undefined) {
        degraded.push({
          kind: "info",
          topic: "eslint-security",
          message: `eslint-security: skipped ${relFile} (parse: ${msg.message.slice(0, 120)})`,
        });
        // One degraded per fatal message is fine; ESLint typically emits a
        // single fatal per unparseable file.
        continue;
      }
      // Only route the Warden-managed plugins' rules. Anything else slipping
      // through would indicate config bleed; emit info and skip.
      if (!isSecurityRule(ruleId)) {
        continue;
      }
      const line = msg.line ?? 1;
      findings.push({
        source: "eslint",
        file: relFile,
        line,
        column: msg.column ?? 1,
        endLine: msg.endLine,
        endColumn: msg.endColumn,
        severity: "error",
        ruleId,
        message: msg.message,
      });
    }
  }
  return { findings, degraded };
}

function isSecurityRule(ruleId: string): boolean {
  return ruleId.startsWith("security/") || ruleId.startsWith("no-secrets/");
}

function createSecurityEslint(repoRoot: string): ESLintLike {
  const eslintModule = requireFromHere("eslint") as { ESLint: ESLintClass };
  const pluginSecurity = requireFromHere("eslint-plugin-security") as unknown;
  const pluginNoSecrets = requireFromHere("eslint-plugin-no-secrets") as unknown;
  const tsParser = requireFromHere("@typescript-eslint/parser") as unknown;

  // Single flat-config entry per file family. Spread two entries so the TS
  // parser is only picked up for TS files — leaving non-TS files on
  // ESLint's default parser keeps plain JS / .mjs / .cjs cheap.
  const overrideConfig = [
    {
      // ESLint can be invoked with paths inside dirs the user has gitignored
      // (e.g. `dist/`, `node_modules/`). M9's noise filter prunes most of
      // this, but defence-in-depth: ESLint's own ignore set keeps the
      // Warden-managed pass from spending time on generated code.
      ignores: ["**/node_modules/**", "**/dist/**", "**/build/**"],
    },
    {
      files: ["**/*.{js,jsx,mjs,cjs}"],
      languageOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        parserOptions: { ecmaFeatures: { jsx: true } },
      },
      plugins: {
        security: pluginSecurity,
        "no-secrets": pluginNoSecrets,
      },
      rules: rulesBlock(),
    },
    {
      files: ["**/*.{ts,tsx}"],
      languageOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        parser: tsParser,
        parserOptions: {
          ecmaFeatures: { jsx: true },
          // We deliberately do NOT pass `project` here. Type-aware linting
          // requires a tsconfig discovery pass that's expensive and brittle
          // against the user's actual project layout. The security plugins
          // we ship are AST-only — no type info needed.
        },
      },
      plugins: {
        security: pluginSecurity,
        "no-secrets": pluginNoSecrets,
      },
      rules: rulesBlock(),
    },
  ];

  return new eslintModule.ESLint({
    cwd: repoRoot,
    overrideConfigFile: true,
    overrideConfig,
    errorOnUnmatchedPattern: false,
    // Suppress ESLint's own "no rule found" warnings — every rule we enable
    // ships in the plugins we just registered.
    ignore: true,
  });
}

/**
 * Rules enabled in the Warden-managed security pass per m13-plan §11.
 * Narrow v0 set — every rule here ships Tier-1 unconditionally, so rules
 * with known FP volume on legitimate code stay disabled:
 *
 * - `detect-object-injection` flags broad `obj[key]` shapes (off).
 * - `detect-unsafe-regex` produces FPs on safely-bounded regexes whose
 *   underlying `safe-regex` algorithm doesn't recognize the bound (off
 *   for v0; revisit if dogfood reveals an actual ReDoS pattern).
 * - `detect-possible-timing-attacks` requires intent to be reasoned about
 *   ("is this constant-time-relevant?") and is the sub-agent's lane (off).
 * - `detect-non-literal-require` overlaps with the LLM's flow recognition
 *   on dynamic `require` (off in v0).
 */
function rulesBlock(): Record<string, "error"> {
  return {
    "security/detect-eval-with-expression": "error",
    "security/detect-child-process": "error",
    "security/detect-non-literal-fs-filename": "error",
    "security/detect-non-literal-regexp": "error",
    "security/detect-pseudoRandomBytes": "error",
    "security/detect-buffer-noassert": "error",
    "security/detect-disable-mustache-escape": "error",
    "no-secrets/no-secrets": "error",
  };
}

function formatErr(err: unknown): string {
  if (err instanceof Error) return err.message.slice(0, 200);
  return String(err).slice(0, 200);
}

// Re-export the TS-extension set so the dispatcher can decide whether to skip
// the Warden security pass entirely when no JS/TS file is in the diff.
export { LINT_EXTS, TS_EXTS };

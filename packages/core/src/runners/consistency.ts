import { readFile, readdir } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";
import ts from "typescript";
import type { ChangedFile } from "../diff/index.js";
import type { DegradedEntry } from "../schema.js";
import { formatErr } from "./_shared.js";
import type { ToolFinding } from "./types.js";

/**
 * Consistency detector (ADR-0021 §1c). Deterministic structured-verifier for
 * three load-bearing claim types in user-facing docs:
 *
 *   1. **Env-var requirements** — README/CLAUDE/AGENTS/docs claim a var is
 *      required, optional, or has a default value. Compared against the zod
 *      schema in `packages/env/src/index.ts` (re-parsed as source — see below).
 *   2. **CLI command shapes** — `warden <verb>` and `--flag` claims in
 *      code-fenced examples. Compared against `program.command(...)` /
 *      `.option(...)` calls in `packages/cli/src/{index,commands/*}.ts`.
 *   3. **File-path constants** — `.warden/<path>` references in docs. Verified
 *      by grepping `packages/*\/src/**` for the same literal.
 *
 * Why re-parse instead of import: importing `wardenEnv()` would invoke its
 * zod parser on `process.env`, which throws on fresh repos without `.env`.
 * The detector must run regardless of env state — static source parse via
 * `ts.createSourceFile` is the only side-effect-free path. Same reasoning
 * for the CLI surface: running `commander` requires executing CLI startup.
 *
 * Out of scope for v0 (per ADR-0021's deferrals):
 *   - Free-form prose claim extraction (deferred to an LLM sub-agent, M11+).
 *   - Multi-language env / CLI surfaces — TS-only via the parser.
 *   - "Schema names env var not in any doc" (omission, not contradiction).
 *   - Inter-verb flag-binding accuracy: a `--flag` registered on *any* verb
 *     in the program is treated as "the program knows that flag" — false-
 *     negative on inter-verb mismatches is intentionally accepted for v0.
 *   - Positional-arg validation; `--flag <value>` value-shape checks.
 */

export interface ConsistencyRunnerInput {
  repoRoot: string;
  changed: ChangedFile[];
}

export interface ConsistencyRunnerOutput {
  findings: ToolFinding[];
  degraded: DegradedEntry[];
}

const ENV_CLAIM_RE =
  /\b(WARDEN_[A-Z_]+|ANTHROPIC_API_KEY|GOOGLE_GENERATIVE_AI_API_KEY|VOYAGE_API_KEY|NODE_ENV)\b[^.\n]{0,80}?\b(required|optional|defaults?\s+to\s+`?([A-Za-z0-9_./-]+)`?|default\s+`?([A-Za-z0-9_./-]+)`?)\b/gi;

const CLI_CLAIM_RE = /\bwarden\s+([a-z][a-z0-9-]*)\b((?:\s+--[a-z][a-z0-9-]*(?:\s+\S+)?)*)/g;

const PATH_CLAIM_RE = /\.warden\/[\w./-]+/g;

const DOC_DEPTH_LIMIT = 4;
const SRC_DEPTH_LIMIT = 6;
const SOURCE_EXT_RE = /\.(?:tsx?|mts|cts|jsx?|mjs|cjs)$/;
const ENV_SOURCE_REL = "packages/env/src/index.ts";
const CLI_INDEX_REL = "packages/cli/src/index.ts";
const CLI_COMMANDS_DIR_REL = "packages/cli/src/commands";

const DOC_PATH_RE = /^(?:README|CLAUDE|AGENTS)\.md$|^docs\/.+\.md$/i;
const SRC_SURFACE_RE = /^packages\/[^/]+\/src\//;

export async function runConsistency(
  input: ConsistencyRunnerInput,
): Promise<ConsistencyRunnerOutput> {
  const findings: ToolFinding[] = [];
  const degraded: DegradedEntry[] = [];

  const changedSet = new Set(input.changed.map((c) => c.path));

  // Trigger gate: skip the entire detector when the diff touches neither any
  // tracked doc file nor any `packages/*/src/**` source file. The per-claim
  // gating below would suppress all findings in that case anyway, so doing
  // the doc walk + env/CLI parse + source-tree scan would be pure overhead.
  const anyDocTouched = [...changedSet].some((p) => DOC_PATH_RE.test(p));
  const srcSurfaceTouched = [...changedSet].some((p) => SRC_SURFACE_RE.test(p));
  if (!anyDocTouched && !srcSurfaceTouched) {
    return { findings, degraded };
  }

  // Collect doc set.
  const docs = await collectDocs(input.repoRoot, degraded);
  if (docs.length === 0) {
    return { findings, degraded };
  }

  // Parse env schema. On parse failure, env claims are skipped (CLI + path
  // claims still run).
  const envFacts = await loadEnvFacts(input.repoRoot, degraded);
  const cliFacts = await loadCliFacts(input.repoRoot, degraded);

  // Pre-walk source tree for path-constant verification.
  const pathLiterals = await collectPathLiterals(input.repoRoot, degraded);

  // Decide which findings to emit. A claim survives if either:
  //   - its source doc is in `changed`, OR
  //   - the code-side artifact it verifies against is touched by `changed`.
  const envSourceTouched = changedSet.has(ENV_SOURCE_REL);
  const cliSurfaceTouched = [...changedSet].some(
    (p) => p === CLI_INDEX_REL || p.startsWith(`${CLI_COMMANDS_DIR_REL}/`),
  );

  for (const doc of docs) {
    const docTouched = changedSet.has(doc.relPath);

    if (envFacts) {
      for (const claim of extractEnvClaims(doc)) {
        if (!docTouched && !envSourceTouched) continue;
        const finding = verifyEnvClaim(claim, doc, envFacts);
        if (finding) findings.push(finding);
      }
    }

    if (cliFacts) {
      for (const claim of extractCliClaims(doc)) {
        if (!docTouched && !cliSurfaceTouched) continue;
        const verbFinding = verifyCliVerb(claim, doc, cliFacts);
        if (verbFinding) {
          findings.push(verbFinding);
          continue; // unknown verb subsumes per-flag checks
        }
        for (const f of verifyCliFlags(claim, doc, cliFacts)) findings.push(f);
      }
    }

    if (pathLiterals) {
      for (const claim of extractPathClaims(doc)) {
        // Path-literal claims like `.warden/cache.sqlite` reference runtime
        // paths that never appear in a diff. Gate on whether any source file
        // under `packages/*/src/**` (where these literals are defined) was
        // touched, not on the literal string itself.
        if (!docTouched && !srcSurfaceTouched) continue;
        if (!pathLiterals.has(claim.literal)) {
          findings.push({
            source: "consistency",
            file: doc.relPath,
            line: claim.line,
            column: 1,
            endLine: claim.line,
            severity: "warning",
            ruleId: "stale-path",
            message: `Doc references ${claim.literal} but no source file under packages/*/src contains that literal`,
          });
        }
      }
    }
  }

  return { findings, degraded };
}

// ─── Doc collection ─────────────────────────────────────────────────────────

interface DocFile {
  relPath: string;
  abs: string;
  content: string;
  lines: string[];
}

const ROOT_DOCS = ["README.md", "CLAUDE.md", "AGENTS.md"];

async function collectDocs(repoRoot: string, degraded: DegradedEntry[]): Promise<DocFile[]> {
  const out: DocFile[] = [];
  for (const rel of ROOT_DOCS) {
    const abs = resolvePath(repoRoot, rel);
    try {
      const content = await readFile(abs, "utf8");
      out.push({ relPath: rel, abs, content, lines: content.split("\n") });
    } catch {
      // Missing root doc is benign — not every repo ships AGENTS.md.
    }
  }
  // Recursive docs/**.md (depth ≤ 4).
  const docsRoot = resolvePath(repoRoot, "docs");
  try {
    await walkDocsDir(docsRoot, repoRoot, 0, out);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      degraded.push({
        kind: "warning",
        topic: "consistency",
        message: `consistency: failed to walk docs/ (${formatErr(err)})`,
      });
    }
  }
  return out;
}

async function walkDocsDir(
  dirAbs: string,
  repoRoot: string,
  depth: number,
  out: DocFile[],
): Promise<void> {
  if (depth > DOC_DEPTH_LIMIT) return;
  const entries = await readdir(dirAbs, { withFileTypes: true });
  for (const ent of entries) {
    const childAbs = join(dirAbs, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === "node_modules" || ent.name.startsWith(".")) continue;
      await walkDocsDir(childAbs, repoRoot, depth + 1, out);
      continue;
    }
    if (!ent.isFile() || !ent.name.endsWith(".md")) continue;
    try {
      const content = await readFile(childAbs, "utf8");
      const rel = relativize(repoRoot, childAbs);
      out.push({ relPath: rel, abs: childAbs, content, lines: content.split("\n") });
    } catch {
      // Per-file read failure: skip silently — the doc set is best-effort.
    }
  }
}

function relativize(repoRoot: string, abs: string): string {
  const rootAbs = resolvePath(repoRoot);
  const a = resolvePath(abs);
  return a.startsWith(rootAbs) ? a.slice(rootAbs.length + 1) : a;
}

// ─── Claim extraction ───────────────────────────────────────────────────────

interface EnvClaim {
  envVar: string;
  predicate: "required" | "optional" | "default";
  defaultValue?: string;
  line: number;
}

interface CliClaim {
  verb: string;
  flags: string[];
  line: number;
}

interface PathClaim {
  literal: string;
  line: number;
}

function lineOfOffset(content: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < content.length; i++) {
    if (content[i] === "\n") line++;
  }
  return line;
}

function extractEnvClaims(doc: DocFile): EnvClaim[] {
  const out: EnvClaim[] = [];
  ENV_CLAIM_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ENV_CLAIM_RE.exec(doc.content)) !== null) {
    const envVar = m[1]!;
    const predicate = (m[2] ?? "").toLowerCase();
    const defaultValue = m[3] ?? m[4];
    const line = lineOfOffset(doc.content, m.index);
    if (/^required$/.test(predicate)) {
      out.push({ envVar, predicate: "required", line });
    } else if (/^optional$/.test(predicate)) {
      out.push({ envVar, predicate: "optional", line });
    } else if (/default/.test(predicate) && defaultValue !== undefined) {
      out.push({ envVar, predicate: "default", defaultValue, line });
    }
  }
  return out;
}

function extractCliClaims(doc: DocFile): CliClaim[] {
  // Only inspect inside fenced code blocks to avoid prose noise like
  // "the `warden review` flow" — the plan's §1c CLI spec is shape-checked
  // against examples, not narrative references.
  const out: CliClaim[] = [];
  const fenceRe = /```[\s\S]*?```/g;
  let fenceMatch: RegExpExecArray | null;
  while ((fenceMatch = fenceRe.exec(doc.content)) !== null) {
    const fenceText = fenceMatch[0];
    const fenceOffset = fenceMatch.index;
    CLI_CLAIM_RE.lastIndex = 0;
    let cm: RegExpExecArray | null;
    while ((cm = CLI_CLAIM_RE.exec(fenceText)) !== null) {
      const verb = cm[1]!;
      const flagsBlob = cm[2] ?? "";
      const flags: string[] = [];
      const flagRe = /--[a-z][a-z0-9-]*/g;
      let fm: RegExpExecArray | null;
      while ((fm = flagRe.exec(flagsBlob)) !== null) flags.push(fm[0]);
      const line = lineOfOffset(doc.content, fenceOffset + cm.index);
      out.push({ verb, flags, line });
    }
  }
  return out;
}

function extractPathClaims(doc: DocFile): PathClaim[] {
  const out: PathClaim[] = [];
  PATH_CLAIM_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PATH_CLAIM_RE.exec(doc.content)) !== null) {
    const literal = m[0];
    const line = lineOfOffset(doc.content, m.index);
    out.push({ literal, line });
  }
  return out;
}

// ─── Env-schema parsing ─────────────────────────────────────────────────────

interface EnvFacts {
  /** `propName -> { kind, defaultValueLiteral? }` from re-parsing `env/src/index.ts`. */
  byName: Map<string, EnvFact>;
}

interface EnvFact {
  kind: "required" | "optional" | "default";
  defaultLiteral?: string;
}

async function loadEnvFacts(repoRoot: string, degraded: DegradedEntry[]): Promise<EnvFacts | undefined> {
  const abs = resolvePath(repoRoot, ENV_SOURCE_REL);
  let content: string;
  try {
    content = await readFile(abs, "utf8");
  } catch {
    return undefined; // benign — repo without warden's env package
  }
  let sf: ts.SourceFile;
  try {
    sf = ts.createSourceFile(abs, content, ts.ScriptTarget.Latest, true);
  } catch (err) {
    degraded.push({
      kind: "warning",
      topic: "consistency",
      message: `consistency: failed to parse env schema; env claims skipped (${formatErr(err)})`,
    });
    return undefined;
  }

  const byName = new Map<string, EnvFact>();
  const objLit = findZObjectLiteral(sf);
  if (!objLit) return { byName };

  for (const prop of objLit.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    let name: string | undefined;
    if (ts.isIdentifier(prop.name)) name = prop.name.text;
    else if (ts.isStringLiteral(prop.name)) name = prop.name.text;
    if (!name) continue;
    const fact = analyzeZodChain(prop.initializer);
    if (fact) byName.set(name, fact);
  }
  return { byName };
}

function findZObjectLiteral(sf: ts.SourceFile): ts.ObjectLiteralExpression | undefined {
  let found: ts.ObjectLiteralExpression | undefined;
  function visit(node: ts.Node): void {
    if (found) return;
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "z" &&
      node.expression.name.text === "object" &&
      node.arguments.length >= 1 &&
      ts.isObjectLiteralExpression(node.arguments[0]!)
    ) {
      found = node.arguments[0] as ts.ObjectLiteralExpression;
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return found;
}

function analyzeZodChain(expr: ts.Expression): EnvFact | undefined {
  // Walk the chain right-to-left so the outermost method wins for the kind.
  // `.default(X)` outranks `.optional()` outranks default-required.
  let cur: ts.Expression = expr;
  let hasOptional = false;
  let defaultLiteral: string | undefined;
  let safety = 30;
  while (safety-- > 0) {
    if (ts.isCallExpression(cur) && ts.isPropertyAccessExpression(cur.expression)) {
      const methodName = cur.expression.name.text;
      if (methodName === "optional") hasOptional = true;
      if (methodName === "default" && cur.arguments.length >= 1) {
        defaultLiteral = literalToString(cur.arguments[0]!);
      }
      cur = cur.expression.expression;
      continue;
    }
    break;
  }
  if (defaultLiteral !== undefined) return { kind: "default", defaultLiteral };
  if (hasOptional) return { kind: "optional" };
  return { kind: "required" };
}

function literalToString(node: ts.Node): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return node.text;
  if (node.kind === ts.SyntaxKind.TrueKeyword) return "true";
  if (node.kind === ts.SyntaxKind.FalseKeyword) return "false";
  return undefined;
}

function verifyEnvClaim(claim: EnvClaim, doc: DocFile, env: EnvFacts): ToolFinding | null {
  const fact = env.byName.get(claim.envVar);
  if (!fact) {
    return {
      source: "consistency",
      file: doc.relPath,
      line: claim.line,
      column: 1,
      endLine: claim.line,
      severity: "warning",
      ruleId: "env-not-in-schema",
      message: `${doc.relPath} mentions env var ${claim.envVar} but it is not defined in ${ENV_SOURCE_REL}`,
    };
  }
  if (claim.predicate === "required" && fact.kind !== "required") {
    return {
      source: "consistency",
      file: doc.relPath,
      line: claim.line,
      column: 1,
      endLine: claim.line,
      severity: "warning",
      ruleId: "env-required-mismatch",
      message: `${doc.relPath} claims ${claim.envVar} is required; ${ENV_SOURCE_REL} treats it as ${fact.kind === "default" ? `having default \`${fact.defaultLiteral ?? "?"}\`` : "optional"}`,
    };
  }
  if (claim.predicate === "optional" && fact.kind === "required") {
    return {
      source: "consistency",
      file: doc.relPath,
      line: claim.line,
      column: 1,
      endLine: claim.line,
      severity: "warning",
      ruleId: "env-required-mismatch",
      message: `${doc.relPath} claims ${claim.envVar} is optional; ${ENV_SOURCE_REL} treats it as required`,
    };
  }
  if (claim.predicate === "default") {
    if (fact.kind !== "default") {
      return {
        source: "consistency",
        file: doc.relPath,
        line: claim.line,
        column: 1,
        endLine: claim.line,
        severity: "warning",
        ruleId: "env-default-mismatch",
        message: `${doc.relPath} claims ${claim.envVar} defaults to \`${claim.defaultValue ?? "?"}\`; ${ENV_SOURCE_REL} treats it as ${fact.kind}`,
      };
    }
    if (fact.defaultLiteral !== undefined && claim.defaultValue !== fact.defaultLiteral) {
      return {
        source: "consistency",
        file: doc.relPath,
        line: claim.line,
        column: 1,
        endLine: claim.line,
        severity: "warning",
        ruleId: "env-default-mismatch",
        message: `${doc.relPath} claims ${claim.envVar} defaults to \`${claim.defaultValue}\`; ${ENV_SOURCE_REL} defaults to \`${fact.defaultLiteral}\``,
      };
    }
  }
  return null;
}

// ─── CLI surface parsing ────────────────────────────────────────────────────

interface CliFacts {
  verbs: Set<string>;
  flags: Set<string>;
}

async function loadCliFacts(repoRoot: string, degraded: DegradedEntry[]): Promise<CliFacts | undefined> {
  const out: CliFacts = { verbs: new Set(), flags: new Set() };
  const indexAbs = resolvePath(repoRoot, CLI_INDEX_REL);
  try {
    const content = await readFile(indexAbs, "utf8");
    parseCliFile(indexAbs, content, out);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined; // not a warden tree
    degraded.push({
      kind: "warning",
      topic: "consistency",
      message: `consistency: failed to parse CLI surface; CLI claims skipped (${formatErr(err)})`,
    });
    return undefined;
  }
  // Walk commands directory if it exists.
  const cmdsAbs = resolvePath(repoRoot, CLI_COMMANDS_DIR_REL);
  try {
    const entries = await readdir(cmdsAbs, { withFileTypes: true });
    for (const ent of entries) {
      if (!ent.isFile() || !SOURCE_EXT_RE.test(ent.name)) continue;
      const abs = join(cmdsAbs, ent.name);
      try {
        const content = await readFile(abs, "utf8");
        parseCliFile(abs, content, out);
      } catch {
        // skip silently
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      degraded.push({
        kind: "warning",
        topic: "consistency",
        message: `consistency: failed to walk cli/commands (${formatErr(err)})`,
      });
    }
  }
  return out;
}

function parseCliFile(abs: string, content: string, out: CliFacts): void {
  let sf: ts.SourceFile;
  try {
    sf = ts.createSourceFile(abs, content, ts.ScriptTarget.Latest, true);
  } catch {
    return;
  }
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.arguments.length >= 1
    ) {
      const methodName = node.expression.name.text;
      const firstArg = node.arguments[0]!;
      if (methodName === "command" && (ts.isStringLiteral(firstArg) || ts.isNoSubstitutionTemplateLiteral(firstArg))) {
        // commander accepts "verb [args...]" — take the first token as the verb name.
        const verbToken = firstArg.text.split(/\s+/)[0];
        if (verbToken && /^[a-z][a-z0-9-]*$/.test(verbToken)) {
          out.verbs.add(verbToken);
        }
      } else if (methodName === "option" && (ts.isStringLiteral(firstArg) || ts.isNoSubstitutionTemplateLiteral(firstArg))) {
        // Flag spec like "--rebuild" or "--max-cost <usd>" — extract the leading --name.
        const flagMatch = /--([a-z][a-z0-9-]*)/.exec(firstArg.text);
        if (flagMatch) out.flags.add(`--${flagMatch[1]!}`);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
}

function verifyCliVerb(claim: CliClaim, doc: DocFile, cli: CliFacts): ToolFinding | null {
  if (cli.verbs.has(claim.verb)) return null;
  return {
    source: "consistency",
    file: doc.relPath,
    line: claim.line,
    column: 1,
    endLine: claim.line,
    severity: "warning",
    ruleId: "cli-unknown-verb",
    message: `${doc.relPath} references \`warden ${claim.verb}\` but no command is registered with that name`,
  };
}

function verifyCliFlags(claim: CliClaim, doc: DocFile, cli: CliFacts): ToolFinding[] {
  const out: ToolFinding[] = [];
  for (const flag of claim.flags) {
    if (cli.flags.has(flag)) continue;
    out.push({
      source: "consistency",
      file: doc.relPath,
      line: claim.line,
      column: 1,
      endLine: claim.line,
      severity: "warning",
      ruleId: "cli-unknown-flag",
      message: `${doc.relPath} passes \`${flag}\` to \`warden ${claim.verb}\` but no commander option registers it`,
    });
  }
  return out;
}

// ─── Path-constant scan ─────────────────────────────────────────────────────

/**
 * Grep `packages/*\/src/**\/*.{ts,mts,tsx,...}` for `.warden/<...>` literals.
 * Returns the full set of literals found. Verification is set-membership:
 * if a doc-cited path isn't in the set, emit a `stale-path` finding.
 */
async function collectPathLiterals(
  repoRoot: string,
  degraded: DegradedEntry[],
): Promise<Set<string> | undefined> {
  const out = new Set<string>();
  const packagesDir = resolvePath(repoRoot, "packages");
  let pkgEntries: { name: string; isDirectory(): boolean }[];
  try {
    pkgEntries = await readdir(packagesDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    degraded.push({
      kind: "warning",
      topic: "consistency",
      message: `consistency: failed to walk packages/ (${formatErr(err)})`,
    });
    return undefined;
  }
  for (const pkg of pkgEntries) {
    if (!pkg.isDirectory()) continue;
    const srcDir = join(packagesDir, pkg.name, "src");
    try {
      await walkSourceForPathLiterals(srcDir, 0, out);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      degraded.push({
        kind: "warning",
        topic: "consistency",
        message: `consistency: failed to scan ${pkg.name}/src (${formatErr(err)})`,
      });
    }
  }
  return out;
}

async function walkSourceForPathLiterals(
  dirAbs: string,
  depth: number,
  out: Set<string>,
): Promise<void> {
  if (depth > SRC_DEPTH_LIMIT) return;
  const entries = await readdir(dirAbs, { withFileTypes: true });
  for (const ent of entries) {
    const childAbs = join(dirAbs, ent.name);
    if (ent.isDirectory()) {
      if (ent.name.startsWith(".") || ent.name === "node_modules") continue;
      await walkSourceForPathLiterals(childAbs, depth + 1, out);
      continue;
    }
    if (!ent.isFile() || !SOURCE_EXT_RE.test(ent.name)) continue;
    try {
      const text = await readFile(childAbs, "utf8");
      PATH_CLAIM_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = PATH_CLAIM_RE.exec(text)) !== null) {
        out.add(m[0]);
      }
    } catch {
      // Per-file errors skipped.
    }
  }
}


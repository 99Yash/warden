import ts from "typescript";
import type { ChangedFile } from "../diff/index.js";
import { assertNever } from "../assert-never.js";
import type { Runner, RunnerInput, RunnerOutput } from "../orchestration/runner.js";
import type { DegradedEntry } from "../schema.js";
import { anyAddedInRange, parseChangedSourceFile } from "./_shared.js";
import type { ToolFinding } from "./types.js";

/**
 * Scalability detector (ADR-0021 #1, Type 1 / AST-pattern). Direct findings;
 * the LLM triage layer downgrades severity when surrounding context (tight
 * `where` clause, bounded set, schema-narrowing comment) makes the smell
 * harmless.
 *
 * v0 patterns (TS-only):
 *   - **load-then-narrow** — query-builder `.all() / .findMany() / .find()`
 *     immediately consumed by `.filter() / .find() / .length / .some() /
 *     .every()`. (Excludes `map` — projection isn't the cardinality smell.)
 *   - **sequential-await** — sibling `await` expressions in the same block
 *     whose awaited values don't depend on each other's results, where the
 *     same group could collapse to `Promise.all`.
 *
 * `import ts from "typescript"` is intentional here — extending `SourceParser`
 * with full AST walking primitives is M8+ work tied to the tree-sitter swap-in
 * for multi-language support (per ADR-0021 #11).
 */

const QUERY_TERMINAL_NAMES: ReadonlySet<string> = new Set(["all", "findMany", "find"]);
const NARROWING_NAMES: ReadonlySet<string> = new Set([
  "filter",
  "find",
  "length",
  "some",
  "every",
]);
const BUILDER_HINT_NAMES: ReadonlySet<string> = new Set([
  "select",
  "from",
  "where",
  "orderBy",
  "limit",
  "offset",
  "groupBy",
  "having",
  "innerJoin",
  "leftJoin",
  "rightJoin",
]);

export interface ScalabilityRunnerInput {
  repoRoot: string;
  changed: ChangedFile[];
}

export interface ScalabilityRunnerOutput {
  findings: ToolFinding[];
  degraded: DegradedEntry[];
}

export async function runScalability(
  input: ScalabilityRunnerInput,
): Promise<ScalabilityRunnerOutput> {
  const findings: ToolFinding[] = [];
  const degraded: DegradedEntry[] = [];

  for (const cf of input.changed) {
    const result = await parseChangedSourceFile(input.repoRoot, cf, "scalability");
    if (result.kind === "skip") continue;
    if (result.kind === "degraded") {
      degraded.push(result.entry);
      continue;
    }
    if (result.kind !== "ok") assertNever(result, "ParseChangedFileResult");
    const { sf, addedLines } = result.parsed;
    findLoadThenNarrow(sf, cf.path, addedLines, findings);
    findSequentialAwait(sf, cf.path, addedLines, findings);
  }

  return { findings, degraded };
}

/**
 * `Runner`-contract wrapper (ADR-0023 #3). Internal AST-traversal logic is
 * unchanged — the wrapper just adapts I/O shapes. `RunnerOutput.findings` is
 * the AST-pattern findings; `questions` is undefined (scalability is a
 * deterministic detector, not a sub-agent).
 */
export const scalabilityRunner: Runner = {
  name: "scalability",
  async run(input: RunnerInput): Promise<RunnerOutput> {
    const result = await runScalability({
      repoRoot: input.repoRoot,
      changed: input.changed,
    });
    return {
      name: "scalability",
      findings: result.findings,
      degraded: result.degraded,
      durationMs: 0, // dispatcher overrides
    };
  },
};

function findLoadThenNarrow(
  sf: ts.SourceFile,
  filePath: string,
  addedLines: Set<number>,
  findings: ToolFinding[],
): void {
  function visit(node: ts.Node): void {
    // Pattern: PropertyAccess whose name is a narrowing method
    // (filter/find/length/some/every) on a receiver that — once parens,
    // `await`, `as` casts, and `!` non-null assertions are stripped — is a
    // CallExpression terminating in all/findMany/find with a builder chain.
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.name) &&
      NARROWING_NAMES.has(node.name.text)
    ) {
      const inner = unwrapInner(node.expression);
      if (ts.isCallExpression(inner) && isQueryTerminalCall(inner)) {
        const startLine = sf.getLineAndCharacterOfPosition(inner.getStart(sf)).line + 1;
        if (touchesDiff(startLine, sf, node, addedLines)) {
          const range = lineRange(sf, node);
          const snippet = node.getText(sf).split("\n").slice(0, 3).join("\n");
          findings.push({
            source: "scalability",
            file: filePath,
            line: range.startLine,
            column: 1,
            endLine: range.endLine,
            severity: "warning",
            ruleId: "load-then-narrow",
            message: `Query loads all rows then narrows in JS via .${node.name.text} — push the predicate into the query (${snippet.replace(/\s+/g, " ").slice(0, 80)})`,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
}

function unwrapInner(node: ts.Expression): ts.Expression {
  let cursor: ts.Expression = node;
  while (true) {
    if (ts.isParenthesizedExpression(cursor)) {
      cursor = cursor.expression;
    } else if (ts.isAwaitExpression(cursor)) {
      cursor = cursor.expression;
    } else if (ts.isAsExpression(cursor) || ts.isTypeAssertionExpression(cursor)) {
      cursor = cursor.expression;
    } else if (ts.isNonNullExpression(cursor)) {
      cursor = cursor.expression;
    } else {
      return cursor;
    }
  }
}

function isQueryTerminalCall(call: ts.CallExpression): boolean {
  // `<receiver>.<terminal>()` where terminal ∈ {all,findMany,find} AND
  // receiver chain mentions at least one builder name.
  if (!ts.isPropertyAccessExpression(call.expression)) return false;
  const terminal = call.expression.name.text;
  if (!QUERY_TERMINAL_NAMES.has(terminal)) return false;
  // Walk back the receiver chain for builder hints.
  let cursor: ts.Expression = call.expression.expression;
  let sawBuilder = false;
  let hops = 0;
  while (hops < 12) {
    if (ts.isCallExpression(cursor) && ts.isPropertyAccessExpression(cursor.expression)) {
      if (BUILDER_HINT_NAMES.has(cursor.expression.name.text)) sawBuilder = true;
      cursor = cursor.expression.expression;
    } else if (ts.isPropertyAccessExpression(cursor)) {
      if (BUILDER_HINT_NAMES.has(cursor.name.text)) sawBuilder = true;
      cursor = cursor.expression;
    } else {
      break;
    }
    hops++;
  }
  return sawBuilder;
}

function findSequentialAwait(
  sf: ts.SourceFile,
  filePath: string,
  addedLines: Set<number>,
  findings: ToolFinding[],
): void {
  function visit(node: ts.Node): void {
    if (ts.isBlock(node)) {
      const cluster = collectAwaitCluster(node, sf);
      if (cluster.statements.length >= 2) {
        const startLine = sf.getLineAndCharacterOfPosition(cluster.statements[0]!.getStart(sf)).line + 1;
        const endLine = sf.getLineAndCharacterOfPosition(cluster.statements[cluster.statements.length - 1]!.getEnd()).line + 1;
        if (anyAddedInRange(startLine, endLine, addedLines)) {
          findings.push({
            source: "scalability",
            file: filePath,
            line: startLine,
            column: 1,
            endLine,
            severity: "warning",
            ruleId: "sequential-await",
            message: `${cluster.statements.length} sequential awaits with no inter-dependency — collapse with \`Promise.all\` for parallel I/O`,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
}

interface AwaitCluster {
  statements: ts.Statement[];
}

/**
 * Find the longest run of consecutive `const x = await ...` statements at the
 * top of a block whose later statements don't reference any of the bindings.
 * If a later `await` consumes an earlier binding (or any later statement before
 * a join point references it), the cluster ends.
 */
function collectAwaitCluster(block: ts.Block, _sf: ts.SourceFile): AwaitCluster {
  const candidates: { stmt: ts.Statement; bindings: string[] }[] = [];
  for (const stmt of block.statements) {
    if (!isConstAwaitDecl(stmt)) break;
    const bindings = collectConstBindings(stmt);
    candidates.push({ stmt, bindings });
  }
  if (candidates.length < 2) return { statements: [] };

  // Reject the cluster if any candidate's awaited expression references an
  // earlier binding — those are genuinely dependent.
  const seenSoFar = new Set<string>();
  const cleared: ts.Statement[] = [];
  for (const cand of candidates) {
    if (referencesAny(cand.stmt, seenSoFar)) break;
    cleared.push(cand.stmt);
    for (const b of cand.bindings) seenSoFar.add(b);
  }
  return cleared.length >= 2 ? { statements: cleared } : { statements: [] };
}

function isConstAwaitDecl(stmt: ts.Statement): boolean {
  if (!ts.isVariableStatement(stmt)) return false;
  if ((stmt.declarationList.flags & ts.NodeFlags.Const) === 0) return false;
  for (const decl of stmt.declarationList.declarations) {
    if (decl.initializer && ts.isAwaitExpression(decl.initializer)) return true;
  }
  return false;
}

function collectConstBindings(stmt: ts.Statement): string[] {
  if (!ts.isVariableStatement(stmt)) return [];
  const out: string[] = [];
  for (const decl of stmt.declarationList.declarations) {
    if (ts.isIdentifier(decl.name)) out.push(decl.name.text);
  }
  return out;
}

function referencesAny(stmt: ts.Statement, names: Set<string>): boolean {
  if (names.size === 0) return false;
  let found = false;
  function walk(node: ts.Node): void {
    if (found) return;
    if (ts.isIdentifier(node) && names.has(node.text)) {
      found = true;
      return;
    }
    ts.forEachChild(node, walk);
  }
  // Only inspect the awaited expression on each declarator — the binding name
  // itself shouldn't trigger a self-reference.
  if (ts.isVariableStatement(stmt)) {
    for (const decl of stmt.declarationList.declarations) {
      if (decl.initializer) walk(decl.initializer);
    }
  } else {
    walk(stmt);
  }
  return found;
}

function lineRange(sf: ts.SourceFile, node: ts.Node): { startLine: number; endLine: number } {
  const start = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  const end = sf.getLineAndCharacterOfPosition(node.getEnd());
  return { startLine: start.line + 1, endLine: end.line + 1 };
}

function touchesDiff(
  startLine: number,
  sf: ts.SourceFile,
  node: ts.Node,
  addedLines: Set<number>,
): boolean {
  const endLine = sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
  return anyAddedInRange(startLine, endLine, addedLines);
}


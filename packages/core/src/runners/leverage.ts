import ts from "typescript";
import type { ChangedFile } from "../diff/index.js";
import type { Runner, RunnerInput, RunnerOutput } from "../orchestration/runner.js";
import type { DegradedEntry } from "../schema.js";
import { anyAddedInRange, parseChangedSourceFile } from "./_shared.js";
import type { ToolFinding } from "./types.js";

/**
 * Leverage detector (ADR-0027, M12). Pure AST runner — emits
 * `kind: "assertion"` findings for three bounded stdlib idiom-miss patterns:
 *
 *   - `JSON.parse(JSON.stringify(x))` → `structuredClone(x)`
 *   - `arr.indexOf(x) !== -1` (and `!=`, `>`, `>=` variants against the
 *     correct numeric pivot) → `arr.includes(x)`
 *   - `arr.filter(p).length > 0` / `>= 1` / `!== 0` AND
 *     `arr.find(p) !== undefined` / `!= null` → `arr.some(p)`
 *
 * Three v0 patterns only — ADR-0027 §2. New patterns ride dogfood evidence
 * of which substitutions the leverage sub-agent consistently misses, not
 * speculative additions. Detector is stdlib-only: library-specific
 * substitutions are the sub-agent's lane (ADR-0027 alternatives).
 *
 * Diff-localness: every visitor computes a 1-indexed line range from the
 * AST node and only fires when `anyAddedInRange()` confirms the construct
 * overlaps the diff. Mirrors scalability/deadcode posture.
 */

const STRUCTURED_CLONE_CLAIM =
  "Consider structuredClone(x) instead of JSON.parse(JSON.stringify(x)) when " +
  "you want a general deep clone — structuredClone preserves Maps, Sets, " +
  "Dates, RegExps, and typed arrays that the JSON roundtrip strips.";

const INCLUDES_CLAIM =
  "Replace indexOf(...) checks with includes(...) — includes is the " +
  "idiomatic membership check and reads as a boolean.";

const SOME_CLAIM_FILTER =
  "Replace arr.filter(...).length > 0 with arr.some(...) — some " +
  "short-circuits on the first match and reads as a boolean check.";

const SOME_CLAIM_FIND =
  "Replace arr.find(...) !== undefined with arr.some(...) — some " +
  "short-circuits on the first match and reads as a boolean check.";

export interface LeverageRunnerInput {
  repoRoot: string;
  changed: ChangedFile[];
}

export interface LeverageRunnerOutput {
  findings: ToolFinding[];
  degraded: DegradedEntry[];
}

export async function runLeverage(
  input: LeverageRunnerInput,
): Promise<LeverageRunnerOutput> {
  const findings: ToolFinding[] = [];
  const degraded: DegradedEntry[] = [];

  for (const cf of input.changed) {
    const result = await parseChangedSourceFile(input.repoRoot, cf, "leverage");
    if (result.kind === "skip") continue;
    if (result.kind === "degraded") {
      degraded.push(result.entry);
      continue;
    }
    const { sf, addedLines } = result.parsed;
    findStructuredClone(sf, cf.path, addedLines, findings);
    findIncludes(sf, cf.path, addedLines, findings);
    findSome(sf, cf.path, addedLines, findings);
  }

  return { findings, degraded };
}

export const leverageRunner: Runner = {
  name: "leverage",
  async run(input: RunnerInput): Promise<RunnerOutput> {
    const result = await runLeverage({
      repoRoot: input.repoRoot,
      changed: input.changed,
    });
    return {
      name: "leverage",
      findings: result.findings,
      degraded: result.degraded,
      durationMs: 0, // dispatcher overrides
    };
  },
};

// ---------------------------------------------------------------------------
// Pattern (a): JSON.parse(JSON.stringify(<expr>)) → structuredClone(<expr>).
// ---------------------------------------------------------------------------

function findStructuredClone(
  sf: ts.SourceFile,
  filePath: string,
  addedLines: Set<number>,
  findings: ToolFinding[],
): void {
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && isJsonParseOfJsonStringify(node)) {
      emit(node, sf, filePath, addedLines, findings, "structured-clone", STRUCTURED_CLONE_CLAIM);
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
}

function isJsonParseOfJsonStringify(call: ts.CallExpression): boolean {
  if (!isPropertyCall(call, "JSON", "parse")) return false;
  if (call.arguments.length !== 1) return false;
  const arg = call.arguments[0];
  if (!arg || !ts.isCallExpression(arg)) return false;
  if (!isPropertyCall(arg, "JSON", "stringify")) return false;
  // Single-argument `JSON.stringify` only. `stringify(x, replacer)` and
  // `stringify(x, null, 2)` are intentional projections — the user wanted a
  // pretty-print or filter, not a deep clone — and `structuredClone` doesn't
  // replace either. Same with `JSON.parse(x, reviver)` above.
  if (arg.arguments.length !== 1) return false;
  return true;
}

/** Match `<receiverName>.<memberName>(...)`. */
function isPropertyCall(call: ts.CallExpression, receiverName: string, memberName: string): boolean {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee)) return false;
  if (!ts.isIdentifier(callee.expression)) return false;
  if (callee.expression.text !== receiverName) return false;
  if (!ts.isIdentifier(callee.name)) return false;
  return callee.name.text === memberName;
}

// ---------------------------------------------------------------------------
// Pattern (b): <receiver>.indexOf(<x>) <cmp> <pivot> → <receiver>.includes(<x>).
// ---------------------------------------------------------------------------

function findIncludes(
  sf: ts.SourceFile,
  filePath: string,
  addedLines: Set<number>,
  findings: ToolFinding[],
): void {
  function visit(node: ts.Node): void {
    if (ts.isBinaryExpression(node)) {
      const opKind = node.operatorToken.kind;
      if (isIndexOfBooleanComparison(node, opKind)) {
        emit(node, sf, filePath, addedLines, findings, "includes", INCLUDES_CLAIM);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
}

function isIndexOfBooleanComparison(
  node: ts.BinaryExpression,
  opKind: ts.SyntaxKind,
): boolean {
  // Accept indexOf either on the left or the right side of the comparison.
  const { left, right } = node;
  const leftIsIndexOf = isCallNamed(left, "indexOf");
  const rightIsIndexOf = isCallNamed(right, "indexOf");
  if (!leftIsIndexOf && !rightIsIndexOf) return false;

  const numericSide = leftIsIndexOf ? right : left;
  const pivot = readSignedNumeric(numericSide);
  if (pivot === null) return false;

  // For `indexOf(...) op pivot`, semantic membership maps to:
  //   `indexOf !== -1` / `indexOf != -1`         → `.includes`
  //   `indexOf > -1`                              → `.includes`
  //   `indexOf >= 0`                              → `.includes`
  // When indexOf is on the RHS, the comparison reads `-1 !== indexOf` etc;
  // flip the operator semantics so we still recognize the same shapes.
  const effectiveOp = leftIsIndexOf ? opKind : mirrorOperator(opKind);
  switch (effectiveOp) {
    case ts.SyntaxKind.ExclamationEqualsEqualsToken:
    case ts.SyntaxKind.ExclamationEqualsToken:
      return pivot === -1;
    case ts.SyntaxKind.GreaterThanToken:
      return pivot === -1;
    case ts.SyntaxKind.GreaterThanEqualsToken:
      return pivot === 0;
    default:
      return false;
  }
}

function isCallNamed(node: ts.Node, member: string): boolean {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee)) return false;
  if (!ts.isIdentifier(callee.name)) return false;
  return callee.name.text === member;
}

/**
 * Read a possibly-signed numeric literal. `-1` parses as a unary minus
 * over a literal `1`, so a plain `isNumericLiteral` check would miss it.
 */
function readSignedNumeric(node: ts.Node): number | null {
  if (ts.isNumericLiteral(node)) {
    return Number.parseFloat(node.text);
  }
  if (ts.isPrefixUnaryExpression(node)) {
    if (
      node.operator === ts.SyntaxKind.MinusToken &&
      ts.isNumericLiteral(node.operand)
    ) {
      return -Number.parseFloat(node.operand.text);
    }
    if (
      node.operator === ts.SyntaxKind.PlusToken &&
      ts.isNumericLiteral(node.operand)
    ) {
      return Number.parseFloat(node.operand.text);
    }
  }
  return null;
}

function mirrorOperator(op: ts.SyntaxKind): ts.SyntaxKind {
  switch (op) {
    case ts.SyntaxKind.GreaterThanToken:
      return ts.SyntaxKind.LessThanToken;
    case ts.SyntaxKind.GreaterThanEqualsToken:
      return ts.SyntaxKind.LessThanEqualsToken;
    case ts.SyntaxKind.LessThanToken:
      return ts.SyntaxKind.GreaterThanToken;
    case ts.SyntaxKind.LessThanEqualsToken:
      return ts.SyntaxKind.GreaterThanEqualsToken;
    default:
      return op;
  }
}

// ---------------------------------------------------------------------------
// Pattern (c): filter(...).length > 0 OR find(...) !== undefined → some(...).
// ---------------------------------------------------------------------------

function findSome(
  sf: ts.SourceFile,
  filePath: string,
  addedLines: Set<number>,
  findings: ToolFinding[],
): void {
  function visit(node: ts.Node): void {
    if (ts.isBinaryExpression(node)) {
      const opKind = node.operatorToken.kind;
      if (isFilterLengthComparison(node, opKind)) {
        emit(node, sf, filePath, addedLines, findings, "some", SOME_CLAIM_FILTER);
      } else if (isFindNonNullCheck(node, opKind)) {
        emit(node, sf, filePath, addedLines, findings, "some", SOME_CLAIM_FIND);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
}

function isFilterLengthComparison(
  node: ts.BinaryExpression,
  opKind: ts.SyntaxKind,
): boolean {
  // Accept either `<call>.length OP pivot` or `pivot OP <call>.length`.
  const leftIsLen = isFilterLengthAccess(node.left);
  const rightIsLen = isFilterLengthAccess(node.right);
  if (!leftIsLen && !rightIsLen) return false;

  const numericSide = leftIsLen ? node.right : node.left;
  const pivot = readSignedNumeric(numericSide);
  if (pivot === null) return false;

  const effectiveOp = leftIsLen ? opKind : mirrorOperator(opKind);
  switch (effectiveOp) {
    case ts.SyntaxKind.GreaterThanToken:
      return pivot === 0;
    case ts.SyntaxKind.GreaterThanEqualsToken:
      return pivot === 1;
    case ts.SyntaxKind.ExclamationEqualsEqualsToken:
    case ts.SyntaxKind.ExclamationEqualsToken:
      return pivot === 0;
    default:
      return false;
  }
}

function isFilterLengthAccess(node: ts.Node): boolean {
  if (!ts.isPropertyAccessExpression(node)) return false;
  if (!ts.isIdentifier(node.name) || node.name.text !== "length") return false;
  return isCallNamed(node.expression, "filter");
}

function isFindNonNullCheck(
  node: ts.BinaryExpression,
  opKind: ts.SyntaxKind,
): boolean {
  if (
    opKind !== ts.SyntaxKind.ExclamationEqualsEqualsToken &&
    opKind !== ts.SyntaxKind.ExclamationEqualsToken
  ) {
    return false;
  }
  const leftIsFind = isCallNamed(node.left, "find");
  const rightIsFind = isCallNamed(node.right, "find");
  if (!leftIsFind && !rightIsFind) return false;
  const other = leftIsFind ? node.right : node.left;
  return isUndefinedOrNullLiteral(other);
}

function isUndefinedOrNullLiteral(node: ts.Node): boolean {
  if (node.kind === ts.SyntaxKind.NullKeyword) return true;
  if (ts.isIdentifier(node) && node.text === "undefined") return true;
  return false;
}

// ---------------------------------------------------------------------------
// Shared emission helper.
// ---------------------------------------------------------------------------

function emit(
  node: ts.Node,
  sf: ts.SourceFile,
  filePath: string,
  addedLines: Set<number>,
  findings: ToolFinding[],
  ruleId: string,
  claim: string,
): void {
  const start = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  const end = sf.getLineAndCharacterOfPosition(node.getEnd());
  const startLine = start.line + 1;
  const endLine = end.line + 1;
  if (!anyAddedInRange(startLine, endLine, addedLines)) return;
  const snippet = collapseWhitespace(node.getText(sf));
  findings.push({
    source: "leverage",
    file: filePath,
    line: startLine,
    column: start.character + 1,
    endLine,
    severity: "warning",
    ruleId,
    message: claim,
    evidence: {
      path: filePath,
      line: startLine,
      snippet,
    },
  });
}

function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

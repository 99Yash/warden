import { readFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import ts from "typescript";
import { db, importGraph } from "@warden/db";
import { assertNever } from "../assert-never.js";
import type { ChangedFile } from "../diff/index.js";
import type { DegradedEntry } from "../schema.js";
import { anyAddedInRange, formatErr, parseChangedSourceFile } from "./_shared.js";
import type { ToolFinding } from "./types.js";

/**
 * Deadcode detector (ADR-0021 #1, Type 1 / AST + reverse import-graph).
 * Finds optional parameters on diff-touched exported functions whose presence
 * is checked in the body but who no caller actually passes.
 *
 *   1. For each diff-touched function with `export` modifier and at least one
 *      optional parameter (`?`, default value, or `T | undefined`/`T | null`),
 *      collect the optional params and their presence-checking branches.
 *   2. Scan `import_graph` for rows whose `imports_json` resolves to the
 *      changed file's absolute path (one-hop reverse).
 *   3. Parse each caller; locate `CallExpression` nodes whose callee resolves
 *      to the function. If no callsite passes the optional position, emit one
 *      finding per `(param, branch)` pair with a 3-part evidence array.
 *
 * Out of scope for v0 (per ADR-0021's caveats):
 *   - Dynamic dispatch (`obj[methodName]()`).
 *   - Multi-hop re-exports.
 *   - Methods on classes — only top-level `function`s and `const fn = ...`.
 *
 * `import ts from "typescript"` is intentional here, mirroring the scalability
 * detector. A SourceParser-shaped abstraction lands with the M8+ multi-language
 * milestone (per ADR-0021 #11).
 */

export interface DeadcodeRunnerInput {
  repoRoot: string;
  changed: ChangedFile[];
}

export interface DeadcodeRunnerOutput {
  findings: ToolFinding[];
  degraded: DegradedEntry[];
}

interface OptionalParamInfo {
  paramName: string;
  paramIndex: number;
  paramLine: number;
  branchLine: number;
  fnName: string;
  fnLine: number;
}

export async function runDeadcode(input: DeadcodeRunnerInput): Promise<DeadcodeRunnerOutput> {
  const findings: ToolFinding[] = [];
  const degraded: DegradedEntry[] = [];

  // Build the reverse import-graph index once on first need. Repeating
  // `import_graph.all()` per changed file blows up with cache size; one pass
  // + an in-memory Map<targetAbs, callers[]> keeps deadcode O(rows + changed).
  let reverseIndex: Map<string, CallerEntry[]> | undefined;
  let indexFailed = false;

  for (const cf of input.changed) {
    const parseResult = await parseChangedSourceFile(input.repoRoot, cf, "deadcode");
    if (parseResult.kind === "skip") continue;
    if (parseResult.kind === "degraded") {
      degraded.push(parseResult.entry);
      continue;
    }
    if (parseResult.kind !== "ok") assertNever(parseResult, "ParseChangedFileResult");
    const { abs, sf, addedLines } = parseResult.parsed;
    const candidates = collectOptionalParamCandidates(sf, addedLines);
    if (candidates.length === 0) continue;

    if (!reverseIndex && !indexFailed) {
      try {
        reverseIndex = buildReverseImportIndex(input.repoRoot);
      } catch (err) {
        indexFailed = true;
        degraded.push({
          kind: "info",
          topic: "deadcode",
          message: `deadcode: import-graph lookup failed (${formatErr(err)})`,
        });
      }
    }
    if (!reverseIndex) continue;
    const callers = reverseIndex.get(abs) ?? [];
    if (callers.length === 0) continue;

    for (const cand of candidates) {
      const callsites = await collectCallsites(callers, cand.fnName, cand.paramIndex);
      if (callsites.totalCount === 0) continue;
      if (callsites.passingCount > 0) continue;

      const example = callsites.exampleSite;
      const message = example
        ? `Optional parameter '${cand.paramName}' is never passed by any of ${callsites.totalCount} callsite(s); branch on L${cand.branchLine} is unreachable. Example callsite: ${example.path}:${example.line}`
        : `Optional parameter '${cand.paramName}' is never passed by any of ${callsites.totalCount} callsite(s); branch on L${cand.branchLine} is unreachable.`;

      findings.push({
        source: "deadcode",
        file: cf.path,
        line: cand.fnLine,
        column: 1,
        endLine: cand.branchLine,
        severity: "warning",
        ruleId: "unreachable-optional-param",
        message,
      });
    }
  }

  return { findings, degraded };
}

function collectOptionalParamCandidates(
  sf: ts.SourceFile,
  addedLines: Set<number>,
): OptionalParamInfo[] {
  const out: OptionalParamInfo[] = [];
  for (const stmt of sf.statements) {
    if (!hasExportModifier(stmt)) continue;
    if (ts.isFunctionDeclaration(stmt)) {
      if (!stmt.name || !stmt.body) continue;
      collectFromFunctionLike(sf, stmt, stmt.name.text, addedLines, out);
    } else if (ts.isVariableStatement(stmt)) {
      // `export const fn = (...) => { ... }` shape.
      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) continue;
        const init = decl.initializer;
        if (
          init &&
          (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) &&
          init.body
        ) {
          collectFromFunctionLike(sf, init, decl.name.text, addedLines, out);
        }
      }
    }
  }
  return out;
}

function collectFromFunctionLike(
  sf: ts.SourceFile,
  fn: ts.FunctionLikeDeclaration,
  fnName: string,
  addedLines: Set<number>,
  out: OptionalParamInfo[],
): void {
  const fnLine = sf.getLineAndCharacterOfPosition(fn.getStart(sf)).line + 1;
  for (let i = 0; i < fn.parameters.length; i++) {
    const param = fn.parameters[i]!;
    if (!isOptionalParam(param)) continue;
    if (!ts.isIdentifier(param.name)) continue;
    const paramName = param.name.text;
    const branchLine = findPresenceCheckBranch(fn.body!, paramName, sf);
    if (branchLine === undefined) continue;
    const paramLine = sf.getLineAndCharacterOfPosition(param.getStart(sf)).line + 1;
    // Trigger only when the diff actually touches this function.
    if (
      !anyAddedInRange(fnLine, sf.getLineAndCharacterOfPosition(fn.getEnd()).line + 1, addedLines)
    ) {
      continue;
    }
    out.push({
      paramName,
      paramIndex: i,
      paramLine,
      branchLine,
      fnName,
      fnLine,
    });
  }
}

function isOptionalParam(param: ts.ParameterDeclaration): boolean {
  if (param.questionToken !== undefined) return true;
  if (param.initializer !== undefined) return true;
  if (param.type) {
    if (ts.isUnionTypeNode(param.type)) {
      for (const t of param.type.types) {
        if (t.kind === ts.SyntaxKind.UndefinedKeyword) return true;
        if (ts.isLiteralTypeNode(t) && t.literal.kind === ts.SyntaxKind.NullKeyword) return true;
      }
    }
  }
  return false;
}

function findPresenceCheckBranch(
  body: ts.ConciseBody,
  paramName: string,
  sf: ts.SourceFile,
): number | undefined {
  let line: number | undefined;
  function visit(node: ts.Node): void {
    if (line !== undefined) return;
    if (ts.isIfStatement(node) && referencesIdent(node.expression, paramName)) {
      line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      return;
    }
    if (ts.isConditionalExpression(node) && referencesIdent(node.condition, paramName)) {
      line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      return;
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken &&
      referencesIdent(node.left, paramName)
    ) {
      line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(body);
  return line;
}

function referencesIdent(expr: ts.Node, name: string): boolean {
  let found = false;
  function walk(node: ts.Node): void {
    if (found) return;
    if (ts.isIdentifier(node) && node.text === name) {
      found = true;
      return;
    }
    ts.forEachChild(node, walk);
  }
  walk(expr);
  return found;
}

interface CallerEntry {
  path: string;
  abs: string;
}

/**
 * One-pass scan of `import_graph` keyed by resolved import target. Caller
 * lookup per changed file collapses to a single Map.get() instead of
 * re-scanning the table.
 */
function buildReverseImportIndex(repoRoot: string): Map<string, CallerEntry[]> {
  const rows = db()
    .select({
      filePath: importGraph.filePath,
      importsJson: importGraph.importsJson,
    })
    .from(importGraph)
    .all();
  const out = new Map<string, CallerEntry[]>();
  const seenPerTarget = new Map<string, Set<string>>();
  for (const row of rows) {
    let imports: { resolved?: string }[];
    try {
      imports = JSON.parse(row.importsJson) as { resolved?: string }[];
    } catch {
      continue;
    }
    for (const imp of imports) {
      if (!imp.resolved) continue;
      const targetAbs = resolvePath(imp.resolved);
      let seen = seenPerTarget.get(targetAbs);
      if (!seen) {
        seen = new Set();
        seenPerTarget.set(targetAbs, seen);
      }
      if (seen.has(row.filePath)) continue;
      seen.add(row.filePath);
      let entries = out.get(targetAbs);
      if (!entries) {
        entries = [];
        out.set(targetAbs, entries);
      }
      entries.push({ path: row.filePath, abs: resolvePath(repoRoot, row.filePath) });
    }
  }
  return out;
}

interface CallsiteSurvey {
  totalCount: number;
  passingCount: number;
  exampleSite?: { path: string; line: number };
}

async function collectCallsites(
  callers: CallerEntry[],
  fnName: string,
  paramIndex: number,
): Promise<CallsiteSurvey> {
  // A callsite "passes" the optional parameter when its argument list reaches
  // the param's positional index (zero-based) — i.e. arity > paramIndex.
  const passingArity = paramIndex + 1;
  let totalCount = 0;
  let passingCount = 0;
  let exampleSite: CallsiteSurvey["exampleSite"];
  for (const caller of callers) {
    let content: string;
    try {
      content = await readFile(caller.abs, "utf8");
    } catch {
      continue;
    }
    let sf: ts.SourceFile;
    try {
      sf = ts.createSourceFile(caller.abs, content, ts.ScriptTarget.Latest, true);
    } catch {
      continue;
    }
    visitCalls(sf, (call, line) => {
      const callee = call.expression;
      const matchesName =
        (ts.isIdentifier(callee) && callee.text === fnName) ||
        (ts.isPropertyAccessExpression(callee) &&
          ts.isIdentifier(callee.name) &&
          callee.name.text === fnName);
      if (!matchesName) return;
      totalCount++;
      const passes = call.arguments.length >= passingArity;
      if (passes) passingCount++;
      if (!exampleSite && !passes) {
        exampleSite = { path: caller.path, line };
      }
    });
  }
  return { totalCount, passingCount, exampleSite };
}

function visitCalls(
  sf: ts.SourceFile,
  visit: (call: ts.CallExpression, line: number) => void,
): void {
  function walk(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      visit(node, line);
    }
    ts.forEachChild(node, walk);
  }
  walk(sf);
}

function hasExportModifier(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  const mods = ts.getModifiers(node) ?? [];
  return mods.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}


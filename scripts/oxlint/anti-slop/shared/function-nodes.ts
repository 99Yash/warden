import type { ESTree } from "@oxlint/plugins";

type FunctionExpression = ESTree.ArrowFunctionExpression | ESTree.Function;

export type FunctionNode =
  | ESTree.ArrowFunctionExpression
  | ESTree.Function
  | ESTree.TSCallSignatureDeclaration
  | ESTree.TSConstructSignatureDeclaration
  | ESTree.TSConstructorType
  | ESTree.TSFunctionType
  | ESTree.TSMethodSignature;

const RUNTIME_FUNCTION_TYPES = new Set([
  "ArrowFunctionExpression",
  "FunctionDeclaration",
  "FunctionExpression",
]);

const ALL_FUNCTION_BOUNDARY_TYPES = new Set([
  ...RUNTIME_FUNCTION_TYPES,
  "TSDeclareFunction",
  "TSEmptyBodyFunctionExpression",
]);

export function isRuntimeFunction(node: ESTree.Node): node is FunctionExpression {
  return RUNTIME_FUNCTION_TYPES.has(node.type);
}

export function enclosingFunction(node: ESTree.Node): FunctionExpression | null {
  let current: ESTree.Node | null = node.parent;
  while (current !== null && current.type !== "Program") {
    if (RUNTIME_FUNCTION_TYPES.has(current.type)) {
      return current as FunctionExpression;
    }
    current = current.parent;
  }
  return null;
}

export function functionBoundary(node: ESTree.Node): ESTree.Node | null {
  let current: ESTree.Node | null = node.parent;
  while (current !== null && current.type !== "Program") {
    if (ALL_FUNCTION_BOUNDARY_TYPES.has(current.type)) return current;
    current = current.parent;
  }
  return null;
}

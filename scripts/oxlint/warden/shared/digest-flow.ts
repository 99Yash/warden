import type { ESTree, Reference, Scope, SourceCode, Variable } from "@oxlint/plugins";

import { ownerOfSpecifier } from "./hash-owners.ts";

// The value flow into a hash digest, for one file. `warden/sha256-over-json-stringify`
// asks whether `JSON.stringify` output reaches a digest. `warden/no-exported-hasher`
// asks whether a parameter of an exported function reaches one. Both read the same
// sinks and the same flow, which `rules/sha256-over-json-stringify.ts` documents.

export type Ranged = Readonly<{ start: number; end: number }>;

export type FunctionNode = ESTree.Function | ESTree.ArrowFunctionExpression;

export type Sink = {
  readonly call: ESTree.CallExpression;
  readonly data: ESTree.Expression;
  /** The `.update` receiver, which must be a hasher. Null for `subtle.digest` and an owner hasher. */
  readonly receiver: ESTree.Expression | null;
  /** The callee text of an owner hasher call (`sha256Hex`, `hash.sha256Hex`). Null for a raw digest. */
  readonly helper: string | null;
};

export type Flow = { json: boolean; readonly params: Variable[] };

export type ParameterSlot = { readonly fn: FunctionNode; readonly index: number };

type Write = {
  readonly value: ESTree.Expression | null;
  /** True when the write keeps the earlier value (`+=`, `??=`). */
  readonly keepsEarlier: boolean;
  /** The statement that holds the write, when the write is the whole statement. */
  readonly statement: ESTree.Node | null;
};

const within = (inner: Ranged, outer: Ranged): boolean =>
  inner.start >= outer.start && inner.end <= outer.end;

export function unwrap(expression: ESTree.Expression): ESTree.Expression {
  let current = expression;

  while (
    current.type === "ParenthesizedExpression" ||
    current.type === "ChainExpression" ||
    current.type === "TSAsExpression" ||
    current.type === "TSSatisfiesExpression" ||
    current.type === "TSNonNullExpression" ||
    current.type === "TSTypeAssertion"
  ) {
    current = current.expression;
  }

  return current;
}

/** `object.name`, read only when `name` is a plain property name. */
function staticMember(
  expression: ESTree.Expression,
): { readonly object: ESTree.Expression; readonly name: string } | null {
  if (expression.type !== "MemberExpression" || expression.computed) return null;

  if (expression.property.type !== "Identifier") return null;

  return { object: expression.object, name: expression.property.name };
}

export function isJsonStringify(call: ESTree.CallExpression): boolean {
  const member = staticMember(call.callee);

  return (
    member !== null &&
    member.name === "stringify" &&
    member.object.type === "Identifier" &&
    member.object.name === "JSON"
  );
}

/** `subtle`, `crypto.subtle`, `globalThis.crypto.subtle`. */
function isSubtle(expression: ESTree.Expression): boolean {
  if (expression.type === "Identifier") return expression.name === "subtle";

  return staticMember(expression)?.name === "subtle";
}

/** A raw digest: `<receiver>.update(data)` or `subtle.digest(alg, data)`. */
export function digestSinkOf(call: ESTree.CallExpression): Sink | null {
  const member = staticMember(call.callee);

  if (member === null) return null;

  const [first, second] = call.arguments;

  if (member.name === "update" && first !== undefined && first.type !== "SpreadElement") {
    return { call, data: first, receiver: member.object, helper: null };
  }

  if (
    member.name === "digest" &&
    isSubtle(member.object) &&
    second !== undefined &&
    second.type !== "SpreadElement"
  ) {
    return { call, data: second, receiver: null, helper: null };
  }

  return null;
}

function isFunctionNode(node: ESTree.Node): node is FunctionNode {
  return (
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression"
  );
}

function importedName(specifier: ESTree.ImportSpecifier): string {
  const imported = specifier.imported;

  return imported.type === "Literal" ? imported.value : imported.name;
}

/**
 * The owner hasher imports of a file (see `hash-owners.ts`). `named` maps each
 * reference to a named or renamed import of an owner hasher to the hasher's
 * export name. `namespaces` holds each reference to a namespace import of an
 * owner module, mapped to that owner's hashers. The references come from the
 * scope manager, so a local binding that shadows the import is not one of them.
 * `canonicalizers` contains the named and namespace callees of owner serializers.
 */
export type OwnerImports = Readonly<{
  named: ReadonlyMap<ESTree.Node, string>;
  namespaces: ReadonlyMap<ESTree.Node, ReadonlyMap<string, string>>;
  canonicalizers: ReadonlySet<ESTree.Node>;
}>;

export function ownerImportsOf(
  sourceCode: SourceCode,
  program: ESTree.Program,
  filename: string,
  cwd: string,
): OwnerImports {
  const named = new Map<ESTree.Node, string>();
  const namespaces = new Map<ESTree.Node, ReadonlyMap<string, string>>();
  const canonicalizers = new Set<ESTree.Node>();

  for (const statement of program.body) {
    if (statement.type !== "ImportDeclaration" || statement.importKind === "type") continue;
    const owner = ownerOfSpecifier(statement.source.value, filename, cwd);

    if (owner === null) continue;

    for (const specifier of statement.specifiers) {
      if (specifier.type === "ImportSpecifier" && specifier.importKind === "type") continue;
      const [variable] = sourceCode.getDeclaredVariables(specifier);

      if (variable === undefined) continue;

      if (specifier.type === "ImportNamespaceSpecifier") {
        for (const reference of variable.references) {
          namespaces.set(reference.identifier, owner.hashers);
          const member = reference.identifier.parent;
          if (
            member.type === "MemberExpression" &&
            !member.computed &&
            member.object === reference.identifier &&
            member.property.type === "Identifier" &&
            owner.canonicalizers.has(member.property.name)
          )
            canonicalizers.add(member);
        }

        continue;
      }

      if (specifier.type !== "ImportSpecifier") continue;
      const name = importedName(specifier);

      if (owner.canonicalizers.has(name)) {
        for (const reference of variable.references) canonicalizers.add(reference.identifier);
      }
      if (!owner.hashers.has(name)) continue;

      for (const reference of variable.references) named.set(reference.identifier, name);
    }
  }

  return { named, namespaces, canonicalizers };
}

/** The owner hasher that `callee` names, as `{ export name, callee text }`, or null. */
export function ownerHasherOf(
  imports: OwnerImports,
  callee: ESTree.Expression,
): Readonly<{ name: string; text: string }> | null {
  const node = unwrap(callee);

  if (node.type === "Identifier") {
    const name = imports.named.get(node);

    return name === undefined ? null : { name, text: node.name };
  }

  const member = staticMember(node);

  if (member === null || member.object.type !== "Identifier") return null;
  const hashers = imports.namespaces.get(member.object);

  if (hashers === undefined || !hashers.has(member.name)) return null;

  return { name: member.name, text: `${member.object.name}.${member.name}` };
}

/** A call of an owner hasher is a sink over its first argument. */
export function ownerSinkOf(imports: OwnerImports, call: ESTree.CallExpression): Sink | null {
  const hasher = ownerHasherOf(imports, call.callee);
  const [first] = call.arguments;

  if (hasher === null || first === undefined || first.type === "SpreadElement") return null;

  return { call, data: first, receiver: null, helper: hasher.text };
}

/** An owner serializer or JSON.parse call that can change serialized key order. */
export type JsonTransform = Readonly<{
  call: ESTree.CallExpression;
  kind: "canonical" | "parse";
}>;

/**
 * One file's flow analysis. `jsonCalls` are the `JSON.stringify` calls of the
 * file; pass none to follow every parameter without stopping at JSON.
 */
export function createDigestFlow(
  sourceCode: SourceCode,
  jsonCalls: readonly ESTree.CallExpression[],
  transforms: readonly JsonTransform[] = [],
) {
  const references: Reference[] = sourceCode.scopeManager.scopes.flatMap(
    (scope: Scope) => scope.references,
  );

  const referenceOf = new Map<ESTree.Node, Reference>();

  for (const reference of references) referenceOf.set(reference.identifier, reference);

  function isCreateHash(callee: ESTree.Expression): boolean {
    const node = unwrap(callee);
    const member = staticMember(node);
    const identifier = node.type === "Identifier" ? node : member?.object;
    if (identifier?.type !== "Identifier") return member?.name === "createHash";
    const variable = referenceOf.get(identifier)?.resolved;
    if (variable == null)
      return node.type === "Identifier"
        ? node.name === "createHash"
        : member?.name === "createHash";
    return variable.defs.some((definition) => {
      if (definition.type !== "ImportBinding" || definition.parent?.type !== "ImportDeclaration")
        return false;
      const source = definition.parent.source.value;
      if (source !== "node:crypto" && source !== "crypto") return false;
      return node.type === "Identifier"
        ? definition.node.type === "ImportSpecifier" &&
            importedName(definition.node) === "createHash"
        : member?.name === "createHash" &&
            (definition.node.type === "ImportNamespaceSpecifier" ||
              definition.node.type === "ImportDefaultSpecifier");
    });
  }

  function writeOf(reference: Reference): Write {
    const identifier = reference.identifier;
    const parent = identifier.parent;

    if (
      parent.type === "VariableDeclarator" &&
      parent.id === identifier &&
      parent.init !== null &&
      parent.parent.type === "VariableDeclaration" &&
      !(
        (parent.parent.parent.type === "ForOfStatement" ||
          parent.parent.parent.type === "ForInStatement") &&
        parent.parent.parent.left === parent.parent
      )
    ) {
      return { value: parent.init, keepsEarlier: false, statement: parent.parent };
    }

    if (parent.type === "AssignmentExpression" && parent.left === identifier) {
      return {
        value: parent.right,
        keepsEarlier: parent.operator !== "=",
        statement: parent.parent.type === "ExpressionStatement" ? parent.parent : null,
      };
    }

    return { value: null, keepsEarlier: false, statement: null };
  }

  /** The write always runs before the use: it is a whole statement in a block that holds the use, in the same function. */
  function dominates(statement: ESTree.Node | null, write: Reference, use: Reference): boolean {
    if (statement === null || write.from.variableScope !== use.from.variableScope) return false;

    const block = statement.parent;

    return (
      block !== null &&
      (block.type === "BlockStatement" ||
        block.type === "Program" ||
        block.type === "StaticBlock" ||
        block.type === "TSModuleBlock") &&
      within(use.identifier, block)
    );
  }

  /** The values the binding can hold at `use`. See the sha256 rule header for the reaching rule. */
  function reachingValues(variable: Variable, use: Reference): ESTree.Expression[] {
    const [definition] = variable.defs;

    if (definition === undefined || variable.defs.some((def) => def.type !== "Variable")) return [];

    const writes = variable.references.filter((reference) => reference.isWrite());
    const declaration = definition.parent;

    if (declaration?.type === "VariableDeclaration" && declaration.kind === "const") {
      return writes.flatMap((write) => writeOf(write).value ?? []);
    }

    const above = writes
      .filter(
        (write) =>
          write.identifier.start < use.identifier.start &&
          (write.writeExpr === null || !within(use.identifier, write.writeExpr)),
      )
      .sort((a, b) => b.identifier.start - a.identifier.start);

    const values: ESTree.Expression[] = [];

    for (const write of above) {
      const { value, keepsEarlier, statement } = writeOf(write);

      if (value === null) break;
      values.push(value);

      if (!keepsEarlier && dominates(statement, write, use)) break;
    }

    return values;
  }

  /**
   * The function and argument index of a parameter binding that nothing
   * reassigns: a plain parameter (`s`, `s: T`, `s = d`, `...s`) or a name that a
   * destructured parameter binds (`{ raw }`).
   */
  function parameterSlot(variable: Variable): ParameterSlot | null {
    const [definition] = variable.defs;

    if (variable.defs.length !== 1 || definition?.type !== "Parameter") return null;

    const fn = definition.node;

    if (!isFunctionNode(fn)) return null;

    const index = fn.params.findIndex((param) => within(definition.name, param));

    const reassigned = variable.references.some(
      (reference) => reference.isWrite() && reference.identifier !== definition.name,
    );

    return index === -1 || reassigned ? null : { fn, index };
  }

  /** The name a function is called by in this file: its declaration, or a `const` that holds it. */
  function functionVariable(fn: FunctionNode): Variable | null {
    if (fn.type === "FunctionDeclaration" && fn.id !== null) {
      const name = fn.id.name;

      return sourceCode.getDeclaredVariables(fn).find((variable) => variable.name === name) ?? null;
    }

    const holder = fn.parent;

    if (
      holder.type === "VariableDeclarator" &&
      holder.init === fn &&
      holder.id.type === "Identifier" &&
      holder.parent.type === "VariableDeclaration" &&
      holder.parent.kind === "const"
    ) {
      return sourceCode.getDeclaredVariables(holder)[0] ?? null;
    }

    return null;
  }

  function collect(
    expression: Ranged,
    flow: Flow,
    seen: Set<string>,
    canonicalizing = false,
    decoded = false,
  ): void {
    if (flow.json) return;

    // Parsing removes a stringify's outer key order only when the resulting
    // value is canonicalized. Follow the stringify's input in that case, so
    // nested JSON strings remain order-dependent and are still reported.
    const candidates = [
      ...transforms.filter(({ kind, call }) => {
        if (kind === "canonical") return true;
        if (!canonicalizing) return false;
        const callee = staticMember(unwrap(call.callee));
        return (
          callee?.object.type === "Identifier" &&
          (referenceOf.get(callee.object)?.resolved?.defs.length ?? 0) === 0
        );
      }),
      ...(decoded ? jsonCalls.map((call) => ({ call, kind: "stringify" as const })) : []),
    ].filter(
      ({ call }) =>
        within(call, expression) &&
        call.arguments.length === 1 &&
        call.arguments[0]?.type !== "SpreadElement",
    );
    const outer = candidates.filter(
      ({ call }) => !candidates.some((other) => other.call !== call && within(call, other.call)),
    );
    const transformed = (node: Ranged) => outer.some(({ call }) => within(node, call));
    for (const { call, kind } of outer) {
      const argument = call.arguments[0];
      if (argument !== undefined && argument.type !== "SpreadElement") {
        collect(argument, flow, seen, true, kind === "parse");
      }
    }

    if (jsonCalls.some((call) => within(call, expression) && !transformed(call))) {
      flow.json = true;

      return;
    }

    for (const reference of references) {
      const key = `${reference.identifier.start}:${canonicalizing}:${decoded}`;
      if (
        !within(reference.identifier, expression) ||
        transformed(reference.identifier) ||
        seen.has(key)
      )
        continue;

      if (!reference.isRead() || reference.resolved === null) continue;
      seen.add(key);
      const variable = reference.resolved;

      if (parameterSlot(variable) !== null) {
        if (!flow.params.includes(variable)) flow.params.push(variable);
        continue;
      }

      for (const value of reachingValues(variable, reference)) {
        if (isFunctionNode(unwrap(value))) continue;
        collect(value, flow, seen, canonicalizing, decoded);

        if (flow.json) return;
      }
    }
  }

  function isHasher(expression: ESTree.Expression, seen: Set<Reference>): boolean {
    const node = unwrap(expression);

    if (node.type === "CallExpression") {
      if (isCreateHash(node.callee)) return true;
      const member = staticMember(node.callee);

      return member !== null && member.name === "update" && isHasher(member.object, seen);
    }

    if (node.type !== "Identifier") return false;
    const reference = referenceOf.get(node);

    if (reference === undefined || reference.resolved === null || seen.has(reference)) return false;
    seen.add(reference);

    return reachingValues(reference.resolved, reference).some((value) => isHasher(value, seen));
  }

  return {
    /** True when the sink digests: its `.update` receiver is a hasher, or it has no receiver. */
    digests(sink: Sink): boolean {
      return sink.receiver === null || isHasher(sink.receiver, new Set());
    },
    /** Whether `expression` carries JSON, and the parameters it reads when it does not. */
    flowOf(expression: Ranged): Flow {
      const flow: Flow = { json: false, params: [] };
      collect(expression, flow, new Set());

      return flow;
    },
    parameterSlot,
    /**
     * Each call in this file of the function that owns `slot`, with its
     * argument in that slot. Empty when the function has no name to call it
     * by, and for a call that spreads an argument at or before the slot.
     */
    slotArguments(slot: ParameterSlot): {
      readonly helper: string;
      readonly argument: ESTree.Expression;
    }[] {
      const fnVariable = functionVariable(slot.fn);

      if (fnVariable === null) return [];
      const found: { helper: string; argument: ESTree.Expression }[] = [];

      for (const reference of fnVariable.references) {
        const call = reference.identifier.parent;

        if (call.type !== "CallExpression" || call.callee !== reference.identifier) continue;
        const argument = call.arguments[slot.index];

        if (argument === undefined || argument.type === "SpreadElement") continue;

        if (call.arguments.slice(0, slot.index).some((arg) => arg.type === "SpreadElement")) {
          continue;
        }

        found.push({ helper: fnVariable.name, argument });
      }

      return found;
    },
  };
}

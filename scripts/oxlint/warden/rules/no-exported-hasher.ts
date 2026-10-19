import { defineRule } from "@oxlint/plugins";

import type { ESTree, SourceCode, Variable } from "@oxlint/plugins";

import { createDigestFlow, digestSinkOf, ownerImportsOf, unwrap } from "../shared/digest-flow.ts";
import type { FunctionNode, OwnerImports, Sink } from "../shared/digest-flow.ts";
import { HASH_OWNERS, isOwnerModule, ownerOfSpecifier } from "../shared/hash-owners.ts";
import { inGateScope } from "../shared/scope.ts";

/**
 * `no-exported-hasher`: a function exported from a module that is not a hash
 * owner, whose parameter flows into a hash digest. Such a function is a hash
 * helper that other files call, and `warden/sha256-over-json-stringify` checks
 * one file at a time, so it cannot see a `JSON.stringify` argument passed to it
 * from another file. This rule keeps the set of cross-file hashers closed and
 * known: only an owner module (the list in `shared/hash-owners.ts`) may export
 * one, and the sha256 rule treats each owner hasher as a sink. The fix is to
 * hash through `sha256Hex(text)`, or `sha256Hex(canonicalJson(value))` for a
 * structured value, from `@warden/core/hash`, or to keep the helper private to
 * its file, where the sha256 rule reads its calls.
 *
 * Digest. The sinks are the raw digests the sha256 rule knows:
 * `createHash(…).update(data)`, `h.update(data)` on a bound hasher, and
 * `subtle.digest(alg, data)`. The flow is the sha256 rule's flow: a parameter
 * reaches a sink when a name in `data` is the parameter, or resolves to a
 * binding whose value reads it. A parameter is a plain parameter or a name that
 * a destructured parameter binds. It also reaches a sink through a same-file
 * helper: `export function f(s) { return hashOf(s); }` over a private
 * `hashOf` that digests its parameter. A call of an owner hasher is not a raw
 * digest, so a function that hashes through `sha256Hex` is not reported.
 *
 * Export forms. The rule reports the function when the module exports it in
 * any of these forms:
 * - `export function f`, `export default function`, `export const f = (…) =>`
 *   or a function expression;
 * - a local function or `const` that `export { f }`, `export { f as g }`,
 *   `export default f` or `export = f` exposes;
 * - a method or a function property of an object literal that the module
 *   exports in one of the forms above, at any depth
 *   (`export const hashing = { of(s) { … } }`);
 * - a method of a class that the module exports. A `#private` method is not
 *   reachable from another file, so it is not reported.
 *
 * Re-export. An owner hasher re-exported from another module widens the set of
 * import paths that the sha256 rule must resolve. So the rule also reports
 * `export { sha256Hex } from "@warden/core/hash"`, `export * from` an owner
 * module, and an export of a local import of an owner hasher (`export {
 * sha256Hex }`, `export default sha256Hex`, `export const h = sha256Hex`).
 *
 * Out of reach. A function that passes its parameter to an owner hasher
 * (`stableCommentId(key)` in `packages/core/src/comment-id.ts`, `taskIdFor` in
 * `indexing/job-runner.ts`) is not reported:
 * a function that hashes its input is a normal domain function, and the rule
 * cannot tell it from a wrapper. So a `JSON.stringify` argument to such a
 * function, from another file, is not seen. A function that a module assigns
 * to an exported object after the literal (`api.of = (s) => …`) is also not
 * read.
 *
 * File scope. The rule sees the same files as the sha256 rule (`inGateScope`).
 * The owner modules are skipped.
 */

const FIX =
  "Hash through sha256Hex(text), or sha256Hex(canonicalJson(value)) for a structured value, from @warden/core/hash, or keep the helper private to this file, where warden/sha256-over-json-stringify reads its calls. The owner list is scripts/oxlint/warden/shared/hash-owners.ts.";

const OWNER_MODULES = HASH_OWNERS.map((owner) => owner.module).join(", ");

function keyName(key: ESTree.Node): string | null {
  if (key.type === "Identifier") return key.name;

  if (key.type === "Literal" && !("regex" in key) && key.value !== null) return String(key.value);

  return null;
}

/** The outermost node that holds `node` through `(…)`, `as`, `satisfies` and `!` only. */
function lift(node: ESTree.Node): ESTree.Node {
  let current = node;

  while (
    current.parent !== null &&
    (current.parent.type === "ParenthesizedExpression" ||
      current.parent.type === "TSAsExpression" ||
      current.parent.type === "TSSatisfiesExpression" ||
      current.parent.type === "TSNonNullExpression")
  ) {
    current = current.parent;
  }

  return current;
}

/** True when an `export { x }`, `export default x` or `export = x` names the binding. */
function exportedByReference(variable: Variable | undefined): boolean {
  return (
    variable?.references.some((reference) => {
      const parent = reference.identifier.parent;

      return (
        (parent.type === "ExportSpecifier" && parent.local === reference.identifier) ||
        parent.type === "ExportDefaultDeclaration" ||
        parent.type === "TSExportAssignment"
      );
    }) ?? false
  );
}

/**
 * The name under which the module exports `start` (a function, an object
 * literal or a class), or null when no export form reaches it. See "Export
 * forms" in the rule comment.
 */
function exportedName(sourceCode: SourceCode, start: ESTree.Node): string | null {
  let node = start;
  let path = "";

  for (;;) {
    const lifted = lift(node);
    const holder = lifted.parent;

    if (holder === null) return null;

    const own =
      (node.type === "FunctionDeclaration" ||
        node.type === "ClassDeclaration" ||
        node.type === "ClassExpression" ||
        node.type === "FunctionExpression") &&
      node.id !== null &&
      node.id !== undefined
        ? node.id.name
        : null;

    switch (holder.type) {
      case "ExportNamedDeclaration":
        return `${own ?? "default"}${path}`;
      case "ExportDefaultDeclaration":
        return `${own ?? "default"}${path}`;
      case "Program":
      case "BlockStatement":
      case "TSModuleBlock":
        if (node.type !== "FunctionDeclaration" && node.type !== "ClassDeclaration") return null;

        return own !== null && exportedByReference(sourceCode.getDeclaredVariables(node)[0])
          ? `${own}${path}`
          : null;
      case "VariableDeclarator": {
        if (holder.init !== lifted || holder.id.type !== "Identifier") return null;
        const name = `${holder.id.name}${path}`;

        if (holder.parent.parent?.type === "ExportNamedDeclaration") return name;

        return exportedByReference(sourceCode.getDeclaredVariables(holder)[0]) ? name : null;
      }

      case "Property": {
        if (holder.value !== lifted || holder.parent.type !== "ObjectExpression") return null;
        const key = holder.computed ? null : keyName(holder.key);

        if (key === null) return null;
        path = `.${key}${path}`;
        node = holder.parent;
        continue;
      }

      case "MethodDefinition":
      case "PropertyDefinition": {
        if (holder.value !== lifted || holder.key.type === "PrivateIdentifier") return null;
        const key = holder.computed ? null : keyName(holder.key);

        if (key === null) return null;
        const owningClass = holder.parent.parent;

        if (owningClass === null) return null;
        path = `.${key}${path}`;
        node = owningClass;
        continue;
      }

      default:
        return null;
    }
  }
}

/** Every function whose parameter reaches a raw digest, directly or through a same-file helper. */
function hashingFunctions(sourceCode: SourceCode, sinks: readonly Sink[]): Set<FunctionNode> {
  const flow = createDigestFlow(sourceCode, []);
  const found = new Set<FunctionNode>();
  const visited = new Set<Variable>();

  function visit(param: Variable): void {
    const slot = flow.parameterSlot(param);

    if (slot === null || visited.has(param)) return;
    visited.add(param);
    found.add(slot.fn);

    for (const { argument } of flow.slotArguments(slot)) {
      for (const next of flow.flowOf(argument).params) visit(next);
    }
  }

  for (const sink of sinks) {
    if (!flow.digests(sink)) continue;

    for (const param of flow.flowOf(sink.data).params) visit(param);
  }

  return found;
}

/** The owner hasher that an exported local binding holds (`import { sha256Hex }` re-exported), or null. */
function heldHasher(imports: OwnerImports, identifier: ESTree.Node): string | null {
  return imports.named.get(identifier) ?? null;
}

export const noExportedHasherRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow exporting a function whose parameter flows into a hash digest from a module that is not a hash owner.",
    },
    messages: {
      exportedHasher: `\`{{name}}\` is exported and hashes its parameter, so a caller in another file can pass JSON.stringify output that warden/sha256-over-json-stringify cannot see. Only an owner module (${OWNER_MODULES}) may export a hasher. ${FIX}`,
      reexportedHasher: `Do not re-export the owner hasher \`{{name}}\`. Import it from its owner module (${OWNER_MODULES}), so warden/sha256-over-json-stringify resolves every call of it.`,
    },
  },
  createOnce(context) {
    let sinks: Sink[] = [];
    let ownerImports: OwnerImports = { named: new Map(), namespaces: new Map() };

    return {
      before() {
        sinks = [];

        return (
          inGateScope(context.filename, context.cwd) &&
          !isOwnerModule(context.filename, context.cwd)
        );
      },
      Program(program) {
        ownerImports = ownerImportsOf(context.sourceCode, program, context.filename, context.cwd);
      },
      CallExpression(node) {
        const sink = digestSinkOf(node);

        if (sink !== null) sinks.push(sink);
      },
      ExportNamedDeclaration(node) {
        if (node.source !== null) {
          const owner = ownerOfSpecifier(node.source.value, context.filename, context.cwd);

          if (owner === null) return;

          for (const specifier of node.specifiers) {
            const local = keyName(specifier.local);

            if (local !== null && owner.hashers.has(local)) {
              context.report({
                node: specifier,
                messageId: "reexportedHasher",
                data: { name: local },
              });
            }
          }

          return;
        }

        for (const specifier of node.specifiers) {
          const name = heldHasher(ownerImports, specifier.local);

          if (name !== null) {
            context.report({ node: specifier, messageId: "reexportedHasher", data: { name } });
          }
        }

        if (node.declaration?.type !== "VariableDeclaration") return;

        for (const declarator of node.declaration.declarations) {
          const name =
            declarator.init === null ? null : heldHasher(ownerImports, unwrap(declarator.init));

          if (name !== null) {
            context.report({ node: declarator, messageId: "reexportedHasher", data: { name } });
          }
        }
      },
      ExportDefaultDeclaration(node) {
        const declaration = node.declaration;

        if (declaration.type !== "Identifier") return;
        const name = heldHasher(ownerImports, declaration);

        if (name !== null) context.report({ node, messageId: "reexportedHasher", data: { name } });
      },
      ExportAllDeclaration(node) {
        const owner = ownerOfSpecifier(node.source.value, context.filename, context.cwd);

        if (owner === null) return;
        const name = [...owner.hashers.keys()].join(", ");

        context.report({ node, messageId: "reexportedHasher", data: { name } });
      },
      "Program:exit"() {
        if (sinks.length === 0) return;

        for (const fn of hashingFunctions(context.sourceCode, sinks)) {
          const name = exportedName(context.sourceCode, fn);

          if (name !== null)
            context.report({ node: fn, messageId: "exportedHasher", data: { name } });
        }
      },
    };
  },
});

import { defineRule } from "@oxlint/plugins";

import type { ESTree, Variable } from "@oxlint/plugins";

import {
  createDigestFlow,
  digestSinkOf,
  isJsonStringify,
  ownerImportsOf,
  ownerSinkOf,
  unwrap,
} from "../shared/digest-flow.ts";
import type { JsonTransform, OwnerImports, Sink } from "../shared/digest-flow.ts";
import { inGateScope } from "../shared/scope.ts";

// A content hash whose pre-image is `JSON.stringify` output depends on object key
// INSERTION order. Warden is content-addressed (docs/code-style.md §6): the review
// resume key (`reviewRuns.input_hash`), index task ids, chunk hashes and the Merkle
// root all depend on a digest being stable. The review harness hashed
// `JSON.stringify(config)` for its resume key, so two equal configs built along two
// code paths could produce two keys and a resume lookup would silently miss.
// `sha256Hex(canonicalJson(value))` is the fix. (Ported from alfred, where three
// copies of the same bug fed a dedup index.)
//
// Sinks. The rule reads the value a hash is computed over at four sinks:
// - `createHash(…).update(data)`, also a later `.update(data)` in the same chain;
// - `h.update(data)`, where `h` resolves to a binding whose value is a hasher. A
//   receiver that is not a hasher (Drizzle `db.update(table)`, a cache entry) is
//   never a sink;
//   ESM crypto imports resolve by binding, including `createHash as nodeHash`;
// - `subtle.digest(alg, data)` and `crypto.subtle.digest(alg, data)`;
// - `sha256Hex(data)`: a call of an owner hasher (the closed list in
//   `shared/hash-owners.ts`) through an import of the owner module, named, renamed
//   (`import { sha256Hex as h }`) or namespace (`hash.sha256Hex(…)`).
//   The specifier must resolve to the owner module: a package specifier through
//   that package's `package.json` `exports` (`@warden/core/hash`), or a relative path
//   resolved from this file (`./hash`, `../hash.ts`). The scope manager resolves the
//   callee, so a local binding that shadows the import is not a sink.
// Any algorithm counts (`md5`, `sha1`, a variable): the bug is the key-order
// pre-image, not the digest. `createHmac` is not a sink: a MAC is checked over the
// bytes that came with it, and the owner hasher takes no key.
//
// JSON. `data` carries JSON when a `JSON.stringify(…)` call sits anywhere inside it
// (joined into a template or a `+`, inside an array or object literal, an argument of
// another call, an encoder, `Buffer.from`), or when a name inside it resolves to a
// binding whose value carries JSON. Names resolve through scope analysis, so a
// parameter, a destructured binding, a `catch` binding or an inner callback parameter
// of the same name is its own binding and never inherits another one.
// Parsing a JSON round-trip and then calling the owner's `canonicalJson`
// removes the outer serialization's key order. Nested serialized strings still
// carry JSON; canonicalizing a string does not sort the keys encoded in it.
//
// Value of a binding:
// - `const`: its initializer.
// - `let` / `var`: the writes that reach the use. Walk the plain writes above the use,
//   nearest first, and stop at the first one that always runs before it: a statement
//   in a block that holds the use, in the same function. So `bytes = raw` on its own
//   line hides an earlier JSON value, and `if (x) bytes = raw` does not. A compound
//   write (`+=`, `??=`) adds its value and does not stop the walk. A destructuring or
//   loop write stops the walk with no value. A write below the use is not read, also
//   in a loop.
// - Anything else (parameter, import, `catch`, function, class) has no value. A
//   function-valued binding is not followed: a helper that holds JSON in its body is
//   not the value of a call to it.
//
// Same-file helper. When `data` reaches a parameter of a named function in this file
// (`function hashOf(s) { … update(s) … }`, a `const` arrow, or a name that a
// destructured parameter binds), each call of that function in this file is read, and
// an argument in that slot that carries JSON is reported at the call. This chains: a
// helper that passes its parameter to another helper is read the same way.
//
// Helper in another file. A one-file rule cannot read the body of an imported
// function, so `warden/no-exported-hasher` keeps the set of cross-file hashers closed:
// only an owner module may export a function whose parameter flows into a digest. The
// owner hashers are the fourth sink above, so a `JSON.stringify` argument to one, or to
// a same-file helper over one, is reported here.

type Finding = { readonly node: ESTree.Node; readonly helper: string | null };

const FIX =
  "Hash sha256Hex(canonicalJson(value)) from @warden/core/hash (packages/core/src/hash.ts): canonicalJson sorts object keys, so equal values always hash the same. It is the one pre-image for the review resume key, index task ids and every other dedup / change-detection digest. If the digest is audit-only and never compared, add `// oxlint-disable-next-line warden/sha256-over-json-stringify -- <why order-dependence is safe here>`.";

/** Each `JSON.stringify` output that reaches a digest, at the sink or at a helper call. */
function jsonFindings(
  flow: ReturnType<typeof createDigestFlow>,
  sinks: readonly Sink[],
): Finding[] {
  const findings: Finding[] = [];
  const reported = new Set<ESTree.Node>();

  function helperCalls(param: Variable, visited: Set<Variable>): void {
    const slot = flow.parameterSlot(param);

    if (slot === null || visited.has(param)) return;
    visited.add(param);

    for (const { helper, argument } of flow.slotArguments(slot)) {
      const argumentFlow = flow.flowOf(argument);

      if (argumentFlow.json && !reported.has(argument)) {
        reported.add(argument);
        findings.push({ node: argument, helper });
      }

      if (!argumentFlow.json) for (const next of argumentFlow.params) helperCalls(next, visited);
    }
  }

  for (const sink of sinks) {
    if (!flow.digests(sink)) continue;
    const sinkFlow = flow.flowOf(sink.data);

    if (sinkFlow.json) {
      findings.push(
        sink.helper === null
          ? { node: sink.call, helper: null }
          : { node: sink.data, helper: sink.helper },
      );
      continue;
    }

    for (const param of sinkFlow.params) helperCalls(param, new Set());
  }

  return findings;
}

/** Ban a content hash whose pre-image is `JSON.stringify` output. */
export const sha256OverJsonStringifyRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow a hash digest over JSON.stringify output, whose pre-image depends on object key order.",
    },
    messages: {
      jsonPreimage: `This digest hashes JSON.stringify output, so two equal values with different key order hash differently. ${FIX}`,
      jsonIntoHashHelper: `\`{{helper}}\` hashes this argument, and it holds JSON.stringify output, so two equal values with different key order hash differently. ${FIX}`,
    },
  },
  createOnce(context) {
    let sinks: Sink[] = [];
    let jsonCalls: ESTree.CallExpression[] = [];
    let transforms: JsonTransform[] = [];
    let ownerImports: OwnerImports = {
      named: new Map(),
      namespaces: new Map(),
      canonicalizers: new Set(),
    };

    return {
      before() {
        sinks = [];
        jsonCalls = [];
        transforms = [];

        return inGateScope(context.filename, context.cwd);
      },
      Program(program) {
        ownerImports = ownerImportsOf(context.sourceCode, program, context.filename, context.cwd);
      },
      CallExpression(node) {
        const callee = unwrap(node.callee);
        if (ownerImports.canonicalizers.has(callee)) {
          transforms.push({ call: node, kind: "canonical" });
        } else if (
          callee.type === "MemberExpression" &&
          !callee.computed &&
          callee.object.type === "Identifier" &&
          callee.object.name === "JSON" &&
          callee.property.type === "Identifier" &&
          callee.property.name === "parse"
        ) {
          transforms.push({ call: node, kind: "parse" });
        }
        if (isJsonStringify(node)) {
          jsonCalls.push(node);

          return;
        }

        const sink = digestSinkOf(node) ?? ownerSinkOf(ownerImports, node);

        if (sink !== null) sinks.push(sink);
      },
      "Program:exit"() {
        if (sinks.length === 0 || jsonCalls.length === 0) return;
        const flow = createDigestFlow(context.sourceCode, jsonCalls, transforms);

        for (const { node, helper } of jsonFindings(flow, sinks)) {
          if (helper === null) context.report({ node, messageId: "jsonPreimage" });
          else context.report({ node, messageId: "jsonIntoHashHelper", data: { helper } });
        }
      },
    };
  },
});

# Warden oxlint rules

Warden's own oxlint JS plugin. These rules are first-party source: we write and
own them. That is the difference from `../anti-slop/`, which is a vendored copy
of a third-party plugin that we keep close to upstream.

So this directory is linted like any other repo source. It is not in
`ignorePatterns` in the root `.oxlintrc.json`, and the anti-slop rules apply to
it. `scripts/tsconfig.json` type-checks it, and `pnpm check-types` runs that
program.

## Provenance

The two hash rules and `shared/` are ported from alfred's first-party plugin
(`alfred/scripts/oxlint/alfred/` at alfred `5d6372f6`), which has the same
author. They are adapted, not vendored: the owner module, its specifier, the
hasher names and the fix text name warden's owner (`packages/core/src/hash.ts`,
`@warden/core/hash`), the fixtures gained warden's own sites (marked
`warden:`), and `shared/scope.ts` holds the file-scope predicate that alfred
reads from its regex-rule table, which warden does not have. The flow analysis
in `shared/digest-flow.ts` started as alfred's copy. Warden now resolves renamed
crypto imports and follows JSON parsing through owner canonicalizers. Port fixes
with those local changes in mind.

## Layout

- `index.ts` builds the plugin with `eslintCompatPlugin` from `@oxlint/plugins`
  and `meta: { name: "warden" }`. It imports each rule from
  `./rules/<rule-id>.ts`. Keep the `rules` object sorted by key, one
  `"<rule-id>": <name>Rule,` entry per line: `pnpm check:oxlint-plugin` reads
  that shape.
- `rules/<rule-id>.ts` is the rule. Its doc comment is the spec: what it flags,
  what it skips, and why.
- `rules/<rule-id>.rule-test.ts` is the RuleTester fixture file. The name is not
  `*.test.ts` on purpose: it is not a suite that a workspace runner owns.
- `shared/` holds AST helpers that a second rule needs. Do not import from
  `../anti-slop/`: it is vendored, so copy a small helper instead.
- `shared/scope.ts` is the file scope: `.ts`/`.tsx` product source, without
  build output, tests, evals, mocks, or anything under a `scripts/` directory.
  A rule returns `inGateScope(context.filename, context.cwd)` from `before()`,
  so it needs no `overrides` entry in `.oxlintrc.json`.
- `shared/digest-flow.ts` is the value flow into a hash digest (sinks, reaching
  writes, parameters, same-file helpers), and `shared/hash-owners.ts` is the
  closed list of modules that may export a hasher. `sha256-over-json-stringify`
  and `no-exported-hasher` both read them, so the two rules cannot disagree on
  what a digest or an owner is.

## How a rule is proven

`pnpm check:oxlint-plugin` discovers every rule in this directory. It fails
when a rule has no fixture file, is not registered in `index.ts`, is not listed
in the root `.oxlintrc.json`, or fails a fixture case. Then it lints each
`invalid` fixture case that the root config can reproduce (no `filename`,
`options` or `settings`) through `.oxlintrc.json`, and fails unless the rule
reports each one at `error`. So a new rule needs:

1. the rule and its fixtures here;
2. an entry in `index.ts`;
3. `"warden/<rule-id>": "error"` in the root `.oxlintrc.json`, or `"off"` with
   its measured count while the tree still violates it (docs/gate-design.md).

A deliberate exception takes a disable comment with its reason, as for any
other rule in this repo:

```ts
// oxlint-disable-next-line warden/sha256-over-json-stringify -- <why order-dependence is safe here>
```

## Rules

| Rule                         | What it rejects                                                                                                                                                                                                                                            |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `no-exported-hasher`         | a function exported from a module that is not a hash owner (`shared/hash-owners.ts`), whose parameter flows into a digest, and a re-export of an owner hasher. Hash through `sha256Hex` from `@warden/core/hash`.                                          |
| `sha256-over-json-stringify` | a hash digest (`createHash(…).update`, a bound hasher, `subtle.digest`, an imported owner hasher `sha256Hex`) over `JSON.stringify` output, whose pre-image depends on key order. Hash `sha256Hex(canonicalJson(value))` from `@warden/core/hash` instead. |

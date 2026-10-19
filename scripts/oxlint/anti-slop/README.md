# Vendored anti-slop rules

A partial vendor of [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop),
an oxlint plugin of rules that reject low-evidence TypeScript. Upstream states it
is "meant to be vendored, not treated as a fixed npm dependency", so this is a
copy we own, not a dependency we track.

## Provenance

- Copied verbatim from alfred's vendor (`alfred/scripts/oxlint/anti-slop/` at
  alfred `5d6372f6`), which was itself copied from upstream. Upstream commits:
  `446268e5d15baa968eaec669ff65358d36ae6259` for every rule except
  `require-readable-spacing`, and `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b` for
  `require-readable-spacing.ts` plus `vendor/eslint-stylistic/`.
  `no-runtime-typeof.ts` carries the `isExistenceProbe` port from upstream
  `f2a8e0b9a479f3c7fa75d64ab7341add40eab7e1`.
- Upstream license: MIT (`./LICENSE`). `vendor/eslint-stylistic/` carries its own
  `LICENSE` and `UPSTREAM.md`, because the padding engine comes from ESLint
  Stylistic, not from anti-slop.
- Upstream's `<rule>.test.ts` fixtures are renamed `<rule>.rule-test.ts`. They are
  RuleTester fixtures that `pnpm check:oxlint-plugin` runs, not a suite that a
  workspace runner owns.
- The directory is in `ignorePatterns` in the root `.oxlintrc.json`, so the copy
  stays byte-close to upstream. `scripts/tsconfig.json` still type-checks it.
- Plugin API: `@oxlint/plugins`, a root devDependency pinned to the same minor as
  `oxlint`. The rules use `SourceCode` / `Scope` internals, so the two move together.

## What is enforced

Every rule registered in `index.ts` has an explicit entry in the root
`.oxlintrc.json`: `"error"` when the tree is at zero, or `"off"` with the measured
count and the reason. `pnpm check:oxlint-plugin` fails on a registered rule that
the config does not mention, so a rule cannot sit registered and unconfigured.
`docs/gate-design.md` holds the ratchet queue with the counts.

A rule moves from `"off"` to `"error"` in its own change, after that change drives
the tree to zero. A rule at `warn` enforces nothing, because `pnpm lint` does not
fail on a warning.

## Why some upstream rules are not here

These were measured and rejected in alfred. The reasons hold for warden:

- `no-unknown-parameters` rejects `unknown` inputs, which is the signature of
  every boundary parser. A parser whose input is already typed has nothing left
  to prove.
- `no-conditional-empty-object-spread` rejects `...(x ? { x } : {})`, the idiom
  that omits an optional key instead of setting it to `undefined`. Warden uses it
  (`run-worker.ts` builds `streamText` options this way) and will need it more
  once `exactOptionalPropertyTypes` is on.
- `no-reflect-get` rejects `Reflect.get`, which is the correct field read on a
  class instance such as a caught `Error`.
- `no-shape-in-symbol-names`: a substring ban that cannot tell a vague name from
  a domain term.

## Updating from upstream

Re-copy the specific `rules/<name>.ts`, its fixtures, and any `shared/` module it
imports; update the commit SHA above; run `pnpm check:oxlint-plugin`. Do not vendor
a rule without its fixtures. The gate rejects that, because a rule that stops
matching leaves a green tree behind it.

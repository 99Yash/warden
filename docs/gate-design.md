# Gate design — which kind of check a rule gets

A rule that only a reviewer enforces is missed the first time the reviewer is tired, and warden's reviewer is often an agent. A rule that becomes a check is only as good as the instrument it runs on. This doc says which instrument a new rule gets, what proves a gate is armed, and which rules are still waiting for one. [`code-style.md`](./code-style.md) tags each rule with the check that enforces it today, and [`enforced-rules.md`](./enforced-rules.md), which a script generates, lists each rule that a gate enforces. The structure is adapted from alfred's `docs/reference/gate-design.md`.

## What runs

`pnpm verify` is the whole gate. CI runs it on every PR and push to `main` (`.github/workflows/check.yml`).

| Script                     | What it proves                                                                                                                                                         |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm check:oxlint-plugin` | Each vendored or first-party rule in `scripts/oxlint/` has passing fixtures, is registered, and is listed in `.oxlintrc.json`. Each `"error"` rule is driven through the root config. |
| `pnpm check:rules-catalog` | `docs/enforced-rules.md` matches what `scripts/enforced-rules-catalog.mjs` generates from the rule sources. |
| `pnpm check:osv-cache` | OSV cache reads use a real temporary SQLite database; malformed JSON, invalid records and expired rows refetch, and valid rows reuse the cache. No network calls. |
| `pnpm knip`                | No unused file, export, dependency, or catalog entry, and no unlisted one. `knip.jsonc` declares each blind spot with its reason; a stale entry fails as a hint.       |
| `pnpm lint`                | oxlint with the root `.oxlintrc.json`, type-aware through tsgolint, `--deny-warnings`.                                                                                 |
| `pnpm format:check`        | oxfmt over code and config. LLM prompts and eval fixtures are excluded, because reformatting them changes what the model reads.                                        |
| `pnpm check-types`         | `tsc` across every workspace, plus `scripts/tsconfig.json` for the repo tooling.                                                                                       |

At edit time, `.claude/hooks/lint-on-edit.mjs` lints each `.ts`/`.tsx`/`.mts` file an agent writes, and returns the diagnostics to the agent. The hook is advisory and `pnpm lint` stays the gate. Claude Code asks each user to trust project hooks before it runs them.

## The ladder

Take the first rung that can state the rule. Each rung down reads less of the program, so it has more ways to miss a case.

| Rung | Instrument                                                                | States                                                             | Fails              |
| ---- | ------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------ |
| 1    | The compiler: types, `tsc` flags                                          | which values a function accepts, which cases a mapping must cover  | `pnpm check-types` |
| 2    | Type-aware lint: `typescript/*` in `.oxlintrc.json`, run through tsgolint | a fact that needs the type of an expression but is not a signature | `pnpm lint`        |
| 3    | Built-in or AST lint rule: oxlint rules, `scripts/oxlint/<plugin>/`       | scope, binding, imports, data flow inside one file                 | `pnpm lint`        |
| 4    | A check script                                                            | a fact about a config, a manifest, or the repo layout              | `pnpm check`       |

**Prefer the compiler.** A closed literal union, a `satisfies Record<Union, T>` map, and an exhaustive switch ending in `assertNever` (`packages/core/src/assert-never.ts`) are read at every call site, through every alias. A lint rule reads one file.

**A regex is the last resort.** Warden has no regex-rule table yet. Alfred's experience is the reason to keep it that way: when a regex gate needs a second round of hole fixes, port it to an AST rule rather than patching it again.

## The bar for "error"

- A rule goes to `"error"` only when the tree is at zero for it. If the tree still violates it, either drive the tree to zero in its own change and then add the rule, or record it as `"off"` with its measured count.
- A rule at `"warn"` enforces nothing. `pnpm lint` runs with `--deny-warnings` so default-category warnings cannot pile up, and `check:oxlint-plugin` rejects a vendored rule at `"warn"`.
- One rule per change when a rule needs code changes, so that the diff reviews as one decision.
- A deliberate exception takes `// oxlint-disable-next-line <rule> -- <reason>`. The reason is required: it is the only thing that tells the next reader whether the exception still holds.

## A green gate proves nothing about itself

A gate passes on a clean tree whether it is armed or dead. Each new rule ships with a planted-violation probe. The probe asserts the diagnostic text, not the exit code.

- **Vendored or first-party plugin rule.** `pnpm check:oxlint-plugin` writes a violating snippet for each `"error"` rule to a temp directory, lints it through the root config, and fails unless the rule reports at `error`. A control snippet must stay clean.
- **Built-in or type-aware rule.** Nothing drives these automatically yet. The PR that adds one shows the probe output in its body: a file that violates the rule, the diagnostic, then the file removed.
- **Compiler guard.** Prove it once with a call that must fail to compile, and report the output in the PR body.

## Enforced today

[`enforced-rules.md`](./enforced-rules.md) lists each rule that a gate enforces: each lint rule at `"error"` with its options, scope and reason, the overrides, the `tsc` flags, and the check scripts. `scripts/enforced-rules-catalog.mjs` generates it from `.oxlintrc.json`, the plugin rules, the tsconfigs, `package.json` and the CI workflow. Do not keep a second table here.

- The reason for a built-in lint rule is the comment directly above its key in `.oxlintrc.json`. Keys that follow one another with no comment and no blank line share one reason, when that comment names each rule or its family (`no-unsafe-*`). The script fails on a built-in rule at `"error"` with no reason.
- A plugin rule's text is its own `meta.docs.description`. A check script's text is the first comment paragraph of its file.
- A change that adds, removes or changes a lint rule, a `tsc` flag or a check script runs `pnpm rules:catalog` and commits the result. `pnpm check:rules-catalog` fails while the catalog is stale.

## Queue: rules with no gate yet

Counts were measured on 2026-10-18 by running alfred's full rule set against this tree; the `typescript/*` rows were measured again on 2026-10-20. The split is product `src` / scripts (smoke, probe, eval). **High**: small, or autofix. **Medium**: a paydown of a few dozen sites. **Low**: a large count, or a check that cannot separate the good case from the bad one. **Stays review**: decided, with the reason.

| Rule                                                        | Mechanism                                                                                                                                                                                                                                                                                                                          | Count (src / scripts)     | Feasibility     |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | --------------- |
| Unused disable directives fail the build                    | `--report-unused-disable-directives-severity=error`. Blocked by `packages/cli/src/index.ts:36`: a `security/*` directive that serves warden's own ESLint-security pass when warden reviews itself. Fix by loading `eslint-plugin-security` as an oxlint JS plugin, or by giving the security runner its own directive spelling     | 1 blocker                 | Medium          |
| Configuration through `@warden/env`, completely             | `WARDEN_CACHE_PATH` is read directly in `db/src/path.ts` and is not in the env schema (disable comment marks it)                                                                                                                                                                                                                   | 1                         | Medium          |
| Subprocess env follows ADR-0054                             | `diff/source.ts` starts `git` with the full `process.env`, provider keys included, while repo-controlled tools get `deterministicProcessEnv()`. Decide whether git needs more than the deterministic set (disable comment marks it)                                                                                                | 1                         | Medium          |
| Parse instead of `typeof` probing                           | `anti-slop/no-runtime-typeof` with `allowInTypeGuards`                                                                                                                                                                                                                                                                             | 75 / 42                   | Low             |
| Blank lines between statement groups                        | `anti-slop/require-readable-spacing` (whitespace-only autofix, 191 files). A style decision, not a defect                                                                                                                                                                                                                          | 4375                      | High, if wanted |
| Duplicated logic                                            | `jscpd` at alfred's thresholds (8 lines, 70 tokens). 5 clones, 0.36% of lines; a discovery aid, not a gate                                                                                                                                                                                                                         | 5                         | Stays review    |
| Timeouts and `abortSignal` on every external and model call | An AST rule over `fetch` / `generateText` / `streamText` option objects. Today `osv.ts` and `run-worker.ts` both do it                                                                                                                                                                                                             | —                         | Medium          |
| Derive row and schema types (`$inferSelect`, `z.infer`)     | A checker cannot separate a deliberate reshape from drift                                                                                                                                                                                                                                                                          | —                         | Stays review    |
| Never `db:push` outside local exploration                   | A command someone runs, not a fact in the source                                                                                                                                                                                                                                                                                   | —                         | Stays review    |

Two infrastructure items from alfred that warden can adopt when the tree needs them: the `.lessons/` + `/learn` flow (already present), and an edit-time helper-hint table (`helper-hints.mjs`). The table only earns its place once warden has canonical helpers that agents keep re-implementing; `canonicalJson` and `sha256Hex` (`packages/core/src/hash.ts`) are the first candidates.

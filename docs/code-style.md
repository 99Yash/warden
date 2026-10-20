# Code style & review checklist

The rules a warden change is held to. Read it before opening a PR, and use it as the checklist when reviewing one. The _why_ for architecture lives in [`decisions.md`](../decisions.md); library mechanics live in [`conventions.md`](./conventions.md). The structure and most of the rules are adapted from alfred's `docs/reference/code-style.md`, kept only where they apply to a CLI that runs tools, calls models, and verifies claims.

Each rule ends with the check that enforces it. _Gate_ names the check that fails `pnpm verify`. _Partly_ names the check for one slice, and review owns the rest. _Review_ means no check enforces it. [`gate-design.md`](./gate-design.md) says which kind of check a new rule gets, and holds the queue of review-only rules with measured counts. [`enforced-rules.md`](./enforced-rules.md) is generated from the gate config, and lists each rule that a gate enforces today. When a tag and the catalog disagree, the catalog is correct.

---

## 1. Types come from their source of truth

A local shape that mirrors a schema drifts from it at the next change.

- **Drizzle rows → `$inferSelect` / `$inferInsert`.** Use `Pick<typeof table.$inferSelect, …>` for a subset. Only `.notNull()` controls select-nullability; `.default()` does not. An untyped JSON column infers `unknown`, not your shape. _Review._
- **Zod schemas → `z.infer`.** A value validated by a schema takes its type from the schema, never from a parallel `interface`. _Review._
- **A literal shape is right when it deliberately differs** from the source, such as a wire reshape or a model-facing projection. Say why in one comment line. _Review._
- **`import type` for type-only imports.** A declaration whose every name is a type is `import type { X }`; a mixed import marks each type inline, `import { f, type X }`. A value imported only for `typeof` takes `type` too. _Partly: `verbatimModuleSyntax` (`pnpm check-types`) and `typescript/consistent-type-imports` fail a type-only import with no `type`; the `import type { X }` form over `import { type X }` is review._
- **Keep the type that a literal already proves.** An explicit `Record<…>`, `unknown`, `object`, or anonymous object type on a binding, a property, a return, or an `as` discards what an object literal, an array, a function, or a `new` proves, such as its keys and literal values. Let inference keep the type, check the shape with `satisfies`, or name the owner contract: an interface, or a mapped type over a closed union. Use a `Map` for a table that an arbitrary string indexes. A generic walker whose callers parse the result keeps its return with `// oxlint-disable-next-line anti-slop/no-known-value-widening -- <reason>`. _Gate: `anti-slop/no-known-value-widening`. It reads syntax only, so it reads each `Record<K, V>` as an open dictionary, also when `K` is a closed union. Whether a directive's reason is still true is review._
- **An optional property means the key is absent.** `k?: T` does not accept `undefined`. When the value may be missing, omit the key: `...(x !== undefined ? { k: x } : {})`. Write `k?: T | undefined` only when an explicit `undefined` means something different from a missing key, or when the type mirrors an API that sends one. zod's `.optional()` infers `T | undefined`, so a parsed field is spread into a hand-written optional field, not assigned to it. _Gate: `exactOptionalPropertyTypes` (`pnpm check-types`)._

## 2. Data from outside is `unknown` until parsed

Warden's claim is that every external fact is verified through a citable source. The parse at the boundary is where that claim is kept or lost.

- **No `any`.** Use `unknown` and narrow it. _Gate: `typescript/no-explicit-any` for an `any` you write; the `typescript/no-unsafe-*` family (`return`, `argument`, `call`, `member-access`, `assignment`) for an `any` that flows on (TypeScript sources)._
- **Parse at the owning boundary, with a schema.** HTTP responses (OSV.dev, npm), tool output (`tsc`, ESLint, `npm audit` JSON), model output, and rows read back from the SQLite cache are all `unknown`. Parse them with zod where they enter. Do not write `(await res.json()) as T` followed by a spot check of one field. `verify/osv.ts` shows the shape: a schema `safeParse`, and a failure is an unverified result. _Partly: `anti-slop/no-widen-then-assert` rejects a widen-then-assert, `no-chained-type-assertions` rejects `as unknown as T`, `typescript/no-unsafe-type-assertion` rejects a single `as T` on parsed JSON, and `anti-slop/no-unknown-returns` rejects a function that returns `unknown` to its callers. That the schema matches the source is review._
- **Do not return `unknown` past the boundary.** A function whose return type is `unknown` or `Promise<unknown>` makes each caller check the value again, or cast it. Parse the value where it enters and return the domain type, or let inference keep the narrow type. A JSON parse wrapper or a generic walker whose callers parse the result keeps `unknown` with `// oxlint-disable-next-line anti-slop/no-unknown-returns -- <reason>`, and the reason names the parse. _Gate: `anti-slop/no-unknown-returns`. It reads only an explicit return type. Whether a directive's reason is still true is review._
- **Give a dictionary a concrete value type.** A `Record<string, unknown>` or an index signature whose value is `unknown`, `any`, `object`, or `{}` says nothing about its values, so each reader checks them again. Parse the value with a zod schema and use its inferred type, name the keys that the code reads in an interface, derive the type from its owner (an SDK type, a table's `$inferInsert`), or use a `Map` with a concrete value type for a table that an arbitrary string indexes. A type guard for unknown JSON (`isRecord`), an opaque JSON column whose reader parses it, and a generic bound keep the open dictionary with `// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- <reason>`. _Gate: `anti-slop/no-unsafe-dictionary-type`. It reads syntax in one file, so it does not follow an alias that another file declares. Whether a directive's reason is still true is review._
- **Type guards over casts.** `as` asserts; it does not check. If you must assert, check first whether the assertion is needed: remove it and run `pnpm check-types`. _Gate: `typescript/no-unnecessary-type-assertion` fails an `as T` or `!` that does not change the type; `typescript/no-unsafe-type-assertion` fails an `as T` that narrows it. A cast that stays (an SDK type gap, a generic walker) takes `// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- <reason>`; whether the reason is still true is review._
- **Delete a guard that the types already decide.** A `?.`, `??`, truthiness check, or comparison whose result the types fix is dead code, or it hides a type that does not match the runtime. Delete it when a parse or the code above it set the type. When the value comes from JSON, an SDK, env, a cast, or a child process, fix the type at that boundary instead. A flag that a callback sets, and a security or fail-closed guard, keep the check with `// oxlint-disable-next-line typescript/no-unnecessary-condition -- <reason>`. _Gate: `typescript/no-unnecessary-condition`, with `allowConstantLoopConditions: "only-allowed-literals"` so that `while (true)` stays legal. Whether a directive's reason is still true is review._
- **No `object` parameters, no `Reflect.apply`, no alias of `unknown`.** Name the owner type. _Gate: `anti-slop/no-object-parameters`, `no-reflect-apply`, `no-unknown-type-aliases`._
- **Exhaustive switches.** A switch over a union ends in `default: return assertNever(x, "<where>")` (`packages/core/src/assert-never.ts`), so a new variant fails the build. _Partly: `typescript/switch-exhaustiveness-check` fails a union switch with no `default` that misses a member; the `assertNever` default is review._
- **Minimize `!`.** A non-null assertion is a promise the compiler cannot keep. Narrow instead, or throw an `Error` that names the invariant. Never trade `!` for `as T`. _Gate: `typescript/no-non-null-assertion`._
- **Throw an `Error`.** A thrown string or object has no stack and no `message`. A caught `unknown` may be rethrown as it is. _Gate: `typescript/only-throw-error`._
- **Every path returns.** A function that returns a value on one path returns one on every path. _Gate: `noImplicitReturns` (`pnpm check-types`)._

## 3. Promises

- **Await it, return it, or mark it `void`.** A fire-and-forget promise is spelled `void (async () => { … })()`, with a comment that says where its errors surface (`workers/run-worker.ts` counts tool calls this way; errors surface through the awaited `result.output`). _Gate: `typescript/no-floating-promises`._
- **`return await` inside a `try`.** A promise returned without `await` settles after the `try` exits, so its `catch` never sees the rejection and its `finally` runs too early. _Gate: `typescript/return-await` (`error-handling-correctness-only`)._
- **No async callback where a void callback is expected.** A rejected `async` handler passed to `createServer` or `.forEach` is unhandled. _Gate: `typescript/no-misused-promises`._
- **Cancel siblings on failure.** When one leg of a `Promise.all` over model calls fails, abort the others so they stop billing. _Review._

## 4. Environment, subprocesses, and output

- **Configuration goes through `@warden/env`.** `wardenEnv()`, the provider helpers, or the setup and runtime helpers. Never `process.env` in product code. _Gate: `node/no-process-env` (`packages/env` is the owner and is exempt)._
- **Repo-controlled tools get the deterministic env.** A child process that runs code from the repo under review takes `deterministicProcessEnv()` from `@warden/env`, never the parent env with provider keys in it (ADR-0054). A child that needs more, such as the OpenCode lane, says why at the spawn site. _Review._
- **Product code never writes through `console`.** `warden mcp` speaks JSON-RPC over stdio, so one stray `console.log` corrupts the protocol stream. Write to `process.stdout` / `process.stderr` on purpose, or through the CLI's renderer. Scripts are exempt. _Gate: `no-console`._
- **Never log a full error object.** It can carry a key or a token. Log the message and safe fields. _Review._

## 5. Models and external calls

- **Get a model from `@warden/ai`.** `getBossModel()`, `getWorkerStrongModel()`, `getWorkerCheapModel()`. Provider packages (`@ai-sdk/*`) are imported only inside `packages/ai`. _Gate: `no-restricted-imports`._
- **Every external call has a timeout.** `fetch` gets an `AbortController` with a named timeout constant (`OSV_TIMEOUT_MS` in `verify/osv.ts`). Model calls set `timeout` (`run-worker.ts`). _Review._
- **AI SDK v6 spellings.** `maxOutputTokens`, `stopWhen: [stepCountIs(n)]`, `inputSchema`, and `generateText` with an `output` instead of the deprecated `generateObject`. See [`conventions.md`](./conventions.md#ai-sdk). _Review._
- **Read the library's `.d.ts` before you claim it cannot do something.** Most "limitations" are an option name you missed. _Review._

## 6. Cache keys and hashing

Warden is content-addressed: the review resume key, index task ids, chunk hashes, and the Merkle root all depend on a digest being stable.

- **Hash canonical JSON, not `JSON.stringify`.** `JSON.stringify` output depends on key insertion order, so two equal configs can produce two keys. Hash a structured value as `sha256Hex(canonicalJson(value))`. `canonicalJson`'s output is the persisted `jobs.task_id` contract, so change it only with a versioned key. _Gate: `warden/sha256-over-json-stringify`._
- **Hash through the one owner.** `sha256Hex` and `canonicalJson` live in `packages/core/src/hash.ts`; import them as `@warden/core/hash`, or relatively inside core, and do not re-export them. Do not export another hash helper. A domain function that hashes through the owner (`stableCommentId`, `taskIdFor`) is fine. _Gate: `warden/no-exported-hasher`. A private inline `createHash` is not caught; review owns it._

## 7. Database

- **`db:generate` → `db:migrate`.** Never `db:push` outside local exploration. _Review._
- **Schema lives in `packages/db/src/schema/`** and is exported through `packages/db/src/schemas.ts`. _Review._

## 8. Constants

- **Name non-obvious numbers.** Thresholds, caps, TTLs, timeouts, retry counts, step caps, and prompt budgets get a named constant with a short reason (`OSV_TTL_MS`, `PER_WORKER_STEP_CAP`). Transparent arithmetic does not. _Review._
- **Place it at the narrowest owner.** The file that enforces the value first; a shared module only when several files read it. Use the environment only for operator knobs, not to avoid naming a constant. _Review._

## 9. Suppressions

A suppression is a claim that this line is the one exception.

- **Name the rule and give the reason**: `// oxlint-disable-next-line <rule> -- <reason>`. A bare directive reads as "this region is unchecked". _Review._
- **Do not keep a suppression "in case the rule comes back."** Delete it. _Review: the unused-directive check is queued (see [`gate-design.md`](./gate-design.md))._
- **`eslint-disable … security/*` directives are not for oxlint.** They suppress a finding in warden's own ESLint-security pass when warden reviews itself (`packages/cli/src/index.ts`). Do not delete one because oxlint has no such rule.

## 10. Formatting

- **oxfmt owns formatting.** Run `pnpm format`. _Gate: `pnpm format:check`._
- **LLM prompts and eval fixtures are not formatted.** `packages/core/src/review-harness/prompts/**` and `packages/cli/scripts/eval/fixtures/**` are in `.oxfmtrc.json`'s `ignorePatterns`, because a reformatted prompt is a different prompt.

## 11. Exports and dependencies

- **Export only what another module imports.** A symbol used only in its own file stays unexported. The type of a public function's argument or result is re-exported from the package's `index.ts` next to the function. _Gate: `pnpm knip`._
- **Declare what you import, and nothing else.** A package loaded by a string specifier (`createRequire` in `runners/eslint-security.ts`) or a binary spawned from `PATH` (`opencode`) is a knip blind spot: add it to `knip.jsonc` with the reason, not to a silent ignore. _Gate: `pnpm knip`._
- **Cross-package exports of `ai`, `core`, `db`, and `env` are not checked.** Their `"./*"` export map makes every `src/` file public API, so knip reports an unused export only in `cli`, `mcp`, and scripts. _Review._

---

## Review hit-list

1. External data cast with `as` instead of parsed (§2). _Partly._
2. A promise neither awaited nor marked `void` (§3). _Gate._
3. `process.env` outside `@warden/env`, or a repo-controlled tool spawned with the full env (§4). _Partly._
4. `console.*` in product code (§4). _Gate._
5. A provider package imported outside `@warden/ai` (§5). _Gate._
6. A `fetch` or model call with no timeout (§5). _Review._
7. A digest over `JSON.stringify`, or a new private sha256 helper (§6). _Review._
8. A local shape that restates a Drizzle table or zod schema (§1). _Review._
9. A suppression with no rule name or no reason (§9). _Review._
10. A non-exhaustive switch over a union (§2). _Partly._

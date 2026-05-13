import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Lookup-on-demand cache for `lookupTypeDef` results (M11 / ADR-0026).
 *
 * Rows are content-addressed on `(package, version, symbol)`:
 *  - `package` is the **literal import path** the LLM queried — e.g.
 *    `'drizzle-orm'`, `'drizzle-orm/sqlite-core'`, `'@radix-ui/react-dialog'`,
 *    `'next/server'`. Subpath variants stay independent rows because they
 *    could expose overlapping symbol names from different `.d.ts` files.
 *  - `version` is the installed version of the *root* package (the segment
 *    before the first subpath `/`), read from
 *    `node_modules/<rootPackageName>/package.json` at lookup time. An
 *    `npm install` that changes the installed version naturally invalidates
 *    cached rows (queries filter on the *current* version).
 *  - `symbol` is the dotted path the LLM asked for — `'with'`, `'NS.foo'`,
 *    `'User.method'`.
 *
 * Both positive and negative resolutions are cached. The negative cases
 * (`no_types`, `symbol_not_found`, `lookup_error`) avoid re-walking the same
 * `.d.ts` tree on repeat lookups in the same install state. The single
 * exception is `package_not_installed` — never cached because the version
 * isn't knowable.
 *
 * No FKs: chunks/embeddings/etc are independent indexes; this table is
 * orthogonal to the M6 indexing storage.
 */
export const typeDefCache = sqliteTable(
  "type_def_cache",
  {
    package: text("package").notNull(),
    version: text("version").notNull(),
    symbol: text("symbol").notNull(),

    /** True when the symbol was resolved; false when any of the
     * NotFoundReason buckets fired. */
    found: integer("found", { mode: "boolean" }).notNull(),

    // Populated when found === true. All seven travel together; the
    // resolver re-materializes a `SuggestedApiDefSource` from them on cache
    // hit (not stored — it's pure derivation).
    kind: text("kind"),
    signature: text("signature"),
    /** Null = looked for JSDoc and none present. Distinct from "didn't look". */
    jsdoc: text("jsdoc"),
    /** repoRoot-relative path into `node_modules/`. */
    dts_file: text("dts_file"),
    line_start: integer("line_start"),
    line_end: integer("line_end"),

    /** Populated when found === false: NotFoundReason enum value. */
    reason: text("reason"),

    /** ISO-8601 timestamp; populates the SuggestedApiDefSource's
     * `retrievedAt` field on cache hits. */
    retrievedAt: text("retrieved_at").notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.package, t.version, t.symbol] }),
  }),
);

export type TypeDefCache = typeof typeDefCache.$inferSelect;
export type NewTypeDefCache = typeof typeDefCache.$inferInsert;

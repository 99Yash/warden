import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCachePath } from "./path.js";

// `import.meta.url`-relative resolution finds migrations in the workspace
// (`packages/db/src/migrations/`) and in published builds
// (`packages/db/dist/migrations/` — see tsdown.config.ts copy entry).
const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "migrations");

let _sqlite: Database.Database | undefined;
let _db: ReturnType<typeof drizzle> | undefined;

/**
 * Returns the singleton Drizzle handle backed by `.warden/cache.sqlite`.
 * Creates the file (and the `.warden/` directory) on first use, then
 * applies any pending migrations so the very first call from any package
 * sees a fully-initialized schema. A schema newer than the bundled migrations
 * (cache survived a warden downgrade) hard-fails with a clear remediation.
 */
export function db() {
  if (!_db) {
    const cachePath = resolveCachePath();
    const sqlite = new Database(cachePath);
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");
    const handle = drizzle(sqlite);
    try {
      migrate(handle, { migrationsFolder: MIGRATIONS_DIR });
    } catch (err) {
      // Don't leave a half-initialized cache visible to subsequent db() calls —
      // close the connection and keep _db undefined so the next attempt retries.
      try {
        sqlite.close();
      } catch {
        // Ignore close errors during cleanup; the migrate failure is what we
        // want to surface.
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Cache schema migration failed (${message}). If the cache is newer than this warden version, upgrade warden or delete \`${cachePath}\` to recreate.`,
      );
    }
    _sqlite = sqlite;
    _db = handle;
  }
  return _db;
}

/** Closes the underlying SQLite connection. */
export function closeDb() {
  if (_sqlite) {
    _sqlite.close();
    _sqlite = undefined;
    _db = undefined;
  }
}

export { resolveCachePath } from "./path.js";
export * from "./helpers.js";
export * from "./schemas.js";

// Re-export the drizzle-orm operator surface that consumers need so callers
// can stay on `@warden/db` as the single import point and don't need to add
// `drizzle-orm` to their own package.json.
export { and, count, eq, gt, gte, inArray, lt, lte, ne, or, sql } from "drizzle-orm";

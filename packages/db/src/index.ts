import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { resolveCachePath } from "./path.js";

let _sqlite: Database.Database | undefined;
let _db: ReturnType<typeof drizzle> | undefined;

/**
 * Returns the singleton Drizzle handle backed by `.warden/cache.sqlite`.
 * Creates the file (and the `.warden/` directory) on first use.
 */
export function db() {
  if (!_db) {
    _sqlite = new Database(resolveCachePath());
    _sqlite.pragma("journal_mode = WAL");
    _sqlite.pragma("foreign_keys = ON");
    _db = drizzle(_sqlite);
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
export { and, eq, gt, gte, inArray, lt, lte, ne, or, sql } from "drizzle-orm";

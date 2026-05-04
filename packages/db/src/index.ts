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

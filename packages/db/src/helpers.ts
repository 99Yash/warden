import { sql } from "drizzle-orm";
import { integer } from "drizzle-orm/sqlite-core";
import { customAlphabet } from "nanoid";

/**
 * Standard `created_at` / `updated_at` columns for SQLite tables.
 *
 * Stored as Unix epoch milliseconds (`integer` mode `timestamp_ms`) for
 * compact representation and easy comparison; Drizzle hydrates them as
 * `Date` objects on read.
 */
export const lifecycle_dates = {
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`)
    .$onUpdate(() => new Date()),
};

/**
 * Generate a prefixed nanoid (e.g. `createId('cache')` → `cache_abc123def456`).
 * Lowercase alphanumeric, 12-char body by default — collision-resistant for
 * the cache scale Warden runs at.
 */
export function createId(prefix?: string, { length = 12, separator = "_" } = {}): string {
  const id = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", length)();
  return prefix ? `${prefix}${separator}${id}` : id;
}

/** Returns the first row of an array, or `null` if empty. */
export function firstOrNull<T>(rows: T[]): T | null {
  return rows[0] ?? null;
}

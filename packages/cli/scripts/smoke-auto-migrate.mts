import { existsSync, unlinkSync } from "node:fs";

const TEST_DB = "/tmp/warden-fresh-cache.sqlite";
if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
process.env["WARDEN_CACHE_PATH"] = TEST_DB;

const { db, chunks } = await import("@warden/db");
const handle = db();
const rows = handle.select().from(chunks).all();
console.log(`chunks rows: ${rows.length} — schema bootstrapped via auto-migrate`);

if (!existsSync(TEST_DB)) throw new Error("expected SQLite file at " + TEST_DB);
console.log(`fresh cache file created at ${TEST_DB}`);

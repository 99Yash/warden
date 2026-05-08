import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import Database from "better-sqlite3";

const cachePath = "/Users/yash/Developer/self/blair/.warden/cache.sqlite";
const sqlite = new Database(cachePath);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");
const db = drizzle(sqlite);
migrate(db, { migrationsFolder: "/Users/yash/Developer/self/warden/packages/db/src/migrations" });
console.log("migrations applied to", cachePath);
sqlite.close();

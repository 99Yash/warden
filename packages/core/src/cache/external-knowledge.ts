import { createId, db, eq, externalKnowledge } from "@warden/db";
import type { SourceType } from "../schema.js";

/**
 * Typed wrapper over the `external_knowledge` table for per-query caching of
 * OSV / advisory / changelog / web fetches. Per `vision.md` §9 every external
 * lookup gets cached behind a deterministic `queryKey` (`osv:GHSA-...`,
 * `web:<sha256-of-url>`, etc.) so the LLM/formatter never re-fetches the same
 * source within a TTL window.
 *
 * Implementation note — better-sqlite3 is synchronous; the API mirrors that
 * (`getCached` returns directly, no Promise) which keeps the call sites in the
 * pipeline straightforward.
 */

export interface CachedEntry<T> {
  payload: T;
  retrievedAt: Date;
}

export function getCached<T>(queryKey: string): CachedEntry<T> | undefined {
  const row = db()
    .select({
      payload: externalKnowledge.payload,
      retrievedAt: externalKnowledge.retrievedAt,
      ttlExpiresAt: externalKnowledge.ttlExpiresAt,
    })
    .from(externalKnowledge)
    .where(eq(externalKnowledge.queryKey, queryKey))
    .get();

  if (!row) return undefined;
  if (row.ttlExpiresAt.getTime() <= Date.now()) return undefined;
  return { payload: row.payload as T, retrievedAt: row.retrievedAt };
}

/**
 * `external_knowledge` is the cache for *externally fetched* sources —
 * CVE, advisory, changelog, documentation, web, tool, repo_convention.
 * `api_def` (M11) sources come from local `.d.ts` lookup and have their
 * own dedicated `type_def_cache` table, so they're excluded here.
 */
export type ExternalSourceType = Exclude<SourceType, "api_def">;

export interface PutOptions {
  queryKey: string;
  sourceType: ExternalSourceType;
  sourceUrl?: string;
  payload: Record<string, unknown>;
  ttlMs: number;
}

export function putCached(opts: PutOptions): void {
  const now = Date.now();
  const expiresAt = new Date(now + opts.ttlMs);
  db()
    .insert(externalKnowledge)
    .values({
      id: createId("xk"),
      queryKey: opts.queryKey,
      sourceType: opts.sourceType,
      sourceUrl: opts.sourceUrl ?? null,
      payload: opts.payload,
      ttlExpiresAt: expiresAt,
      retrievedAt: new Date(now),
    })
    .onConflictDoUpdate({
      target: externalKnowledge.queryKey,
      set: {
        sourceType: opts.sourceType,
        sourceUrl: opts.sourceUrl ?? null,
        payload: opts.payload,
        ttlExpiresAt: expiresAt,
        retrievedAt: new Date(now),
        updatedAt: new Date(now),
      },
    })
    .run();
}

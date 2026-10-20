import { createId, db, eq, externalKnowledge, sql, type NewExternalKnowledge } from "@warden/db";
import { z, type ZodType } from "zod";
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
 *
 * A cached payload is read back through the caller's schema: the row is JSON
 * an older warden (or a hand edit) wrote, so it is not trusted as `T`. A row
 * that fails the schema is a miss, and the caller's refetch overwrites it.
 */

export interface CachedEntry<T> {
  payload: T;
  retrievedAt: Date;
}

export function getCached<T>(queryKey: string, schema: ZodType<T>): CachedEntry<T> | undefined {
  const row = db()
    .select({
      // Read text without the JSON column's decoder: malformed JSON must be
      // a cache miss, not an exception thrown before the schema can run.
      payload: sql<unknown>`${externalKnowledge.payload}`,
      retrievedAt: externalKnowledge.retrievedAt,
      ttlExpiresAt: externalKnowledge.ttlExpiresAt,
    })
    .from(externalKnowledge)
    .where(eq(externalKnowledge.queryKey, queryKey))
    .get();

  if (!row) return undefined;
  // A text column can still hold a BLOB or a NULL (a hand edit); a payload that is not text is a miss.
  const payloadText = z.string().safeParse(row.payload);
  const expiresAt = row.ttlExpiresAt.getTime();
  if (
    !Number.isFinite(expiresAt) ||
    expiresAt <= Date.now() ||
    !Number.isFinite(row.retrievedAt.getTime()) ||
    !payloadText.success
  )
    return undefined;
  let payload: unknown;
  try {
    payload = JSON.parse(payloadText.data);
  } catch {
    return undefined;
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success) return undefined;
  return { payload: parsed.data, retrievedAt: row.retrievedAt };
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
  payload: NewExternalKnowledge["payload"];
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

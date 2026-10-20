// Checks the OSV cache against a real temporary SQLite database: malformed JSON,
// invalid records and expired rows refetch, and a valid row reuses the cache. Only
// the HTTP boundary is replaced, so the check needs no network and no credentials.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, db, eq, externalKnowledge, sql } from "@warden/db";
import { verifyOsv } from "@warden/core/verify/osv";

// Use the real SQLite schema and Drizzle decoder. Only the HTTP boundary is
// replaced, so this test needs no network access or provider credentials.
const directory = mkdtempSync(join(tmpdir(), "warden-osv-cache-"));
const originalCachePath = process.env["WARDEN_CACHE_PATH"];
const originalFetch = globalThis.fetch;
process.env["WARDEN_CACHE_PATH"] = join(directory, "cache.sqlite");

const ghsaId = "GHSA-test-cache-row";
const queryKey = `osv:${ghsaId}`;
const record = { id: ghsaId, aliases: ["CVE-2026-12345"], summary: "Verified advisory" };
let fetches = 0;

globalThis.fetch = async (input, init) => {
  assert.equal(input, `https://api.osv.dev/v1/vulns/${ghsaId}`);
  assert.ok(init?.signal instanceof AbortSignal);
  fetches++;
  return Response.json({ ...record, references: [], modified: "2026-10-19T00:00:00Z" });
};

function storePayload(payload: string, expiresAt = Date.now() + 60_000): void {
  // Bypass the ORM's JSON encoder to reproduce malformed on-disk rows.
  db().run(sql`update ${externalKnowledge}
    set payload = ${payload}, ttl_expires_at = ${expiresAt}
    where query_key = ${queryKey}`);
}

async function expectRefetch(label: string): Promise<void> {
  const before = fetches;
  const verified = await verifyOsv(ghsaId);
  assert.equal(fetches, before + 1, `${label}: the cache miss must refetch`);
  assert.deepEqual(verified?.record, record, `${label}: return the parsed advisory`);
  const cached = db()
    .select()
    .from(externalKnowledge)
    .where(eq(externalKnowledge.queryKey, queryKey))
    .get();
  assert.deepEqual(cached?.payload, record, `${label}: overwrite the bad row with parsed fields`);
}

try {
  await expectRefetch("missing row");
  const cached = await verifyOsv(ghsaId);
  assert.deepEqual(cached?.record, record);
  assert.equal(fetches, 1, "a valid fresh row must not make an HTTP request");

  storePayload("{broken");
  await expectRefetch("malformed JSON");

  storePayload(JSON.stringify({ ...record, aliases: null }));
  await expectRefetch("invalid advisory shape");

  storePayload(JSON.stringify(record), Date.now() - 1_000);
  await expectRefetch("expired row");

  storePayload("{broken", Date.now() - 1_000);
  await expectRefetch("expired malformed JSON");

  db().run(
    sql`update ${externalKnowledge} set retrieved_at = ${"invalid"} where query_key = ${queryKey}`,
  );
  await expectRefetch("invalid citation timestamp");

  db().run(
    sql`update ${externalKnowledge} set ttl_expires_at = ${"invalid"} where query_key = ${queryKey}`,
  );
  await expectRefetch("invalid expiry timestamp");

  storePayload("{broken");
  globalThis.fetch = async () => {
    fetches++;
    return new Response(null, { status: 503 });
  };
  assert.equal(await verifyOsv(ghsaId), undefined, "an unavailable upstream stays unverified");

  process.stdout.write("smoke:osv-cache: all assertions passed\n");
} finally {
  globalThis.fetch = originalFetch;
  closeDb();
  if (originalCachePath === undefined) delete process.env["WARDEN_CACHE_PATH"];
  else process.env["WARDEN_CACHE_PATH"] = originalCachePath;
  rmSync(directory, { recursive: true, force: true });
}

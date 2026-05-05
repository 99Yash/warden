import { getCached, putCached } from "../cache/external-knowledge.js";

/**
 * OSV.dev verification — the citation discipline core of `vision.md` §10 and
 * the no-hallucinated-CVEs guarantee from ADR-0008.
 *
 * Every advisory surfaced by `npm audit` / `pnpm audit` is round-tripped
 * through OSV.dev's public API. An advisory that 404s on OSV is dropped
 * entirely — it never reaches the comment list. This is the single most
 * load-bearing rule in the review pipeline.
 *
 * Records are cached in `external_knowledge` with a 24h TTL. Advisories
 * change rarely (OSV's `modified` timestamps are typically months apart);
 * 24h is well below the natural change rate but well above any single
 * dogfooding run, so cache hits are the common case.
 */

const OSV_VULN_ENDPOINT = "https://api.osv.dev/v1/vulns/";
const OSV_TTL_MS = 24 * 60 * 60 * 1000;
const OSV_TIMEOUT_MS = 5_000;

export interface OsvRecord {
  id: string;
  /** CVE / GHSA aliases. The OSV record for a GHSA usually aliases a CVE. */
  aliases?: string[];
  summary?: string;
  details?: string;
  modified?: string;
  published?: string;
  references?: { type: string; url: string }[];
}

export interface VerifiedAdvisory {
  ghsaId: string;
  record: OsvRecord;
  /** ISO timestamp the OSV record was retrieved (citation freshness). */
  retrievedAt: string;
}

export async function verifyOsv(ghsaId: string): Promise<VerifiedAdvisory | undefined> {
  const queryKey = `osv:${ghsaId}`;

  const cached = getCached<OsvRecord>(queryKey);
  if (cached) {
    return { ghsaId, record: cached.payload, retrievedAt: cached.retrievedAt.toISOString() };
  }

  const record = await fetchOsv(ghsaId);
  if (!record) return undefined;

  putCached({
    queryKey,
    sourceType: "advisory",
    sourceUrl: `${OSV_VULN_ENDPOINT}${ghsaId}`,
    payload: record as unknown as Record<string, unknown>,
    ttlMs: OSV_TTL_MS,
  });

  return { ghsaId, record, retrievedAt: new Date().toISOString() };
}

async function fetchOsv(ghsaId: string): Promise<OsvRecord | undefined> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), OSV_TIMEOUT_MS);
  try {
    const res = await fetch(`${OSV_VULN_ENDPOINT}${ghsaId}`, {
      signal: ctrl.signal,
      headers: { accept: "application/json" },
    });
    if (res.status === 404) return undefined;
    if (!res.ok) return undefined;
    const json = (await res.json()) as OsvRecord;
    if (!json || typeof json !== "object" || typeof json.id !== "string") return undefined;
    return json;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

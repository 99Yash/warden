import { createHash } from "node:crypto";

// The one owner of content hashing (docs/code-style.md §6). `warden/no-exported-hasher`
// rejects an exported hash helper anywhere else, and `warden/sha256-over-json-stringify`
// treats `sha256Hex` as a digest sink, so a `JSON.stringify` pre-image passed to it is
// reported at the call. The owner list is scripts/oxlint/warden/shared/hash-owners.ts.
// Import it as `@warden/core/hash` (or relatively inside core); do not re-export it.
//
// It lives in core because every hash in the tree is computed there. `@warden/db`,
// `@warden/ai` and `@warden/env` sit below core in the dependency graph and cannot
// import it; a hash one of them needs moves this module down, it does not grow a
// second owner.

/**
 * SHA-256 of `data`, as 64 lowercase hex characters, with no prefix. A string is
 * hashed as its UTF-8 bytes; bytes are hashed as they are. For raw content: a file
 * body, a chunk, a key. A structured value goes through {@link canonicalJson} first,
 * because `JSON.stringify` output depends on key insertion order.
 *
 * Persisted values depend on this exact output: `chunks.chunk_hash`, the walked
 * `fileSha`, the import-graph row sha, `jobs.task_id`, the repo Merkle root,
 * comment ids and `reviewRuns.input_hash`.
 */
export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * JSON with every object's keys sorted, so two equal values serialize the same
 * whatever order their keys were inserted in. The pre-image for a content hash of a
 * structured value: `sha256Hex(canonicalJson(value))`.
 *
 * Its output is the persisted contract of `jobs.task_id` (`taskIdFor`), so it is kept
 * byte-for-byte as it was in `indexing/job-runner.ts`, quirks included:
 * - keys sort with `localeCompare`, not by code unit;
 * - a present `undefined` (or function) value is emitted as `"k":undefined`, not
 *   skipped as `JSON.stringify` would, and an array slot holding one is emitted empty;
 * - `toJSON` is honoured only on leaves (`Date` objects serialize as `{}`).
 * Changing any of these re-keys every stored job row; do it with a versioned key.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/**
 * Zero-ceremony runtime guards for values whose type is `unknown`: parsed
 * JSON, a tool payload, a caught error. Narrow with these instead of an `as`
 * cast. When a zod schema for the value exists, parse with it instead.
 */

/** A non-null object that is not an array: JSON's `{…}`. */
// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- the canonical guard for unknown JSON: the check proves only an object, so each value read stays `unknown` and the caller narrows it
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The `code` of a Node system error (`"ENOENT"`, `"EISDIR"`, …), or
 * `undefined` when `err` is not an `Error` or has no string `code`.
 */
export function errnoCode(err: unknown): string | undefined {
  return hasStringCode(err) ? err.code : undefined;
}

/** An `Error` with a string `code`: the shape of a Node system error. */
function hasStringCode(err: unknown): err is Error & { code: string } {
  return err instanceof Error && "code" in err && typeof err.code === "string";
}

/**
 * Zero-ceremony runtime guards for values whose type is `unknown`: parsed
 * JSON, a tool payload, a caught error. Narrow with these instead of an `as`
 * cast. When a zod schema for the value exists, parse with it instead.
 */

/** A non-null object that is not an array: JSON's `{…}`. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The `code` of a Node system error (`"ENOENT"`, `"EISDIR"`, …), or
 * `undefined` when `err` is not an `Error` or has no string `code`.
 */
export function errnoCode(err: unknown): string | undefined {
  if (!(err instanceof Error) || !("code" in err)) return undefined;
  return typeof err.code === "string" ? err.code : undefined;
}

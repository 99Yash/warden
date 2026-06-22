/**
 * Compile-time exhaustiveness guard for discriminated unions.
 *
 * Call in the `default` arm of a `switch` (or the final `else`) over a union's
 * discriminant. When every case is handled, the narrowed value is `never` and
 * this typechecks. Add a new variant without handling it and `x` is no longer
 * `never`, so `pnpm check-types` fails at the unhandled site — turning a silent
 * fall-through into a build error.
 *
 * The throw is a runtime backstop for values that bypass the type system
 * (e.g. data decoded from JSON/DB that doesn't match the declared union).
 */
export function assertNever(x: never, context: string): never {
  throw new Error(`Unhandled variant in ${context}: ${JSON.stringify(x)}`);
}

import { z, type ZodType } from "zod";

/**
 * M15 (ADR-0031): surgical Zod-schema adapter for Google Gemini's
 * structured-output API.
 *
 * **The problem.** Gemini's structured-output endpoint rejects schemas
 * whose enums use numeric literals (e.g. `"enum": [1, 2, 3]`); it accepts
 * only string-keyed enums. Warden's `CommentSchema.tier` is `TierEnum =
 * z.union([z.literal(1), z.literal(2), z.literal(3)])` per `@warden/core/
 * schema.ts`, which Anthropic accepts but Gemini 400s on. The failure is
 * latent — the boss-loop cascade falls back to Gemini only when Anthropic
 * fails, and the 400 surfaces as noisy stderr during the M14 close-out's
 * provider cascade. The numeric `TierEnum` shape is locked from the rest
 * of the codebase per ADR-0031's "no `@warden/core` schema changes" rule.
 *
 * **The fix.** Walk the schema, detect numeric-literal-union nodes
 * (`z.union([z.literal(N1), z.literal(N2), …])` — ALL options must be
 * numeric literals), substitute with `z.union([z.literal("N1"),
 * z.literal("N2"), …])` for the request, and record the field path so the
 * response can be coerced back to numbers before the rest of the pipeline
 * sees it. The substitution is universal — Anthropic accepts string-form
 * enums identically to numeric-form (the boss never sees the schema; it
 * sees a JSON-Schema-derived contract from the AI SDK), so applying the
 * transform to both call paths keeps the cascade simple. Semantically,
 * Anthropic behavior is unchanged — wire encoding differs by `"1"` vs `1`,
 * `responseTransform` reverses the difference before downstream code sees
 * it.
 *
 * **What this does not do (intentionally).**
 *   - Other Gemini quirks: `oneOf`-style discriminator transforms, format-
 *     string limitations, recursive schemas. No evidence yet that they
 *     block us. v0 fix only what M14 close-out actually surfaced.
 *   - Generic provider-adapter framework. The plan §"What NOT to do" defers
 *     to BYOLLM per ADR-0006.
 *   - String→numeric coercion in the other direction. The request always
 *     transforms numeric→string; response reverses.
 *   - Tuples, intersections, custom refinements at the level of literal
 *     unions. The walker recurses through object/array/optional/nullable/
 *     default/readonly wrappers; everything else passes through as the
 *     original schema (which is correct when the schema contains no
 *     numeric-literal-union).
 *
 * Single-export module per ADR-0031. The adapter handles Warden's actual
 * `CommentSchema` shape (object → array → object → union); future Gemini
 * quirks extend this utility.
 */

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * Pair returned by `transformSchemaForGemini`. `requestSchema` is the Zod
 * schema to pass to `Output.object({ schema })` (numeric literals
 * substituted with their string forms). `responseTransform` walks a
 * parsed value and converts each touched field back to its numeric form —
 * call it before returning the parsed object to the rest of the pipeline.
 *
 * When the schema contains no transformable numeric-literal-union nodes,
 * `requestSchema === input` (identity) and `responseTransform` is a
 * pass-through (`v => v`). Callers can always wrap unconditionally — there
 * is no need to gate on "did the adapter actually change anything?"
 */
export interface GeminiSchemaPair<T extends ZodType> {
  requestSchema: T;
  responseTransform: (raw: unknown) => unknown;
}

export function transformSchemaForGemini<T extends ZodType>(schema: T): GeminiSchemaPair<T> {
  const recordedPaths: PathStep[][] = [];
  const transformed = walk(schema, [], recordedPaths);
  if (recordedPaths.length === 0) {
    return { requestSchema: schema, responseTransform: identity };
  }
  return {
    requestSchema: transformed as T,
    responseTransform: (raw) => applyPaths(raw, recordedPaths),
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * One step in a path through a parsed Gemini response. `kind: "key"` walks
 * into a property name; `kind: "index"` maps over every element of an
 * array (we don't know element-indexes statically). The path is recorded
 * during schema walk and replayed during response post-processing.
 */
type PathStep = { kind: "key"; name: string } | { kind: "index" };

interface ZodInternal {
  _zod?: { def?: ZodDef };
}

interface ZodDef {
  type?: string;
  options?: ZodType[];
  shape?: Record<string, ZodType>;
  element?: ZodType;
  innerType?: ZodType;
  values?: unknown[];
  defaultValue?: unknown;
}

function defOf(schema: unknown): ZodDef | undefined {
  return (schema as ZodInternal | undefined)?._zod?.def;
}

function identity(v: unknown): unknown {
  return v;
}

/**
 * Walk a Zod schema. When a numeric-literal-union is found, returns a
 * substituted string-literal-union and records the path into `paths`. For
 * object/array/wrapper nodes, recurses into children and rebuilds the
 * parent only when at least one child changed (preserves identity for
 * unchanged subtrees so the caller's schema reference survives intact
 * when no transformation was needed).
 *
 * Unknown / unsupported node types pass through unchanged.
 */
function walk(schema: ZodType, currentPath: PathStep[], paths: PathStep[][]): ZodType {
  const def = defOf(schema);
  if (!def) return schema;

  switch (def.type) {
    case "union": {
      if (isNumericLiteralUnion(def)) {
        paths.push([...currentPath]);
        return numericLiteralUnionToString(def);
      }
      return schema;
    }
    case "object": {
      const shape = def.shape ?? {};
      const newShape: Record<string, ZodType> = {};
      let changed = false;
      for (const key of Object.keys(shape)) {
        const child = shape[key];
        if (child === undefined) continue;
        const transformed = walk(child, [...currentPath, { kind: "key", name: key }], paths);
        newShape[key] = transformed;
        if (transformed !== child) changed = true;
      }
      return changed ? (z.object(newShape) as unknown as ZodType) : schema;
    }
    case "array": {
      if (def.element) {
        const transformed = walk(def.element, [...currentPath, { kind: "index" }], paths);
        if (transformed !== def.element) {
          return z.array(transformed) as unknown as ZodType;
        }
      }
      return schema;
    }
    case "optional": {
      if (def.innerType) {
        const transformed = walk(def.innerType, currentPath, paths);
        if (transformed !== def.innerType) {
          return transformed.optional() as unknown as ZodType;
        }
      }
      return schema;
    }
    case "nullable": {
      if (def.innerType) {
        const transformed = walk(def.innerType, currentPath, paths);
        if (transformed !== def.innerType) {
          return transformed.nullable() as unknown as ZodType;
        }
      }
      return schema;
    }
    case "default": {
      if (def.innerType) {
        const transformed = walk(def.innerType, currentPath, paths);
        if (transformed !== def.innerType) {
          // Default values for transformed numeric-literal-unions would
          // need their type adjusted (number → string). In practice the
          // schemas we transform don't carry defaults on union fields
          // (TierEnum has no default); preserving the wrapper without the
          // default keeps the request schema parsable on the wire. If a
          // future schema needs default-preserving transform, lift the
          // default into responseTransform.
          return transformed as unknown as ZodType;
        }
      }
      return schema;
    }
    case "readonly": {
      if (def.innerType) {
        const transformed = walk(def.innerType, currentPath, paths);
        if (transformed !== def.innerType) {
          return transformed as unknown as ZodType;
        }
      }
      return schema;
    }
    default:
      return schema;
  }
}

/**
 * True iff the union has ≥1 option, every option is a `z.literal(...)`,
 * and every literal value is a finite number. Bigint literals reject (the
 * Gemini API path doesn't see them in practice; ruling them out keeps the
 * conversion typed cleanly).
 */
function isNumericLiteralUnion(def: ZodDef): boolean {
  const options = def.options;
  if (!options || options.length === 0) return false;
  for (const opt of options) {
    const optDef = defOf(opt);
    if (!optDef || optDef.type !== "literal") return false;
    const values = optDef.values;
    if (!values || values.length === 0) return false;
    for (const v of values) {
      if (typeof v !== "number" || !Number.isFinite(v)) return false;
    }
  }
  return true;
}

function numericLiteralUnionToString(def: ZodDef): ZodType {
  const options = def.options ?? [];
  const stringLiterals = options.flatMap((opt) => {
    const values = defOf(opt)?.values ?? [];
    return values
      .filter((v): v is number => typeof v === "number")
      .map((v) => z.literal(String(v)));
  });
  if (stringLiterals.length === 1) {
    return stringLiterals[0] as unknown as ZodType;
  }
  return z.union(
    stringLiterals as unknown as [ZodType, ZodType, ...ZodType[]],
  ) as unknown as ZodType;
}

/**
 * Walk the parsed Gemini response according to the recorded paths and
 * replace each string-form numeric back to its numeric counterpart. Each
 * path is applied independently — paths share prefixes harmlessly because
 * conversion is idempotent (a number stays a number on the second pass).
 *
 * The traversal clones aggregate nodes (objects, arrays) before mutating
 * so the caller's input is not mutated in place — the AI SDK's response
 * object may be referenced elsewhere.
 */
function applyPaths(raw: unknown, paths: PathStep[][]): unknown {
  let acc: unknown = raw;
  for (const path of paths) {
    acc = applyPath(acc, path, 0);
  }
  return acc;
}

function applyPath(value: unknown, path: PathStep[], step: number): unknown {
  if (value === null || value === undefined) return value;
  if (step === path.length) {
    if (typeof value === "string") {
      const n = Number(value);
      if (Number.isFinite(n)) return n;
    }
    return value;
  }
  const next = path[step];
  if (next === undefined) return value;
  if (next.kind === "key") {
    if (typeof value !== "object" || Array.isArray(value)) return value;
    const obj = value as Record<string, unknown>;
    if (!(next.name in obj)) return value;
    const replaced = applyPath(obj[next.name], path, step + 1);
    if (replaced === obj[next.name]) return value;
    return { ...obj, [next.name]: replaced };
  }
  if (!Array.isArray(value)) return value;
  let changed = false;
  const out = value.map((el) => {
    const r = applyPath(el, path, step + 1);
    if (r !== el) changed = true;
    return r;
  });
  return changed ? out : value;
}

/**
 * Smoke for M15 (ADR-0031) Gemini schema adapter.
 * `transformSchemaForGemini()` round-trips numeric-literal-union enums
 * (e.g. `TierEnum`) to string-literal-union for the wire and back to
 * numbers in the response transform. No LLM calls required — this is a
 * pure schema-walk + parse exercise.
 *
 * Asserts:
 *   1. Identity-no-op when the schema contains no numeric-literal-union.
 *   2. Numeric-literal-union → string-literal-union substitution; the
 *      transformed schema accepts string-form input but the original
 *      schema rejects it.
 *   3. `responseTransform` coerces strings back to numbers; the result
 *      round-trips through the original schema.
 *   4. Works on the real `CommentSchema`/`BossOutputSchema` shape: nested
 *      object → array → object → numeric-literal-union (`tier` field).
 *   5. Nested numeric unions inside an `optional()` wrapper transform
 *      correctly (path-recording survives the wrapper unwrap).
 *
 * Does NOT exercise the cascade end-to-end (would require a stubbed
 * Anthropic-fail-then-Gemini-succeed path with mocked HTTP transport).
 * The `boss-loop.ts` integration is type-checked alongside this smoke.
 *
 * Usage:
 *   pnpm --filter @warden/cli smoke:m15-gemini-adapter
 */

import { z } from "zod";
import { transformSchemaForGemini } from "@warden/ai";

let failed = 0;
function assert(cond: unknown, msg: string): void {
  if (cond) {
    process.stdout.write(`  ✓ ${msg}\n`);
  } else {
    process.stdout.write(`  ✗ ${msg}\n`);
    failed++;
  }
}

// -----------------------------------------------------------------------
// 1. Identity no-op when schema has no numeric-literal-union
// -----------------------------------------------------------------------
process.stdout.write(`\n[1] schemas without numeric-literal-union → identity\n`);

const noNumeric = z.object({
  id: z.string(),
  status: z.enum(["a", "b", "c"]),
  count: z.number(),
});
const idPair = transformSchemaForGemini(noNumeric);
assert(idPair.requestSchema === noNumeric, `requestSchema is identical when no transform applies`);
const idResp = idPair.responseTransform({ id: "x", status: "a", count: 5 });
assert(
  JSON.stringify(idResp) === JSON.stringify({ id: "x", status: "a", count: 5 }),
  `responseTransform is identity`,
);

// -----------------------------------------------------------------------
// 2. Numeric-literal-union substituted for the wire
// -----------------------------------------------------------------------
process.stdout.write(`\n[2] numeric-literal-union → string-literal-union substitution\n`);

const TierEnum = z.union([z.literal(1), z.literal(2), z.literal(3)]);
const TopLevel = z.object({ tier: TierEnum });
const pair2 = transformSchemaForGemini(TopLevel);

assert(pair2.requestSchema !== TopLevel, `requestSchema is a NEW schema (was: same)`);

const wireForm = { tier: "2" };
const requestParse = pair2.requestSchema.safeParse(wireForm);
assert(requestParse.success, `requestSchema accepts string-form input`);

const origParse = TopLevel.safeParse(wireForm);
assert(!origParse.success, `original schema rejects string-form input`);

const numericForm = { tier: 2 };
const origParseNumeric = TopLevel.safeParse(numericForm);
assert(origParseNumeric.success, `original schema still accepts numeric input`);

// -----------------------------------------------------------------------
// 3. responseTransform reverses the substitution
// -----------------------------------------------------------------------
process.stdout.write(`\n[3] responseTransform coerces strings back to numbers\n`);

const transformed = pair2.responseTransform({ tier: "3" }) as { tier: unknown };
assert(
  typeof transformed.tier === "number",
  `tier coerced to number (got ${typeof transformed.tier})`,
);
assert(transformed.tier === 3, `tier value preserved (got ${transformed.tier as number})`);

// Round-trip: original schema accepts the post-transform value.
const roundTrip = TopLevel.safeParse(transformed);
assert(roundTrip.success, `post-transform value round-trips through original schema`);

// -----------------------------------------------------------------------
// 4. Real CommentSchema shape: nested object → array → object → tier
// -----------------------------------------------------------------------
process.stdout.write(`\n[4] real CommentSchema/BossOutputSchema shape\n`);

const { CommentSchema } = await import("@warden/core");
const BossOutputSchema = z.object({ comments: z.array(CommentSchema) });
const pair4 = transformSchemaForGemini(BossOutputSchema);

assert(
  pair4.requestSchema !== BossOutputSchema,
  `BossOutputSchema replaced (nested transform fired)`,
);

const wireBoss = {
  comments: [
    {
      id: "x",
      file: "src/a.ts",
      lineStart: 1,
      lineEnd: 1,
      tier: "1", // string-form
      category: "correctness",
      kind: "assertion",
      claim: "claim",
      explanation: "explanation",
      sources: [],
      confidence: 0.9,
    },
    {
      id: "y",
      file: "src/b.ts",
      lineStart: 5,
      lineEnd: 5,
      tier: "3",
      category: "leverage",
      kind: "question",
      claim: "claim",
      explanation: "explanation",
      sources: [],
      confidence: 0.8,
    },
  ],
};

const reqParse = pair4.requestSchema.safeParse(wireBoss);
assert(reqParse.success, `requestSchema parses string-form BossOutputSchema (wire shape)`);

const coerced = pair4.responseTransform(reqParse.success ? reqParse.data : wireBoss) as {
  comments: { tier: unknown }[];
};
const tiersAreNumbers = coerced.comments.every((c) => typeof c.tier === "number");
assert(
  tiersAreNumbers,
  `all tier fields coerced to numbers (got: ${coerced.comments.map((c) => typeof c.tier).join(",")})`,
);

const finalParse = BossOutputSchema.safeParse(coerced);
assert(finalParse.success, `coerced value round-trips through original BossOutputSchema`);

const origRejectsWire = BossOutputSchema.safeParse(wireBoss);
assert(!origRejectsWire.success, `original BossOutputSchema rejects string-form tiers`);

// -----------------------------------------------------------------------
// 5. Optional-wrapped numeric-literal-union
// -----------------------------------------------------------------------
process.stdout.write(`\n[5] numeric-literal-union inside optional() wrapper\n`);

const WithOptional = z.object({
  required: TierEnum,
  optional: TierEnum.optional(),
});
const pair5 = transformSchemaForGemini(WithOptional);

const present = pair5.requestSchema.safeParse({ required: "2", optional: "3" });
assert(present.success, `present optional field accepts string`);

const absent = pair5.requestSchema.safeParse({ required: "2" });
assert(absent.success, `absent optional field is fine`);

const coerced5 = pair5.responseTransform(present.success ? present.data : {}) as {
  required: unknown;
  optional: unknown;
};
assert(coerced5.required === 2, `required coerced (got ${coerced5.required as number})`);
assert(coerced5.optional === 3, `optional coerced (got ${coerced5.optional as number})`);

// -----------------------------------------------------------------------

if (failed > 0) {
  process.stdout.write(`\n${failed} assertion(s) failed\n`);
  process.exit(1);
}
process.stdout.write(`\nall assertions passed\n`);

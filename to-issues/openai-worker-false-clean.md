# OpenAI worker path silently false-cleans the whole review

**Severity:** high — a review tool reporting "no findings" when it actually
errored is the worst possible failure mode.

## Symptom

With `OPENAI_API_KEY` set, `getReviewModel`/worker routing prefer OpenAI
(`gpt-5.4-mini`). Every worker dispatch then 400s:

```
Invalid schema for response_format 'response': In context=(...,'sources','items'),
'required' is required to be supplied and to be an array including every key in
properties. Missing 'url'.
```

OpenAI strict structured-output requires **every** property to appear in
`required`; the worker `sources[]` schema has `url` optional. All workers fail,
the boss emits an empty review, and the CLI prints `warden review: no findings`
with a successful exit and a tiny cost. Observed on the 2026-06-21 alfred PR#235
dogfood: two runs reported "clean" purely because every worker had errored.

This is a _second_ variant of the landmine in memory
`project_warden_boss_structured_output` — the first (`z.url()` → `format:"uri"`)
was fixed; the all-keys-in-`required` rule is a different rejection on the same
schema.

## Fixes (pick one or both)

1. **Make the schema OpenAI-strict-safe:** mark `sources[].url` required +
   nullable (`z.string().nullable()` with the field always present) instead of
   optional, in the worker output schema(s). Verify against
   `programmatic-dispatch-multi` on the OpenAI path.
2. **Never silent-clean on worker error:** if N of M worker dispatches fail,
   surface a loud degraded entry and a non-zero signal rather than rendering an
   empty-but-successful review. An all-workers-failed review must not look like
   a clean review.

Until fixed, dogfood/eval with `unset OPENAI_API_KEY` (Anthropic worker path
handles the schema).

## Refs

- memory `project_warden_boss_structured_output`
- `packages/ai/src/models.ts` (OpenAI-preferred-when-keyed)
- worker output schema in `packages/core/src/review-harness/`

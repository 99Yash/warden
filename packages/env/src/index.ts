import { z } from 'zod';
import { currentWardenRuntime } from './config.js';

export * from './config.js';

const envSchema = z.object({
  ANTHROPIC_API_KEY: z
    .string()
    .min(1, 'ANTHROPIC_API_KEY is required — see https://console.anthropic.com')
    .optional(),
  // Optional fallback per ADR-0017. Tool-using review call sites still
  // skip Gemini fallback; provider wiring remains for non-tool cascades.
  GOOGLE_GENERATIVE_AI_API_KEY: z.string().min(1).optional(),
  // Optional review LLM provider. When set, Warden prefers OpenAI for
  // worker dispatch and can run review without Anthropic.
  OPENAI_API_KEY: z.string().min(1).optional(),
  // Required for `warden init` and the `warden review` semantic signal
  // (ADR-0019). Optional at env-validate time so `warden check` (which
  // never touches the index) doesn't surprise users; the embedding-provider
  // factory throws fast when consumed without the key.
  VOYAGE_API_KEY: z.string().min(1).optional(),
  WARDEN_LOG_LEVEL: z
    .enum(['silent', 'error', 'warn', 'info', 'debug'])
    .default('info'),
  // Optional one-off env-file override. Loaded by config.ts before this
  // schema is parsed; kept here so docs-vs-code consistency checks see the
  // supported surface.
  WARDEN_ENV_FILE: z.string().min(1).optional(),
  // ADR-0028 / M13: per-category confidence floor override for the
  // `security` category. Parsed as a numeric string so missing/empty values
  // are unambiguous. v0 default lives in `@warden/core`'s
  // `CATEGORY_CONFIDENCE_FLOOR`; this env var only overrides it.
  WARDEN_SECURITY_CONFIDENCE_FLOOR: z
    .string()
    .regex(/^\d+(\.\d+)?$/, {
      message: 'WARDEN_SECURITY_CONFIDENCE_FLOOR must be a numeric string',
    })
    .refine(
      (s) => {
        const n = Number(s);
        return n >= 0 && n <= 1;
      },
      {
        message:
          'WARDEN_SECURITY_CONFIDENCE_FLOOR must be a number between 0.0 and 1.0',
      },
    )
    .optional(),
  // ADR-0030 / M14: boss-loop step cap for the M14 review harness. Default 5
  // rounds; clamped to [1, 10] so neither a typo'd 0 nor a runaway 1000 can
  // wreck a review. Each round is one `streamText` step the boss spends
  // dispatching workers via `dispatch_worker` or emitting the final
  // `Output.object({ comments: Comment[] })` structured result.
  WARDEN_REVIEW_BOSS_ROUNDS: z
    .string()
    .regex(/^\d+$/, {
      message: 'WARDEN_REVIEW_BOSS_ROUNDS must be a positive integer',
    })
    .refine(
      (s) => {
        const n = Number(s);
        return n >= 1 && n <= 10;
      },
      {
        message: 'WARDEN_REVIEW_BOSS_ROUNDS must be between 1 and 10',
      },
    )
    .optional(),
  // ADR-0030 / M14: optional total cap on workers dispatched across the
  // whole boss loop. Unset = unbounded (boss self-budgets within the round
  // cap × max-tool-calls-per-round). When set, the dispatch tool returns an
  // error to the boss + emits a degraded entry past the cap. Must be a
  // positive integer; 0 is invalid per the design (use the round cap to
  // disable workers).
  WARDEN_REVIEW_WORKER_BUDGET: z
    .string()
    .regex(/^[1-9]\d*$/, {
      message:
        'WARDEN_REVIEW_WORKER_BUDGET must be a positive integer (use the round cap to disable workers)',
    })
    .optional(),
  // ADR-0032 / M16: optional USD cap for the review-time incremental
  // embedding refresh. Unset means the review harness uses its default
  // budget; 0 is the explicit opt-out.
  WARDEN_REVIEW_REFRESH_MAX_USD: z
    .string()
    .optional()
    .transform((value) =>
      value === undefined || value === '' ? undefined : Number(value),
    )
    .refine(
      (value) => value === undefined || (Number.isFinite(value) && value >= 0),
      {
        message: 'WARDEN_REVIEW_REFRESH_MAX_USD must be a non-negative number',
      },
    ),
  // ADR-0033: per-tier dispatch concurrency caps. Strong = Sonnet via
  // `getWorkerStrongModel()`; cheap = Haiku via `getWorkerCheapModel()`.
  // Provider-neutral naming so M18 + BYOLLM inherit. Positive integers; 0
  // is rejected (the path for "no concurrency at all" is to set
  // WARDEN_REVIEW_BOSS_ROUNDS=1, a different surface). Default values
  // are applied at the consumer in `review-harness/harness.ts`.
  WARDEN_WORKER_CONCURRENCY_STRONG: z
    .string()
    .regex(/^[1-9]\d*$/, {
      message: 'WARDEN_WORKER_CONCURRENCY_STRONG must be a positive integer',
    })
    .optional(),
  WARDEN_WORKER_CONCURRENCY_CHEAP: z
    .string()
    .regex(/^[1-9]\d*$/, {
      message: 'WARDEN_WORKER_CONCURRENCY_CHEAP must be a positive integer',
    })
    .optional(),
  // M18 / ADR-0029: belt-and-suspenders cap for the dedicated security
  // harness worker fan-out. The boss plan prompt receives the budget too,
  // but this env var is the deterministic enforcement point.
  WARDEN_SECURITY_WORKER_BUDGET: z
    .string()
    .regex(/^[1-9]\d*$/, {
      message: 'WARDEN_SECURITY_WORKER_BUDGET must be a positive integer',
    })
    .optional(),
  // ADR-0046: opt into the `react-doctor` det-prior (subprocessed
  // `react-doctor` CLI — its visitor rules + scan() SAST suite + the
  // `--scope changed` delta). Default **off** while eval-gated; the
  // `det-priors.ts` call site gates on this. Boolean-ish: `1` / `true`
  // (case-insensitive) enable it; anything else (incl. unset) is off.
  WARDEN_REACT_DOCTOR: z
    .string()
    .optional()
    .transform(
      (value) => value !== undefined && /^(1|true)$/i.test(value.trim()),
    ),
  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .default('development'),
});

export type WardenEnv = z.infer<typeof envSchema>;

export function wardenEnv(): WardenEnv {
  currentWardenRuntime();
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const formatted = result.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(
      `Missing or invalid environment variables:\n${formatted}\n\nRun \`warden setup --check\` to see provider readiness and env file paths.`,
    );
  }
  return result.data;
}

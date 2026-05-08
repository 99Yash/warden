import { z } from 'zod';

const envSchema = z.object({
  ANTHROPIC_API_KEY: z
    .string()
    .min(
      1,
      'ANTHROPIC_API_KEY is required — see https://console.anthropic.com',
    ),
  // Optional fallback per ADR-0017. When set, the LLM cascade routes to
  // Google Gemini after Anthropic fails post-retry. When unset, Anthropic
  // failure is hard-fail.
  GOOGLE_GENERATIVE_AI_API_KEY: z.string().min(1).optional(),
  // Required for `warden init` and the `warden review` semantic signal
  // (ADR-0019). Optional at env-validate time so `warden check` (which
  // never touches the index) doesn't surprise users; the embedding-provider
  // factory throws fast when consumed without the key.
  VOYAGE_API_KEY: z.string().min(1).optional(),
  WARDEN_LOG_LEVEL: z
    .enum(['silent', 'error', 'warn', 'info', 'debug'])
    .default('info'),
  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .default('development'),
});

export type WardenEnv = z.infer<typeof envSchema>;

let _env: WardenEnv | undefined;

export function wardenEnv(): WardenEnv {
  if (_env) return _env;
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const formatted = result.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(
      `Missing or invalid environment variables:\n${formatted}\n\nSet them in .env at the repo root, or export them in your shell.`,
    );
  }
  _env = result.data;
  return _env;
}

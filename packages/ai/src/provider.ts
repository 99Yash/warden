import { createAnthropic } from "@ai-sdk/anthropic";
import { wardenEnv } from "@warden/env";

let _anthropic: ReturnType<typeof createAnthropic> | undefined;

/**
 * Lazily-instantiated Anthropic provider singleton. v0 hardcodes Anthropic
 * per ADR-0006; multi-provider auto-selection is deferred.
 */
export function anthropicProvider(): ReturnType<typeof createAnthropic> {
  if (!_anthropic) {
    _anthropic = createAnthropic({ apiKey: wardenEnv().ANTHROPIC_API_KEY });
  }
  return _anthropic;
}

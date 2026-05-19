# Warden — M17 Plan (setup + repo onboarding)

> **Status, 2026-05-19:** M17 is the setup/onboarding milestone. The prior deep-security plan moved to [`m18-plan.md`](./m18-plan.md).

## Goal

Make Warden easy to install, configure once, and initialize on any repository without copying a server `.env` file between projects.

M17 keeps the split sharp:

- **User-level setup** belongs to `warden setup`: global config/env templates, provider readiness, and diagnostics.
- **Repo-level indexing** stays with `warden init`: `.warden/`, `.gitignore`, cache/index creation, cost estimate, and embedding refresh.

## Decisions

1. **Config is JSONC and layered.** Built-in defaults load first, then `~/.config/warden/config.jsonc`, then `<repo>/warden.jsonc` when present.
2. **Secrets remain env-based.** Config files can name env vars with `apiKeyEnv`, but raw keys are rejected by schema. Secret values can come from process env, configured env files, project `.env` / `.env.local`, or `WARDEN_ENV_FILE`.
3. **Setup writes only safe templates.** `warden setup` creates global config mode `0644`, global env mode `0600`, and the global config dir mode `0700` when missing. The env template contains commented placeholders only.
4. **Project config is explicit.** `warden setup project` creates `warden.jsonc`; Warden does not copy global config into a repository automatically.
5. **Readiness is command-scoped.** `check` needs no provider key, `review` requires the primary LLM key, `init` requires the embedding key unless `--dry-run` is used. Gemini fallback is additive, not a blocker.
6. **Future bot/cloud consumers use the same facts.** The structured setup JSON includes written files, config paths, env lookup results, and provider/command readiness without depending on terminal output.

## M17 Scope

- Add `@warden/env` config runtime (`config.ts`) for JSONC parsing, env-file loading, provider routing defaults, setup file creation, and readiness reporting.
- Add `warden setup`, `warden setup --check`, `warden setup --json`, `warden setup project`, and `warden setup --project`.
- Stop validating Anthropic for `warden check`.
- Gate `warden review` on Anthropic, `warden init` on Voyage, and keep Gemini optional.
- Update README, env docs, glossary, and milestone notes.

## Explicit Non-Goals

- No OS keychain or hosted auth in M17.
- No interactive prompt flow; Warden stays a one-shot CLI per ADR-0014.
- No BYOLLM model-picker UI yet. The config shape leaves space for provider routing, but M17 only supports the current Anthropic primary, Google fallback, and Voyage embeddings.
- No custom alerts or cloud bot surfaces yet. The readiness JSON is the handoff point for those future wrappers.

## Acceptance Checks

- `warden setup` can create global templates without requiring any provider key.
- `warden setup --check --json` reports readiness without writing files.
- `warden setup project` creates a commit-safe `warden.jsonc`.
- `warden check` runs without `ANTHROPIC_API_KEY`.
- `warden review` fails early with a clear message when the primary LLM key is missing.
- `warden init --dry-run` does not require Voyage; `warden init` does.

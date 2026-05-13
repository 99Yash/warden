# Showcase fixtures

`warden-on-warden.json` is the checked-in `CommentSet` consumed by the static examples page and
homepage hero.

Regenerate it before a public deploy:

```bash
pnpm gen-fixtures
```

The generator runs `warden review --json --base main` from the repository root and overwrites this
file. Keeping the JSON checked in makes site builds deterministic and avoids deploy-time API keys.

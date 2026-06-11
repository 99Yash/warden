# m6-misses (warden PR#3, "feat: warden init and embeddings", merged 2026-05-08)

Warden's M6 PR (`99Yash/warden#3`) shipped `warden init` + Voyage embeddings.
Copilot reviewed the same PR alongside warden and caught categories of
findings that warden's M6-era pipeline missed. These labels make the
missed findings catchable for candidate configs and let us measure
whether the Sentry-Warden prompt-craft borrows recover them on a real PR.
See `docs/dogfood-backlog.md` + the `project_warden_review_category_gaps`
memory for full origin context.

Note: a fifth category in the original memory (committability —
`packages/db/scripts-bootstrap-blair.mts`) does not appear in this PR's
diff; it may have lived on a sibling branch / different PR. The fixture
is calibrated to the misses warden core can plausibly catch from PR-scoped
diff content alone.

```yaml
id: chunk-store-load-then-filter
path: packages/core/src/indexing/chunk-store.ts
category: scalability
description: db.select().from(chunks).all() followed by rows.filter — the predicate should be a SQL WHERE. Pattern repeats in this file across more than one accessor. Copilot caught.
```

```yaml
id: embedding-store-load-then-filter
path: packages/core/src/indexing/embedding-store.ts
category: scalability
description: Load-all-then-filter shape — select() returns every embedding row, then JS filters by file SHA / model. Same shape as chunk-store.ts; should be a WHERE clause at the storage layer.
```

```yaml
id: readme-voyage-required-but-optional
path: README.md
category: consistency
description: README claims VOYAGE_API_KEY is required for `warden review`, but `wardenEnv()` marks it optional and the pipeline degrades to cheap-signals selection when unset. README drift will mislead users into thinking they need the key.
```

```yaml
id: compute-banner-state-dead-branch
path: packages/core/src/banner/index.ts
category: deadcode
description: computeBannerState has a branch that fires only when an optional parameter is supplied; no callsite supplies it — made acceptance criterion 6.3 silently untestable. Pattern is the "dead-from-callsites" branch — inverted import-graph signal ("who passes this argument" vs "who imports this file").
```

---
title: CI usage
description: Gate CI on Warden's deterministic check today, and trial lane reviews on pull requests with the tracer workflow.
---

<p class="doc-lede">You can use Warden in CI in two ways. The deterministic check is ready now: it's fast, it costs nothing, and it never calls a model. The lane review workflow is a trial. It runs a real review on labeled pull requests and reports to the job summary.</p>

## The deterministic gate

```bash
pnpm install --frozen-lockfile
pnpm warden check --base origin/main --json
```

`check` runs the deterministic phase and exits: type errors, lint, audited advisories, duplication, Warden's detectors, and the scans for credentials and hidden instructions on the added lines. It makes no model call and needs no secrets, so it can run on every push. It can also run on pull requests from forks, but give that job no secrets: ESLint loads the PR's own config and plugins, so the PR's code runs on the runner. With `--json` it prints the same `CommentSet` as every other command, so a script can fail the build on Tier 1 comments or post a summary without parsing terminal output.

Check out enough history for the merge-base to resolve. With `actions/checkout`, that means `fetch-depth: 0`.

## Lane review on pull requests

The repository includes a trial workflow, `.github/workflows/warden-review.yml`. It runs `warden opencode-review` on a pull request and records how long each step takes and what the session cost. We call it a tracer: it proves the whole path works end to end, but it isn't finished yet.

Here's what it does:

1. **It runs only when you ask.** Add the `warden-review` label to a pull request. Each run spends model credit, so nothing happens without the label.
2. **It checks out the PR head** with full history, so the base resolves by merge-base. Git credentials aren't left in `.git/config`, because a lane can read files, and a token sitting in the checkout would be one more thing to leak.
3. **It installs a pinned OpenCode.** The driver depends on how the shipped OpenCode binary actually behaves, and OpenCode updates often, so the version is fixed and verified.
4. **It runs the review.** Only this step receives the model secret.
5. **It reports.** The result is validated against the `CommentSet` schema and then written to the job summary and an artifact, together with the lane model, the timings, and the session cost. The job passes whatever the review finds. It's for evaluation, not for blocking merges.

### Secrets and variables

<div class="doc-property-list">
  <div><code>ANTHROPIC_API_KEY</code><span>Secret. The lane model's key, or a Cloudflare AI Gateway token.</span></div>
  <div><code>ANTHROPIC_BASE_URL</code><span>Optional secret. Routes the lane model through a gateway.</span></div>
  <div><code>WARDEN_LANE_MODEL</code><span>Optional repository variable. Overrides the lane model.</span></div>
</div>

### Why only same-repository pull requests

The workflow never uses `pull_request_target`, and it skips pull requests from forks. A fork's diff could carry text written to steer the lane, and a fork's ESLint config would run on the runner. Keeping the model secret out of those runs is the simplest control there is. It doesn't make every same-repository PR safe, though. [Untrusted input](/docs/untrusted-input/) explains what does and doesn't help there.

## Not done yet

The tracer leaves out three things that a real CI reviewer needs:

- **Pull request comments.** Results go to the job summary for now.
- **A hard spend cap.** Cost is measured after the run, not limited during it. A CI reviewer that runs on every push needs a ceiling it can't exceed.
- **A cached index.** CI would have to embed the repository again on every run. Exporting and importing the index ([#45](https://github.com/99Yash/warden/issues/45)) will make the index a cache artifact, keyed by repository and embedding model.

Those land with the CI runner work tracked in the [repository issues](https://github.com/99Yash/warden/issues).

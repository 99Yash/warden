---
title: CI usage
description: Gate CI on Warden's deterministic check, and trial lane reviews on pull requests.
---

<p class="doc-lede">Use <code>warden check</code> as a deterministic CI gate. Use the lane review workflow to trial <code>warden opencode-review</code> on pull requests: it is a tracer today, and it reports to the job summary only.</p>

<div class="doc-feature-list">
  <a class="doc-card" href="#deterministic-gate"><span class="doc-card-icon">check</span><strong>Deterministic gate</strong><p>No model call. Good for fast CI, pre-commit, and failure summaries.</p></a>
  <a class="doc-card" href="#lane-review-on-pull-requests"><span class="doc-card-icon">lane</span><strong>Lane review</strong><p>OpenCode runs a lane against the PR diff; the post-pass decides what ships.</p></a>
  <a class="doc-card" href="#output"><span class="doc-card-icon">json</span><strong>Stable output</strong><p>The same <code>CommentSet</code> for scripts, bots, and summaries.</p></a>
</div>

## Deterministic gate

<div class="doc-code-card">
  <div class="doc-code-header"><span>CI-friendly</span><code>no LLM</code></div>
  <pre><code>pnpm install --frozen-lockfile
pnpm warden check --json</code></pre>
  <p>Runs the deterministic phase and exits. This is the safe default for automation that must not spend model credit. Use the workspace command until Warden is published to npm.</p>
</div>

## Lane review on pull requests

The repository ships a tracer workflow, `.github/workflows/warden-review.yml`. It runs `warden opencode-review` on a pull request and records how long each step takes.

<ol class="doc-steps doc-steps-compact">
  <li><span>Opt in</span><p>Add the <code>warden-review</code> label to a pull request. Each run spends model credit, so nothing runs without the label.</p></li>
  <li><span>Check out the head</span><p>The job checks out the PR head with full history, so the base resolves by merge-base. Credentials are not persisted to <code>.git/config</code>.</p></li>
  <li><span>Install OpenCode</span><p>The OpenCode version is pinned, because the driver depends on the behavior of the shipped binary.</p></li>
  <li><span>Review</span><p>Run the lane. Only this step receives the model secret.</p></li>
  <li><span>Report</span><p>Write the result, the lane model, timings, and session cost to the job summary and an artifact. The job passes on every review verdict.</p></li>
</ol>

<div class="doc-property-list">
  <div><code>ANTHROPIC_API_KEY</code><span>Secret. The lane model key, or a Cloudflare AI Gateway token.</span></div>
  <div><code>ANTHROPIC_BASE_URL</code><span>Optional secret. Route the lane model through a gateway.</span></div>
  <div><code>WARDEN_LANE_MODEL</code><span>Optional repository variable. Overrides the lane model.</span></div>
</div>

<div class="doc-callout doc-callout-warning">
  <strong>Same-repo pull requests only</strong>
  <p>The workflow never uses <code>pull_request_target</code> and skips pull requests from forks. Untrusted diff text can try to steer a lane, so the model secret stays out of fork runs.</p>
</div>

<div class="doc-callout doc-callout-note">
  <strong>Not yet</strong>
  <p>The workflow does not comment on the pull request, enforce a hard spend cap, or restore a cached repo index. Those land with the CI runner work tracked in the repository issues.</p>
</div>

## Output

Pass `--json` to any review command to get the typed `CommentSet`. A wrapper can render it in a PR comment, a Slack message, or a summary without scraping terminal output.

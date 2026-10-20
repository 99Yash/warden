---
title: Connect OpenCode
description: Run Warden as an MCP server, connect OpenCode to it, and run a review lane that publishes through the post-pass.
---

<p class="doc-lede">Warden runs as a local MCP server that the review agent calls for evidence. On top of that, <code>warden opencode-review</code> runs the whole review for you: it starts OpenCode, runs one lane, and publishes only what survives Warden's checks.</p>

There are two ways to use this. Most people want the second.

- **Just the tools.** Add Warden to your own OpenCode config and call its tools from any session. You get the deterministic evidence and the type lookups, but nothing checks what the model writes.
- **A full review.** Run `warden opencode-review`. Warden sets up the session itself, runs the lane, and puts every finding through the post-pass before anything is published.

## Add Warden to OpenCode

Start OpenCode from the repository you want to review. Warden finds the repository root from the directory it was launched in, and it opens `.warden/cache.sqlite` there the first time it needs it. A new cache sets itself up, so there's no separate setup step. Add this to `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "warden": {
        "type": "local",
        "command": ["warden", "mcp"],
        "codemode": false,
      },
    },
  },
}
```

Keep `"codemode": false`. OpenCode's default puts MCP tools behind a single code-execution tool, and then the agent never sees `warden_run_det_priors` or `warden_lookup_type_def` by name. Run `opencode mcp list` to check that the server connects.

### Running from a clone

The `warden` command above assumes a published CLI, and there isn't one yet. Until there is, point `command` at your clone and keep the working directory on the repository under review, not on the Warden clone:

```jsonc
"command": [
  "node",
  "--import",
  "/abs/path/to/warden/packages/cli/node_modules/tsx/dist/esm/index.mjs",
  "/abs/path/to/warden/packages/cli/src/index.ts",
  "mcp"
]
```

The absolute path to the loader means the repository you're reviewing doesn't need `tsx` installed.

## The tools

Warden exposes two tools. A third, `search_index`, for semantic search over the repository index, is planned ([#44](https://github.com/99Yash/warden/issues/44)).

**`run_det_priors`** runs the deterministic phase on the diff: TypeScript, ESLint, `npm audit` confirmed against OSV, duplication, Warden's detectors, and the scans of added lines. It returns the changed files, a summary, and the findings. Findings arrive in pages. The first call returns a review handle, and later calls ask for the next page by handle and offset. Warden keeps the results between calls, so paging doesn't run `tsc` again.

**`lookup_type_def`** resolves a library export, such as `ai#streamText`, to its declaration in the `.d.ts` file installed in `node_modules`. It returns a source the agent can cite as-is. The lane charters tell the agent to call it before making any claim about how a library behaves.

Every result comes in a versioned envelope, and three things hold for all of them:

- **The shape is versioned.** Each envelope carries a schema version, so an upgrade on either side can't quietly change what the other side reads.
- **The size is bounded.** Results are built to fit a page budget, and a 64 KiB cap catches anything pathological. A citation is never truncated. If a finding can't fit on a page even by itself, it's counted as unretrievable and left out, so you can see it happened.
- **Failure is a result.** A missing detector or an unknown symbol comes back as a structured not-found or error result. Nothing throws across the transport, and one broken detector doesn't fail the review.

The [principles page](/docs/principles/#measure-the-payload-before-you-bound-it) tells the story behind the size rules. The first cap broke every real review.

## Run a review lane

```bash
pnpm warden opencode-review --base main
```

Here's what happens when you run it:

1. Warden resolves the diff against the merge-base with `main`, and it refuses inputs it knows are unsafe: a new or changed `AGENTS.md` below the root, or a symlink that points outside the repository or into `.git`.
2. It writes a locked-down OpenCode config for the lane. The agent gets `read`, `grep`, and `glob`, plus Warden's two tools, and nothing else. Your repository's own OpenCode config, plugins, and root `AGENTS.md` aren't loaded.
3. It starts a private `opencode serve` and waits until the Warden MCP server is connected and its tools are registered.
4. It runs the lane. The lane must call `run_det_priors` before anything else. A lane that never calls it fails, because that almost always means the MCP server didn't start properly.
5. It reads the findings the lane submits, runs them through the [post-pass](/docs/review/#4-the-post-pass), and prints the result. Nothing the model wrote is published until the post-pass has checked it.

Warden needs no provider key for this. The lane model is OpenCode's, so the credentials are too. The default model is `anthropic/claude-opus-5-5#high`.

### Options

<div class="doc-property-list">
  <div><code>--lane down|up</code><span><code>down</code> is the default. It takes the behavior a change claims and tries to break it. <code>up</code> looks for structural problems and only runs when you ask for it. See <a href="/docs/review/#3-the-lane">the lanes</a>.</span></div>
  <div><code>--base &lt;ref&gt;</code><span>The ref to diff against, by merge-base. The default is the repository's default branch. It has to be a plain ref name.</span></div>
  <div><code>--model &lt;id&gt;</code><span>The lane model, as <code>provider/model#variant</code>.</span></div>
  <div><code>--json</code><span>Print the <code>CommentSet</code> as JSON.</span></div>
  <div><code>--verbose</code><span>Keep Tier 3 comments (style and duplication), which are hidden by default.</span></div>
  <div><code>--volume-cap &lt;n&gt;</code><span>The most comments to publish. The default is 5, and Tier 1 comments are always kept.</span></div>
  <div><code>--lanes-out &lt;file&gt;</code><span>Save what the lane submitted, so you can audit it or replay the post-pass. Findings that would repeat a credential are replaced by a marker before the file is written.</span></div>
  <div><code>--timings-out &lt;file&gt;</code><span>Save how long each step took: diff, gates, MCP startup, lane, and post-pass.</span></div>
  <div><code>--timeout &lt;s&gt;</code><span>Stop the OpenCode process after this many seconds. The default is 900.</span></div>
  <div><code>--mcp-timeout &lt;s&gt;</code><span>How long to wait for the Warden MCP server to connect. The default is 30.</span></div>
</div>

### When a lane runs out of room

A lane has a 60-step limit and runs with OpenCode's compaction turned off. Compaction would replace older turns with a summary, and a summary has lost the code a finding has to quote. So when a lane hits the context limit, it fails with a `context_limit` reason. You'll see an actionable note saying the result isn't clean, and the command exits 1. For a very large diff, review it in smaller ranges.

## Replay the post-pass

The post-pass is also a command of its own, and it makes no model call. Give it a saved lane file and the same diff, and you get the same `CommentSet` back.

```bash
pnpm warden opencode-review --base main --lanes-out lanes.json
pnpm warden post-pass --lanes lanes.json --base main --json
```

Replay is useful for debugging a surprising result, and for checking a change to the post-pass against real lane output without paying for another model run. If you run OpenCode by hand and then call `post-pass` yourself, the checks still apply. But nothing then stops someone from publishing the raw session text instead, and that's why `opencode-review` is the supported path.

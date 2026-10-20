---
title: How a review runs
description: Follow one pull request through Warden, from the diff to the published comments, and see why each step is there.
---

<p class="doc-lede">This page follows one pull request through <code>warden opencode-review</code>, from start to finish. Warden owns the first part and the last part: evidence before the model starts, and checks after it's done. The middle part, the review itself, runs in OpenCode.</p>

## 1. Before the model

Everything starts with the diff. Warden finds the merge-base between your branch and the base ref and takes the diff from there. Then it removes the files a reviewer shouldn't spend time on: lockfiles, build output, minified bundles, and generated code.

That pruning matters more than it sounds. In one early run, a 6,618-line generated database snapshot reached the model in every round of the review. That run cost $11. With the snapshot pruned, the same review cost $0.93. Warden records what it pruned in the output notes.

Before any model sees the diff, Warden refuses two kinds of input it knows to be unsafe:

- **A new or changed `AGENTS.md` below the repository root.** OpenCode loads those as instructions while it reads files, so a PR could use one to rewrite the reviewer's brief.
- **A symlink that points outside the repository or into `.git`.** OpenCode's `read` tool follows links without checking the target, so a link could expose Git credentials or the process environment.

Either one fails the lane closed, with a note that says why. [Untrusted input](/docs/untrusted-input/) explains both.

## 2. The evidence

The lane's first job is to call `run_det_priors`. Warden runs every deterministic tool it has against the diff:

- **TypeScript** (`tsc`) and **your ESLint config**, so the review starts from the errors your own tools would report.
- **`npm audit`**, with every advisory confirmed against [OSV.dev](https://osv.dev). An advisory without an OSV record is dropped.
- **Warden's security lint**, a fixed set of ESLint security rules that runs even when your config doesn't include them.
- **Duplication** (`jscpd`), limited to the changed files and the related code Warden selects as context.
- **Warden's detectors** for scalability (for example, sequential `await` in a loop), dead code, consistency, and leverage, which means a library or standard-library feature that would replace hand-written code.
- **Scans of the added lines** for credentials, hidden Unicode characters, and text addressed to an AI reviewer.
- **`react-doctor`**, if you turn it on with `WARDEN_REACT_DOCTOR=1`.

Results arrive in pages within a byte budget, so a large PR can't flood the agent's context.

On this path, the lane treats these results as evidence and doesn't repeat them as its own findings. Publishing deterministic findings will be the job of a `surface` lane, which doesn't exist yet. The exceptions are the credential and integrity scans. Their findings are always published, whatever the lane does. More on that in [step 4](#4-the-post-pass).

## 3. The lane

A lane is one review agent with one way of looking at code. Warden's method, which it shares with a sibling project, has three of these approaches, plus a judge:

- **`down`: try to break the claim.** Pick a behavior the change claims ("this retries on failure", "this can't run twice") and trace it through callers, state, and failure paths until it either holds or breaks. This is the default lane, and it focuses on correctness.
- **`up`: look for a better shape.** Picture the structure the domain wants, then measure the change against it: one fact stored in several places, one construct doing two jobs, a dependency that points the wrong way. This lane is opt-in (`--lane up`).
- **`surface`: sweep against known rules.** Not built yet.
- **`judge`: combine and decide across lanes.** Not built yet.

The method's motto is "fund up first, earn down selectively". In plain terms: look at structure before details, so a pile of local nits doesn't set the agenda, and spend deep tracing only where a claim is risky. Today the lanes run one at a time, so nothing enforces that order yet. The motto is a direction, not a guarantee.

### What a lane can do

A lane gets `read`, `grep`, and `glob`, plus Warden's two MCP tools, and nothing else. It has no tool to write files, run commands, or reach the network. It has 60 steps, and compaction is off. Because a finding must quote real code, a lane that runs out of context fails visibly and doesn't carry on from a summary.

The `down` lane also limits how far it traces each claim. It reads each changed file in full. Then, for each claim, it may open one caller and one definition, three files at most. When those three files don't settle the claim, the lane doesn't keep digging. It calls the claim **unproven**, names the next file it would have opened, and says what breaks if that file doesn't hold up. This is deliberate. Proving everything isn't possible, and an honest "unproven" is more useful than a guess presented as a proof.

### What a lane hands back

The lane ends by submitting its findings as JSON. Each finding has a file and line range, a category, a tier, a confidence, a claim, an explanation, and the sources it quotes. The driver also records which files that lane was asked to review. That record is the lane's **scope**. The driver writes it, not the model, so the lane can't widen its own scope.

## 4. The post-pass

The post-pass is where Warden decides what you see. It runs after the lane returns, outside the model, and in a fixed order:

1. **Schema check.** Each finding is validated on its own, so one malformed finding doesn't sink the others. Warden assigns IDs from each finding's content, so two identical findings become one.
2. **Secret guard.** If any field of a finding matches a known credential format, or cites a sensitive file such as `.env`, the finding is dropped and the drop is reported. The value is never repeated.
3. **Scope.** A finding has to cite at least one file inside its lane's scope.
4. **Citation check.** Each quoted snippet is matched against the real file, near the line it claims. A finding whose quotes all fail is dropped. No model output can rescue a citation that doesn't match.
5. **Added lines.** A finding has to anchor on a line the PR added. A comment about code the PR didn't change belongs in a different conversation.
6. **Confidence.** Below the bar (0.7, or 0.8 for security), an assertion becomes a question. Nothing is dropped for being uncertain. A verified citation of a library's installed type definition counts as authority and keeps the assertion.
7. **Tier 3.** Style and duplication findings stay hidden unless you pass `--verbose`.
8. **Order.** Findings are sorted by [reading order](/docs/reading-comments/#categories-what-to-read-first), with correctness first.
9. **Volume.** At most five comments are published by default. Tier 1 comments are always kept.

After the lane's findings pass these checks, Warden adds its own Tier 1 security findings from the scans of the added lines: credentials, sensitive files, hidden Unicode, and instructions addressed to a reviewer. These skip the lane entirely. A lane that fails, returns nothing, or was talked into silence can't remove them.

## 5. What you get

The result is one `CommentSet`, the same shape that `check` and `review` produce. It holds the published comments, a list of anything that didn't run or was dropped (`degradedWorkers`), and run metadata such as timings.

The command exits 1 when the result can't be trusted as clean. That happens when no lane ran, when every lane failed, when the diff was empty, or when the secret guard dropped a finding. "No comments" and "clean" are not the same thing, and the exit code keeps them apart.

## The older path: `warden review`

`warden review` runs Warden's original in-process loop: an Opus "boss" that dispatches per-concern worker models. It's still the default review command until the parity eval ([#43](https://github.com/99Yash/warden/issues/43)) shows the OpenCode path matches it. It uses the same deterministic phase and citation check, but its final rules are older. It drops low-confidence findings instead of turning them into questions, and it has no volume cap. It's also the only path that uses the embedding index today.

`warden security` and `warden review --deep` exist, but so far they run only the first triage step of the deep security review. The rest is designed and deferred. When it's built, it will be a lane that uses Warden's tools, not a second loop inside Warden.

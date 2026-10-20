---
title: Why Warden works this way
description: The mistakes, measurements, and dogfood runs behind Warden's design, and what each one changed.
---

<p class="doc-lede">Most of Warden's rules started as a bug report against Warden itself. This page goes through the ones that shaped it: what we saw, what we changed, and what's still open. None of it is settled for good. These are the lessons so far, and the numbers come from our own runs.</p>

## The model writes; it doesn't testify

We started from one fear: an AI reviewer that invents a CVE. A made-up vulnerability with a confident severity is about the fastest way to lose a team's trust, and language models will produce one if you ask them to. So the first rule Warden had was that anything with an outside authority behind it gets checked against that authority. A vulnerability comment needs an [OSV.dev](https://osv.dev) record, and without one the comment is dropped. That's the one hard drop that has survived every redesign since.

Library APIs turned out to be the same problem in a different form. Models remember APIs as they were at training time, and they're happy to tell you a function takes `parameters` when the current version takes something else. So the review agent can call `lookup_type_def`, which resolves a library export to the `.d.ts` file actually installed in your `node_modules`. The finding cites that declaration, and the citation is verified like any other.

The same rule caught us the other way, too. One finding cited a doc comment bundled inside an SDK as proof that a setting would fail. The comment was out of date, and the SDK never checked the setting. A doc comment records what someone believed when they wrote it. These days only the declaration counts as authority.

## A quote proves the code exists, not that the argument holds

For a while Warden required every finding to carry a verified citation, and we treated that as the guarantee of quality. It wasn't one. The verifier checks that a quoted snippet really appears in the file, so it proves the code exists. It can't tell you whether the reasoning about that code holds up. That's how the twelve-finding run from the [overview](/docs/) happened: eight wrong findings, every one of them with a real quote.

It also hid a quieter problem. One worker met the citation rule by labeling its own quote as a "tool" source. The rule was satisfied, and it meant nothing.

So we stopped pretending every finding could have an outside source ([ADR-0044](https://github.com/99Yash/warden/blob/main/decisions.md)). Some findings are **sourced**: a type error, an advisory, an API claim backed by a real declaration. Others are **reasoned**: a judgment about the diff, such as "this branch can never run". A reasoned finding has to quote the lines it's talking about, it has to sit on a line the PR added, and its confidence decides whether it's stated as a problem or asked as a question. Dropping a finding just because nobody outside vouched for it would cut recall, and recall was already the weak side.

We also added fixtures that are supposed to produce no comment at all. These are false-positive traps built from findings we know were wrong, and a review fails if it posts one. One caveat: when we re-ran the original PR, the eight wrong findings didn't come back, so that fixture is easy to pass today. Giving reasoned findings the callers and callees they depend on, and adding a pass that tries to refute them, is planned but not built ([ADR-0047](https://github.com/99Yash/warden/blob/main/decisions.md)).

## Missed bugs were mostly missing context

Wrong findings were one half of the problem. Missed bugs were the other half, and they came from a different cause than we expected.

On one pull request we ran Warden next to another review setup on the same diff. Warden reported two findings, and one of them was wrong. The other setup reported five real ones. It wasn't a bigger budget: Warden had room to spare, and every file involved was in the diff. The difference was what each reviewer knew. The other setup had a staff-engineer brief, the PR description, the design records, and the project's journals. Warden had the diff. On a second pull request, with four bugs we had written down by hand, Warden found none of them.

An earlier eval showed the same pattern. On small fixture repositories both arms of an experiment caught 0 of 7 planted bugs. Moving the fixtures into real repository checkouts took one arm to 2 of 7. The model wasn't the limit. Context was.

That's why the open work is mostly about context. Feeding in what the author said they meant to do ([ADR-0049](https://github.com/99Yash/warden/blob/main/decisions.md)) is planned. Letting a finding cite unchanged code elsewhere in the repo ([ADR-0051](https://github.com/99Yash/warden/blob/main/decisions.md)) is proposed. A structural pass that steps back from the diff ([ADR-0052](https://github.com/99Yash/warden/blob/main/decisions.md)) has shipped as the opt-in `up` lane.

## A check the model can skip is not a check

When we moved the review loop into OpenCode, the obvious design was to expose everything as MCP tools, citation checks included. That would have looked like more capability and given us less. A model can decline to call a tool. It can call it once, see that the check fails, and phrase the finding a little differently. If verification is something the model chooses to do, precision becomes optional.

So the checks aren't tools. They run in a **post-pass** after the agent returns, against whatever findings it submitted. Then we had to decide what runs the post-pass. An OpenCode plugin was the first idea, but OpenCode v2 has no hook that fires when a session ends, and a plugin can be switched off in config or fail to load without any error. The driver, `warden opencode-review`, does it instead. It runs the session, waits for it, reads the findings, runs the post-pass, and publishes only the result. Raw model output has no path to you.

## An empty review is not a clean review

The worst result a reviewer can give you is a false "all clear". We've shipped that bug more than once.

The first time, a provider's strict JSON-schema mode rejected every worker request. The loop got no findings back, reported "no findings", and exited 0. It looked like a cheap, successful review. Later, when we put deterministic results on the MCP wire, the serializer read the tool findings and forgot the vulnerability stream. That made 59 of 149 findings (40%) invisible to every client, and nothing in the output said anything was missing. And an early version of the evidence tool accepted a `head` revision while its detectors read the working tree, so asking about a broken revision returned "ok" with zero findings.

Each time, the fix went beyond patching the bug. Now when part of a review doesn't run, the output says so. Partial failures go into `degradedWorkers` with a reason. No lanes, all lanes failed, or an empty diff each produce an entry that says plainly that this is **not** a clean result, and the command exits 1. An honest "I couldn't check this" beats a silent pass.

## Measure the payload before you bound it

MCP tool results go straight into the agent's context window, so we capped each one at 16 KiB to be safe. That cap was a tripwire, not a safety rail. An oversized result isn't truncated. It's replaced with a `result_too_large` error, so any review of real size got an error instead of evidence.

When we measured, the culprit wasn't anything we'd guessed. On a range of 332 files and 120,318 added lines, 1.4 MB of the 1.8 MB bundle was one field: the list of added line numbers, one integer per line. Sending a count per file instead made that part 46 times smaller. (The first figure we wrote down was 647 times, and it was wrong, because it compared two different shapes.) So results are now bounded by how they're built: findings are paged inside a byte budget, context ships as file locations instead of file contents, and the 64 KiB cap only fires on pathological input. A citation is never cut in half, because half a citation is not evidence.

We also got the list of consumers of that field wrong three times in a row before anyone checked. The measurement script stays in the repository so the numbers can be produced again.

## A reviewer needs the code, not a summary of it

OpenCode compacts long sessions by default: it replaces older turns with a model-written summary. That's sensible for a coding session. For a review it's a quiet way to lose evidence, because a finding has to quote the code, and a summary no longer contains it.

Review lanes run with compaction off. If a lane runs out of context, it fails and says so. Warden also counts compactions after the run and fails the lane if any happened, in case a future OpenCode version ignores the setting. It's better to fail visibly than to keep reviewing from a paraphrase.

## Fewer comments, in the order you'd read them

The rule of thumb we started from is that people stop reading a reviewer once about a third of what it says is noise. So Warden would rather say less. You get five comments by default, and blocking ones are always kept. Style and cleanup findings (Tier 3) stay hidden unless you ask for them. A finding below the confidence bar becomes a question rather than a claim, because "is this branch reachable?" is useful, and "this branch is unreachable" is harmful when it's wrong.

Order matters as much as count. Comments are sorted the way a careful reviewer reads code: correctness first, then security, then structure, then style, with tests last. A correctness fix can change the rest of the diff, so there's no point polishing the parts that might move. See [Reading a comment](/docs/reading-comments/) for the full order.

## Text under review is data

A review agent reads text that other people wrote: the diff, code comments, dependency files, sometimes the PR description. Any of it can contain instructions aimed at the agent. Two cases worried us most. OpenCode loads any `AGENTS.md` it passes on the way to a file as session instructions, so a PR that adds one can rewrite the reviewer's brief. And a committed symlink can point a harmless-looking path at `.git/config`, or on a Linux runner at the process environment.

We can't make a model immune to what it reads, so Warden doesn't try. It fixes what the agent is allowed to do before the session starts, blocks the inputs it can recognize, and makes sure some findings get published whatever the agent does. [Untrusted input](/docs/untrusted-input/) covers each control and what it doesn't cover.

## What we haven't solved

- **Recall is low.** The only full eval of the down lane so far was a single-sample tracer. It caught 1 of 6 planted bugs and 2 of 15 known real-PR issues. Five of the six planted bugs were outside its correctness focus, and one real-PR catch was scored as a miss because it was anchored a file away from the label. It posted nothing on the clean fixtures and fell into none of the eight false-positive traps. That run is a baseline, not a gate.
- **Lanes run one at a time.** The method says to look at structure before chasing details. Today `up` and `down` run separately, and nothing enforces that order yet.
- **Deterministic findings aren't published on the OpenCode path,** apart from the integrity and credential scans. That job belongs to a `surface` lane that doesn't exist yet.
- **No spend cap in CI.** Cost is measured after the run, not limited during it.
- **Injection controls can't prove a review is complete.** They make some attacks visible. They don't show that a clean result means nothing was hidden.

The full record of decisions, including the ones we reversed, is in [`decisions.md`](https://github.com/99Yash/warden/blob/main/decisions.md).

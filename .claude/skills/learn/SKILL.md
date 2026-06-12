---
name: learn
description: Capture a durable lesson from this session into .lessons/ so future sessions don't repeat the mistake. Use after solving a non-obvious, costly, repeatable problem, or when the user says /learn.
user-invokable: true
args:
  - name: note
    description: Optional hint about what the lesson is. If omitted, infer it from the conversation.
    required: false
---

Capture one durable lesson into `.lessons/` so the recall hook surfaces it in future sessions.

## What qualifies (be strict — the index must stay skimmable)

Write a lesson ONLY when the thing learned is all three:

- **Non-obvious** — not derivable from reading the code, types, or docs in a minute.
- **Costly** — it burned real time/tokens this session, or would next time.
- **Repeatable** — likely to bite again in a future session.

Do NOT write: anything the repo already records (code, ADRs, CLAUDE.md), one-off facts, or session narrative (that's what `/handoff` and the journal are for). If it doesn't clear the bar, say so and stop — don't pad the index.

## Steps

1. **Dedup first.** Read `.lessons/INDEX.md` and scan existing titles. If a lesson already covers this, OPEN that file and UPDATE it (sharpen the fix, add a keyword/glob) instead of creating a near-duplicate.

2. **Get the date:** run `date -u +%Y-%m-%d`.

3. **Write `.lessons/<slug>.md`** (kebab-case slug from the title) in this exact format:

   ```markdown
   ---
   title: <imperative one-liner naming the gotcha>
   created: <YYYY-MM-DD>
   keywords: [lowercase, terms, error-strings, tool-or-package-names]
   globs: [file-patterns this applies to, e.g. app.json, metro.config.*, "**/*.expo.*"]
   symptom: <the observable failure that should make a future agent recall this>
   ---

   **Fix:** <the durable action that resolves or avoids it>

   **Why:** <root cause, briefly — so the lesson generalizes beyond the exact case>
   ```

   `keywords` and `globs` are the recall surface — pack them with the literal error strings, tool names, and file patterns a future agent would have in hand. `globs` can be empty if the lesson isn't file-specific.

4. **Update the index.** Add (or edit) one line in `.lessons/INDEX.md` under the lessons section:

   `- [<title>](.lessons/<slug>.md) — <short hook / symptom>`

   Keep it to one line. The index is loaded into every session, so the hook must let a future agent decide relevance at a glance.

5. Confirm to the user what was written or updated, in one line.

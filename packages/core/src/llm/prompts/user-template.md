# Diff under review

```diff
{{diff}}
```

# Tool findings (deterministic, pre-verified)

Each finding is identified by an `id`. To rewrite or drop one, reference it by id in `revisedComments`. Unmentioned ids are kept verbatim.

{{tool_findings}}

# Verified vulnerability advisories

These were produced by `npm audit` and verified against OSV.dev. Treat them as authoritative — same triage rules apply (rewrite for readability, drop only if clearly irrelevant).

{{verified_advisories}}

# Retrieved repository context

Code adjacent to the diff that may help you judge intent. Two kinds of evidence:

- **Adjacent files (with evidence)**: line ranges from files that import / are imported by / reference symbols in the diff. Cite by `path:line` when a claim leans on these.
- **Same-folder neighbors (paths only)**: awareness signal for files living next to the diff. No content is shown — you do not know what's in them, so do not claim things about them.

{{retrieved_context}}

# Your task

Apply the rules from your system prompt:

- Decide which tool findings to rewrite, drop, or leave alone.
- Emit clarification questions when the diff makes you uncertain about author intent.
- Respect the priority order. Apply the soft suppression rules with judgment.
- Output the JSON object per the schema in your system prompt.

Default-keep on tool findings: when in doubt, leave it alone.

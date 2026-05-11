<diff>
{{diff}}
</diff>

<tool-findings>
Each finding has an `id` attribute. To rewrite or drop one, reference it by id in `revisedComments`. Unmentioned ids are kept verbatim.

{{tool_findings}}
</tool-findings>

<verified-advisories>
Produced by `npm audit` and verified against OSV.dev. Treat them as authoritative — same triage rules apply (rewrite for readability, drop only if clearly irrelevant).

{{verified_advisories}}
</verified-advisories>

<retrieved-context>
Code adjacent to the diff that may help you judge intent. Two kinds of evidence:

- `<adjacent-files>` — `<chunk>` entries with content from files that import / are imported by / reference symbols in the diff. Cite by `path:line` when a claim leans on these.
- `<same-folder-neighbors>` — `<neighbor>` paths only. Awareness signal. No content is shown — you do not know what's in them, so do not claim things about them.

{{retrieved_context}}
</retrieved-context>

<the-task>
Apply the rules from your system prompt:

- Decide which tool findings to rewrite, drop, or leave alone.
- Emit clarification questions when the diff makes you uncertain about author intent.
- Respect the priority order. Apply the soft suppression rules with judgment.
- Output the JSON object per the schema in your system prompt.

Default-keep on tool findings: when in doubt, leave it alone.
</the-task>

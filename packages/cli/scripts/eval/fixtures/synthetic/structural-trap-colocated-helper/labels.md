# structural-trap-colocated-helper

ADR-0052 eval leg (ii), the misplacement anti-pattern: colocated code that
must **not** be moved to a tidier taxonomy that is farther from its use.
Synthetic. The diff holds every home of the bait: the new `src/export/csv.ts`,
and two edits that show `src/utils/strings.ts` whole (as hunk context) and its
second caller `src/reports/pdf.ts`.

The bait: the change moves the generic `slugify` into `src/utils/strings.ts`
(it now has two callers, the CSV and the PDF download) but keeps
`escapeCsvField` private in `csv.ts`. A reviewer that sorts by kind proposes
"move `escapeCsvField` to `utils` next to `slugify`" or "string helpers belong
in `utils/strings.ts`".

Why it is a trap: `escapeCsvField` is the RFC 4180 quoting rule of the CSV
format, and `toCsv` is its only caller. It changes when the CSV output
changes, so it belongs in the CSV module. `slugify` has two callers in two
formats, so its shared home is right. Moving the CSV rule to `utils` puts it
farther from its one use and adds a public helper that no other format
should call (colocation beats classification; gate B fails). The change is
otherwise clean: the PDF edit keeps its output byte for byte.

Scoring: an `expect: absent` label on the helper (line 10, so a comment on
lines 5–15 hits it). A comment on `toCsv` itself (line 17 and after) does not
hit it. Gate (f), any sample.

```yaml
id: csv-escape-must-stay-colocated
expect: absent
path: src/export/csv.ts
line: 10
description: [structural] [trap] misplacement anti-pattern. escapeCsvField is the CSV format's quoting rule with one caller (toCsv); moving it to utils/strings.ts beside the two-caller slugify is a tidier taxonomy farther from use.
```

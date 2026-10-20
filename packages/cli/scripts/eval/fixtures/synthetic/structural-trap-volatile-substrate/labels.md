# structural-trap-volatile-substrate

ADR-0052 eval leg (ii), the reinvention anti-pattern: a substrate primitive
deliberately **not** used because it is more volatile than the local code.
Synthetic, two new files, so the sparse tree holds the whole bait.

The bait: `formatReminderTime` builds "2:05 PM" by hand. The runtime has
`Intl.DateTimeFormat` and `Date.prototype.toLocaleTimeString` one call away,
so a reviewer that hunts reinvention proposes to replace the six lines with
`toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })`.

Why it is a trap: the primitive's output follows the runtime's ICU data, and
that output has changed between Node releases: ICU 72 (Node 20) put U+202F
(narrow no-break space) before "AM"/"PM". U+202F is not in the GSM-7
alphabet, so an SMS that contains it is sent as UCS-2 and splits into more
segments. The local code emits ASCII on every runtime. Coupling the SMS text
to ICU data couples it to a substrate detail that is more volatile than the
six lines it would replace (gate B fails). The code states the reason. The
change is otherwise clean: 12 AM and 12 PM map to 12, and the offset is the
client's offset at the appointment time.

Scoring: a path-only `expect: absent` label on the formatter file. Any
comment on it is a trap hit (gate (f), any sample).

```yaml
id: ascii-time-must-not-use-intl
expect: absent
path: src/sms/time.ts
description: [structural] [trap] reinvention anti-pattern. formatReminderTime avoids Intl/toLocaleTimeString on purpose; ICU 72 emits U+202F before AM/PM, which is not GSM-7 and turns the SMS into UCS-2.
```

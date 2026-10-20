# structural-trap-coincidental-duplication

ADR-0052 eval leg (ii), the repetition anti-pattern: coincidental duplication
that must **not** be DRYed. Synthetic, three new files, so the sparse tree
holds every home of the bait (a new file materializes whole).

The bait: `formatInvoiceNumber` and `formatTicketNumber` have the same shape,
a prefix and a 6-digit zero-padded sequence. A reviewer that counts shapes
proposes one `formatPrefixedNumber(prefix, n)` helper.

Why it is a trap: the two homes do not share a truth. The invoice format is
an external contract (the accounting system parses it; a change needs a new
export version). The ticket format is a display choice that the support team
can change at any time. They change for different reasons and at different
times, so a shared helper couples a parsed contract to a UI choice: gate B
("name the domain change under which they co-vary") fails. The change is
otherwise clean: an exhaustive switch over a discriminated union, no other
planted defect.

Scoring: path-only `expect: absent` labels. Any comment on either formatter
file is a trap hit (gate (f), any sample). The feed file is not a trap
anchor.

```yaml
id: invoice-format-must-not-be-dryed
expect: absent
path: src/billing/invoice-number.ts
description: [structural] [trap] repetition anti-pattern. The invoice number format is an accounting export contract; it only looks like the ticket format. Proposing a shared prefixed-number helper is coincidental-duplication DRY.
```

```yaml
id: ticket-format-must-not-be-dryed
expect: absent
path: src/support/ticket-number.ts
description: [structural] [trap] repetition anti-pattern. The ticket number format is a support display choice that changes on its own schedule; merging it with the invoice format is coincidental-duplication DRY.
```

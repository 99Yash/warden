# structural-trap-one-implementer

ADR-0052 eval leg (ii), the wrong-dependency-direction anti-pattern: a
one-implementer interface that must **not** be added "for flexibility".
Synthetic, two new files, so the sparse tree holds the whole bait.

The bait: `sendWelcomeEmail` in `accounts/` names the concrete `SmtpMailer`
class from `notify/`. A reviewer that applies dependency inversion by rule
proposes a `Mailer` interface (or a `MailTransport` port) in `accounts/` and
an adapter that implements it.

Why it is a trap: SMTP is the app's one transport, and no second one is
named. The function already depends only on the shape it uses
(`Pick<SmtpMailer, "send">`), so a test passes a fake without an interface.
A named interface with one implementer adds a file and an indirection and
de-risks no named change (gate A fails: "we might add a second transport" is
speculative generality). The change is otherwise clean.

Scoring: path-only `expect: absent` labels on both files. Any comment on
either file is a trap hit (gate (f), any sample).

```yaml
id: welcome-must-not-gain-mailer-interface
expect: absent
path: src/accounts/welcome.ts
description: [structural] [trap] wrong-direction anti-pattern. sendWelcomeEmail already depends on Pick<SmtpMailer, "send">; a Mailer interface or port with one implementer is speculative generality.
```

```yaml
id: smtp-mailer-must-not-gain-interface
expect: absent
path: src/notify/smtp-mailer.ts
description: [structural] [trap] wrong-direction anti-pattern. SmtpMailer is the one transport; extracting an interface for it "for flexibility" de-risks no named change.
```

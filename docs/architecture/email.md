# Email: SES events, bounces and complaints

As-built reference. Moved out of `CLAUDE.md` on 2026-09-30, when that file had grown to 170K characters; `CLAUDE.md` now keeps only the rules and a pointer here. Keep this file current in the same PR as the code it describes.

## Email bounces & complaints (#449)

The growth loop is email to hand-typed addresses, so typos are the norm. SES publishes what
happened to each message; the backend records it per address so a coach can be told.

```
mailer.send ──(ConfigurationSetName)──► SES ──► SNS ──► SQS ──► SesEventConsumer ──► User row
```

- **Both halves are switched by environment and are off when unset**: `SES_CONFIGURATION_SET`
  (`SesMailer` adds `ConfigurationSetName` to every send; a send without it publishes no events)
  and `SES_EVENTS_QUEUE_URL` (`index.ts` starts `createSesEventConsumer()` after `listen`; `null`
  when unset). Production sets both in `infra/task-definition.json`; the resources they name are
  in `infra/ses-events.tf`. Procedures, the apply order and the verification steps:
  [`docs/runbooks/email-deliverability.md`](../runbooks/email-deliverability.md).
- **`services/mailer/ses-events.ts`** turns one message into at most one write on
  `User.emailSuppressedAt` / `emailSuppressedReason` (`EmailSuppressionReason { BOUNCE, COMPLAINT }`,
  migration `20260927120000_user_email_suppression`):

  | Event | Effect |
  | --- | --- |
  | Bounce, `Permanent` | flag, reason `BOUNCE` |
  | Bounce, subtype `OnAccountSuppressionList` (a re-send to a suppressed address) | flag **only if unflagged** — it must not turn a recorded `COMPLAINT` into a `BOUNCE` |
  | Bounce, `Transient` / `Undetermined` | log only |
  | Complaint | flag, reason `COMPLAINT` |
  | Delivery | clear a flag **older than** the delivery (events are unordered) |
  | Reject | log only |
  | anything else | ignored |

- **Nothing in the app blocks a send.** SES's account-level suppression list is the gate: a send
  to a suppressed address is accepted, never delivered, and does not count toward
  `Reputation.BounceRate` (it does count toward the daily quota). State follows SES, so after an
  operator removes an address from the suppression list the next delivery clears the flag with no
  second step. Don't add an app-level "skip flagged addresses" check — it would make that
  self-heal impossible.
- **Address matching is two steps, on purpose.** `storedEmailsFor` searches with `emailEquals`
  (which already escapes the `ILIKE` wildcards, see "Email matching" in `roster-and-invitations.md`),
  compares exactly in code as a second check, then writes by the stored value
  (`email: { in: […] }`). The wildcard behaviour was first found here, by
  `tests/integration/email-suppression.db.test.ts`; a mocked test cannot see it.
- **Every write that changes or removes `User.email` spreads `EMAIL_SUPPRESSION_CLEARED`**
  (`utils/email-suppression.ts`): `PlayerService.updatePlayer` (the coach's recovery path — fix the
  address, then Resend), `syncUser`'s linked-user email change, the rejection strip in
  `invitation-service.ts`, and the account-deletion tombstone. A new write path onto `email` must
  do the same, or a corrected address is reported as bounced.
- **Who sees it:** `GET /teams/:id` roster rows carry both fields for callers with
  `canManageRoster` and are stripped with the email for everyone else. They are selected through
  `ROSTER_PLAYER_SELECT`, **not** `USER_SUMMARY_SELECT` — that one also feeds staff rows, which
  every team member reads.
- **`services/mailer/ses-event-consumer.ts`** long-polls the queue (20s, batches of 10). Handled
  and ignored messages are deleted; a handler failure **or a malformed body** is left alone, so it
  is redelivered and ends in the dead-letter queue intact. Receive failures back off 5s → 60s and
  report to Sentry once per outage (`flow: ses-event-consumer`). Every write is idempotent, so
  at-least-once delivery and a second replica are both safe. A queue rather than an SNS → HTTPS
  webhook because the API is one task: a webhook drops events during every deploy once SNS stops
  retrying, and needs a public route with signature verification.
- Log lines carry `toHashes` (`hashRecipient`), never an address; parse errors name the offending
  **paths**, never values.
- **Announcement email goes to the same audience as push** — players, staff and guardians of
  players, deduplicated, minus the author — through `utils/team-audience.ts#getTeamAudienceUserIds`,
  which `NotificationService.sendToTeam` uses too (before #449 email went to players only). Sends
  run **sequentially** in the background: with guardians a team is 30-45 messages, and a
  concurrent burst that size trips the SES per-second rate.
- **Reply email** (#34, `templates/announcement-reply.ts`) goes to the announcement's author only,
  from `AnnouncementReplyService.notifyAuthor`, after the push; skipped for a self-reply, when the
  author has `notifyOnReplies` off, or when the author is a tombstone. Metadata `event_type`
  `announcement.replied` with `teamId`, `announcementId`, `replyId`.
- Tests: `tests/services/ses-events.test.ts`, `tests/services/ses-event-consumer.test.ts`,
  `tests/integration/email-suppression.db.test.ts` (real Postgres), the `SES_CONFIGURATION_SET`
  block in `tests/services/mailer.test.ts`, the email-audience block in
  `tests/services/announcement-service.test.ts`, `tests/api/email-notifications.test.ts`.

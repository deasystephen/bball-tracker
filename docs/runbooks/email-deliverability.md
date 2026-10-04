# Email deliverability runbook

How Hooplings handles bounces and complaints, what to do when a deliverability alarm fires, and
the text to give AWS when requesting SES production access (#23).

Everything here is declared in [`infra/ses.tf`](../../infra/ses.tf),
[`infra/ses-events.tf`](../../infra/ses-events.tf) and
[`infra/alerting.tf`](../../infra/alerting.tf) (#449). Do not create or edit these resources in
the AWS console.

Mail that people read, at `hooplings.com` itself, is a separate path through Google Workspace
(#555): see [Mail at the apex](#mail-at-the-apex-google-workspace).

## At a glance

| Item | Value |
| --- | --- |
| Sender | `noreply@mail.hooplings.com`, SES v2, `us-east-1` |
| Reply-To | `support@hooplings.com` on every message (#450). The sender's domain has one MX, the SES bounce handler, so without it a reply reaches nobody. Every footer names the address and says that a reply goes to support, not to the coach |
| Identity | `mail.hooplings.com` — Easy DKIM (RSA-2048), custom MAIL FROM `bounce.mail.hooplings.com` (SPF aligned), DMARC `p=none` with reports to `dmarc@hooplings.com` |
| What is sent | Transactional only: team and guardian invitations, RSVP confirmations, team announcements, and reply notifications to an announcement's author (#34; opt-out via the Profile reply-notifications toggle, `User.notifyOnReplies`; send rules in `docs/architecture/email.md`, "Reply email"). No marketing. |
| Suppression | SES **account-level suppression list**, reasons `BOUNCE` and `COMPLAINT` |
| Configuration set | `bball-tracker-production-transactional` — named on every send |
| Events published | `BOUNCE`, `COMPLAINT`, `DELIVERY`, `REJECT` |
| Event path | SES → SNS `bball-tracker-production-ses-events` → SQS `bball-tracker-production-ses-events` → the API |
| Dead-letter queue | `bball-tracker-production-ses-events-dlq` (after 5 failed receives; 14-day retention) |
| Alarms | `ses-bounce-rate`, `ses-complaint-rate`, `ses-events-queue-stalled`, `ses-events-dlq-not-empty` → the alerts topic ([on-call runbook](on-call.md)) |
| Logs | Datadog US5, `service:bball-tracker-api`, messages starting `SES ` |

## How it works

```
coach types an address
        │
        ▼
API sends (ConfigurationSetName) ──► SES ──► recipient's mail server
                                      │
             Bounce / Complaint / Delivery / Reject
                                      ▼
                          SNS ──► SQS ──► API consumer ──► User row ──► roster row
```

1. **SES decides what is deliverable.** A hard bounce or a complaint puts the address on the
   account-level suppression list. From then on SES accepts a send to it, does not deliver it,
   and **does not count it toward the bounce rate** (it does count toward the daily quota). The
   application never blocks a send itself.
2. **The API records what SES reported**, per address, on the account that holds it
   (`User.emailSuppressedAt`, `emailSuppressedReason`):

   | SES event | Recorded |
   | --- | --- |
   | Permanent bounce | flagged, reason `BOUNCE` |
   | Complaint | flagged, reason `COMPLAINT` |
   | Delivery, newer than the flag | flag cleared |
   | Transient bounce (mailbox full, greylisting) | nothing; logged |
   | Reject (SES refused the content) | nothing; logged |

3. **The coach is told on the roster row** ("Email bounced" / "Email blocked", roster managers
   only) and corrects the address from the row's menu, **Fix email address**, which also sends
   the invitation again. Changing a player's email clears the flag, because the bounce belonged
   to the old address. App binaries that have not taken the update show no chip; the API state
   is the same either way.

Nothing is lost while the API is down or deploying: the queue holds events for 14 days and the
API catches up when it returns.

**Limits worth knowing:**

- **Gmail does not report complaints to SES.** A recipient who presses *Spam* in Gmail is not
  suppressed and produces no event. The complaint-rate alarm only sees providers that run a
  feedback loop.
- A **soft bounce is not recorded**. SES retries on its own; an address that keeps soft-bouncing
  eventually comes back as a permanent bounce.
- Addresses are never written to logs. Log lines carry `toHashes`: the first 12 hex characters of
  the SHA-256 of the lower-cased address. To find the lines for one address:
  ```bash
  printf '%s' 'someone@example.com' | tr '[:upper:]' '[:lower:]' | shasum -a 256 | cut -c1-12
  ```

## Bounce or complaint rate alarm

`ses-bounce-rate` (above 3%), `ses-complaint-rate` (above 0.1%)

AWS places the account **under review at 5% bounces or 0.1% complaints** and **pauses sending at
10% or 0.5%**. A paused account sends nothing: no invitations, no announcements.

1. **Read the account's standing.** `EnforcementStatus` other than `HEALTHY` means AWS has
   already acted; open the SES console's *Reputation metrics* page for the case details.
   ```bash
   aws sesv2 get-account --region us-east-1 \
     --query '{status:EnforcementStatus,sending:SendingEnabled,production:ProductionAccessEnabled,sentLast24h:SendQuota.SentLast24Hours}'
   ```
2. **Find where the bounces come from.** One team with a roster of mistyped addresses looks very
   different from bounces spread across every team. In Datadog:
   `service:bball-tracker-api "SES permanent bounce recorded"`, then match the `messageId` values
   against `"Email sent via SES"` lines, which carry `event_type` and the send's metadata:
   `invitation.created`, `guardian_invitation.created`, `announcement.created` and
   `announcement.replied` carry `teamId` (replies also `announcementId` and `replyId`);
   `rsvp.upserted` carries `gameId` and `rsvpStatus` instead, so attribute an RSVP bounce to a
   team through the game (`SELECT "teamId" FROM "Game" WHERE id = '<gameId>'`, or the game's
   detail screen). The sources are the `metadata` objects passed to `mailer.send` in
   `backend/src/services/`.
3. **Stop the source, not the service.** Bounced addresses are already suppressed, so the rate
   recovers as normal mail is delivered. If one team keeps adding bad addresses, contact its
   coach. If the volume looks automated (many invitations from one account within minutes), treat
   it as abuse and review that account's `POST /teams/:teamId/players` and
   `POST /teams/:teamId/invitations` requests in Datadog. There is no operator tool to suspend an
   account. The brakes are automatic (#715): `inviteRateLimit` caps one account at 60 of those
   requests an hour (429 `Too many invitations sent`), and a Resend to the same player within 2
   minutes of the previous invitation is refused (429 `resend_cooldown`, logged as
   `Invitation resend refused (cooldown)`). An account repeatedly hitting either shows up as
   `HTTP request` lines with `statusCode:429` and its `userId`.

If the account is under review, answer the AWS case with the facts in
[What to tell AWS](#what-to-tell-aws) and what was done in step 3. Do not request a limit
increase while a review is open.

These two alarms use `ignore` for missing data: SES publishes a reputation datapoint only around a
send, so a quiet hour must not turn `ALARM` back into `OK`. The alarm clears when SES next reports
a rate under the threshold.

## Events are not being processed

`ses-events-queue-stalled` (oldest message older than 15 minutes), `ses-events-dlq-not-empty`

Mail is still being sent and SES is still suppressing. What stops is the record: no new bounce
reaches a roster until this is fixed. Nothing is lost for 14 days.

1. **Is the consumer running?** The API logs `SES event consumer started` at boot, only when
   `SES_EVENTS_QUEUE_URL` is set in `infra/task-definition.json`. Repeated
   `SES event queue poll failed` lines give the reason — `AccessDenied` means the task role lost
   the `ses-events-consume` policy, `NonExistentQueue` means the URL and the queue disagree.
   ```bash
   aws logs tail /ecs/bball-tracker-production --since 30m --filter-pattern '"SES event"'
   ```
2. **How much is waiting, and where?**
   ```bash
   cd infra
   for q in ses_events_queue_url ses_events_dlq_url; do
     aws sqs get-queue-attributes --queue-url "$(terraform output -raw $q)" \
       --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible \
       --query 'Attributes'
   done
   ```
3. **Dead-letter queue: read the message before doing anything else.** The log line
   `SES event could not be processed` says whether it was `malformed: true` (SES sent a shape the
   parser does not accept — a code change) or `malformed: false` (the database write failed —
   usually an outage that has since ended).
   ```bash
   aws sqs receive-message --queue-url "$(terraform output -raw ses_events_dlq_url)" \
     --max-number-of-messages 10 --visibility-timeout 0
   ```
   The body contains recipient addresses: do not paste it into an issue or a chat.
   - **Database failure that is over:** move the messages back. They are re-applied safely; every
     write is idempotent.
     ```bash
     aws sqs start-message-move-task \
       --source-arn "$(aws sqs get-queue-attributes --queue-url "$(terraform output -raw ses_events_dlq_url)" \
         --attribute-names QueueArn --query Attributes.QueueArn --output text)"
     ```
   - **Malformed:** fix the parser (`backend/src/services/mailer/ses-events.ts`), deploy, then move
     the messages back. `ses-events-dlq-not-empty` stays in `ALARM` until the queue is empty.

## A coach says a flagged address is correct

The roster shows an address as bounced, and the coach has confirmed with the family that it is
right (a mailbox that did not exist yet, a provider outage that returned a permanent error).

This is the one case the coach cannot fix from the app: "Fix email address" only accepts a
different address.

1. **Confirm it is suppressed, and why.**
   ```bash
   aws sesv2 get-suppressed-destination --region us-east-1 --email-address '<address>'
   ```
2. **Remove it from the suppression list.** Use the exact case SES lists it under.
   ```bash
   aws sesv2 delete-suppressed-destination --region us-east-1 --email-address '<address>'
   ```
3. **Ask the coach to press Resend.** When the message is delivered, the delivery event clears
   the flag on the roster. There is no database step. A Resend within 2 minutes of the previous
   invitation to that player is refused with "Try again in N seconds" (#715); waiting is the fix.

If it bounces again, the address is wrong; the coach needs a different one. If the reason was
`COMPLAINT`, do not remove it: that person asked not to receive the mail.

## Applying and verifying

Terraform is applied by hand from `infra/` — **apply first, then merge** (see
[on-call runbook](on-call.md#applying-and-verifying-one-time-and-after-any-change)). The order
matters here more than usual:

| Order | Step | Why |
| --- | --- | --- |
| 1 | The backend code that reads the two variables is deployed | Unset variables change nothing |
| 2 | `terraform apply` | Creates the configuration set, queue and IAM |
| 3 | Merge the change that sets `SES_CONFIGURATION_SET` and `SES_EVENTS_QUEUE_URL` | Deploying these **before** step 2 makes every send fail: SES rejects an unknown configuration set, and a send that names one is authorized against its ARN |

After the deploy:

1. **The consumer started.**
   ```bash
   aws logs tail /ecs/bball-tracker-production --since 15m --filter-pattern '"SES event consumer started"'
   ```
2. **A bounce travels the whole path.** Use the SES mailbox simulator; it never affects the
   account's reputation and never suppresses anything. As a coach, on a team used for testing,
   add a player with the email `bounce@simulator.amazonses.com`. Within a minute:
   - the log shows `SES permanent bounce recorded` with `matched: 1`;
   - the roster row shows the "Email bounced" chip after a refresh (`GET /teams/:id` returns
     `emailSuppressedReason: "BOUNCE"` for that player).

   Remove the player afterwards.
3. **The same from the command line**, which proves SES → SNS → SQS → API but matches no account
   (`matched: 0`):
   ```bash
   aws sesv2 send-email --region us-east-1 \
     --from-email-address noreply@mail.hooplings.com \
     --destination 'ToAddresses=bounce@simulator.amazonses.com' \
     --configuration-set-name bball-tracker-production-transactional \
     --content 'Simple={Subject={Data=Bounce test},Body={Text={Data=Bounce test}}}'
   ```
   `complaint@simulator.amazonses.com` and `success@simulator.amazonses.com` exercise the other
   two events. **Never generate a real bounce against a real domain to test this.**
4. **The alarms settled.** `ses-bounce-rate` and `ses-complaint-rate` read `INSUFFICIENT_DATA`
   until the first send after the apply, then `OK`. The two queue alarms read `OK`.
   ```bash
   aws cloudwatch describe-alarms --alarm-name-prefix bball-tracker-production-ses- \
     --query 'MetricAlarms[].[AlarmName,StateValue]' --output table
   ```

## DMARC

`_dmarc.hooplings.com` and `_dmarc.mail.hooplings.com` both read
`v=DMARC1; p=none; rua=mailto:dmarc@hooplings.com`: monitor only, with the aggregate reports
sent to `dmarc@hooplings.com`. The policy is `local.dmarc_policy` in
[`infra/workspace.tf`](../../infra/workspace.tf), one value for both records.

| Step | Owner | State |
| --- | --- | --- |
| The `rua` tag on both DMARC records | #555 (Google Workspace on `hooplings.com`) | done, applied 2026-09-29 |
| Tighten to `p=quarantine`, after about 30 days of reports show only aligned mail | #555, step 5 | not started; earliest 2026-10-29 |

Every source in the reports must be one of ours (Google Workspace for `hooplings.com`, Amazon
SES for `mail.hooplings.com`) and must pass DKIM or SPF **aligned**.

Do not tighten the policy without the reports: `p=quarantine` on a domain with an unknown
legitimate sender sends that sender's mail to spam.

## Mail at the apex: Google Workspace

People read mail at `hooplings.com` through Google Workspace (#555). The DNS records are in
[`infra/workspace.tf`](../../infra/workspace.tf); the account, its one seat and the addresses
are set in the Google admin console.

| Name | Sender | SPF | DKIM | DMARC record |
| --- | --- | --- | --- | --- |
| `hooplings.com` | Google Workspace | `include:_spf.google.com` | `google._domainkey.hooplings.com` | `_dmarc.hooplings.com` |
| `mail.hooplings.com` | Amazon SES | `include:amazonses.com`, at `bounce.mail.hooplings.com` | three Easy DKIM CNAMEs | `_dmarc.mail.hooplings.com` |

Keep the two on separate names. SES does not belong in the apex SPF and Google does not belong
on the `mail.` subdomain: separate names keep the DMARC alignment of one path independent of
the other.

### Addresses

All four are aliases or groups on the one paid seat, not extra users.

| Address | Purpose |
| --- | --- |
| `support@hooplings.com` | User support, and the public contact for the App Store listing (#450, #451) |
| `privacy@hooplings.com` | Privacy policy contact and data-subject requests (#25, [data-subject requests](data-subject-requests.md)) |
| `alerts@hooplings.com` | Production alerts |
| `dmarc@hooplings.com` | DMARC aggregate reports, named by the `rua` tag of both DMARC records |

A group rejects mail from outside the organization unless it is set to accept it. After
creating or changing an address, send it a message from an outside account.

### Do not move these to `hooplings.com`

These accounts stay on an address outside the domain, on purpose. Do not tidy them up.

| Account | Why it stays |
| --- | --- |
| AWS root account email | The domain is registered and its DNS is hosted in this AWS account. If the account is locked or the zone breaks, mail to `@hooplings.com` stops, and that is where the password reset would be sent. |
| Google Workspace admin recovery address | Same dependency: the recovery message for the Workspace account cannot go to a mailbox inside it. |
| Apple ID, GitHub and Expo owner logins | A recovery identity must not depend on the infrastructure it recovers. |
| The application ADMIN login | Email is the login identity in the app (`syncUser` links by email) and the admin allowlist keys on it. Changing it is an account migration, not a forwarding change. |

## What to tell AWS

For the SES production-access request (#23). AWS asks how bounces and complaints are handled;
these are the answers, and each one is a resource in this repository.

> **Use case.** Hooplings is a youth basketball team management app. It sends transactional email
> only: invitations to join a team, invitations for a parent or guardian to follow a player,
> RSVP confirmations, announcements from a coach to the team, and a notification to the author of
> an announcement when a team member replies to it (the author can turn these off in the app).
> There is no marketing email and
> no purchased or imported list. Every recipient address is entered by a team's coach for a named
> player or parent, or belongs to a user who signed up.
>
> **Bounces.** Every message is sent through a configuration set that publishes bounce,
> complaint, delivery and reject events to Amazon SNS, delivered to an SQS queue that the
> application consumes. The account-level suppression list is enabled for bounces and complaints,
> so an address that hard-bounces is never sent to again. The application records the bounce
> against the address and shows it to the coach who entered it, so the address is corrected
> rather than retried.
>
> **Complaints.** A complaint suppresses the address through the same list and is recorded the
> same way. We do not remove a complaint suppression on request of the sender.
>
> **Monitoring.** Amazon CloudWatch alarms notify us when the account bounce rate exceeds 3% or
> the complaint rate exceeds 0.1%, below the thresholds at which SES reviews an account. Further
> alarms cover the event queue, so a failure to process events is itself detected.
>
> **Authentication.** The sending domain uses Easy DKIM with 2048-bit keys, a custom MAIL FROM
> domain so SPF aligns, and a DMARC record.
>
> **Volume.** Expected volume is low: a team of about 15 players produces 15 to 45 invitations
> when its roster is created, a few announcements a week, and a handful of reply notifications
> per announcement thread.

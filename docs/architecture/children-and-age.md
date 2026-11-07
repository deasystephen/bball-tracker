# Children, age and COPPA (as built)

As-built reference for the adults-only-accounts posture (#980) and its enforcement points. Keep this file current in the same PR as the code it describes. The legal analysis with its sources is a dated snapshot linked from #980; this file records what the product does.

## The posture (owner decision 2026-10-26, confirmed 2026-11-07)

Hooplings is a **general-audience** service. **Account holders must be 13 or older; 16 in the EU, the EEA, the UK and Switzerland.** A player under that age is a **roster record** that a coach or a parent/guardian enters and maintains (`User.isManaged = true`, no `workosUserId`; `docs/architecture/roster-and-invitations.md`, `docs/architecture/guardians.md`), never a login. There is no verifiable-parental-consent program and no "Kids" store category.

Why this keeps the service outside the US Children's Online Privacy Protection Rule (16 CFR Part 312, as amended with a 2026-04-22 compliance date): the Rule reaches services directed to children, and general-audience services with **actual knowledge** that they collect personal information **from** a child under 13. Information an adult enters **about** a child (a name on a roster, a photo a coach uploads) is not collected from the child (FTC COPPA FAQ A.8 and F.4). The posture holds only while nobody under 13 holds a login, so the enforcement points below exist to make that true and to undo it fast when it is not.

What is deliberately **not** stored anywhere: a date of birth, an age, or an age bracket for any person. The only age-related column is `User.ageConfirmedAt`, the moment an account holder's answer met the minimum.

## Enforcement points

| Where | What it does | Code |
| --- | --- | --- |
| **Age screen at first sign-in** (#981) | Every new account (and, since the column arrived, every existing one once) answers a neutral birth month and year before reaching anything else. Old enough → `ageConfirmedAt` set. Under the minimum → the sign-in is undone (below) and the session ends. | `mobile/app/onboarding/age.tsx`, `POST /auth/age-confirmation` in `backend/src/api/auth/routes.ts`, `AccountService.confirmAge` / `refuseUnderage` |
| **API gate** (#981) | While `ageConfirmedAt` is null, `authenticate` answers every route 403 `age_confirmation_required` except `GET /auth/me`, `POST /auth/age-confirmation`, `POST /auth/logout`, `DELETE /auth/me` and `DELETE /auth/push-token` (`AGE_GATE_EXEMPT`). The Socket.io handshake refuses the same accounts. `AGE_GATE_ENFORCED=false` in the task definition relaxes the gate while the OTA that carries the screen reaches devices; unset means enforced. | `backend/src/api/auth/middleware.ts#assertAgeConfirmed`, `backend/src/websocket/game-events.ts#socketUserAllowed`, `infra/task-definition.json` |
| **Add Player steer** (#982) | "Is this player 13 or older?" before the player-email field; **No** removes the player email and requires a parent email, so the child stays a managed record and the parent gets the PARENT account. Client-side only; the answer is never sent. | `mobile/app/teams/[id]/players.tsx`, `mobile/utils/age-group.ts` |
| **Operator path** (#983) | When we learn after the fact that an account holder is under 13, the runbook converts the account back to a managed record or deletes it within 5 business days, deletes the WorkOS user and files the vendor deletions. | `docs/runbooks/data-subject-requests.md`, "We learned an account holder is under 13"; `backend/scripts/convert-to-managed.ts` |
| **Terms and privacy policy** (#25) | Accounts 13+ (16 EU/EEA/UK/CH); whoever enters a minor's information warrants they are the parent or guardian or have consent; the children's section states the posture and how a parent deletes a record. | `web/app/terms/page.tsx`, `web/app/privacy/page.tsx` (draft until counsel reviews) |
| **Store metadata** (#451) | Not the Kids Category, "Made for Kids" = No, age rating from Apple's content questionnaire, "data collected from children" = No once the gate is in the submission build. | `docs/release/app-store-submission.md` §2 and §4 |

## The age screen (#981)

**Neutral, in the FTC's sense (FAQ H.3, D.7).** Free entry of the birth month (twelve pills) and year (a four-digit field), no default, no drop-down that starts at 13, no text that names a minimum on the question. A confirmation step repeats the entered month and year ("Born in March 1990?") so a typo cannot end an account; it names no age either. There is no way back: the onboarding stack has `gestureEnabled: false` for the screen, a hardware back returns to the question, and `useAuthRedirect` replaces any other route with the screen while the stored user says `ageConfirmed: false`.

**Threshold.** `backend/src/utils/minimum-age.ts`: 13, or 16 when the device's region setting (`expo-localization` `regionCode`, sent as `regionCode` with the answer and stored nowhere) is an EU or EEA state, the UK or its dependencies, or Switzerland (`SIXTEEN_PLUS_REGIONS`). One figure for the whole GDPR area is deliberate: Article 8 lets member states set 13 to 16 and no state may set higher, the UK's statutory age is 13, and Switzerland has no fixed age, so 16 is conservative everywhere and wrong nowhere. The age is counted in whole years from the birth month, UTC, with the birth month counted as reached on its first day (someone born in March 2013 is 13 from 1 March 2026); the day is never asked.

**Old enough.** `AccountService.confirmAge` sets `ageConfirmedAt` (idempotent) and logs `Age confirmed` with the user id. The mobile store flips `user.ageConfirmed`, fires the `identifyUser` and `user_logged_in` it held back at sign-in (`completeAgeConfirmation`), then `age_confirmed` (no properties), and the usual post-login route follows (role step, name prompt, pending deep link).

**Under the minimum.** `AccountService.refuseUnderage`, in one transaction with the row locked:

- a player account on a roster (no adult signals, `assertPlayerAccount`) is **un-claimed** back into a managed record (`unclaimManagedRow`, shared with the operator conversion): login, email, verified flag, photo (unless the team uploaded it), push and calendar tokens, pending invitations, the child's announcement replies and `ageConfirmedAt` go; the name, roster rows, events, stats and guardian links stay; `managedById` is the one head coach of the player's active-season teams, or null when none qualifies (an ADMIN can still edit the record);
- anything else (no roster, or adult signals such as a staff role or a created team) is **deleted** through `deleteAccount` in `self` mode: erased outright when nothing references the row, tombstoned otherwise;
- a **sole head coach of an active-season team** cannot be deleted automatically. The session is revoked, the row stays gated, the outcome is logged at error and sent to Sentry (`flow: age-refusal`), and an operator finishes by the runbook (`pending_operator`).

After commit the WorkOS user is deleted (a 404 counts as gone; on failure every session is revoked and `identityDeleted: false` is logged), and the cleared photo's S3 object is removed. The route answers the same 403 `under_minimum_age` whatever happened, and the request logger sees only the path: the answer never reaches a log line, a column or an analytics event (tests pin all three). The mobile screen explains the rule and Done calls `clearSession('age_refused')`, which resets the Amplitude identity and records no `user_logged_out`.

**Why no device-level "cookie".** The FTC recommends a cookie so a visitor cannot back-button and retry. Here the account itself is the record: an under-age answer deletes the WorkOS user, so a retry needs a new sign-up with a new identity. A device flag was considered and rejected: on a shared family tablet it would refuse (and erase) a parent's account after a child's answer. Counsel should confirm this reading.

**Rollout.** Existing accounts are asked once on their next launch (owner decision 2026-11-07, no backfill). The API ships with `AGE_GATE_ENFORCED=false`, the OTA with the screen is published, and a follow-up PR flips the flag once the OTA has reached devices; a client without the screen would otherwise fail every request. Build #34 (runtime 1.6.0) and earlier never receive the screen and are locked out once the gate is enforced, which is acceptable for TestFlight testers.

## Analytics before the age screen

Amplitude initialises at launch, so `app_opened` and `screen_viewed` (route patterns only) fire on an anonymous device id before anyone signs in, and `sign_in_started` / `sign_in_failed` too. Nothing user-identifying is sent until `completeAgeConfirmation`. The pre-screen identifiers are persistent identifiers used only for "support for the internal operations" (16 CFR 312.2, 312.5(c)(7); FTC FAQ J.7 counts analytics of the service's own functioning), which is the Rule's own carve-out for collection before age is known; the IP-derived location stays at city level (FAQ G.3). Sentry sends no user id from the app at all.

## State app-store and age-assurance laws (#984)

Independent of COPPA, several US states route age through the stores and the operating system. Decided 2026-11-07: the in-app age screen is the enforcement at GA; Apple's **Declared Age Range API** (`com.apple.developer.declared-age-range`, a native entitlement, iOS 26+) is adopted in the first post-GA binary. Two dates bind that follow-up:

- **California AB 1043** (as amended by AB 1856), operative **2027-01-01**: a developer **must request** the OS age signal when the app is downloaded and launched, for already-installed apps by 2027-07-01, must treat it as the primary age indicator, is deemed to have actual knowledge of the bracket it receives, and may not nudge the user to change their age or share the signal. An under-13 bracket must produce the age screen's under-minimum outcome without asking the question.
- **Texas SB 2420** is in force (Fifth Circuit stay of the injunction, June 2026; Supreme Court declined to vacate, July 2026): developers assign an age rating to the app and every in-app purchase, consume the store's age and consent signal, use it only for age restrictions, compliance and safety, and delete it after use. Utah (May 2027), Louisiana (July 2027) and Alabama (January 2027) follow the same shape with their own dates.

The follow-up issue carries the build plan; `docs/release/app-store-submission.md` carries the store-metadata answers.

## Tests that pin this

- Backend: `tests/utils/minimum-age.test.ts`, `tests/schemas/age-confirmation.test.ts`, `tests/api/age-confirmation.test.ts` (route, gate, exemptions, flag, no answer in any log line), `tests/middleware/auth.test.ts` (the gate), `tests/websocket/game-events.test.ts` (the socket gate), `tests/integration/age-refusal.db.test.ts` (every under-age branch against Postgres).
- Mobile: `__tests__/app/onboarding-age.test.tsx` (real i18n, both outcomes, no answer in analytics), `__tests__/utils/age-gate.test.ts`, `__tests__/utils/role-onboarding.test.ts`, `__tests__/hooks/useAuthRedirect.test.ts`, `__tests__/store/auth-store.test.ts` (deferred sign-in analytics). Maestro: `.maestro/age-gate.yaml` with the two seeded fixtures in `backend/tests/support/flow-fixtures.ts#AGE_GATE_FIXTURES`.

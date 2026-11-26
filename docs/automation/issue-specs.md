# Issue specs: how a work item is written

GitHub issues are the only store for work that is left to do (`CLAUDE.md`, Work Hygiene).
An issue is also the whole brief for an agent that picks it up with no conversation behind
it, so the body has to stand on its own. This file is the format; the templates in
`.github/ISSUE_TEMPLATE/` (`work-item.md`, `bug_report.md`) are the same headings as a
skeleton.

`gh issue create --body` does not apply a template. A session that files an issue from the
command line reads the template file and fills the same headings.

## Sections

| Section | What it holds |
| --- | --- |
| Header line | `**Kind:** … · **Area:** … · **Needs:** …`. `Needs` names anything the work cannot proceed without: credentials, a device, a design decision, production access, or "nothing external" |
| Context (self-contained) | Why the issue exists and what is true today, with file paths and line numbers. Quote a decision made elsewhere; never "as discussed" |
| Deliverable | What changes, as a short list, naming the files or directories |
| Acceptance criteria | A checklist. Each box is one observable outcome that a command, a named test or a named Maestro flow can check. A bug carries a regression test that fails before the fix |
| Verification | The `Verifiable by` line and the commands that prove the criteria |
| Out of scope | What a reasonable reader might add and must not, with the issue that owns it |
| Working notes for an unassisted agent | Traps, prior art, ordering constraints, paths that must not change |

A bug report replaces Context and Deliverable with What happens, Repro and Cause or fix
direction. Write "unknown" for a cause that is not established.

One issue is one PR. Split an issue whose criteria cannot all land in one reviewable change.

## Verifiable by

The `Verifiable by` line says what it takes to know the work is done:

| Value | Meaning |
| --- | --- |
| CI alone | Every criterion is proven by the required checks on the PR (Jest, Vitest, lint, type-check, `expo export`, the migration guard) |
| a local Maestro flow | A criterion needs a named flow in `.maestro/`. Flows are manual and are not in CI (`docs/testing/maestro.md`) |
| a device | A native change, a new runtime or anything Jest, `expo export` and Maestro cannot see |
| production access | AWS, WorkOS, App Store Connect, EAS, DNS or another live system |

## Labels

- `agent-ready`: the body follows this format, `Needs` is "nothing external", `Verifiable by`
  is "CI alone", and the work stays out of `infra/`, native mobile config and migrations
  already on `main`. An unattended run may pick it up.
- `needs-human`: anything else that has a blocker a person must clear (credentials, a design
  or scoping decision, a device check, a `terraform apply`). Say which in `Needs`.
- An issue with neither label has not been triaged for delegation. Do not assume it is safe
  to run unattended.
- Area labels (`backend`, `mobile`, `infra`; there is no `web` label) and `bug`, `automation`, `ga-blocker`
  are applied as before.

A session that finds an `agent-ready` issue is not self-contained, or cannot be verified by
CI alone, removes the label and comments with what is missing; it does not guess.

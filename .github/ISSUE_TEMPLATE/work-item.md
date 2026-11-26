---
name: Work item
about: A feature, task or refactor, written so an agent with no other context can build it
title: ''
labels: ''
assignees: ''
---

<!-- Format and labelling rules: docs/automation/issue-specs.md. Delete these comments before saving. -->

**Kind:** feature | task | refactor | docs · **Area:** backend | mobile | web | infra (`path/to/the/main/file`) · **Needs:** nothing external | credentials | a device | a design decision | production access

## Context (self-contained)

<!-- Why this exists and what is true today, with file paths and line numbers.
     The reader has only this issue and the repo: quote anything decided
     elsewhere, never "as discussed" or "per the plan". -->

## Deliverable

<!-- What changes, as a short list. Name the files or directories to touch. -->

-

## Acceptance criteria

<!-- One observable outcome per box. Each must be checkable by a command, a named
     test or a named Maestro flow; say which. "Works correctly" is not a criterion. -->

- [ ]
- [ ] Docs updated: `docs/…` (or "none needed", with the reason)

## Verification

**Verifiable by:** CI alone | a local Maestro flow | a device | production access

<!-- The commands that prove it, for example:
     cd backend && npm test -- --testPathPattern="game"
     Anything other than "CI alone" makes the issue `needs-human` at the PR gate. -->

## Out of scope

<!-- What a reasonable reader might add and must not. Link the issue that owns it, if any. -->

-

## Working notes for an unassisted agent

<!-- Traps, prior art to copy, ordering constraints, paths that must not change
     (migrations already on main, mobile/binary-manifest.json, native config). -->

-

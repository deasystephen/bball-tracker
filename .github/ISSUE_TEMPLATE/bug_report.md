---
name: Bug report
about: Something behaves wrongly, written so an agent with no other context can fix it
title: ''
labels: bug
assignees: ''
---

<!-- Format and labelling rules: docs/automation/issue-specs.md. Delete these comments before saving. -->

**Kind:** bug · **Area:** backend | mobile | web | infra (`path/to/the/suspect/file`) · **Needs:** nothing external | credentials | a device | a design decision | production access

## What happens

<!-- Observed behaviour and expected behaviour, one or two sentences each. -->

## Repro

<!-- Numbered steps from a known state (a seeded database, a named seed user).
     Include the exact error text, and the Sentry or Datadog link if there is one. -->

1.

**Seen on:** <!-- commit or `/health` commit, TestFlight build and OTA group, iOS or Android version -->

## Cause or fix direction

<!-- What is known, with file paths and line numbers. Write "unknown" if it is;
     a guess presented as a finding sends the fix the wrong way. -->

## Acceptance criteria

<!-- One observable outcome per box, each checkable by a command, a named test or
     a named Maestro flow. Include the regression test that fails before the fix. -->

- [ ] A test fails before the fix and passes after: `path/to/test`
- [ ]

## Verification

**Verifiable by:** CI alone | a local Maestro flow | a device | production access

<!-- The commands that prove it. Anything other than "CI alone" makes the issue
     `needs-human` at the PR gate. -->

## Out of scope

-

## Working notes for an unassisted agent

<!-- Traps, related issues, paths that must not change. -->

-

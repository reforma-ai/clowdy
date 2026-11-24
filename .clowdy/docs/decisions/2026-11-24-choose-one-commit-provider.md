# Choose one provider for commit messages

- Status: accepted
- Date: 2026-11-24
- Decided by: user (semi-manual)
- Scope: commit message generation in Source Control
- Related tasks: CLO-99
- Supersedes: none
- Superseded by: none

## Context

Independent switches for Codex and Claude Code made the provider ambiguous when both were on. With neither available, the commit form hid Generate.

## Decision

Settings > Source Control offers Off, Codex, or Claude Code. Generate opens Source Control when the selected provider cannot run. Generation uses the selected provider and reports its failures directly.

## Reason

One selector shows which provider gets the selected changes. The daemon can save that choice atomically in its existing settings file. Older profiles with both switches on resolve to Codex, the previous first choice.

## Consequences

New profiles start at Off. Changing the choice stops queued generation from starting with the old provider. A request that has already started can finish.

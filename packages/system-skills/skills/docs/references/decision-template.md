# Decision record template

One shape for every record in `decisions/`, whoever decides (autopilot or the grill in semi-manual). One significant decision per file: `decisions/<YYYY-MM-DD>-<slug>.md`, in the project's main checkout. The slug is at most five kebab-case words and names the decision, not the topic: `keep-cookie-sessions-for-google-login`, not `auth`.

```markdown
# <The decision as a short statement>

- Status: accepted
- Date: 2026-11-17
- Decided by: autopilot
- Scope: <what this covers, in which areas, and what it does not cover>
- Related tasks: <CLW-12, CLW-14>
- Supersedes: none
- Superseded by: none

## Context
<Facts that forced the choice. Cite code paths, documents, task keys. 2 to 5 lines.>

## Options considered
1. <Option>: <what it is>. For: <...>. Against: <...>.
2. <Option>: ...
3. <Do nothing, or the smallest change>: ...

## Decision
<What we do, in one or two sentences.>

## Reason
- Fit: <how it matches existing code and records>
- Reversibility: <how to undo it and what that costs>
- Cost: <effort, dependencies, running cost, risk to other work>

## Consequences
<What gets easier, what gets harder, what to watch. The trigger that should reopen this decision.>

## Assumptions
<Only when the decision rests on something unverified. One checkable line each. Delete the section otherwise.>
```

## Fill it in

- Before writing, list `decisions/` and read any record on the same topic. If one still holds, follow it and write nothing. If your file name is taken, add `-2`.
- `Status` is `accepted` or `superseded`. Write the record after the choice is made, so there is no `proposed` state.
- `Decided by` is `autopilot`, `user (semi-manual)` or `user (delegated)`. The last two come from the grill in clowdy:semi-manual. A record decided by the user binds every later run until the user says otherwise: an agent may not supersede it.
- Date from `date +%F`, not from memory. Keep it under about 40 lines. State what is true, what you assumed and what you chose in separate places.
- `Supersedes` and `Superseded by` hold a relative link to the other file, for example `[Hosted database](2026-11-17-hosted-db.md)`, or `none`. How to supersede: clowdy:docs, section "Decisions".
- Prose in the language of the project's documents; file names and field labels stay in English. No secrets, no pasted logs: summarize and name the file or command.
- Add the record's line to `index.md` once it is written (clowdy:docs).

## Example for a stack choice

```markdown
# Build the bakery site as a TypeScript web app with SQLite

- Status: accepted
- Date: 2026-11-17
- Decided by: autopilot
- Scope: Stack for the first milestone. Not hosting.
- Related tasks: CLW-1
- Supersedes: none
- Superseded by: none

## Context
The brief is a page where customers order cakes and the owner sees orders. No stack named. Bun and Node are installed (`bun --version`, `node --version`, checked 2026-11-17). No hosting account exists.

## Options considered
1. TypeScript web app, one codebase, SQLite file. For: one language, runs locally, agents can test it end to end. Against: SQLite limits scaling to several servers.
2. Separate front end and hosted database. For: scales. Against: needs accounts and keys before anything runs.
3. No-code form tool. For: no code. Against: the owner's order list and slots do not fit.

## Decision
Option 1.

## Reason
- Fit: nothing exists to match, so the user's tools come first (none stated), then the simplest.
- Reversibility: queries stay in one folder; moving to a hosted database replaces that folder.
- Cost: no accounts, no running cost.

## Consequences
Deployment is a later task. Reopen if more than one shop or server is needed.

## Assumptions
- One shop, fewer than 100 orders a day (from the brief; unverified).
```

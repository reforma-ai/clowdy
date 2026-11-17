# product.md and architecture.md templates

Both files separate what exists from what is intended (see the four labels in clowdy:docs). Copy the shape, delete sections that have nothing to say, never fill a section with guesses.

## product.md

````markdown
# <Product name>

## In one sentence
<What it is and who it helps. Plain words, no stack.>

## Who uses it
| User | What they want done |
| --- | --- |
| Customer | Order a cake and pick a pick-up time without calling the shop |
| Shop owner | See today's orders in one list |

## Current milestone
Outcome: <what a person can do when this milestone is reached>.

How to check it:
1. <Step a person or a script can run>
2. <Next step>
3. Expected: <what they see>

## Implemented
Verified behavior only, in the user's terms. Each line: what, since when, which check.
- Customers can pick a cake and a pick-up slot (2026-11-20, [check](checks/2026-11-20-ordering-flow.md)).

## Plan
Decided and not built yet. Task keys in brackets.
- Owner can mark an order as ready (CLW-7).

## Not now
Things that were considered and deliberately left out, with the reason in a few words.
- Online payment: the shop takes cash at pick-up.

## Hypotheses and open questions
Each with how to settle it.
- Most orders come from phones. Check: ask the owner, or add basic visit counts.
````

Rules:

- `Implemented` is what a person sees, not what the code contains. It changes only after a check.
- Keep it to one page. Detail goes in its own document and is linked.
- The product statement and the first milestone come from the user's brief, in the user's words.

## architecture.md

````markdown
# Architecture

## Summary
<Three or four sentences: the shape of the system and the main reason for the stack.>

## Stack
| Part | Choice | Why |
| --- | --- | --- |
| Language and runtime | TypeScript on Bun | Matches the user's team; one language everywhere. [decision](decisions/2026-11-17-stack.md) |
| Storage | SQLite file | One shop; runs locally. [decision](decisions/2026-11-17-use-sqlite.md) |

## Layout
```text
src/server/   HTTP API; one file per route in routes/
src/web/      Pages; one folder per screen
src/db/       Schema, migrations, queries
tests/        Mirrors src/
```

## Commands
| Task | Command |
| --- | --- |
| Install | `bun install` |
| Check everything (types, lint, tests) | `bun run check` |
| Run locally | `bun run dev` |

## Conventions
The rules every agent follows. Short, concrete, enforced by a tool where possible.
- Naming: <files, functions, routes>.
- Add a route: create `src/server/routes/<name>.ts` exporting a handler. Nothing else changes.
- Add a screen: create `src/web/<name>/`. It registers itself.
- Errors: <how they are raised, how the user sees them>.
- Config: read from environment in `src/config.ts` only; list every variable in `.env.example`.
- Tests: a test file next to the behavior it checks; `bun run check` must pass before you report done.
- Dependencies: add only what your task needs, by the package manager's add command; do not upgrade others.

## Shared files
Files several tasks may need to touch, and the rule for each (who edits, how). Keep this list short; the fewer shared files, the more work runs in parallel.

## Contracts
Shapes that more than one task depends on, written down before work starts (API routes with request and response, data tables with columns).

## Implemented
Structure that exists and was seen working.

## Plan
Structure decided and not built yet.

## Hypotheses and risks
Each with how to settle it.
````

Rules:

- A convention that is not written here does not exist for the next agent.
- `Layout` and `Commands` are copied from the real repository, not from intent. Re-check them when you change the structure.
- A contract section is the way to let two tasks build against each other in parallel: change it only with a note in the affected tasks.

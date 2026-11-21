# Plan and sizing

Load this when you write the task graph.

## Task template

`clowdy task create "<title>" --description-file - --depends-on <keys>`, the description as a heredoc. `--depends-on` takes the keys (such as CLW-21) that `clowdy task create` returned, so create dependencies first; `--blocks <keys>` makes tasks that already exist wait for the new one. Title: the outcome in a few words ("CSV export endpoint"), not an activity ("work on export"). Description, the same five parts for every task, in the project's language:

```text
Outcome: <what is true when this is done, in product terms, 1-2 sentences>
Owns: <directories or files this task may edit; exclusive among parallel tasks>
Needs: <contracts, decisions, docs to read; what it relies on from other tasks>
Check: <how it will be verified: commands, the user flow, the observable result>
Out of scope: <what a reader might assume but must not do>
```

A task without a Check is not ready to start. A task without Owns cannot be shared with a sub-agent or a thread while others edit.

## Size

One task is one coherent outcome that you can build and check as one piece. Typical: 30-120 minutes of agent work, one area, a handful to a dozen files.

- Too small: rename a function, add one test, update imports, "write docs" for code another task writes. Merge it into the task that owns the code.
- Too big: spans unrelated areas, has no single Check, or would end as "partly done". Split by ownership (area or file set), not by activity (code, tests, docs).
- Typical larger work is 3-8 tasks. More than about 12 means the pieces are too fine or the request is several milestones; group, or finish the first milestone and report.

## Dependencies

Use `--depends-on` only for real ordering: a task needs another's output (a schema, a type, an API) or must edit the same files after it. Everything else can be done in any order. Prefer removing a dependency by fixing the contract up front.

Common shapes:

```text
Fan:        A  B  C                   (no ordering; verify them together)
Foundation: Contract -> A  B  C       (Contract is verified and Done before A, B, C start)
Line:       A -> B -> C               (one after another)
```

A task is ready only when everything it depends on is Done, and Done means verified. So a task that others wait on gets checked first (its Check, build, typecheck, tests, a read of the diff) and is set Done before you start the dependents. Never start a task whose dependencies are not Done. Verification is not a task: you verify the tasks you built.

## Status flow

Statuses are the project's columns; the default is To do, In progress, Review, Done, Canceled. Name a status the way the task tools return it (its name, its category or its id); never invent one. There is no Blocked column: a blocker goes in the task description.

| Move | When |
| --- | --- |
| To do -> In progress | You start the work |
| In progress -> Review | The work is built and its own narrow check passed; Review means built, not yet verified |
| Review -> Done | Verification passed (the gates for a task others wait on; the full steps for the final result) |
| Any -> Canceled | The task is dropped; write the reason in the description |
| Review or Done -> In progress | Verification failed; add the failure to the description |

Do not delete tasks to replan: cancel with a reason and create the new one. History is how the manager follows what happened.

## Replanning

Replan when a result changes the facts: the premise was false, a dependency cannot be met, two tasks collided on a file, scope grew, or a decision changed the shape.

1. State the new fact in one line.
2. `clowdy task update <key> --description-file - --depends-on <keys>` the affected tasks (outcome, owns, dependencies); cancel tasks that no longer make sense, with a reason.
3. Stop sub-agents working on cancelled or now-wrong pieces, and `clowdy thread stop` such threads; `clowdy thread tell` the others what changed.
4. If two parallel pieces collided on a file, serialize them with `--add-depends-on`; do not let both continue.
5. Tell the manager what changed and why in one or two lines. Record a decision when it was significant.

If two sub-agents or threads changed the same area, do not pick a winner silently. A mechanical conflict you resolve, keeping both intents. A semantic one (opposite choices) is decided by the contract in the tasks; if none exists, it is a fork for your mode. Changes outside a task's scope in a sub-agent's answer or a thread's report: read what changed and decide whether to keep it. Keeping needs a line in the report; reverting is deliberate, never a blind `git checkout`.

## Example graph

Request: "Add a password reset flow."

```text
CLW-30 Reset token model and email sender
       Owns: apps/api/src/auth/reset/**, migrations/ (the only migration owner)
       Check: unit tests; a token expires after 1 hour
CLW-31 Reset request and confirm pages
       Owns: apps/web/src/auth/reset/**
       Needs: contract POST /auth/reset, POST /auth/reset/confirm {token, password}
       Check: component tests; pages render the error states
```

CLW-30 and CLW-31 do not wait for each other because the contract is written in both. When both are in Review and integrated, you check the full flow on the combined result: a real mail sink, an expired and a reused token, the password rules. Pass: both Done.

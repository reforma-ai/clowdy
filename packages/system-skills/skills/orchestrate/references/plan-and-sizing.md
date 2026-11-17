# Plan and sizing

Load this when you write the task graph.

## Task template

`task_create({ title, description, dependsOn })`. `dependsOn` takes the ids (or keys such as CLW-21) that `task_create` returned, so create dependencies first. Title: the outcome in a few words ("CSV export endpoint"), not an activity ("work on export"). Description, the same five parts for every task, in the project's language:

```text
Outcome: <what is true when this is done, in product terms, 1-2 sentences>
Owns: <directories or files this task may edit; exclusive among parallel tasks>
Needs: <contracts, decisions, docs to read; what it relies on from other tasks>
Check: <how it will be verified: commands, the user flow, the observable result>
Out of scope: <what a reader might assume but must not do>
```

A task without a Check is not ready to start. A task without Owns cannot run in parallel.

## Size

One task is one coherent outcome that one agent can finish in one run and one verifier can check. Typical: 30-120 minutes of agent work, one area, a handful to a dozen files.

- Too small: rename a function, add one test, update imports, "write docs" for code another task writes. Merge it into the task that owns the code. Every run costs about 20k tokens before it works.
- Too big: spans unrelated areas, has no single Check, or would end as "partly done". Split by ownership (area or file set), not by activity (code, tests, docs).
- Typical larger work is 3-8 tasks. More than about 12 means the pieces are too fine or the request is several milestones; group, or finish the first milestone and report.

## Dependencies

Use `dependsOn` only for real ordering: a task needs another's output (a schema, a type, an API) or must edit the same files after it. Everything else runs at once. Prefer removing a dependency by fixing the contract up front.

Common shapes:

```text
Fan:        A  B  C                   (all at once, then verify them together)
Foundation: Contract -> A  B  C       (Contract is verified and Done before A, B, C start)
Line:       A -> B -> C               (one run or do it yourself; nothing to parallelize)
```

A task is ready only when everything it depends on is Done, and Done means verified. So a task that others wait on gets checked first, by you (its Check, build, typecheck, tests, a read of the diff), and is set Done before you spawn the dependents. Never spawn a task whose dependencies are not Done. Verification is not a task: the verifier run is bound to the tasks it checks (`taskIds`).

## Status flow

Statuses are the project's columns; the default is To do, In progress, Review, Done, Canceled. Use only the `statusId` values the task tools return; never invent an id. There is no Blocked column: a blocker goes in the task description.

| Move | By |
| --- | --- |
| To do -> In progress | You, when you start work or spawn the run |
| In progress -> Review | The executor, through `report_result` (it never sets Done) |
| Review -> Done | You, after verification passed (your own gates for a task others wait on; a verifier run for the final result) |
| Any -> Canceled | You, when the task is dropped; write the reason in the description |
| Review or Done -> In progress | You, when verification failed; add the failure to the description |

Do not delete tasks to replan: cancel with a reason and create the new one. History is how the manager follows what happened.

## Replanning

Replanning is in [child-results](child-results.md).

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

CLW-30 and CLW-31 start together because the contract is written in both. When both are in Review and integrated, one verifier run bound to both checks the full flow: a real mail sink, an expired and a reused token, the password rules. Pass: both Done.

# Handling child results

Load this when the daemon resumes you with child summaries.

## What arrives

For each child, about 2 KB: `runId`, `taskIds`, `state`, `summary`, failure reason. Several children can arrive in one resume. Handle all of them before you spawn anything, then start the next wave in one step. Use `run_inspect({ runId })` only when a summary leaves a real question; it is for diagnosis, not for routine reading.

Order: read every child, update task notes and statuses, decide the next wave, spawn it, tell the manager in one line, end the turn.

## By state

| State | Meaning | Do |
| --- | --- | --- |
| `succeeded` | The executor reported done. | Not proof. Compare the summary with the task's Check: are there commands and results? Move the task to Review if it is not. If other tasks wait on it, verify it now (your own gates) and set Done before spawning them. Otherwise integrate and verify with the rest. A summary without evidence means the evidence is yours to produce. |
| `failed` | The run ended with an error or reported failed. | Read the reason, then classify below. Never skip it. |
| `blocked` | The run reported a blocker and a question. | Read the question. Answerable from code or docs, or by a routine call: answer it yourself and respawn with the answer. A significant product or technical fork: autopilot decides and records it, semi-manual uses `ask_user`. External (credentials, a service, a human action): keep the task blocked, continue unaffected work, and report exactly what is needed. |
| `cancelled` | Someone stopped the run. | Do not restart it. If the manager did it, hold the dependents and say so in the report (semi-manual: ask with `ask_user` if the work is still wanted; autopilot: list it under Open). If you did it (scope change), nothing more. |
| `interrupted` | The process died or the app restarted. | Partial edits may exist: check `git status` and the task notes. Spawn one continuation whose prompt says "the previous run was interrupted; inspect the changes, continue, do not redo", with a new `idempotencyKey`. |

A verifier ends the same way: `done` means `Result: passed`, `failed` means `Result: failed` with reasons, `blocked` means a blocker. A failed verdict is a good result of a working verifier; act on its findings. Take the path of its check report from the summary and link it in `index.md`.

## Classifying a failure

1. **The work is wrong** (the check fails, a bug, wrong approach): reopen the task, add the concrete reason and what was learned to its description, spawn one executor with that reason. Same task, new key (`-2`).
2. **The environment failed** (engine crash, timeout, tool missing, flaky network): retry once unchanged. If it fails again, treat it as blocked.
3. **A usage limit**: not a code failure. Do not respawn in a loop. Keep unaffected work moving. If nothing can move, end the turn and report what is paused and why; the manager or the daemon resumes it after the reset.
4. **The plan is wrong** (the premise was false, a dependency cannot be met, the task is bigger than sized): replan, see below.
5. **Third failure on the same task**: change the approach (different split, different engine or model, do it yourself) or stop and report failed with what was tried. Never retry the same prompt a third time.

## Replan

Do this when a child's result changes the facts: the premise was false, a dependency failed, two tasks collided on a file, scope grew, or a decision changed the shape.

1. State the new fact in one line.
2. `task_update` the affected tasks (outcome, owns, dependsOn); cancel tasks that no longer make sense with a reason, do not delete them.
3. `run_cancel` runs working on cancelled or now-wrong tasks.
4. If two parallel tasks collided on a file, serialize them with `dependsOn`; do not let both continue.
5. Tell the manager what changed and why in one or two lines. Record a decision when it was significant.

## Conflicting or overlapping results

If two children changed the same area, do not pick a winner silently. Mechanical conflict: resolve it yourself and keep both intents. Semantic conflict (they made opposite choices): decide by the contract in the tasks; if none exists, that is a fork for your mode. Then send the loser's follow-up back as a task.

## Out-of-scope changes

A summary mentions work outside the task's scope (extra files, extra features): read what changed, decide whether to keep it. Keeping out-of-scope changes needs a line in the report; reverting them is a task for an executor, never a blind `git checkout`.

## Example

Resume with three children:

- CLW-21 `succeeded`: summary lists commands and exit codes. Move to Review.
- CLW-22 `failed`, reason "typecheck error in generated client; the API schema in CLW-21 changed its field name". Plan problem: contract drift. `task_update` CLW-22 with the final field name, spawn `CLW-22-executor-2`.
- CLW-24 `blocked`, question "Which payment sandbox key should the tests use?". Not answerable from the code; autopilot: no secrets in docs, so report blocked to the manager with the exact need, keep CLW-24 blocked, continue the rest.

One line to the manager: "CLW-21 is built; CLW-22 is being redone after a naming mismatch; CLW-24 needs a sandbox key from you." Then end the turn.

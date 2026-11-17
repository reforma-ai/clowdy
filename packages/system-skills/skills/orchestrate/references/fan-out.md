# Fan-out playbook

Load this when you are about to start more than one piece of work at once.

## 1. The ready set

A task is ready when every task in its `dependsOn` is Done. Start the whole ready set in one step (several tool calls in the same message), not one after another. When a child finishes, look again: new tasks may have become ready. Work that is not ready waits; do not start it early "to save time".

If the graph is a straight line, there is nothing to parallelize: one executor for the chain, or do it yourself.

## 2. Who does the work

| Choice | Use when | Cost and limits |
| --- | --- | --- |
| **You** | The piece is small, or it is the glue between pieces (integration, a conflict, a one-line contract fix). | Uses your context; keep it for decisions. |
| **Engine sub-agent** (Claude's `Agent` tool; Codex's own sub-agent facility if it has one) | Read-only research and review; file-disjoint edits small enough for one sub-agent turn; many similar probes, one item each (the same check over many modules, a review of many files). The result is only needed by you. | Cheap, in-process, shares your cache. Launch 5-15 per wave in one message; the engine allows about 20 at once. They end with your turn, and with it if the daemon restarts. |
| **`run_spawn`** | A coarse piece of work worth tracking as its own task-bound agent: large, long (more than 10-15 minutes), needs its own session you may inspect or cancel, needs another engine or model, or is a verifier. | About 20k tokens fixed overhead each, bounded by the daemon cap (extra runs queue; that is fine). Visible in the Agents screen. Its record survives a restart; a run that was mid-turn then comes back as `interrupted`. |

Rules of thumb: research and review are sub-agents; implementation of a task is a `run_spawn`; independent verification is a `run_spawn` verifier. Do not spawn a run for something a sub-agent would finish in one turn, and do not hide hours of work in a sub-agent. Leave `engine` and `model` unset unless the manager asked or you have a reason (for example a verifier on the other engine for a second opinion).

An engine sub-agent does not load these skills. Its prompt must hold everything it needs: the question or the edit, the owned paths, "read-only" or not, the mode line, the paths of settled decisions, and the shape of the answer ("at most 15 lines, with file paths"). It writes no documents; a significant fork goes back to you in its answer.

## 3. File ownership

1. Every parallel task lists what it **Owns**: directories or files. Owned sets of parallel tasks must not intersect. If two tasks need the same file, either serialize them with `dependsOn` or move the shared part into one task that both depend on.
2. Shared hot files have exactly one owner, or are left to you at integration: lockfile and dependency manifests, route or module registries, barrel files, generated files, migration numbering, `index.md`. Tell executors not to run installs or regenerate lockfiles; do it yourself afterwards.
3. Fix contracts before fan-out. Write the interface in the task descriptions and in each prompt: type names, endpoint path and response shape, file format, function signatures. Without it, parallel tasks diverge and integration becomes rework.
4. Tests belong to the task that owns the code; do not make "write tests" a separate task.

## 4. Where to work

Your call per task, as in any session. Default: one checkout, disjoint ownership, no extra copies; a worktree costs an install and adds a merge. Create one with plain git (`git worktree add <path outside the repository> -b <task key>`), install dependencies there and pass `cwd: <path>` to `run_spawn` (an absolute path to an existing folder, or the call is refused) when:

- two tasks must change the same files and cannot be serialized;
- a task may break the build or the tests for a long time (migration, big refactor, dependency upgrade);
- you try two alternatives to compare;
- the manager has uncommitted changes in the area: never overwrite or revert them;
- a verifier must test a fixed candidate while others keep editing;
- the project is Clowdy's own repository ([self-hosting](self-hosting.md)).

Read-only agents use the main checkout. When a worktree task is verified, merge it yourself and remove the worktree; leave none behind.

Commits: in the shared checkout executors do not commit and you commit each verified task's own paths (`git commit -m "<what and why>" -- <paths>`); in its own worktree an executor commits freely. Never push unless the manager asked.

## 5. Prompt templates

`run_spawn({ taskIds, prompt, role, engine?, model?, cwd?, idempotencyKey })`. `idempotencyKey` is `<task key>-<role>-<n>`: a retried call with the same key does not start a duplicate; a deliberate new attempt increments `n`.

Executor prompt (the run starts in clowdy:executor; do not repeat its rules, give it facts):

```text
Mode: <autopilot | semi-manual>.
Goal: <one sentence, in product terms>.
Tasks: CLW-21 (read it with task_get).
Read first: the project guide (AGENTS.md or similar), .clowdy/docs/architecture.md (section "API"), <code paths>.
Decisions already made: <paths of the settled records, with the reason in a few words>.
Owns: <paths>. Do not edit anything else; report changes needed elsewhere.
Contract with other agents: <endpoint, types, format>.
Done when: <checkable result>. Run: <build, test commands>.
Where: work in <cwd>. Documents: <absolute path of the main checkout>/.clowdy/docs. Commit: <no | yes, your own paths>.
Report: end with report_result (what changed, commands and results, open questions).
```

Verifier prompt (first line names the skill, because a verifier starts fresh):

```text
Follow clowdy:verify. Mode: <autopilot | semi-manual>.
Claim to check: <the result, in the manager's words>.
Tasks: CLW-23 (and the tasks it covers: CLW-21, CLW-22).
Where: <cwd and, if any, the branch or commit of the integrated result>.
Acceptance criteria: <numbered, copied from the tasks and the request>.
Known commands: <build, test, run>. User flow: <steps a user takes>.
You do not fix anything. Record evidence in .clowdy/docs/checks/ and finish with report_result.
```

Give a verifier the claim and the criteria. Do not give it the executor's summary or reasoning.

## 6. Caps and waves

- The daemon caps simultaneous runs. Spawn everything that is ready; extra runs queue. Do not ration by hand.
- Count cost anyway: 6 coarse runs beat 30 fine ones. If the ready set is large and each piece is small, group pieces into 3-6 tasks by area before spawning.
- After each resume, start whatever became ready before you do anything slow yourself.

## 7. While children run

- You are idle: end the turn. Do not read their files and do not poll `run_inspect`.
- `run_wait({ runIds, timeoutSeconds })` is for a short wait (one call waits at most 60 seconds) when the next step needs a result now and you have nothing else to do. It is not a way to babysit.
- If the manager sends a message: answer it. If it changes scope, update tasks, `run_cancel` the affected runs, replan.

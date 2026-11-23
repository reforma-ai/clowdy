# Threads

Load this when you are about to hand work to another agent: a thread, or the engine's own sub-agents ([sub-agents](sub-agents.md) has their prompt template).

A thread is a chat below yours with an agent of its own. You start it with a brief, it works alongside you, and its last message of each turn is its report, which the daemon delivers to you as a message each time it stops. The person sees it in the app and can write to it. You drive threads with the shell command `clowdy thread`; `clowdy thread --help` lists the commands and `clowdy thread <command> --help` their options. If your shell does not find `clowdy`, `"$CLOWDY_CLI"` is the same command.

## 1. Who does the work

| Choice | Use when | Cost and limits |
| --- | --- | --- |
| **You** | The default: a task's coherent piece, the glue between pieces, a conflict, a one-line contract fix, anything that needs the whole picture. | Uses your context; keep it for decisions. |
| **Engine sub-agent** (Claude's `Agent` tool; Codex's own sub-agent facility if it has one) | Read-only research and review; file-disjoint edits small enough for one sub-agent turn; many similar probes, one item each. The result is only needed by you. | Cheap, in-process, shares your cache. Launch 5-15 per wave in one message. They end with your session. |
| **Thread** (`clowdy thread spawn`) | A coarse piece worth an agent of its own: a task of 30 minutes or more, long-running work that should not hold your turn, an independent check of what you built, or a piece for another agent or model. | A full agent session and a turn of yours for each of its reports. It keeps its chat after a restart and the person can follow it. 2-6 at once is normal. |

Rules of thumb: research and review are sub-agents; implementation of a task that splits off cleanly is a thread or yours; an independent check is a fresh thread. Delegate only when the person asked for it or the work really splits into independent pieces. Do not start a thread for something you or a sub-agent would finish in a few minutes, and do not hand off a piece whose result you could not check.

## 2. The brief

The thread does not see this conversation or these skills (it has clowdy:orchestrate and clowdy:thread of its own, nothing of your plan). The brief is everything it knows:

```text
Mode: <autopilot | semi-manual>.
Goal: <one sentence, in product terms>.
Tasks: CLW-21 (read it with `clowdy task get CLW-21`; it is assigned to you).
Read first: the project guide (AGENTS.md or similar), .clowdy/docs/architecture.md (section "API"), <code paths>.
Decisions already made: <paths of the settled records, with the reason in a few words>.
Owns: <paths>. Do not edit anything else; put changes needed elsewhere in your report.
Contract with other agents: <endpoint, types, format>.
Done when: <checkable result>. Run: <build, test commands>.
Where: work in <cwd>. Documents: <absolute path of the main checkout>/.clowdy/docs, never index.md. Commit: <no | yes, your own paths>.
Report: end your turn with the verdict first, then the commands you ran and what they showed, then what is left.
```

Leave the agent and the model unset unless the person asked or you have a reason (a check by another agent for a second opinion): a thread runs on yours by default.

## 3. Start, then end your turn

1. Start every thread that is ready in one step, then go on. A brief belongs in a heredoc, so quotes and `$` stay as written:

   ```bash
   clowdy thread spawn --title "CSV export endpoint" --tasks CLW-21 --prompt-file - <<'EOF'
   Mode: autopilot.
   Goal: ...
   EOF
   ```

2. Tell the manager in one line what runs, and end your turn. Do not wait, and never poll with `list`, `output` or `wait` in a loop.
3. The daemon wakes you each time a thread stops, with its report. The same thread may report again: after a message of yours, after work it still had running in the background, or when it fails later. Notices of threads that stop close together arrive in one message.
4. Handle every notice. `finished`: read the report, check the claim (section 5), set tasks, start what became ready. Finished with background work still running: not final yet, it reports again. `failed`: look with `clowdy thread log <thread>`, then retry once with the reason (`clowdy thread tell` it, or a new thread), do it yourself, or report it. `interrupted` (the daemon restarted): `clowdy thread tell` it to continue, or start it again. A thread of a semi-manual chat may wait at a question card in its own chat; it shows as `asking` until the person answers there, then goes on and reports.
5. Do not answer notices just to acknowledge them, and never message a thread for an acknowledgement, thanks or "how is it going".

## 4. Steer, stop, read

- `clowdy thread tell <thread> "<message>"` redirects a thread that works: it joins the running turn (`--mode steer`, the default) when its agent can take it, else it waits for the next turn. `--mode queue` always waits for the next turn. A message to a thread at rest starts a turn on it. A long message goes through `--message-file -` with a heredoc.
- `clowdy thread stop <thread>` when the plan changed or the work went wrong. It stops that thread only, not the threads it started; stop each one. A later `tell` starts it again.
- `clowdy thread output <thread>` reads its last report again; `clowdy thread log <thread>` shows what it did, to diagnose a failure. `clowdy thread list` shows your threads and their state (`--all` with theirs).
- `clowdy thread wait <thread> --timeout-seconds <n>` only for a short wait when nothing else is left: you hold your turn and its slot while it waits. Ending your turn is almost always better.

## 5. Check what a thread built

A thread's "done" is a claim. Cheap gates (build, typecheck, tests) you run yourself on the integrated result. For a user flow or a risky change, start a fresh thread that checks it: give it the claim in the manager's words, the acceptance criteria, where the result is and the commands, never the author's report or reasoning, and tell it to fix nothing and write a check report (clowdy:docs). Its findings come back as its report: a failure goes back to the author with the repro, then a new check. See [verification](verification.md) for the steps the checking thread follows: put "follow the steps of clowdy:orchestrate references/verification.md" in its brief.

## 6. File ownership

1. Every piece handed to a parallel agent, sub-agent or thread, lists what it **Owns**: directories or files. The owned sets of parallel pieces must not intersect. If two pieces need the same file, do them one after the other, or move the shared part into one piece that comes first.
2. Shared hot files have exactly one owner, or are left to you at integration: lockfile and dependency manifests, route or module registries, barrel files, generated files, migration numbering, `index.md`. Tell the others not to run installs or regenerate lockfiles; do it yourself afterwards.
3. Fix contracts first. Write the interface in the task descriptions and in each brief: type names, endpoint path and response shape, file format, function signatures. Without it, parallel pieces diverge and integration becomes rework.
4. Tests belong to the task that owns the code; do not make "write tests" a separate task.

## 7. Where to work

Your call per piece. Default: one checkout, disjoint ownership, no extra copies; a worktree costs an install and adds a merge. Give a thread one when:

- two pieces must change the same files and cannot be done in order;
- a piece may break the build or the tests for a long time (migration, big refactor, dependency upgrade);
- you try two alternatives to compare;
- the manager has uncommitted changes in the area: never overwrite or revert them;
- a checking thread must test a fixed candidate while others keep editing;
- the project is Clowdy's own repository ([self-hosting](self-hosting.md)).

Two ways to give it one:

- **`--worktree`:** `clowdy thread spawn --worktree` has the daemon make a git worktree for the thread on a branch of its own (`clowdy/<name>`: `--branch <name>`, else made of `--title` when it has English words, else the thread's id), started from the branch you have checked out, in your worktree or in the project's folder (`--base <branch>` starts it from another; on a detached HEAD in your worktree the spawn is refused without it). It starts at the last commit of that branch as it stands when the thread's first turn makes the worktree, so commit what the thread needs first: your uncommitted files are not in it. A fresh worktree holds the repository's files only: dependencies are not installed unless the folder's setup, which the person sets, does it, so tell the thread to install when it needs them. The answer of `thread spawn` has the worktree's path and branch. It does not go with `--cwd`, and it needs the project's folder to be the root of a git repository (the spawn is refused otherwise).
- **Your own:** create one with plain git (`git worktree add <path outside the repository> -b <task key>`), install dependencies there and start the thread in it with `--cwd <absolute path>` (an existing folder, or the spawn is refused).

Read-only work uses the main checkout. When a worktree piece is verified, merge it yourself: `git merge <branch>` in your own checkout, since a thread's branch is in the same repository. Remove a worktree you made yourself and leave none behind, but leave one that `--worktree` made: it belongs to the thread's chat, and removing it is the person's choice. Commits: in the shared checkout the others do not commit and you commit each verified task's own paths (`git commit -m "<what and why>" -- <paths>`); in its own worktree a thread commits freely. Never push unless the manager asked.

## 8. Quota and limits

- Every report of every thread costs you a turn, and every thread a full session. Prefer fewer, larger threads with sharp briefs; 2-6 at once is normal, dozens is a smell.
- The daemon caps them: about 30 active threads and 300 in all per chat, and three levels (your chat, its threads, theirs). A refused spawn says why; finish or stop some first.
- A thread that failed on a usage limit is not a code failure: do not start it again in a loop. Keep the rest moving, and if nothing can move, report what is paused and why.

## Example

Manager, `Mode: autopilot`: "Customers want to export the invoices list as CSV." Two tasks, CLW-21 (endpoint, owns `apps/api/src/invoices/export*`) and CLW-22 (button, owns `apps/web/src/invoices/`), the contract `GET /invoices/export.csv?status=` written in both.

1. Two `clowdy thread spawn` calls in one step, each with its brief, `--tasks` and the contract. One line to the manager, end the turn.
2. Woken: CLW-22's thread finished, both checks green. Set it to Review. End the turn.
3. Woken: CLW-21's thread failed on a missing fixture. `clowdy thread log` shows the path; `clowdy thread tell` it the fixture's location. End the turn.
4. Woken: CLW-21 done. Run build and tests on the whole: green. Start a checking thread with the claim and the criteria. End the turn.
5. Woken: the check failed, a name with a comma breaks the columns, with a repro. `clowdy thread tell` CLW-21's thread the repro, then a new check after its next report.
6. Passed: set both Done, record, report to the manager.

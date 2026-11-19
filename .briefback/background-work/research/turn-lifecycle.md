# How a turn ends in the daemon, and what dies with it

Code as of 2026-11-19. Symbols are named instead of line numbers; they drift.

## Summary

A run's turn is one agent process. When the agent's `session/prompt` returns, `AcpSession` yields `done` and stops the process group (unless it waits for a chat title), the driver settles the run and closes the session, and the runtime cancels native sub-agents. Everything the agent started in the background lives in that group, so it ends with the turn (not for Claude Code, which starts each shell command in a group of its own: the real check of 2026-11-19 found those outliving a stop, which `AgentProcess.watch` and `stop` now reach; see `acp-background-probe.md`). A new turn is a new process that resumes the session.

## How it works

1. `AcpSession.talk` (`apps/daemon/src/engine/acp/session.ts`) sends one `session/prompt` and loops over a channel of updates until the answer arrives (`kind: 'stop'`). It then yields `done` and returns. Updates after that are not read: the notification handler pushes into the channel only while the loop runs.
2. `AcpSession.drive` ends in a `finally`. A cancelled run is stopped by `stopAgent` (`session/cancel`, close stdin, a short grace, then `proc.stop()`). Otherwise: when `awaitsTitle()` is true the session sets `lingering` and calls `linger(proc)`, which keeps the process up to `titleWaitMs` (10 s) for the chat title, and `close()` does not wait for it. In every other case `proc.stop()` runs at once.
3. **A linger path already exists, for titles.** It keeps the agent running after `done` without holding the run. It is the only place that does, and the background-work change must build on it, not beside it. Its limits for this change: the process is no longer recorded on the run, and it ends on a short timer.
4. `AgentProcess.stop()` (`engine/process.ts`) sends SIGTERM to the group and SIGKILL after 2 s; the `exit` handler also SIGKILLs the group. The agent is the leader of its own group (`detached: true`), so MCP servers and sub-processes go with it; Claude Code's shell commands do not (each is in a group of its own), and `stop()` signals them too, from the process tree it read before the stop.
5. `RunDriver.turn` (`apps/daemon/src/runs/driver.ts`): `consume` returns at `done`, `settle` sets the run's status, and the `finally` calls `writer.finish`, `live.native.finish`, `session.close()`, decrements `sessions` and clears the recorded process (`runs.setProcess(runId, null)`).
6. `NativeAgents.finish` (`runs/native.ts`) closes every sub-agent still `running` as `cancelled` ("The parent run ended its turn").
7. The mapper drops what a sub-agent reports after the call that started it ended (`apps/daemon/AGENTS.md`, "Sub-agents": "a background sub-agent's whole work, for now").
8. `settle` parks an orchestrator in `waiting_children` only for children started with `run_spawn`, never for background work inside the session.

## What dies at the end of a turn today

| Started in the turn | Result today | Evidence |
| --- | --- | --- |
| Background `Bash` (`run_in_background`, `cmd &`, `nohup`) | Killed with the group | Code; the adapter probe shows the process alive at the end of the prompt |
| Background sub-agent (`Agent`, `run_in_background`) | **Not killed at the end of the prompt.** Clowdy does not declare `backgroundSubagents`, so the adapter holds `session/prompt` open until the sub-agent finishes. The run stays `running` with its slot, the sub-agent's work is dropped by the mapper, and a steer is injected into the held turn | Probe s3 (`acp-background-probe.md`) |
| `Workflow` | Killed with the group. The demo workflow of the first session lost its verifiers when the chat turn ended | `journal.jsonl` of that run; not re-run through the daemon |
| Foreground sub-agent | Fine: the call blocks the turn | By design |
| `run_spawn` child | Fine: its own run and process; the orchestrator parks in `waiting_children` and is woken with the summary | `settle`, `wake.ts` |

## Constraints that any change must respect

- `apps/daemon/AGENTS.md`, "One session is one process, one turn": each turn is a new process; `model` and `effort` are applied at the start of every turn; `maxProcesses` counts sessions not yet closed (a start that finds the cap waits up to twice `killGraceMs`, then fails the run).
- A run's status changes only through `RunService.setStatus` and the table in `runs/transitions.ts`; `running` is reached only from `queued` through the scheduler.
- Cancel and daemon stop must end a lingering process within the `killGraceMs` ladder; startup already kills recorded process groups, which needs the process to stay recorded on the run while it lingers.
- Engines never write to the database (`engine/types.ts`); a new event must come through `EngineEvent`. `EngineSession` has one prompt per session and `steer?` for a turn in flight.
- The chat's queue (`runs/queue.ts`) and `chat.setArchived` / `chat.delete` treat every non-terminal status as active; a new status changes what they refuse.
- The owner's development app runs this repository's daemon. `apps/daemon/AGENTS.md`: do not replace files of the running build; use a worktree or a scratch daemon on its own data folder and port.

## Sources

- Code as of 2026-11-19, files above.
- Journal of the demo workflow: `~/.claude/projects/-Users-bionic-WORK-My--kachurun-clowdy/58e77d33-d0fb-430b-8b37-8812c3bc1016/subagents/workflows/wf_4f74cd03-da0/journal.jsonl` (local to the author's machine).

## Open questions

- Whether a background command started with `setsid` leaves the group on macOS (not run).
- What the chat shows today when background work is cut off. A background `Bash` call itself already returned `completed`, so most likely nothing.

# Research: background work that outlives a turn (index)

Snapshot 2026-11-19. Research only; the change is in `../plan.md`, the state of the work in `../handoff.md`. Slug `background-work`.

## Question and scope

What happens in Clowdy when an agent starts something in the background (a `Bash` command with `run_in_background`, a background sub-agent, the `Workflow` tool) and ends its turn while it runs? Can the result still reach the chat, as it does in other clients (bb)? Covered: the daemon's ACP session and run runtime, the Claude Code adapter (`claude-agent-acp@0.107.0`) on ACP v1 and the v2 draft, and the Codex adapter (`codex-acp@2.6.0`). Cursor was probed for protocol, steering and background work (v1 only, no steer, no background reporting). Not covered: Gemini and the other agents, which are not in use, and the desktop UI.

## Summary

- **Today the background work is killed at the end of every turn,** except a background sub-agent, which holds the turn open because Clowdy does not declare `backgroundSubagents`. See `turn-lifecycle.md`.
- **The Claude adapter publishes explicit markers** for background tasks, background sub-agents and the turns Claude starts by itself, if the client opts in (`_meta.jetbrains.air` capabilities or `subagents: {}` on v1; the standard `state_update` and `background` list on v2). A quiet-window guess is not needed. See `acp-background-probe.md`.
- **Clowdy's SDK drops those events** (closed union, `Invalid params`); the v1 path needs a tap on the agent's stdout.
- **A message to a live session is a plain `session/prompt`.** It is answered at once while only background tasks run, and waits for an agent-started turn that is in progress. `_session/steering` refuses both.
- **Closing needs a handoff guard:** the report turn starts 0.1 to 0.9 s after the last "done" marker (v1 and v2).
- **ACP v2 is real for Claude and Codex** and it covers shell commands, sub-agents and workflows with standard events (`state_update`, `background`, `subagent_update`). A mid-turn prompt acts as a steer on both. Codex gains nothing for background work from v2: it has no background-task feature to report on either version.
- **A v1-only agent answers `protocolVersion: 1`** to a v2 `initialize` (Cursor verified, six other agents not installed here). The spec's migration guide recommends v1 and v2 as side-by-side layers behind shared logic, one chosen per connection.
- **Nothing in the engine is meant to be turned off.** The owner decided not to forbid background features.

## Topic pages

| Page | Covers |
| --- | --- |
| [turn-lifecycle.md](turn-lifecycle.md) | The code path from `done` to a killed process, the existing title linger, who else dies |
| [acp-background-probe.md](acp-background-probe.md) | The live probes: Claude v1 and v2, sub-agents, steering, Workflow, Codex; timelines and gaps |
| [probe-harness.ts.txt](probe-harness.ts.txt) | The probe client, to repeat or extend |

## Important files

- `apps/daemon/src/engine/acp/session.ts`: the turn loop (`talk`), the shutdown (`drive`'s `finally`), the title linger
- `apps/daemon/src/engine/acp/mapper.ts`: `session/update` to `EngineEvent`; unknown kinds fall into `default`
- `apps/daemon/src/engine/acp/catalog.ts`, `registry.ts`: `clientMeta`, the `_meta` of the client capabilities in `initialize` (where an opt-in goes)
- `apps/daemon/src/engine/types.ts`: `EngineSession` (one prompt per session, `steer?`), `EngineEvent`
- `apps/daemon/src/runs/driver.ts`: one flight per turn, `consume`, `settle`, the `finally` that closes the session
- `apps/daemon/src/runs/native.ts`: native sub-agents end with their parent's turn
- `apps/daemon/src/runs/transitions.ts`, `packages/protocol/src/domain.ts`: run statuses
- `apps/daemon/test/fake-acp-agent.ts`: the scripted ACP agent the engine tests run against

## Open questions

1. Does a v2 Claude session accept a prompt **during** an agent-started turn, and what does it do (steer, queue)? v2 sub-agents, `Workflow` and shell commands are covered (probes s10, s11, s13); a prompt while only background work runs is answered at once.
2. A second background task started inside a report turn (chains of turns).
3. Does the handoff gap stay below one second under load? Eight samples between 0.1 and 0.9 s, v1 and v2.
4. Does any agent besides Claude report background work? Codex and Cursor do not; the agents that are not in use were not looked at.
5. What a lingering session costs in memory per chat (not measured).
6. What happens to a lingering session when the daemon restarts: the process dies with the group; the existing recovery marks the run `interrupted`, but the lost tasks are not told to the agent.

## Assumptions and limits

- One run per scenario, model `haiku` for Claude and the user's default for Codex, one background command or sub-agent each; the Claude Code binary and the Codex binary were the user's own.
- Not run: the daemon itself (the probes talk to the adapters directly), any desktop UI, any other agent.
- Code references are to the working tree of 2026-11-19 (branch `maksim-kachurin/archive-history-icon`, other uncommitted work in `apps/desktop`).

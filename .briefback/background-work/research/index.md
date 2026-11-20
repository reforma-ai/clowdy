# Research: background work that outlives a turn (index)

Snapshot 2026-11-19. Research only; the change is in `../plan.md`, the state of the work in `../handoff.md`. Slug `background-work`.

## Question and scope

What happens in Clowdy when an agent starts something in the background (a `Bash` command with `run_in_background`, a background sub-agent, the `Workflow` tool) and ends its turn while it runs? Can the result still reach the chat, as it does in other clients (bb)? Covered: the daemon's ACP session and run runtime, the Claude Code adapter (`claude-agent-acp@0.107.0`) on ACP v1 and the v2 draft, and the Codex adapter (`codex-acp@2.6.0`, and 2.8.0, which is the one that reports background work on v2: see `codex-app-server.md` and `acp-background-probe.md`, "Codex on v2 through the daemon (2.8.0)"). Cursor was probed for protocol, steering and background work (v1 only, no steer, no background reporting). Not covered: Gemini and the other agents, which are not in use, and the desktop UI.

## Summary

- **Today the background work is killed at the end of every turn,** except a background sub-agent, which holds the turn open because Clowdy does not declare `backgroundSubagents`. See `turn-lifecycle.md`.
- **The Claude adapter publishes explicit markers** for background tasks, background sub-agents and the turns Claude starts by itself, if the client opts in (`_meta.jetbrains.air` capabilities or `subagents: {}` on v1; the standard `state_update` and `background` list on v2). A quiet-window guess is not needed to know that work is open or ended; only the length of the wait for a report that is owed is a bound. See `acp-background-probe.md`.
- **Clowdy's SDK drops those events** (closed union, `Invalid params`); the v1 path needs a tap on the agent's stdout.
- **A message to a live session is a plain `session/prompt`.** It is answered at once while only background tasks run, and waits for an agent-started turn that is in progress. `_session/steering` refuses both.
- **Closing needs two waits, because the report turn has no marker before its first output:** it started 0.1 to 0.9 s after the last "done" marker in the first probes, but through the real daemon on v2 it took 0.75 to 1.7 s and once more than 2 s (it begins when the model's first output arrives). A 2 s handoff guard stays for the turn after a turn; a 20 s report wait covers finished background work whose report is owed. See `acp-background-probe.md`, "Real check through the daemon".
- **ACP v2 is real for Claude and Codex** and it covers shell commands, sub-agents and workflows with standard events (`state_update`, `background`, `subagent_update`). Claude inserts a mid-turn prompt into the running turn as a steer. Codex's adapter holds a plain prompt that comes mid-turn until the turn ends, and takes a steer through `_session/steering` (`injected`, advertised in `initialize` as `_meta.steering.supported`), which the daemon uses on v2.
- **Codex does have background work,** corrected on 2026-11-19 (the earlier probe only used `nohup ... &`, which Codex does not track). A command that outlives its call (a unified-exec process, a short `yield_time_ms`) and a sub-agent are tracked, and `codex-acp` 2.8.0 reports them on v2 as `state_update.background`, with `terminal/cancel` for a command and child sessions for a sub-agent; Codex itself never starts a turn to report that they ended, so the runtime sends the agent a note (`wakesOnBackgroundEnd`). Verified through the daemon. See `codex-app-server.md` and `acp-background-probe.md`, "Codex on v2 through the daemon (2.8.0)".
- **A v1-only agent answers `protocolVersion: 1`** to a v2 `initialize` (Cursor verified, six other agents not installed here). The spec's migration guide recommends v1 and v2 as side-by-side layers behind shared logic, one chosen per connection.
- **Nothing in the engine is meant to be turned off.** The owner decided not to forbid background features.

## Topic pages

| Page | Covers |
| --- | --- |
| [turn-lifecycle.md](turn-lifecycle.md) | The code path from `done` to a killed process, the existing title linger, who else dies |
| [acp-background-probe.md](acp-background-probe.md) | The live probes: Claude v1 and v2, sub-agents, steering, Workflow, Codex (also on v2 through the daemon with `codex-acp` 2.8.0); timelines and gaps |
| [codex-app-server.md](codex-app-server.md) | What `codex app-server` and `codex-acp` offer a client for background work, steering and stopping, and why Codex goes on `codex-acp` 2.8.0 over v2 instead of an adapter of our own |
| [probe-harness.ts.txt](probe-harness.ts.txt) | The probe client, to repeat or extend (scenarios `f1` to `f10` and `c3` record sub-agents on v2) |
| [subagent-wire-v2.jsonl](../../../apps/daemon/test/fixtures/subagent-wire-v2.jsonl) | The raw `session/update`s of six sub-agent runs on v2 (foreground, background, two at once, cancelled, a failed call, a message meanwhile) |

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

1. Does a v2 Claude session accept a prompt **during** an agent-started turn, and what does it do (steer, queue)? A prompt while only background work runs is answered at once on the same process (real check: 1.8 s), and a steer during an ordinary turn lands at the next boundary and gives one answer. During the report turn itself it is **not checked** against the real adapter (fakes only).
2. A second background task started inside a report turn (chains of turns): **not checked** for real; the fakes cover it. The real check only saw a sub-agent's list refill 6 ms after it emptied.
3. Does the handoff gap stay below one second under load? **No.** Over about a dozen real samples it is 0.75 to 1.7 s, and once more than 2 s, which lost the report. It ends when the model's first output arrives, so it has no bound. The daemon now waits 20 s for a report that is owed (`BACKGROUND_REPORT_MS`); see `acp-background-probe.md`, "Real check through the daemon".
4. Does any agent besides Claude report background work? **Answered.** Codex does, on v2 since `codex-acp` 2.8.0 (a command that outlives its call, a sub-agent), and does not start a turn to report that it ended. Cursor does not; the agents that are not in use were not looked at.
5. What a lingering session costs in memory per chat (not measured).
6. What happens to a lingering session when the daemon restarts? **Answered.** The daemon stopping ends the agent and the command it started; a killed daemon is recovered at the next start. The run is `interrupted`, `Run.background` is cleared, and the next message tells the agent that the background work was lost (checked with SIGTERM and SIGKILL). Stop on a waiting run needed a fix to reach the commands, which Claude Code starts in groups of their own.

## Assumptions and limits

- One run per scenario, model `haiku` for Claude and the user's default for Codex (`gpt-6-luna`, low effort, in the Codex checks of 2026-11-19), one background command or sub-agent each; the Claude Code binary and the Codex binary were the user's own.
- Not run: the daemon itself (the probes talk to the adapters directly), any desktop UI, any other agent.
- Code references are to the working tree of 2026-11-19 (branch `maksim-kachurin/archive-history-icon`, other uncommitted work in `apps/desktop`).

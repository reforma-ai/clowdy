# bb threads: what depends on the agent protocol, and what does not

Source: `get-bb/bb` at `9f4c15646d3d7d9320191d4a2cd76199471a1ddc` (2026-11-19), read only, not run. Paths are relative to the bb repo root. Companion to `.briefback/acp/research/bb-source.md` (how bb drives agents), which this page does not repeat.

## Summary

**The threads feature is protocol independent.** The parent link, the sidebar tree, the CLI, the notification rule, `wait`, `output`, `log`, archive and delete all live in the bb server and read only two things from every provider: a **turn boundary event** (`turn/started`, `turn/completed` with a status) and the **text items** of the turn. They never look at which provider produced them. The provider bridge sits behind a fixed set of requests (`thread/start`, `thread/resume`, `thread/fork`, `turn/start`, `turn/steer`, `thread/stop`).

What the protocol changes is the **quality of three operations**: `steer` (what `tell` does to a running thread), `fork`, and how many turn ends a thread produces (background work).

## What each provider's bridge does

| Operation | Claude Code (Agent SDK) | Codex (`codex app-server`) | ACP agent (Cursor, OpenCode, ...) |
| --- | --- | --- | --- |
| Handshake facts | `fork: "checkpoint"`, `steerMode: "inject"`, `sessionRestore: true` (`plugins/provider-claude-code/src/bridge/bridge.ts:2339-2354`) | `fork: "checkpoint"`, `steerMode: "inject"` (`plugins/provider-codex/src/bridge/bridge.ts:1743-1760`) | `fork: "tip"`, `steerMode: "queue"`, `sessionRestore: false` (`packages/provider-bridge-acp/src/bridge/bridge.ts:4075-4090`). Per agent: Cursor and Grok `fork: "none"`, OpenCode, omp, Hermes `tip` (`plugins/provider-acp/src/known-agents.ts`) |
| New turn | Push the prompt into the live SDK input stream (`runTurnInput`, `bridge.ts:2662-2745`; `sdk-session.ts` `pushInput`) | `turn/start` | `session/prompt`; the turn ends when the call returns (`runTurn`, `bridge.ts:3274-3410`) |
| Steer (`tell` to a running thread, notice to a running parent) | Same push; one live session takes it | `turn/steer` with `expectedTurnId`; stale ids are rejected (`bridge.ts:2318-2354`) | **Cancel and re-prompt**: the text goes to `session.queuedInputs`, the bridge sends `session/cancel`, the first prompt returns `cancelled`, then the next prompt carries the text. Same bb turn, so no `turn/completed` in between (`bridge.ts:4275-4313,3142-3153,3374-3390`) |
| Turn status to the server | SDK result | app-server turn events | `end_turn`, `max_tokens`, `refusal` become `completed`; `cancelled` becomes `interrupted` (`packages/provider-bridge-acp/src/delta-translation.ts:986-990`) |
| Turn that the agent starts itself | Background tasks send `task_started/updated/notification` messages (`plugins/provider-claude-code/src/task-translation.ts`); the agent then works on its own and the turn ends again | not read | Any `session/update` that arrives **outside a prompt** and starts agent work opens an *agent turn*; it closes after **5 s without updates and without open tool calls, permissions or compactions** (`AGENT_TURN_QUIET_MS`, `bridge.ts:300,2898-2935,3096-3125`). A timer, not an agent signal. Agents that report their own state (`generation === 2` in `session/session-model.ts:96`) do not feed the guessed work state (inferred: the timer logic itself was not re-read for that case) |
| Background work in the UI | `activity.backgroundCommands/Agents/workflows` from the task messages | not read | None (no events to show) |
| Fork | Rewinds the on-disk transcript to a message id (`session-fork.ts`) | `thread/fork` at a checkpoint | `session/fork`, only if advertised, only at the tip |
| Permission modes | `accept-edits`, `auto`, `full` | same | `accept-edits`, `full` only; `auto` throws (`bridge.ts` `reconcileExecutionSettings`) |
| Stop | Closes the SDK session (`closeThreadForStop`, `bridge.ts:2792-2819`) | not read | `stopSession` and `releaseSession` end the connection and the agent process (`bridge.ts:3125-3140`, handler at `4316-4330`); their cancel details were not read |
| Delivering the CLI knowledge | Instructions plus skill | same | Instructions wrapped in `<system_instructions>` on the **first prompt**; skills via the agent's native skill roots when it has them |

## What this means for threads on ACP, step by step

| Feature | App level (works for any agent) | Needs the protocol |
| --- | --- | --- |
| `spawn`, `tell`, `wait`, `output`, `log`, `stop`, tree, archive | Yes | The agent must be able to run a shell command. In `accept-edits` each `bb` command may ask for an approval (a pending interaction, which the parent is told about) |
| Notify the parent at a turn end | Yes, from `turn/completed` | ACP gives exactly one turn end per `session/prompt`, plus one per agent turn (5 s quiet) |
| `tell` to a **running** ACP thread | The delivery rule (steer, queue, new turn) | Steer works only by **interrupting** the agent. A flaky agent may answer the cancel badly. The skill's default `tell` mode is `steer`, so an agent that follows it interrupts its target |
| Notification into a **running ACP parent** | Queued system message, mode `auto` | Same interrupt: the notice cancels the parent's running prompt and re-prompts it |
| Background work | Shown and counted | ACP agents report none, so a finished background job in Cursor does not start an extra bb turn, unless the agent sends updates outside a prompt |
| `fork` from a point | Event copy and anchor logic are generic | Cursor: refused. Others: tip only |
| `wait` | Polls status | none |

## Answers to the questions in the brief

1. **Is the feature protocol independent?** Yes, in the server and CLI. The only provider hooks are the turn boundary, steer, fork and (optionally) background reports.
2. **For Cursor, what does bb do for tell, wait, notification and stop?** `tell` to a running thread = cancel and re-prompt; to an idle one = a new `session/prompt`. `wait` = unchanged. Notification = from the end of each `session/prompt` (or the quiet-timer agent turn). Stop = the bridge ends the connection and the agent process (cancel details not read). `fork` = refused.
3. **What extra do Claude and Codex use?** Claude: a live streaming input (steer and new turn are the same push), session ids and on-disk transcript forks, task messages for background work. Codex: `turn/steer` with turn ids, `thread/fork`, `thread/resume`.
4. **Could a flaky ACP agent make bb's threads look wrong?** Yes, in specific ways, all observable in bb's own CLI (`bb thread log <id> --all`, `bb thread show`, `bb thread queue list <parent>`):
   - An `end_turn` with no text posts a notice "completed: No final output was recorded." and a warning "The agent ended the turn without replying" (`bridge.ts:3396-3408`).
   - A `cancelled` stop that is not a manual stop posts "was interrupted".
   - Updates arriving after the prompt returned open an agent turn and add one more notice per burst.
   - A `steer` is an interrupt, so a child that is told or notified mid-turn can lose its work in flight.
   - A process exit becomes `provider_process_exited` and a `failed` notice.
   These are properties of the bridge and the agent together; none is a flaw of the thread model.

## Assumptions and limits

- No bb code was run. The ACP rows come from `packages/provider-bridge-acp/src/bridge/bridge.ts` (about a third read: turn handling, steer, agent turns, handshake, fork) and `session/session-model.ts`.
- Codex's bridge was read only for the handshake, fork and steer; its background-work handling and agent-started turns were not.
- Claude's translation of agent-started turns into bb turns (the translator) was not read.

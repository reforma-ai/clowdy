# Research: chat controls

Snapshot 2026-11-18, `main` at `61ea92a`. Research only: no plan, no design. Slug `chat-controls`.

## Question

The owner wants three chat features (root `TODO.md`, "Chat"): compaction, queue or steer a message
(with a default-behaviour setting), and sub-agents. What exists in Clowdy today, end to end
(protocol → daemon → desktop), what is missing, and where an implementer hooks in; and how Reforma
builds the same (Reforma pages below).

## Clowdy today: summary

- **Compaction: manual compaction works, there is no marker.** The agent's `usage_update` becomes
  `Run.context`, the composer's ring shows it, and Compact sends `chat.compact`, which runs the agent's
  own `/compact` as the next orchestrator turn (Claude, Codex; Cursor has none). The stream shows a note
  "Compacting the conversation" and a generic tool line, and the ring drops. Clowdy never compacts by
  itself; the agents' own auto-compaction shows as the same tool line; an overflow fails the run with
  "Start a new chat". Likely bug: a message sent while the compact turn is starting is joined into the
  `/compact` prompt. ACP's stable `compaction_update` (client capability `session.compaction`) is unused.
- **Queue / steer: always queue, no queue UI, no setting.** A message to a working orchestrator goes
  `chat.send` → `RunDriver.deliver` → `AcpSession.send`, waits for the running `session/prompt` to end
  and goes out as the next prompt of the same process (several join into one). Send stays enabled, the
  bubble appears at once. Both pinned adapters (Claude 0.107.0, Codex 2.6.0) advertise
  `_meta.steering.supported` on the `initialize` answer and implement `_session/steering` with a
  `promptRequired` fallback; the SDK sends it through its generic `request(method, params)`.
- **Sub-agents: `run_spawn` works, cards do not exist.** Spawned children are real runs, nested in the
  Agents tree, and wake their parent with summaries; the chat stream shows a generic "Run spawn" line
  and note lines, with no link or nesting. Native sub-agents (`NativeAgents`, `origin: 'native'`) are
  emitted only by the fake engine; the ACP mapper drops Claude's `_meta.claudeCode.parentToolUseId`, so
  a Claude sub-agent's tool calls and text most likely land in the orchestrator's stream as its own.
  Delegation guidance is in the inlined `clowdy:orchestrate` skill, not in `systemPrompt()`.

## Clowdy today: pages

- [clowdy-compaction.md](clowdy-compaction.md): the reading → ring → `chat.compact` → `/compact` turn
  path step by step, what the adapters report, what the stream shows, auto-compaction, gaps (the merged
  message, no marker, "Think" for Codex, demo data), hook points.
- [clowdy-queue-steer.md](clowdy-queue-steer.md): the path of a message to a working orchestrator,
  what the person sees, both adapters' `_session/steering` contracts with file locations, hook points,
  and where a default "steer vs queue" setting could live.
- [clowdy-subagents.md](clowdy-subagents.md): `run_spawn` end to end, the Agents tree, what the stream
  shows, `NativeAgents`, what Claude's adapter sends with and without the `subagents` opt-in (the opt-in
  replaces the `Agent` tool call with `session_message`), the delegation guidance, hook points for cards.

## Key files

| File | Role |
| --- | --- |
| `packages/protocol/src/domain.ts` | `Run` (`parentRunId`, `origin`, `context`), `StreamItemBody`, `ProjectSettings` |
| `packages/protocol/src/commands.ts` | `chat.send`, `chat.compact`, `project.update` schemas |
| `packages/protocol/src/agents.ts` | `AgentInfo.canCompact`, `settings` |
| `apps/daemon/src/commands/chat.ts` | `send()` (queue vs resume by run status), `'chat.compact'` |
| `apps/daemon/src/runs/driver.ts` | `RunDriver`: `spawn`, `launch`, `deliver`, `turn`, `consume`, `waitToRetry`, `settle` |
| `apps/daemon/src/runs/service.ts` | `RunService`: `createRun`, `createNative`, `resume`, `setContext`, `hasUnseenResults` |
| `apps/daemon/src/runs/native.ts` | `NativeAgents`: `subagent` events as native child runs |
| `apps/daemon/src/runs/run-tools.ts`, `runs/tools.ts` | `run_spawn` and the run tools; tools per role |
| `apps/daemon/src/runs/prompts.ts` | `systemPrompt`, `skillPrompt`, `firstMessage` |
| `apps/daemon/src/engine/types.ts` | `EngineSession.send(text)`, `EngineEvent` (`context`, `subagent`, `agentId`) |
| `apps/daemon/src/engine/acp/session.ts` | `AcpSession`: `initialize`, client capabilities, inbox and prompt loop, root-session filter |
| `apps/daemon/src/engine/acp/mapper.ts` | `UpdateMapper`: text, tools, names, `usage_update` → `context` |
| `apps/daemon/src/engine/acp/catalog.ts`, `registry.ts` | `AgentSpec.compact`, Claude's `subagents` setting, `canCompact` |
| `apps/daemon/src/engine/fake.ts` | Demo engine: context readings, steer-like `checkpoint()`, one native sub-agent |
| `packages/system-skills/skills/orchestrate/SKILL.md`, `references/fan-out.md` | Delegation guidance agents get |
| `apps/desktop/src/renderer/features/chats/Composer.tsx`, `ComposerSend.tsx` | Message box, Send vs Stop |
| `apps/desktop/src/renderer/features/chats/ContextRing.tsx`, `contextUsage.ts` | Ring, popover, Compact |
| `apps/desktop/src/renderer/stream/StreamView.tsx`, `ToolCard.tsx`, `toolView.ts`, `turns.ts` | Stream rendering, generic tool line, turn folding |
| `apps/desktop/src/renderer/features/agents/agentTree.ts`, `AgentList.tsx`, `RunDetail.tsx`, `stores/runTree.ts` | Chats tree with nested runs, run page |
| `apps/desktop/src/renderer/features/settings/Screen.tsx`, `settings/ui/`, `settings/projects/ProjectDefaults.tsx`, `stores/storage.ts` | Where settings live |
| `apps/desktop/src/renderer/daemon/fixtureData.ts`, `fixtureTransport.ts`, `config.ts` | Demo data and the in-memory daemon |
| `~/.bun/install/cache/@agentclientprotocol/claude-agent-acp@0.107.0@@@1/dist/`, `codex-acp@2.6.0@@@1/dist/index.js` | The pinned adapters (read, not run) |

## Tests and demo data

- **Desktop:** `bun run test` in `apps/desktop` (Vitest, `vitest.config.ts`: node by default,
  `// @vitest-environment happy-dom` per file, a Babel plugin for decorators). The tests have no MobX
  observer, so a component is drawn again by hand when the store changes (see `ContextRing.test.tsx`).
  Helpers: `daemon/testing.ts` `overrideTransport`, `features/chats/modelTestKit.ts` (a store on the
  fixture agents and models).
- **Daemon:** `bun test` in `apps/daemon` (needs `bun:sqlite`). `test/helpers.ts`: `startHarness`,
  `GateEngine`, `ScriptEngine` (records `sent`), `SHORT_TIMINGS`, `testAgents`; ACP tests drive
  `test/fake-acp-agent.ts` (one directive per prompt line: `say`, `tool`, `call`, `usage`, `context`,
  `/compact`, `sleep`, ...) through `test/acp-helpers.ts`. `CLOWDY_FAKE_SPEED=0` removes the fake
  engine's delays.
- **Demo modes:** `?fixtures` (the in-memory `FixtureTransport` with timed events; `?fixtures=static`
  without them) or a real daemon with `CLOWDY_ENGINE=fake`. The fixtures have a context reading on
  `r-orch-1`, spawned children, no native runs, no `Agent` or `run_spawn` tool items, a `chat.compact`
  that only halves the reading, and a `chat.send` that never ends its turn. New features should extend
  both `fixtureData.ts`/`fixtureTransport.ts` and `engine/fake.ts`.

## Open questions research could not answer

- How `_session/steering` behaves through Clowdy's one-process-per-turn model, and what Claude does
  with a steer during an MCP tool call that waits (`run_wait`, `ask_user`): nothing was run.
- What Claude does with a prompt `/compact\n\n<message>` (custom compaction instructions is the guess).
- Whether Codex 2.6.0 sends `compaction_update` live when `session.compaction` is advertised, and
  whether Claude's own auto-compaction shows up with `trigger: 'auto'` in practice.
- Whether a Claude sub-agent's text and tool calls really reach Clowdy's root stream today (the adapter's
  code says so; not observed).
- The exact shape of `run_spawn`'s result as each adapter reports an MCP tool result (text in `content`
  or `rawOutput`), which a card would parse for the child's `runId`.
- Steering and sub-agent signals of Cursor, OpenCode, Gemini and the other catalog agents.

## Limits

Read only: current source, the SDK in `node_modules`, the pinned adapters in the Bun cache, and the
earlier probe logs in `../../provider-surfaces/research/session-verification.md`. No agent, daemon or
app was started; nothing was changed outside this folder. Line numbers in the adapters' bundles are
approximate.

## Reforma reference

How Reforma (`/Users/bionic/WORK/Reforma/reforma`, read-only) builds the same three features, with
file paths, data shapes, copy, styles, and a split between what ports to an ACP client and what
depends on Reforma's own agent.

- [reforma-queue-steer.md](reforma-queue-steer.md): server-owned queue of `steer` and `next-turn`
  items, the queue strip in the composer (Steer, Edit, Remove, drag, paused note, edit bar),
  Enter vs Cmd+Enter, steers rendered as user bubbles inside the reply. No default-behaviour setting
  exists in Reforma.
- [reforma-compaction.md](reforma-compaction.md): context-usage ring and popover with a Compact button
  that sends `/summarize` as a turn, and the one-line "Summarizing chat context" / "Chat context
  summarized" notice in the stream. Thresholds are Reforma-agent-only.
- [reforma-subagents.md](reforma-subagents.md): the `Agent` tool card (live activity line, no inline
  nested calls), composer strips for running sub-agents, the child-thread view, and the
  `data-subagent-status` patch that feeds them.

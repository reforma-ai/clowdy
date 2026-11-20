# Threads

> Keep this plan current during implementation.
> Check off tasks as their outcomes are completed.
> Check a stage only after done-when, verification, review, and commit
> (or staging per project rules).
> Record scope changes before leaving the stage.
> Record landed commits under the stage they implement.

**Goal:** an agent delegates work to threads (child chats it drives through a `clowdy thread` shell command), the person sees and writes to them, and the parent is woken at every stop of a thread; `run_spawn` and its child-run machinery are gone.

**Approach:** Delete `run_spawn` first (tools, roles, mailbox, `waiting_children`, caps, skills, UI). Then a thread is a child **Chat** (`Chat.parentChatId`) with its own root orchestrator run, so queue, steer, composer, model and archive work unchanged. Agents reach threads through a CLI that calls the daemon over the tool bridge's loopback listener with a per-session credential, not through MCP tools. A thread's turn end becomes a notice to the parent, delivered through the parent's chat queue, so the parent starts a turn when at rest. Research: `research/index.md` (bb read at `9f4c156`), `research/clowdy-mapping.md`.

**Decisions**

- `run_spawn` is deleted with everything that exists only for it: the tools `run_spawn`, `run_inspect`, `run_wait`, `run_cancel`, `report_result`; the role `verifier` and the relation `verifies`; `Run.origin: 'spawned'`; the status `waiting_children`; `run_mailbox` and `Wakeups`; `maxActiveChildren`, `maxChildren`, `wakeWindowMs` and `MAX_DEPTH`; the skills `executor` and `verify` and every instruction to spawn runs. Tasks, `task_*` tools, the assignment of a chat's own run to a task, native sub-agents (`origin: 'native'`, role `executor` kept as their name only) and `run.stopAgents` for native sub-agents stay.
- Old databases: a migration makes finished `spawned` runs `native`, `verifier` runs `executor`, `waiting_children` runs `succeeded`, and drops `run_mailbox`. History is kept, nothing is deleted.
- A thread is a child Chat: `Chat.parentChatId`, its own root orchestrator run (not a child run). Any chat orchestrator may create threads, threads too. Depth 3 levels in total (root, L1, L2), `CLOWDY_MAX_THREAD_DEPTH`; `CLOWDY_MAX_ACTIVE_THREADS` (30) and `CLOWDY_MAX_THREADS` (300) per chat.
- Agents use the shell command `clowdy thread <command>`, the daemon exposes the same operations as `ToolDefinition`s on the bridge listener that the CLI calls; they are not advertised over MCP. The command is on `PATH` and in `CLOWDY_CLI`; the credential is in `CLOWDY_CLI_AUTH` (a name Codex's default environment filter keeps) and works only while the session lives.
- Commands, only the useful ones: `spawn` (prompt, title, engine, model, effort, mode, tasks, cwd), `tell` (`--mode steer|queue`, default steer), `stop`, `wait`, `output`, `log`, `list`. Not now: fork, notify policy, detach, interactions.
- `tell` reaches any chat of the same thread tree (the same root chat), except the sender itself. `stop` and `wait` work on threads below the caller. Stopping a parent does not stop its threads; archive cascades to threads; delete cascades after every run is over.
- A thread stop is a notice to its parent: at every turn end of a thread's orchestrator (also a turn the agent starts by itself, and while its session waits for background work), if the turn said something; a failed or interrupted thread always notifies; a Stop by the person or by `thread stop` does not. Notices of the same thread merge (latest text wins), those of several threads inside a 2 s window (`CLOWDY_THREAD_NOTICE_WINDOW_MS`) become one message.
- The notice goes through the parent's chat queue: a parent at rest (also one that waits for background work) starts a turn at once, a busy parent gets a queued item that merges with the notices already waiting, a held queue (Stop, failure) holds it. No steer into a running turn. `thread wait` and `thread output` remove a pending notice of that thread: the parent that read the answer is not told again.
- A thread to its parent chain is told by the stream's `user` item with a `from` (`thread` for a `tell`, `threadNotice` for stops), which the app draws as a card.
- Desktop: threads are nested rows under their parent chat in the Agents list, collapsed by default (a collapsed thread is hidden, so the "show subthreads" check goes), the "show finished subthreads" check stays; active threads are rows above the composer like sub-agents, with Stop; a thread's chat page is a normal chat page with a crumb to its parent.
- bb's behaviour is the reference for everything not named here; the 27 questions of `research/grill-questions.md` are answered by its recommendations unless this list says otherwise.

**Reuse:** `ChatQueue` (`apps/daemon/src/runs/queue.ts`), `send` of `commands/chat.ts`, `RunService.createRun({ assigned })`, `ToolBridge` (`engine/acp/bridge.ts`), `defineTool` (`runs/tool-kit.ts`), `describeItem` of `run-tools.ts` for `log`, `ScriptEngine` and `startHarness` of `test/helpers.ts`, `RunningAgents`/`ComposerBanner` and `agentRows` on the desktop.

## Out of scope

- `fork`, `notifyParent` policy, `chat.setParent` (detach), answering a thread's question from its parent, per-thread worktrees, a cap on lingering thread sessions, remote hosts.
- Windows (the `.cmd` shim is written, not checked), a Cursor-specific path beyond what its ACP session already does.

## Stage 1 — Delete `run_spawn` and the child-run machinery

**Depends on:** None.

**This stage:** One bounded deletion so the later stages build on a smaller model. The daemon, protocol, system skills and desktop lose every trace of spawned child runs; what stays is a chat's own orchestrator, native sub-agents and tasks. The orchestrator skill is rewritten to the loop without fan-out (threads come back in Stage 4), so it says to do the work itself or with the agent's own sub-agents. Old data is migrated, never dropped. Workers own disjoint trees: daemon and protocol, system skills and docs, desktop.

- [x] Complete
  - [x] Tools, driver, service, queue, wake-ups, mailbox, config and migration 15 removed or reduced (daemon)
  - [x] Protocol types and commands reduced (`waiting_children`, `verifier`, `spawned`, `verifies`)
  - [x] Skills `executor` and `verify` deleted, `orchestrate`, `autopilot`, `semi-manual`, `scaffold` rewritten without `run_*`
  - [x] Daemon tests rewritten or deleted with what they covered
  - [x] Desktop: spawn card, Executors section kept only for native/assigned runs, fixtures, tree, strip, status maps reduced
  - [x] `apps/daemon/AGENTS.md`, `apps/desktop/AGENTS.md`, `packages/system-skills/README.md` describe the smaller model

**Files**

- `apps/daemon/src/runs/{run-tools,tools,wake,reports,driver,service,queue,prompts,transitions}.ts`, `db/{runs,migrations}.ts`, `config.ts`, `daemon.ts`, `engine/fake.ts`, `commands/{run,task}.ts` — remove spawn paths; `wake.ts`, `reports.ts` deleted
- `packages/protocol/src/{domain,commands,agents}.ts` and tests
- `packages/system-skills/skills/*`, `scripts/validate.ts`, `README.md`
- `apps/daemon/test/*` — tests of the removed behaviour deleted, the rest adapted
- `apps/desktop/src/renderer/{stream,features,stores,shared,daemon}/…` — spawn card, status maps, fixtures

**Done when:** no `run_spawn`, `waiting_children`, `run_mailbox` or spawned run is left in code, tests or docs, and the three test suites and typecheck pass.
**Verify:** `bunx turbo run lint typecheck test --affected`
**Commits:**

- `43fa987` refactor: remove run_spawn and the child-run machinery (daemon, protocol, skills, desktop in one commit: the daemon test that checks the skills against the tools spans them). Beyond the plan: migration 15 also drops `runs.outcome`, cancels spawned runs still active and moves their tasks back to To do; the protocol gained the thread message types early. Review found and fixed the task move, a dead compact check, `ToolDeps.driver` and stale comments.

Carried to later stages: restore `describeItem` (the old `run_inspect` line formatter) for `thread log`; old chat streams show `run_spawn` calls as plain tool lines.

## Stage 2 — Thread model and the thread tools

**Depends on:** Stage 1.

**This stage:** A thread exists as data and an agent's tool call can use it. `Chat.parentChatId` and migration 16; a `ThreadService` in the daemon that creates a thread chat through the shared send path, tells another chat (stream item `from`, queue item `from`), stops a thread and reads one (`output`, `log`, `list`). Limits and the tree rule are enforced. Tools are `ToolDefinition`s marked for the CLI surface. No notice and no CLI yet; tests call the tools through `ScriptEngine`.

- [x] Complete
  - [x] `Chat.parentChatId`, `MessageSource`, `from` on `user` items and queued messages (protocol), migration 16
  - [x] `send` split so a thread spawn and a tell share it (`from`, mode, at rest or queued)
  - [x] `thread_spawn` (inherits engine, model, effort, mode; tasks assign the thread's run; limits)
  - [x] `thread_tell`, `thread_stop`, `thread_output`, `thread_log`, `thread_list`
  - [x] Archive and delete cascade, `chat.delete` guard over threads
  - [x] `threads.test.ts`

**Files**

- `packages/protocol/src/{domain,commands,api}.ts` — `Chat.parentChatId`, `MessageSource`, `StreamItemBody.user.from`, `QueuedMessage.from`
- `apps/daemon/src/db/{migrations,chats}.ts`, `domain/{chats,queue,items}.ts`, `config.ts`
- `apps/daemon/src/commands/chat.ts` — `send` moves to `runs/messages.ts`: cannot stay in the command file because threads call it too
- `apps/daemon/src/runs/threads.ts` — create: `ThreadService` (spawn, tell, stop, read), cannot join `queue.ts` (a service of its own over chats and runs)
- `apps/daemon/src/runs/thread-tools.ts` — create: the tool definitions; `tools.ts` registers them
- `apps/daemon/test/threads.test.ts` — create

**Done when:** a scripted orchestrator spawns a thread, tells it with steer and queue, reads its output and log, stops it, and every refusal (depth, caps, tree, archived) is a test.
**Verify:** `cd apps/daemon && bun test && bun run typecheck && bun run lint`; `cd packages/protocol && bun run typecheck`
**Commits:**

- `14e8859` feat(daemon): add threads as child chats with the thread tools. Review found and fixed: `thread_output` returned the first 4,000 characters of the whole turn instead of the final message, clipping could split an emoji, a pass-through helper, error punctuation. `thread_stop` also stops a thread in `waiting_background` (its session holds work); the tools carry `cli` metadata for Stage 4.

## Stage 3 — Notices and `thread wait`

**Depends on:** Stage 2.

**This stage:** The parent learns that a thread stopped. A turn-end hook in the driver (every turn of a thread's orchestrator, including agent-started ones and the stop into `waiting_background`) hands the thread's text to a `ThreadNotices` buffer; a failed or interrupted thread notifies too, a Stop does not. The buffer merges per thread, waits `CLOWDY_THREAD_NOTICE_WINDOW_MS`, then delivers one message through the parent's queue (turn at rest, merged queued item when busy). `thread_wait` blocks until the thread rests and removes the thread's pending notice, as `thread_output` does.

- [ ] Complete
  - [ ] Turn-end hook in `RunDriver` and failed/interrupted status hook
  - [ ] `ThreadNotices`: merge per thread, window, at-rest turn, merged queue item, held queue
  - [ ] `thread_wait` and consumption of a pending notice
  - [ ] Restart: a queued notice survives (it is a queue item); a buffered one is lost by design
  - [ ] Tests: one stop, two stops, two threads in the window, background wait notice, empty stop, Stop, failed, busy parent, held queue, wait consumes

**Files**

- `apps/daemon/src/runs/driver.ts` — `settle`/`onDone`: `onTurnEnd` callback; `service.ts` — status hook for failed/interrupted
- `apps/daemon/src/runs/notices.ts` — create: `ThreadNotices` (a buffer and delivery of its own, not part of `queue.ts`)
- `apps/daemon/src/runs/queue.ts` — `enqueueNotice` merging into one item; `runs/thread-tools.ts` — `thread_wait`
- `apps/daemon/src/daemon.ts`, `config.ts`
- `apps/daemon/test/threads.test.ts`

**Done when:** a thread that stops (also a second time while its session waits for background work) wakes a parent at rest once per window with its text, and a parent that waited or read the output is not told again.
**Verify:** `cd apps/daemon && bun test && bun run typecheck && bun run lint`
**Commits:** None yet.

## Stage 4 — The `clowdy` command, prompts and skills

**Depends on:** Stage 3.

**This stage:** Agents can actually call the thread tools from a shell. The daemon writes a `clowdy` shim into its data folder at start; the bridge registers each session's CLI tools under a credential and hands `CLOWDY_CLI_AUTH`, `CLOWDY_CLI_URL`, `CLOWDY_CLI` and `PATH` to the agent process; a small CLI (`cli/main.ts`, shipped as `cli.js` in the bundle) turns `clowdy thread <command> --flag value` into a call by the tool's schema. Skills and prompts teach it (`clowdy:orchestrate` fan-out through threads, a thread's own intro). A real check with Claude Code, Codex and Cursor shows whether each reaches the daemon.

- [ ] Complete
  - [ ] Bridge: CLI tools per session, not listed over MCP, env for the agent process
  - [ ] Shim written at start (`bin/clowdy`, `.cmd`), bundle entry `cli.js`
  - [ ] CLI: schema-driven flags, `--json`, `--prompt-file`, stdin, exit codes, `--help`
  - [ ] Skills `orchestrate`, `autopilot`, `semi-manual`, `scaffold` use threads; `thread` intro in the system prompt of a thread's run; vocabulary test covers `clowdy thread` commands
  - [ ] Real check: Claude Code, Codex, Cursor call `clowdy thread list` from their shell, results recorded under `.briefback/threads/research/`

**Files**

- `apps/daemon/src/engine/acp/{bridge,engine,session,env}.ts`, `engine/types.ts` — CLI surface and env
- `apps/daemon/src/cli/main.ts` — create: the program an agent runs; it cannot join `mcp-stdio.ts` (a different protocol and a different entry)
- `apps/daemon/src/cli/shim.ts` — create: the shim writer, called from `daemon.ts`
- `apps/daemon/scripts/bundle.ts`, `apps/daemon/src/runs/prompts.ts`, `packages/system-skills/skills/**`, `apps/daemon/test/skills-vocabulary.test.ts`, `apps/daemon/test/cli.test.ts` — create

**Done when:** a test starts the CLI against a real daemon harness and spawns, tells, waits and reads a thread with the fake engine, and the real check says which agents reach the daemon.
**Verify:** `cd apps/daemon && bun test && bun run typecheck && bun run lint`, then the real check by hand
**Commits:** None yet.

## Stage 5 — Threads in the desktop

**Depends on:** Stage 2 (contract); Stage 3 for live notices.

**This stage:** The app shows threads. Rows nest under the parent chat, collapsed by default; the filter loses "subthreads" and keeps "finished subthreads"; the strip above the composer lists active threads like sub-agents, with Stop; the stream draws `from` as a card (`<thread> finished`, `Message from <thread>`); a thread's chat page has a crumb to its parent; archive and delete confirmations list the cascade. The fixture daemon follows the new rules.

- [x] Complete
  - [x] `agentRows`, folds (collapsed by default), `visibleChats`, filter menu
  - [x] `RunningAgents` rows for active threads, Stop, Stop all for threads
  - [x] Stream card for `from`, queue row for a queued notice
  - [x] Crumb, archive/delete cascade text, fixtures, tests
  - [x] `apps/desktop/AGENTS.md`

**Files**

- `apps/desktop/src/renderer/features/agents/{agentTree,AgentList,Screen}.tsx`, `features/chats/{RunningAgents,runningAgentRows,ChatView,ComposerQueue}.tsx`, `stream/*`, `stores/*`, `daemon/{fixtureData,fixtureTransport}.ts`, `apps/desktop/AGENTS.md`
- `packages/components` — only if a component is missing (read its `AGENTS.md` first)

**Done when:** the fixture app shows a thread tree that folds, rows above the composer with Stop, and the cards, and the desktop tests, lint and typecheck pass.
**Verify:** `bunx turbo run lint typecheck test --filter=@clowdy/desktop`
**Commits:**

- `58e6c6e` feat(desktop): show threads as nested chats with their own rows and cards. Review found and fixed: the hand-off transcript wrote a thread's messages as the person's words and dropped notices; long thread messages are clamped; one rule for "threads at work". A queued message from a thread is shown with the sender's title.

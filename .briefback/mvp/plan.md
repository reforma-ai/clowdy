# Clowdy MVP

> Keep this plan current during implementation.
> Check off tasks as their outcomes are completed.
> Check a stage only after done-when, verification, review, and commit.
> Record scope changes before leaving the stage.
> Record landed commits under the stage they implement.

**Goal:** a working prototype in which Clowdy runs many parallel agents on its own repository, so the next change to Clowdy can be made with Clowdy.

**Approach:** A standalone Bun daemon owns projects, chats, an internal task list, agent runs, git worktrees, documents, and a SQLite store; the Electron renderer is a client over a loopback HTTP + SSE contract (`packages/protocol`). Agents run through an engine adapter on the user's Claude (and, if cheap, Codex) subscription; an orchestrator run spawns executor runs that are linked many-to-many with tasks. The UI follows the four wireframes (Chats, Tasks, Agents, Documents) built from the Reforma-derived components.

**Decisions** (the owner asked for speed over perfection; each can be revisited)

- The task list is internal and the source of truth. Linear or any other tracker is an optional external source behind a `TaskProvider` seam (`Task.external`), not built now.
- Runs are linked to tasks many-to-many (`RunTaskLink`); chats are linked to tasks many-to-many (`ChatTaskLink`). A run is never a chat, a task, or a role.
- Engines run on subscriptions, never silently on API keys. Engine and auth choice are configuration, with no connect UI in the MVP. See `research/` for the verdict.
- Parallelism is real and bounded by a configurable cap in the daemon (global and per project); the design must not assume a low ceiling, but the MVP is exercised at tens of runs, not thousands.
- Documents live in one fixed folder per project, `.clowdy/docs/` (the spec's `.factory/docs/` followed the product's old working name; the path is a single constant).
- Daemon: Bun, `bun:sqlite`, `Bun.serve` HTTP + SSE on loopback with a bearer token. Dogfooding runs the daemon from the repo with Bun; packaging it comes later.
- Cursor events carry whole entities (upserts), clients resync from a snapshot, commands are idempotent by `requestId`.
- Daemon tests run with `bun test` (they need Bun's runtime); everything else keeps Vitest.
- Skills are first-class. System skills ship with the app and encode the delivery loop (research, grill, task-graph planning, parallel fan-out, serialized integration, merged-result verification), scaffolding from scratch, and the autopilot and semi-manual modes; project and user skills work alongside them. See `system-skills.md`.
- Everything is files and SQLite. The app is fully desktop now and the daemon will later run on a remote machine, so all state lives in the daemon's data dir (SQLite plus plain files; documents are files in the repo) and nothing depends on a cloud service or on sharing a process with the UI.
- Git, branches and worktrees are the agent's internal business, exactly as in a normal Claude Code session. Clowdy is for people who manage work, not for programmers, so the daemon has no worktree tools, no merge queue, and no git concepts in the main UI. Agents get Bash (the engine's own), a small set of Clowdy tools, and skills that describe the flow; they decide per task whether to work in the project's main checkout, create a worktree with plain `git worktree`, branch, merge, or commit. A question-only chat touches no git at all. `run_spawn` takes an optional `cwd` so a sub-run can work where its parent decided.
- One task, one chat: starting a task opens a new chat whose orchestrator is bound to it. A chat can create 0-N tasks and work on them, or just answer a question.
- Fan-out has two forms and the orchestrator picks: engine-native sub-agents (cheap, in-process, hundreds possible; the adapter maps their events to child runs so the Agents tree shows them) and Clowdy-level runs through `run_spawn` (own process and session, can use another engine, bounded by the scheduler caps).

**Reuse:** `packages/components` (UI), `packages/styles`, `packages/icons`, the renderer shell in `apps/desktop`, and parts of Reforma's agent (catalog in `research/reforma-agent/README.md`).

## Out of scope

- Daemon-side git machinery of any kind (worktree tools, merge queue, integration branch): agents use git themselves, Linear or any provider sync, webhooks, remote UI, cloud execution, auto-update, installers and signing, an engine connect/auth UI, BriefBack's exact method (semi-manual mode asks questions through a simple card protocol).

## Stage 1 — Contract

**Depends on:** None.

**This stage:** `packages/protocol` fixes the domain model, events, commands, and HTTP routes that the daemon and the renderer are built against in parallel.

- [x] Complete
  - [x] Domain types, event union, command schemas, route table

**Files**

- `packages/protocol/src/*` — create

**Done when:** the package typechecks and both sides import it.
**Verify:** `bun run typecheck`
**Commits:** None yet.

## Stage 2 — Daemon core

**Depends on:** Stage 1.

**This stage:** the engine-less daemon: storage with migrations, the event log and cursor, idempotent commands, project/chat/task/run CRUD with the run state machine, stream items, the docs service with hash-checked atomic writes and a file watcher, auth token and single-instance lock. A `fake` engine produces runs, tool items, and child runs so the UI works without spending subscription quota.

- [ ] Complete

**Files**

- `apps/daemon/**` — create

**Done when:** the daemon starts standalone, answers the contract, and `bun test` covers storage, commands, events, docs.
**Verify:** `bun run --cwd apps/daemon test`
**Commits:** None yet.

## Stage 3 — Renderer core

**Depends on:** Stage 1.

**This stage:** the app shell (project select in the title band, left rail, section outlet), the daemon client (snapshot + SSE with cursor resume), the stores, and the shared stream components used by Chats and Agents.

- [ ] Complete

**Files**

- `apps/desktop/src/renderer/**` — shell, client, stores, shared stream components

**Done when:** the shell renders the four sections against a running daemon.
**Verify:** `bun run --cwd apps/desktop typecheck` and a CDP check against `./clowdy dev`.
**Commits:** None yet.

## Stage 4 — Screens

**Depends on:** Stages 2 and 3.

**This stage:** Chats, Tasks (kanban, list, detail panel), Agents (tree, stream), Documents (tree, editor) — one owner per screen folder.

- [ ] Complete

**Done when:** each screen works against the fake engine.
**Verify:** typecheck, lint, CDP walkthrough.
**Commits:** None yet.

## Stage 5 — Engines

**Depends on:** Stage 2 and the research notes.

**This stage:** the engine adapter interface and a real subscription-backed adapter, with cancel, resume, and event mapping onto stream items.

- [ ] Complete

**Done when:** a real run streams into a chat on the user's subscription.
**Commits:** None yet.

## Stage 6 — Orchestration

**Depends on:** Stages 2 and 5.

**This stage:** the scheduler (caps, queue, backoff on subscription limits), orchestrator tools (create/update tasks, spawn runs bound to tasks with an optional cwd, wait, cancel, ask the user, report result), mapping of engine-native sub-agent events to child runs, subtree cancellation, restart recovery, one chat per started task.

- [ ] Complete

**Done when:** an orchestrator turns a request into tasks and runs several sub-agents in parallel in one checkout; it may use a worktree through plain git when it judges that worthwhile; a dependent task waits; a plain question touches no git.
**Commits:** None yet.

## Stage 7 — Shell integration and dogfooding

**Depends on:** Stages 4 and 6.

**This stage:** Electron starts or attaches to the daemon, opens a repository, and the owner opens Clowdy's own repo as a project and makes a change with it.

- [ ] Complete

**Done when:** `./clowdy dev` opens the app wired to a live daemon, and a real change to this repo is made through it.
**Commits:** None yet.

## Stage 8 — System skills

**Depends on:** Stages 5 and 6.

**This stage:** the bundled system skills (`system-skills.md`) and skill loading for every engine: discovery roots and precedence, a catalog the daemon serves, and a settings view. The orchestrator and executors are driven by these skills, so this stage turns the machinery of Stages 5-6 into the intended workflow.

- [ ] Complete

**Done when:** a new run in autopilot and one in semi-manual mode follow the system skills visibly, and a project skill is picked up alongside them.
**Commits:** None yet.

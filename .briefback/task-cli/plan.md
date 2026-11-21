# Tasks as a shell command

> Keep this plan current during implementation.
> Check off tasks as their outcomes are completed.
> Check a stage only after done-when, verification, review, and commit
> (or staging per project rules).
> Record scope changes before leaving the stage.
> Record landed commits under the stage they implement.

**Goal:** agents read and change tasks with `clowdy task get|list|create|update` in their shell, like threads, with a list that never floods their context, and with MCP as a per-agent fallback that runs the same code.

**Approach:** Stage 1 redesigns what the four task tools accept and return (filters, paging, counts, precise edits) while they are still MCP tools, so the contract is tested on its own. Stage 2 marks them as shell commands (`ToolDefinition.cli`), adds a per-agent switch that keeps MCP for an agent that needs it, and moves prompts, system skills, the skill validator and the docs to the command vocabulary. Stage 3 checks real agents on a scratch daemon and sets the switch from what it shows.

**Decisions** (made by the agent with the owner's delegation; the owner trusts Linear's design, so each follows what Linear does where that is known)

- **One execution path, two doors.** `ToolBridge` stays the only place a task tool runs; the shell command and the MCP server are two clients of `POST /call`. Per agent, a task tool is a shell command (default) or an MCP tool (`AgentSpec.taskTools: 'mcp'`; a custom agent says `"taskTools": "mcp"` in its `agents.json` entry), chosen when the session registers its tools. No automatic fallback at run time and no per-run choice.
- **Closed means solved.** A task in the `done` or `canceled` category is closed; `backlog` is parked. There is no separate archive flag and no archive status now. Linear archives closed issues on a timer and hides them from views and search by default; here the same effect comes from defaults (below), and a stored archive needs board controls, so it is out of scope.
- **`task list` shows open work by default:** categories `todo`, `active` and `review`, not `backlog`, not closed. Rules, first match wins: `status` shows those statuses (a category names every status in it); `all` shows every task; `query` shows every task (a duplicate check must find closed work); otherwise open work. `ready`, `blocked`, `running`, `mine` and `updatedSince` narrow whatever that shows.
- **Full argument list of `task list`** (Linear's `list_issues` filters mapped to our model): `query` (text in key, title, description), `status` (list; each entry an id, a status name or a category), `all`, `ready` (not closed, every dependency `done`), `blocked` (not closed, some dependency not `done`), `running` (an active run works on it), `mine` (linked to this chat), `updatedSince` (ISO date or a duration such as `12h`, `7d`), `sort` (`updated` default, newest first; `created`, `number`), `reverse`, `limit` (default 25, at most 100), `cursor`.
- **List rows are compact and carry no description:** `key`, `title`, `status`, `category`, `dependsOn` (keys), `blockedBy` (keys of unfinished dependencies, absent when none), `running` (true when a run works on it, absent otherwise), `updatedAt` (ISO). `task get` has the rest.
- **Every list answer says what it hid:** `total` (tasks matching), `shown`, `nextCursor` (absent on the last page), and `counts` by category for the whole project, so 100 backlog and 500 done tasks show as two numbers. The first page also carries `statuses` (id, name, category); a page that has a `cursor` does not repeat it. Paging is by cursor (Linear: Relay cursors, 50 by default): the cursor is opaque text that encodes the sort position, so tasks changing between pages do not repeat or skip rows.
- **`task get`** answers: `key`, `title`, the full `description`, `status`, `category`, `dependsOn` as `{ key, title, status }`, `blocks` (the same shape, the tasks waiting for this one), `activeRuns`, `createdBy`, `createdAt`, `updatedAt`.
- **One status field.** `status` (an id, a name or a category) replaces the `statusId` and `status` pair on create and update. A miss lists the project's statuses, as now.
- **`task create`:** `title` (the positional word list), `description` (and `--description-file -` for a heredoc), `status`, `dependsOn`, `blocks` (existing tasks that will depend on the new one, so a prerequisite can be added after the fact). Cycles and cross-project links are refused by the existing rules.
- **`task update`:** `taskId` (positional), `title`, `description` (replaces), `append` (text added after a blank line at the end of the description: the notes skills write today by reading the description first and sending it all back), `status`, `dependsOn` (replaces the list), `addDependsOn`, `removeDependsOn`. Refused together: `description` with `append`; `dependsOn` with `addDependsOn` or `removeDependsOn`.
- **No `task delete`, `task start` or comments for agents.** Deleting and starting stay with the person (UI commands).
- **Hard cut of the MCP names in skills.** System skills, prompts and the skill validator speak the command form (`clowdy task update CLW-3 --status review`). The system prompt has one Tasks line for every agent: the command, and that tools named `task_get`, `task_list`, `task_create` and `task_update` (flags as camelCase fields) are the same commands for an agent that has them as MCP tools.
- **Linear facts these follow** (read 2026-11-21): auto-archive after a configurable period hides closed issues from views; the GraphQL `issues` query returns 50 by default with `first`/`after` cursors and `includeArchived`; filters are per field; `linear issue list` shows the user's unstarted issues by default and `issue query` takes `--state` (type, name or id), `--search`, `--limit`, `--json`; `issue update` has `--clear-*` flags. Linear's own MCP tool schema is not published on its docs, so it was not copied.

**Reuse:** `ToolBridge` and `ToolDefinition.cli` (`apps/daemon/src/engine/acp/bridge.ts`, `cli/args.ts`, `cli/clowdy.ts`); `defineTool`, `taskRef` (`runs/tool-kit.ts`); `resolveStatus`, `describeTask` (`runs/task-tools.ts`); `createTask`, `updateTask`, `resolveTask`, `categoryOf` (`domain/tasks.ts`); `listTasks`, `dependentsOf` (`db/tasks.ts`); `activeRunsOfTask` (`runs/service.ts`); `chatIdsOfTask` (`db/chats.ts`).

## Out of scope

- A stored archive flag, an archive status or auto-archiving of closed tasks, and any board control for it (revisit when the board itself shows too many closed tasks).
- Any change to the desktop task board, its filters or its commands.
- Task comments, labels, priority, estimates, parents and sub-tasks, assignees, a `task delete` or `task start` command for agents.
- Automatic fallback between the channels at run time.
- Copying Linear's MCP tool schema (not published).

## Stage 1 — The task contract

**Depends on:** None.

**This stage:** The four task tools get the inputs and answers in **Decisions**, still as MCP tools, so a flood of closed tasks can never reach an agent and edits are precise. The read side (scope rules, filters, sort, cursor, counts) is pure logic over a project's tasks and gets its own tests. `statusId` goes; `status` takes its place everywhere a tool names a status. Skills and prompts still name the old tools until Stage 2, so this stage changes their field names where they appear.

- [x] Complete
  - [x] `task_list` implements the scope rules, every filter, sort, `limit`, `cursor`, `total`, `shown`, `counts` and first-page `statuses`
  - [x] `task_get` answers with `dependsOn` and `blocks` as key, title and status, plus `createdBy` and the timestamps
  - [x] `task_create` takes `status` and `blocks`; `task_update` takes `append`, `status`, `addDependsOn`, `removeDependsOn` and refuses the conflicting pairs
  - [x] The skills' field names (`statusId`) become `status`

**Files**

- `apps/daemon/src/domain/taskQuery.ts` — create: the read model (`queryTasks`: scope, filters, sort, cursor, counts, row shape) cannot join `domain/tasks.ts`, which holds the rules that change tasks and keeps no listing logic; it has a test file of its own
- `apps/daemon/src/runs/task-tools.ts` — `readTaskTools`, `orchestratorTaskTools`, `describeTask`, `statusField`: new inputs and answers
- `apps/daemon/src/domain/tasks.ts` — `updateTask`, `createTask`: `blocks` and the add/remove dependency edits as one transaction (`dependsOn` of other tasks changes through `updateTask`, so cycle checks still apply)
- `apps/daemon/test/tools.test.ts` — task tool cases; `apps/daemon/test/taskQuery.test.ts` — create: the read model's cases (many closed tasks, scopes, filters, cursor stability)
- `packages/system-skills/skills/orchestrate/SKILL.md`, `skills/autopilot/SKILL.md`, `skills/scaffold/SKILL.md`, `skills/orchestrate/references/plan-and-sizing.md` — `statusId` to `status`

**Done when:** a project with 100 backlog and 500 done tasks answers a bare `task_list` with only its open work, the `counts` of everything else and a page of at most 25 rows, and the filters, cursor and edits behave as **Decisions** says.
**Verify:** `cd apps/daemon && bun test test/taskQuery.test.ts test/tools.test.ts test/skills-vocabulary.test.ts && bun run typecheck && bun run lint`; `cd packages/system-skills && bun run test`
**Commits:**

- `f677ea9` feat(daemon): give task_list a scoped, paged answer and task edits precise inputs

**Review changes:** `status` now wins over `all` when both are given, and a status filter by category matches every status of that category; `append` is trimmed and a blank one is refused; the dependency edit and the append text moved into `dependenciesAfter` and `appended`.

## Stage 2 — The shell channel

**Depends on:** Stage 1.

**This stage:** The task tools become `clowdy task get|list|create|update`. A switch on the agent decides per session whether they are shell commands (the default) or MCP tools, and both doors call the same tool. Prompts, system skills, the skill validator and the docs move to the command form, with the MCP note for sessions that use the switch.

- [x] Complete
  - [x] The four tools carry `cli` options (`task get <task>`, `task create <title>`, `task update <task>`, `task list`) and show in `GET /cli/tools`
  - [x] `AgentSpec.taskTools` (`'cli'` default, `'mcp'`) reaches `toolsFor`; a session of an `mcp` agent registers the task tools without `cli`, and one of a `cli` agent without an MCP server unless `ask_user` needs it
  - [x] The system prompt has one Tasks line that names the command and the MCP equivalents; `clowdy task --help` shows examples of the common flow
  - [x] System skills name commands, never `task_*` tools; the validator knows `clowdy task` commands and the skill vocabulary test checks them against the daemon
  - [x] `apps/daemon/AGENTS.md` and `packages/system-skills/README.md` describe the two doors and the list defaults

**Files**

- `apps/daemon/src/runs/task-tools.ts` — `cli` options on the four tools
- `apps/daemon/src/runs/tools.ts` — `toolsFor`: takes the channel of the run's agent; strips `cli` from the task tools for `mcp`
- `apps/daemon/src/engine/acp/catalog.ts` — `AgentSpec`: `taskTools?: 'cli' | 'mcp'`; `apps/daemon/src/engine/acp/registry.ts` — a `taskChannel(id)` beside `compactCommand`
- `apps/daemon/src/daemon.ts` — the `tools` callback of `RunDriver` passes the channel
- `apps/daemon/src/runs/prompts.ts` — `TASKS` beside `THREADS`: one Tasks line that serves both doors (no per-door prompt, so the driver stays untouched); `taskMessage` says `clowdy task get <key>`
- `apps/daemon/src/cli/clowdy.ts` — `EXAMPLES`: task examples
- `packages/system-skills/skills/**` — every `task_*` call becomes its command; `packages/system-skills/scripts/validate.ts` — `TOOLS` loses the task names, a `TASK_COMMANDS` list appears beside `THREAD_COMMANDS`; `apps/daemon/test/skills-vocabulary.test.ts` — checks both lists
- `apps/daemon/test/cli.test.ts`, `apps/daemon/test/acp-bridge.test.ts` — examples against the real tools; both channels list the right tools
- `apps/daemon/AGENTS.md` — Tools, Agents → The clowdy command, Rewind notes mentioning `task_*`; `packages/system-skills/README.md`

**Done when:** an orchestrator on the scripted engine reads and changes tasks with `clowdy task` commands, the same session with `taskTools: 'mcp'` does it with MCP tools, and no skill, prompt or doc names a `task_*` tool for the default channel.
**Verify:** `cd apps/daemon && bun test && bun run typecheck && bun run lint`; `cd packages/system-skills && bun run test`; `bunx turbo run build lint typecheck test --affected`
**Commits:**

- `c30798c` feat(daemon): run the task tools as the clowdy task command, with MCP as a per-agent door
- `039bd35` (another agent's commit, which held these files whole): `AgentSpec.taskTools`, `CustomAgent.taskTools` and `TaskChannel` in `catalog.ts`, the AGENTS.md notes, and the bound-task message in `threads.test.ts`

**Scope changes:** a custom agent can say `taskTools` in `agents.json` (the runtime test and a person whose agent cannot use the shell route need it); the prompt has one Tasks line for both doors, so `driver.ts` is untouched; the system prompt size caps in `orchestration.test.ts` rose by about 350 characters for that line; `shim.ts` says tasks as well as threads in its warning.

## Stage 3 — Real agents

**Depends on:** Stage 2.

**This stage:** The scripted engine proves the wiring, not what a model does with it. On a scratch daemon (own data folder and port, as the threads work did), a real Claude Code, Cursor and Codex session each reads the task list of a project that holds 100 open and 500 done tasks (the default statuses have no backlog one), creates a task with a heredoc description, updates it with `--append`, and sets a status. The result decides `taskTools` for each agent: `mcp` only where the shell route fails or needs a person's approval on every call (Codex's sandbox is the suspect).

- [x] Complete
  - [x] A research note records, per agent, the commands run, what came back, the tokens of the first list and whether the shell needed approval
  - [x] `taskTools` stays unset for every built-in agent: the note shows none needs the MCP door (the field's own comment in `catalog.ts` points to the note)

**Files**

- `.briefback/task-cli/research/real-agents.md` — create: the note; it is a research artifact and cannot join `plan.md`
- `apps/daemon/src/engine/acp/catalog.ts` — `taskTools` for the agent that needs `'mcp'`, if any

**Done when:** each of the three agents completed the flow, and the note shows why each agent has the channel it has.
**Verify:** the note's own runs; `cd apps/daemon && bun test test/acp-registry.test.ts`
**Commits:** with this plan update.

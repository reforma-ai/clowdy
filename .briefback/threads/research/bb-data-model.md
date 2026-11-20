# bb threads: data model, fork, inheritance, cascades

Source: `get-bb/bb` at `9f4c15646d3d7d9320191d4a2cd76199471a1ddc` (2026-11-19 15:19 -08:00), MIT, shallow clone read only, nothing installed or run. Paths are relative to the bb repo root. "Observed" means read in source; "inferred" means my reading.

## Summary

- A bb **thread is the chat**. There is no separate chat, session or run entity in the app model. A thread row has a status (`pending`, `idle`, `starting`, `active`, `stopping`, `error`), an append-only event log (turns, items), and the provider's own session id recorded in that log.
- **Parent and child** is one nullable column, `threads.parent_thread_id`, set only on request (`--parent-self`). It drives the sidebar tree, the "notify the parent" rule and the archive and delete cascade. It is not a separate kind of object.
- **Fork** is a different relation (`source_thread_id` plus `origin_kind = 'fork'`). A fork is not a child: it is not nested in the sidebar and never notifies anyone.
- Nesting is allowed: up to four levels in total (the root and three more). Observed in `apps/server/src/services/threads/thread-parent.ts`.

## Vocabulary

| bb word | What it is | Where |
| --- | --- | --- |
| Thread | One agent conversation, one row in `threads`, one provider session at a time | `packages/db/src/schema.ts:610-668` |
| Chat | Not an entity. The UI says thread everywhere | none |
| Turn | One request to `turn/completed` in the event log (`turn/started`, `turn/completed` events with a `turnId`). Agent-started turns (background work finishing) have no user message | `apps/server/src/internal/events.ts:412-474` |
| Session | The provider's session id (`providerThreadId`), recorded in events and claimed per thread | `apps/server/src/services/threads/thread-fork-history.ts:177-251` |
| Run | Not an entity. The thread's `status` plus `turn/mainRun/updated` events play that part | `packages/domain/src/thread-status.ts`, `packages/domain/src/thread-lifecycle.ts:28-70` |

Status transitions (observed, `thread-lifecycle.ts`): `idle -> starting|active`, `starting -> active|idle|error|stopping`, `active -> idle|error|stopping`, `stopping -> idle|error`, `error -> starting|active`. Background work is **not** a status: a thread with open background commands is `idle` (counts live in `activity`, see `bb-ui.md`).

## Links between threads (`schema.ts:635-663`)

| Column | Meaning | On delete of the target |
| --- | --- | --- |
| `parent_thread_id` | Sidebar parent and the thread that gets notifications. May be in another project | set null |
| `parent_notifications` | `auto` (default), `stuck`, `off` | n/a |
| `visibility` | `visible` or `hidden`. A child inherits its parent's value unless told otherwise. Hidden threads are for plugin workers | n/a |
| `lifecycle_owner_thread_id` | Immutable, set at creation. Archive or delete of the owner archives or deletes the dependents | restrict |
| `source_thread_id` + `origin_kind` (`fork` is the only value) | Fork relation | set null |

Parenting rules (`thread-parent.ts`):

- `MAX_THREAD_HIERARCHY_DEPTH = 4` (line 6). `assertValidParentThread` (141-171) refuses `self`, `cycle`, `not_found`, `archived`, `deleted`, and `too_deep` when `parentDepth + childSubtreeDepth > 4`. In levels: the root plus L1 to L3.
- Only a live thread can be a parent (not archived, not deleted).
- Changing the parent later is allowed (`bb thread update <id> --parent-thread|--clear-parent-thread`, or drag in the sidebar). The new and the old parent each get a short system notice ("<thread> is now a child of this thread" and the reverse), batched (`thread-ownership.ts`, templates `system-message-thread-ownership-*.md`).
- A fork request that names a parent turns it into the **source**, not the hierarchy parent: `thread-create.ts:633-640` (`hierarchyParentThreadId` exists only when `originKind === null`).

## What a spawned child inherits

| Setting | Rule | Source |
| --- | --- | --- |
| Provider | Explicit `--provider`, else the parent's provider if it can still be selected, else the project default | `project-execution-defaults.ts:125-164` |
| Model, reasoning, service tier | The parent's live values when the provider is the same, else project defaults, else global defaults | `thread-default-policy.ts:242-265` |
| Permission mode | The parent's mode (`accept-edits`, `auto`, `full`), adapted to what the child's provider supports. Nesting does **not** cap permissions; the machine's ceiling still applies | `thread-default-policy.ts:242-262`, `packages/templates/src/templates/bb-guide-threads.md:86-89` |
| Environment (cwd) | With a live parent in the same project: a **new git worktree** on the parent's machine by default. A non-git folder or the personal workspace is reused. `--environment <id>` shares the parent's workspace; `--new-environment personal\|worktree` forces a new one | `thread-default-policy.ts:368-520` |
| Visibility | The parent's | `thread-create.ts:566-577` |
| Env vars for the agent's shell | `BB_THREAD_ID`, `BB_PROJECT_ID`, `BB_ENVIRONMENT_ID`, `BB_THREAD_STORAGE`, plus `BB_CLI`, `BB_SERVER_URL` and `bb` first on `PATH` | `packages/agent-runtime/src/thread-shell-environment.ts:20-30`, `apps/host-daemon/src/runtime-shell-env.ts:395-401` |

Ids and names: `thr_<id>` (`packages/db/src/ids.ts:29`). `title` is nullable; `title_fallback` comes from the first prompt; an AI service can name a thread. Agents refer to threads as `@thread:thr_abc` and to one message as `@thread:thr_abc#msg=42` (`packages/templates/src/templates/bb-guide-thread-inspection.md:129-135`).

## Fork (`bb thread fork`)

Observed in `apps/server/src/services/threads/thread-fork.ts:62-120` and `thread-fork-history.ts`.

- **Point**: `--source-seq-end <seq>`. The anchor is the **completed turn that contains that event sequence**; a sequence on a user message forks before it. Without it, the fork starts from the tip (every completed turn). A turn that has not completed is refused (`fork_source_turn_incomplete`); a turn without a provider session is refused (`fork_source_session_unavailable`).
- **History is copied, not referenced.** The server selects the events of the completed turns up to that turn (`INHERITED_EVENT_TYPES`, `thread-fork-history.ts:253-262`: turn requests, `turn/started`, input accepted, completed items, background task completions, `turn/completed`, compaction) and writes them into the fork's own event log in batches (10 rows or 8 ms per transaction, `copyForkSourceHistory`, line 350) with `providerThreadId` cleared.
- **The provider session is cloned by the provider.** Claude Code and Codex fork at a checkpoint (`fork: "checkpoint"`, `plugins/provider-claude-code/src/bridge/bridge.ts:2350`, `plugins/provider-codex/src/bridge/bridge.ts:1753`; Claude forks the on-disk transcript up to a message id in a worker, `session-fork.ts`). ACP agents fork only at the tip, and only when the agent advertises `session/fork` (`packages/provider-bridge-acp/src/bridge/bridge.ts:2555,4165-4175`, error "ACP session/fork cannot fork at a checkpoint; only tip forks are supported"). **Cursor and Grok are declared `fork: "none"`** (`plugins/provider-acp/src/known-agents.ts:57,158`), so `bb thread fork` on a Cursor thread is refused with "Provider acp-cursor does not support thread forks" (`thread-fork.ts:31-42`).
- Other rules: the source must be live and have a ready environment on the same machine (a fork cannot move machines); the fork reuses the source environment unless `--environment` or `--new-environment` says otherwise; the permission mode and the last model, reasoning and tier are copied from the source; an idle fork (no prompt) is titled "(1) <source title>"; `--agent-context-seed` stores agent-only context without a first run.
- A fork is **not** a child: `isParentNotifiableChildThread` returns false when `originKind !== null` (`thread-parent.ts:21`). The info panel lists it under "Forks" and "Forked from" (`RelatedThreadsSection.tsx:83-91`).

## Persistence

SQLite `bb.db` owned by the server: `threads`, an append-only `events` table, `queued_thread_messages` (see `bb-parent-notifications.md`). A restart keeps all of it. With the general setting `resumeThreadsAfterRestart` (default off) a turn cut by a restart is retried after a few seconds with a message saying what the restart stopped (`packages/templates/src/templates/bb-guide-thread-lifecycle.md:60-76`).

## Archive, stop, delete

| Action | Children | Source |
| --- | --- | --- |
| Stop | Does not cascade ("Stop affects only the requested turn or runtime") | `docs/system-overview.md` ("Thread lifecycle ownership"), `packages/templates/src/templates/bb-guide-thread-lifecycle.md:90-104` |
| Archive | Cascades to every non-deleted child, lifecycle dependent and hidden fork, depth first. A running turn and terminals keep going for the undo grace (`ARCHIVE_UNDO_GRACE_MS`), then the thread is stopped. The UI asks for the cascade list first (`listThreadCascades`, `ThreadActionsProvider.tsx:256-325`) | `thread-archive.ts:117-233` |
| Unarchive | Does not restore dependents | `docs/system-overview.md` ("Thread lifecycle ownership") |
| Delete | Cascades to children and lifecycle dependents, hidden and archived included. The API needs `childThreadsConfirmed: true`, else 409 `child_threads_confirmation_required`. Fork sources alone do not imply deletion | `routes/threads/base.ts:518-545`, `child-thread-confirmation.ts` |

## Open questions

- Where the host daemon keeps a thread's agent process across turns (30 idle minutes, per the guide) was not read.
- How cross-machine threads (remote hosts) reach `BB_SERVER_URL` was not read.

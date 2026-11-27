# Daemon core: HTTP API, runs, engines, domain, database

## Summary

The loopback API is well defended. It checks the Host header against loopback names (DNS rebinding), checks Origin against an allow-list (`app://clowdy` plus `CLOWDY_CORS_ORIGINS`), and requires a constant-time bearer token on every route except `/v1/health`. The terminal WebSocket takes the token as a subprotocol and also goes through the origin check. JSON bodies are capped at 8 MB while they are read. `test/http.test.ts` covers all of these. Agents never get the daemon token: they get a per-session bridge token. All SQL is parameterized; the only interpolations are compile-time constants.

The serious problems are about growth and the hot path, not safety:
- The event log and the command-result table are never pruned. Each 50 ms flush of streaming text writes the whole message again, so storage grows quadratically with message length, and the text of deleted chats stays in the database.
- The streaming path re-reads and re-parses the run and the item on every flush, and reads the whole run row for every text chunk.
- Every SSE client re-queries and re-serializes every event.
- `chat.create` with a worktree, and threads that agents spawn with one, run up to about ten `spawnSync` git calls inside an IMMEDIATE transaction, which freezes the whole daemon.
- `runs/service.ts` (1345 lines), `runs/driver.ts` (1665), `domain/workspaces.ts` (1531) and `http/routes.ts` (949) each mix several responsibilities, and several small mechanisms are written three or four times.

## Findings

### F1. The event log and command results grow without bound, and every streaming flush stores the whole message again
- Where: `apps/daemon/src/store.ts:104-118` (`emit` inserts `JSON.stringify(data)` into `events`), `apps/daemon/src/store.ts:161-165` (`saveCommandResult`), `apps/daemon/src/runs/writer.ts:9` (`TEXT_THROTTLE_MS = 50`), `apps/daemon/src/runs/writer.ts:214-244` (each flush calls `updateItem` with the full text), `apps/daemon/src/domain/items.ts:99-116` (`updateItem` emits `stream.item` with the full body), `apps/daemon/src/db/connection.ts:51-56` (each migration first runs `VACUUM INTO` over the whole DB). There is no `DELETE FROM events` or `DELETE FROM commands` anywhere in `src` (grep). `apps/daemon/AGENTS.md` (API decisions) says "The log is never pruned yet".
- Problem (observed): an open assistant message or thought is rewritten up to 20 times a second, and each rewrite inserts a new `events` row that holds the whole body. A message of L characters streamed over T seconds adds about `20·T` rows averaging L/2 characters (inferred, not measured: an 8,000-character answer over 40 s comes to about 3 MB). Thoughts can be up to `MAX_THOUGHT_CHARS = 60_000`. Each command result, `chat.send` included, is kept forever. Consequences:
  - `clowdy.db` grows steadily with use.
  - Each migration's backup copies all of it.
  - `chat.delete` removes runs and items (`db/chats.ts:232-238`) but the text stays in `events` and `commands`, which is a data-retention and privacy problem for a "delete".
- Fix:
  - Prune `commands` rows older than an idempotency window (for example 24 h) at startup and on a timer.
  - Prune `events` below a retention cursor (for example keep 7 days or the last N rows). Answer a resume cursor below the tail with 410, as a cursor above the head already is, so the client refetches the snapshot (needs a matching client change).
  - Stop amplifying writes: emit an item event only when the throttled flush fires, and either move to a delta event (`stream.delta {runId, seq, append}`, a protocol change) or coalesce updates of one `seq` (delete the previous `stream.item` row for the same item inside the same transaction before inserting the new one).
  - On chat or run delete, delete their event rows (needs a `run_id` column on `events`, or `json_extract` in a one-off delete).
- Category: perf | correctness
- Effort: M (pruning) to L (delta events). Risk: medium (client resync contract)

### F2. Each streaming flush and each text chunk re-reads and re-parses data the caller already has
- Where:
  - `apps/daemon/src/domain/items.ts:99-116`: `updateItem` runs `getRun` (`SELECT *` plus JSON.parse of `worktree`, `usage`, `context`, `background`), then `getItem` with the `FLAGGED` query. That query runs `json_extract` over the old body in SQLite, `toItem` JSON-parses the old body again, and the result is then discarded and replaced by the new body. Then two `JSON.stringify` of the new body (the `UPDATE` and the `emit`).
  - `apps/daemon/src/domain/items.ts:77-96`: `appendItem` does `getRun`, then `nextSeq`, the insert, a flagged read-back and `emit`.
  - `apps/daemon/src/runs/driver.ts:1169`: `runs.require(run.id).status` (full `SELECT *` plus parses) runs for every "advancing" event, that is every non-empty text or thought chunk of the orchestrator.
- Problem (observed): the hot path of a turn does several full-row reads and JSON parses per chunk and per 50 ms flush. With tens of concurrent runs (inferred) that is thousands of whole-row decodes a second on the daemon's single thread, competing with HTTP and SSE.
- Fix:
  - Give `TurnWriter` the item envelope it got from `appendItem` (`id`, `at`, `canFork`/`canEdit`), and add an `updateItemBody(store, run, envelope, body)` that skips both reads.
  - Pass the `Run` (or just `projectId` and `offersRewind`) from the writer instead of calling `getRun` per write.
  - In `consume`, replace `runs.require(run.id).status` with a narrow `SELECT status FROM runs WHERE id = ?` helper (`runStatus(db, id)`), or with RunService's in-memory `waits` state.
  - Add `SELECT id, at, point, opens` (no `body`) for envelope reads.
- Category: perf
- Effort: S-M. Risk: low

### F3. SSE fan-out re-queries, re-parses and re-serializes every event for every client
- Where: `apps/daemon/src/http/sse.ts:141-184` (`eventStream.pull` calls `store.eventsAfter` after every commit), `apps/daemon/src/store.ts:14-19, 142-151` (`toEvent` JSON-parses `data`), `apps/daemon/src/http/sse.ts:21-22` (`frame` stringifies the event again).
- Problem (observed): each connected stream wakes on every commit (`nextCommit` subscribes to all commits, `sse.ts:121-135`), runs a `SELECT ... LIMIT 200`, parses every row's `data` and stringifies it again. With F1's 20 Hz full-body updates, every client pays a parse and a stringify per update on top of the write side's two stringifies.
- Fix: build the frame from the stored text without a round trip: `id: ${cursor}\nevent: ${SSE_EVENT}\ndata: {"cursor":${cursor},"at":${at},"projectId":${JSON.stringify(projectId)},"data":${row.data}}\n\n` (add an `eventFramesAfter` that returns raw rows). Optionally keep a small in-memory ring of the encoded frames of recently committed `pending` events (the listener already receives them) and fall back to SQLite only for catch-up.
- Category: perf
- Effort: S. Risk: low

### F4. `chat.create` with a worktree, and a thread with a worktree of its own, run synchronous git inside an IMMEDIATE transaction
- Where:
  - `apps/daemon/src/domain/chats.ts:136-185` (`createChat` calls `createWorkspace` inside `store.tx`, itself inside `settle`'s tx, `commands/index.ts:53-61`).
  - `apps/daemon/src/domain/workspaces.ts:558-575` (`repositoryFolder` calls `isRepositoryRoot`), `:614-660` (`createNewWorkspace` calls `baseOfSync`: 1-4 git, then `resolveBaseSync`: 1-4 git), `:677-680` (`branchTaken`: 2 git). Each goes through `readGit`, a `Bun.spawnSync` with a 10 s timeout (`workspaces.ts:62-65`).
  - The same pattern in `openExistingWorkspace` (`:907`), `threadBase` and `checkoutBranch` (`:989`, `:1023`), and `nameWorkspaceBranch` (`:858`, a `git branch -m` write).
  - Agents reach it through `ThreadService.createThreadChat` (`runs/threads.ts:329-379`).
- Problem (observed): one chat creation runs up to about ten `spawnSync` git processes while holding the SQLite write lock and the only JS thread. That is tens to hundreds of ms of total freeze for every HTTP request, SSE stream and engine event in the normal case, and up to 10 s per call when git or the disk hangs. The code comments acknowledge this (`workspaces.ts:295-297`). An orchestrator that spawns several threads with worktrees freezes the daemon once per thread.
- Fix: do the repository checks before the transaction. `chat.create` is already a "sometimes async" command (`waitsWhen` in `commands/index.ts`, used for `workspace.mode === 'main'`). Extend `waitsWhen` to every `workspace` choice and run the async readers (`resolveBase`, `gitOutput`) first, then write in the transaction. Make `ThreadService.spawn` resolve the base and branch asynchronously before its transaction too. After that, `baseOfSync`, `resolveBaseSync`, `headOf` and `isRepositoryRoot` become dead and can be deleted (see F7). The per-turn `commonGitDir` with no timeout is covered by `daemon-edges.md` F2.
- Category: perf | structure
- Effort: M-L. Risk: medium (command becomes async for this case; tests in `chat-workspaces.test.ts`)

### F5. Restart recovery kills survivors one at a time before the server listens, and runs `ps` inside the transaction
- Where: `apps/daemon/src/runs/service.ts:1057-1059` (`await killSurvivor(...)` in a sequential loop), `apps/daemon/src/runs/processes.ts:93-113` (`killSurvivor` waits up to `graceMs` for each), `apps/daemon/src/daemon.ts:185, 225` (`recover()` before `startServer`), `apps/daemon/src/runs/service.ts:1085, 1138` (`mayBeSameProcess` → `startTimeOf` → `Bun.spawnSync(['ps', ...])` with no timeout, inside `store.tx`). `describeProcess` runs the same synchronous `ps` on every `process` event (`driver.ts:1187`).
- Problem (observed): after a crash with N agent processes that ignore SIGTERM, startup takes up to N × `killGraceMs` (5 s each) before port and `daemon.json` exist. With tens of runs (inferred) the app's wait for the daemon can time out (not checked in `apps/desktop`). The per-run `ps` calls inside the recovery transaction hold the write lock on a process the daemon does not control.
- Fix: kill survivors in parallel (`await Promise.all(survivors.map(s => killSurvivor(s, grace)))`). Compute `mayBeSameProcess` for each recorded process once, before the transaction, and pass the result in. Give `startTimeOf` a timeout (as `processesBelow` has, `engine/process.ts:47`), or make it async for the `process` event path.
- Category: perf | correctness
- Effort: S. Risk: low

### F6. `RunService` and `RunDriver` are oversized and each mixes five or six concerns
- Where: `apps/daemon/src/runs/service.ts` (1345 lines): creation (182-262), status machine and task sync (272-411), slots and dependency waits (413-482), questions, approvals and grants (484-876), cancel and kill ladder (878-1054), recovery (1056-1185), session setters (1193-1311). `apps/daemon/src/runs/driver.ts` (1665 lines): prompt surroundings helpers (133-222, 629-668), flights and launch (265-310), steer and interrupt (312-395), stop hooks (396-525), turn and consume (698-1298), background tracking and the wake note (1299-1419), done, limits, retries and settle (1420-1665).
- Problem (observed): both files are where most behavior changes land (see the AGENTS.md Runtime section), and every change means reading more than 1,300 lines of interleaved state. `threads.ts` imports the file-system helper `isFolder` from `driver.ts` (`runs/threads.ts:14`), a sign the driver also serves as a utility module.
- Fix (behavior-preserving, with the strong existing tests `runs.test.ts`, `background.test.ts`, `orchestration.test.ts`, `races.test.ts`):
  - Move questions, approvals, grants and `waits` into `runs/person.ts` (`PersonWaits`), which RunService owns and delegates to.
  - Move `recover` into `runs/recovery.ts` as a function over Store and RunService.
  - Move `additionalFolders`, `commonGitDir`, `promptChat`, `promptWorkspace` and `surroundings` into `runs/surroundings.ts`, and `isFolder` into a shared fs helper (see F12).
  - Move the background bookkeeping (`onBackground`, `reportEnd`, `settleFinished`, `forgetBackground`, `stopCommand`, `tell`) into `runs/background.ts` over `LiveRun`.
- Category: structure
- Effort: L. Risk: medium

### F7. Resolving a base branch to a commit is implemented four times, and `workspaces.ts` mixes six jobs
- Where: `apps/daemon/src/domain/workspaces.ts:346-394` (`baseRefs`, `resolveBaseSync`, `resolveBase`), `apps/daemon/src/domain/worktrees.ts:81-98` (`baseCommits`: `refs/heads/<name>` then `refs/remotes/<name>`), `apps/daemon/src/domain/workspaceRemoval.ts:640-644` (`readBaseCommit`, the same two lookups). `workspaces.ts` (1531 lines) also holds removal reservations (127-198), the layout and slugs (221-292), branch naming (677-888), sync git reads (300-344), worktree listing and creation (1063-1366) and preparation (1417-1531).
- Problem (observed): four copies of "base name → commit, local branch first, then the remote's". They differ in tool (`show-ref --verify` or `commitOf`), in sync or async, and in hash handling, so a fix to one (for example tags named like branches) does not reach the others. The file's size hides which functions are the synchronous duplicates that F4 removes.
- Fix: add `git/base.ts` with `commitOfBase(folder, base): Promise<{ commit, remote } | undefined>` and a memoizing `baseCommits(folder)` built on it. Use it in worktrees, workspace removal and worktree creation, and delete the sync copy once F4 lands. Split `workspaces.ts` into `workspaceReservations.ts`, `workspaceLayout.ts` (slug, layout, branch names), `worktreeGit.ts` (list, ensure, base commit) and keep `workspaces.ts` for create, open and inherit.
- Category: reuse | structure
- Effort: M. Risk: low-medium

### F8. Every stream lookup by kind or state parses every item of the run in SQLite
- Where: `apps/daemon/src/db/items.ts:21-28` (`FLAGGED`), `:59-67` (`listMessagesBefore`), `:78-168` (`firstUserItem`, `findQuestion`, `listOpenQuestions`, `listPendingQuestionAnswers`, `findApproval`, `listOpenApprovals`, `listRunningTools`, `listOpenThoughts`, `listOpenAssistantMessages`), `:208-216` (`itemBefore`), `:237-268` (`lastStorySeq`, `lastUserSeq`). The schema has only `UNIQUE (run_id, seq)` (`db/migrations.ts:113-120`).
- Problem (observed): each query filters with `json_extract(body, '$.kind')` and similar, so SQLite parses the body of every item of the run. Hot callers: `askApproval` and `waitForPerson` each call `listOpenQuestions` for every permission request (`service.ts:647, 807`), `markRewindPoint` calls `lastStorySeq` at every turn end, and `threads.lastTurnText` calls `lastUserSeq`. For long chats (thousands of items, tool outputs up to 20,000 characters, `engine/acp/mapper-core.ts:12`) each call parses megabytes (inferred).
- Fix: a migration that adds `kind TEXT GENERATED ALWAYS AS (json_extract(body, '$.kind')) STORED` (and `state` if useful) with `CREATE INDEX stream_items_kind ON stream_items(run_id, kind, seq)`, then rewrite the queries to use the column. Index `questionId` and `approvalId` with a generated column too, or keep a small lookup table.
- Category: perf
- Effort: M. Risk: low-medium (migration; `storage.test.ts`)

### F9. The project snapshot ships every run ever made in the project, sub-agents and archived ones included; chat streams are unpaged
- Where: `apps/daemon/src/domain/snapshots.ts:26-37` (`runs: listRuns(store.db, projectId)`), `apps/daemon/src/db/runs.ts:83-87` (`SELECT *`, so `next_prompt`, `cwd`, `pid` and `lost_background` are read and dropped), `apps/daemon/src/runs/native.ts:14` (up to 300 sub-agent runs per turn), `apps/daemon/src/http/routes.ts:407-428` (`/v1/runs/:id/items` and `/v1/chats/:id/items` return everything after `after`, with no limit).
- Problem (observed): native sub-agents are rows in `runs`, and nothing removes them except chat deletion. The snapshot, which the client fetches on every (re)connect, grows linearly with history, and each row is decoded with four JSON parses. Opening a long chat loads its whole stream in one response, running the `FLAGGED` subquery for each user item. (Inferred) months of use with workflows make both multi-MB.
- Fix: list only root runs plus active or unarchived native runs of the last N turns in the snapshot, and add `GET /v1/runs/:id/children` (or fold children into the items page) for the rest. Add `limit`/`before` paging to the item routes (the client asks for the tail first). Replace `SELECT *` with an explicit column list for `RunRow`.
- Category: perf
- Effort: M-L. Risk: medium (protocol and renderer change)

### F10. `routes.ts` is one 949-line table with repeated handler boilerplate
- Where: `apps/daemon/src/http/routes.ts`:
  - 14 copies of `resolvePlace(store, requireProject(store, id), body.folderId, body.workspaceId)` (for example 566, 617, 636, 650, 700, 727, 752, 771, 785, 800, 818), while `fs-routes.ts` already has `placed()` (`fs-routes.ts:58-62`).
  - The SSE headers object four times (`routes.ts:336-340, 686-690, 713-717`, `fs-routes.ts:214-218`).
  - The "untrusted bytes" headers three times (`routes.ts:883-888, 914-919`, `fs-routes.ts:110-116`).
  - `await services.pullRequests.forget(place).catch(() => undefined)` in three `finally` blocks and the sync callback (`708, 742, 760, 808`).
  - An inline 410 body (`317-328`) instead of `failure('invalid', ..., details, undefined, 410)`.
  - The scope check of `POST .../git/viewed` (`555-561`) repeats `gitScopeOf`'s message (`244-252`).
  - `/v1/commands` re-implements `readJson` (`348-374`) only to keep `requestId`.
  - `FsRoute` (`fs-routes.ts:20-28`) duplicates `Route` (`routes.ts:62-70`) only to allow `PUT`.
- Problem (observed): about 25 git routes and the core API share one closure. Each new git route copies 10-15 lines, and the copies have already drifted (the `branch-create` handler at `781-793` has no blank-line structure and inlines its own check).
- Fix: move the git routes into `http/git-routes.ts` (as `fs-routes.ts` and `terminals.ts` are). Add helpers in `http/responses.ts`: `sseResponse(stream)`, `untrustedFile(body, contentType, extra)`. Add `placeOf(projectId, { folderId, workspaceId })` shared by both tables. Add `forgettingPullRequest(place, work)` for the `finally`. Widen `Route.method` to include `PUT` and delete `FsRoute`. Give `readJson` an `onInvalid` hook (or return the raw body) so `/v1/commands` can use it.
- Category: simplify | structure
- Effort: S-M. Risk: low

### F11. HTTP request schemas live only in the daemon, so the protocol's request types can drift
- Where: `apps/daemon/src/http/routes.ts:79-181` (about 15 zod bodies), `apps/daemon/src/http/fs-routes.ts:35-48`, `apps/daemon/src/http/terminals.ts:32-39`. The hand-written interfaces they should match are in `packages/protocol/src/git.ts` (`GitViewedSet` 379, `GitPushRequest` 504, `GitCloneRequest` 543, `GitBranchDeleteRequest` 647, `GitSwitchRequest` 743, `GitCommitRequest` 774, `GitDiscardRequest` 802). Only `pullRequestArchiveBody` is tied to its type (`routes.ts:616`).
- Problem (observed): the renderer compiles against the protocol interfaces and the daemon validates against separate zod objects, with nothing linking them. One drift is already in place: the merge `expectedMode` enum is a literal list in `routes.ts:151`, while the protocol has it as the union `GitBranchMergePreview['mode']` (`git.ts:713`). A field added on one side passes type checks and fails at runtime with 400, or is silently stripped by zod.
- Fix: as `packages/protocol/src/commands.ts` already does for commands, define the request schemas with zod in the protocol (`git.ts`, `fs.ts`, `terminals.ts`) and derive the interfaces with `z.infer`. The daemon then imports the schemas. As a minimum, add `satisfies z.ZodType<GitCommitRequest>` (and so on) to each daemon schema.
- Category: reuse | correctness
- Effort: M. Risk: low

### F12. Small helpers written several times in the core: commit waits, "is a directory", dangling-item cleanup
- Where:
  - Waiting for a matching commit with a timeout and abort: `apps/daemon/src/http/sse.ts:121-135` (`nextCommit`), `apps/daemon/src/runs/service.ts:439-463` (`nextChange`), `apps/daemon/src/runs/threads.ts:551-584` (`untilRest`).
  - "Is a directory": `apps/daemon/src/runs/driver.ts:133-139` (`isFolder`, exported and imported by `runs/threads.ts:14`), `apps/daemon/src/domain/places.ts:28-34` (`isDirectory`), `apps/daemon/src/domain/projects.ts:568` (async `isFolder`), `apps/daemon/src/docs/tree.ts:53`.
  - Closing a dead run's dangling items (running tools → `STOPPED_TOOL`, open thoughts and messages → `done`, open approvals → `expired`) twice inside `recover`: `apps/daemon/src/runs/service.ts:1106-1121` and `:1143-1165`.
- Problem (observed): each copy carries its own cleanup of listeners and timers (the three waits) or its own list of item kinds (the recovery blocks), so a fix to one, for example adding a new item kind that must be closed after a crash, has to be found and repeated by hand.
- Fix: add `Store.nextCommit({ match?, timeoutMs?, signal })` returning `Promise<boolean>`, and use it in the three places. Put `isDirectory` and `isDirectoryAsync` in one shared module (the place `daemon-edges.md` F6 proposes for `isBelow`, `src/fs/paths.ts`). Add `closeDanglingItems(store, runId, { expireQuestions })` in `runs/recovery.ts` (F6) and call it from both blocks.
- Category: reuse
- Effort: S. Risk: low

### F13. The Store carries prompt-suggestion state, and an HTTP handler holds its domain logic
- Where: `apps/daemon/src/store.ts:3, 33-49` (`promptSuggestions` map, `forgetPromptSuggestion`, `rememberPromptSuggestion`, an import of an engine type into the write path), `apps/daemon/src/http/routes.ts:384-406` (the route decides validity from the run, the agent setting and the entry). `apps/daemon/src/http/routes.ts:14-15, 570, 586` writes viewed marks through `db/viewed` directly (`store.tx(() => setViewed(...))`), the only place where `http/` imports `db/`.
- Problem (observed): `Store` is documented as "the write path" (`store.ts:21-27`) but also holds an in-memory LRU of predictions unrelated to persistence. The rule "suggestion is valid if the run succeeded, the finish time matches and the agent setting is on" sits in a route closure, where neither the driver that sets it nor tests of the runtime can reuse it.
- Fix: add a `PromptSuggestions` class in `runs/` (remember, forget, `current(runId)` with the validity rule, `await(runId)`), owned by the driver and exposed in `Services`. The route becomes a two-line handler. Move the viewed writes into `domain/viewed.ts` (`markViewed`, `unmarkViewed`) like the other domain functions.
- Category: structure
- Effort: S. Risk: low

### F14. A failed startup leaves the database and the services open
- Where: `apps/daemon/src/daemon.ts:85-251`. The `catch` at 248-251 only calls `releaseLock()`. By then `openDatabase`, `createEngines` (whose `ToolBridge` may already listen), `SkillsService`, and after `recover` also `skills.watchFolders`, may exist.
- Problem (observed): if `runs.recover()`, `ensurePersonalProject` or `startServer` throws (for example a taken `CLOWDY_PORT`), the database handle and watchers stay open. In production the process exits right after (`main.ts:12-15`), but in tests and in any caller that retries `startDaemon` in-process they leak, and the WAL is not checkpointed by a clean close.
- Fix: keep a list of disposers as services are created (`store.db.close`, `created?.stop`, `skills.stop`, `power.stop`), and run them in reverse in the `catch` before `releaseLock()`. `stop()` can reuse the same list.
- Category: correctness
- Effort: S. Risk: low

### F15. Symbols exported but used only in their own file
- Where (each confirmed by grep of `src`, `test`, `scripts` and `packages`): `runs/task-tools.ts` (`resolveStatus`, `describeTask`), `runs/threads.ts` (`THREAD_OUTPUT_CHARS`, `threadMessage`), `runs/processes.ts` (`isSameProcess`), `runs/prompts.ts` (`BACKGROUND_KINDS`, `namedTitle`), `engine/acp/promptSuggestions.ts` (`bestPromptSuggestion`, `SUGGESTION_WAIT_MS`), `engine/acp/bridge.ts` (`BRIDGE_SERVER_NAME`), `engine/acp/catalog.ts` (`COMMIT_MESSAGE_SETTING`), `domain/workspaces.ts` (`ensureWorktree`), `domain/worktrees.ts` (`inspectWorktree`, `orderWorktrees`), `domain/chats.ts` (`rootChatOf`), `domain/workspaceSetup.ts` (`SetupError`), `domain/taskQuery.ts` (`OPEN_CATEGORIES`, `emptyCounts`), `http/sse.ts` (`frame`).
- Problem (observed): the extra exports enlarge each module's apparent API, and an agent changing one of them has to grep the repository to learn it is private. Biome does not flag unused exports. None of them is dead code: each is used inside its file.
- Fix: drop `export` from these. Optionally add a periodic `knip`-style check in the coordinator's baseline (not a new dependency without the owner's say).
- Category: dead-code
- Effort: S. Risk: low

## Cross-area notes

- Protocol: F1 (an event retention or 410 contract and possibly a `stream.delta` event), F9 (snapshot without every sub-agent, paged item routes) and F11 (request schemas in zod inside `packages/protocol`) all change the daemon–renderer contract and need matching work in `apps/desktop`'s event and snapshot client.
- `daemon-edges.md` overlaps: the synchronous `git()` with no timeout and the per-turn `commonGitDir` (its F2), and the path-containment helpers (its F6, which also lists `workspaces.ts:167` and `workspaceRemoval.ts:344` from this area). F12's `isDirectory` helpers should live in the same module that F6 proposes.
- If F5's parallel recovery is not done, check that the desktop app's wait for `daemon.json` and `/v1/health` tolerates a slow recovery.
- F4's removal of the synchronous base readers depends on F7's `git/base.ts`, so do F7 first or in the same stage.

## Not inspected / limits

- `engine/acp/v2.ts` (1302 lines), `session.ts`, `mapper-v2.ts`, `children.ts`, `permission.ts` and `registry.ts` were only outlined. The v1 and v2 layers share names (`selectsOf`, `isResumeWarningUpdate`) but are typed against different SDK modules, and no confirmed defect was found in a quick pass.
- `runs/queue.ts`, `notices.ts`, `messages.ts`, `fork.ts`, `edit.ts`, `task-tools.ts` and `thread-tools.ts` were skimmed for structure only. No race was proven: the synchronous-transaction design rules out most of them, and the async commands are deduplicated by `requestId`.
- `domain/workspaceRemoval.ts` (898 lines), `workspaceSetup.ts` and `taskQuery.ts` were checked only for duplication with the files above.
- The growth figures in F1 and the per-chunk cost in F2 are derived from the code (throttle constants, queries per call), not measured on a real database. A size check of an owner's `clowdy.db` (`SELECT type, COUNT(*), SUM(LENGTH(data)) FROM events GROUP BY type`) would confirm F1's priority.
- No tests were run.

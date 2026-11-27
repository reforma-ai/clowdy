# Renderer data layer: daemon client, stores, stream data, hotkeys logic

## Summary

The layer is coherent at the top: one `Transport` interface, one `RootStore`, events routed by project with cursor checks, streams buffered while they load, and a hotkey registry that is clean and well tested. The problems sit in the hot paths and in repetition.

- Every `stream.item` (up to 20 per second per streaming run, `apps/daemon/src/runs/writer.ts:9`) copies and sorts the whole run, then `StreamView` refolds the history and re-renders every message whose props are rebuilt each render. Streams opened during a session are never released.
- The event feed drops the connection without cancelling the reader when a handler throws, skips that event on reconnect, and has no stall watchdog despite the daemon's 15 s heartbeat.
- Components scan whole `chats`, `runs` and `tasks` maps during render, so the Agents `Screen`, every sub-agent card and every inline code span re-render on unrelated events. Selection resolution is written three times.
- About 8.9k lines of fixture daemon are bundled into production through a static import in `daemon/config.ts`, and that fixture reimplements daemon rules by hand.
- The same mechanisms are written several times over: latest-request-wins loading (4 variants, one without a guard), SSE reading (4 copies), reconnect backoff (3), persisted MobX preferences (13 classes plus a non-observable `theme.ts`), and draft storage (2 stores written on every keystroke).
- `HttpTransport`, `Transport` (60 methods kept in four places), `UiStore` (899 lines) and `RootStore` mix responsibilities. Stores import from `features/`.

## Findings

### F1. The event feed leaks its connection on a handler error, skips the failed event, and never notices a stalled stream
- Where: `apps/desktop/src/renderer/daemon/httpTransport.ts:703-752` (`#follow`), especially `728-741`. Compare with `daemon/httpFileSystem.ts:236-269`, which closes its stream on every exit. Daemon heartbeat: `apps/daemon/src/http/sse.ts:16` (`HEARTBEAT_MS = 15_000`), dropped by `daemon/sse.ts:37`.
- Problem (observed):
  - If `JSON.parse(frame.data)` or `onEvent(event)` (that is, `RootStore.handleEvent` and every store action under it) throws, the outer `catch {}` falls through to the reconnect. `reader.cancel()` is never called and the fetch signal is the subscription's, so it is not aborted. The old response stays open while a new one is made.
  - `cursor = event.cursor` runs before `onEvent` (`738-739`), so the reconnect resumes after the event that threw. That event is never applied and the store silently diverges from the daemon.
  - No idle timer exists. A daemon that hangs, or a stream that stalls, keeps the status `connected`, the "Can't reach the daemon" banner never shows, and events stop without anyone being told.
- Problem (inferred): the window already keeps several long-lived SSE streams to the same origin (the feed, one `HttpFileSystem.watch` per Files or Docs place). Chromium allows 6 HTTP/1.1 connections per host, so a few leaked feed connections would block every other request to the daemon. A malformed frame would loop: same cursor, same frame, one more leaked connection each time.
- Fix: add `readSse(response, signal)` to `daemon/sse.ts` as an async generator with `try/finally reader.cancel()` (see F8). Wrap each `onEvent` call in its own `try/catch` that logs and goes on to the next event, and advance the cursor after the event is applied. Reset an idle timer on every chunk, heartbeats included, and abort the attempt after about 2× the heartbeat (30 s) so the normal `reconnecting` path and the banner take over. Add tests for a throwing handler and for a silent stream.
- Category: correctness | safety
- Effort: S. Risk: low

### F2. Each stream event copies, sorts, refolds and re-renders the whole run
- Where:
  - `stores/StreamStore.ts:27-29`: `items` is `[...this.byId.values()].sort(...)`, rebuilt on every `upsert`.
  - `stream/StreamView.tsx:193-199`: `turnMarks(items)`, `groupToolRuns(foldFinishedWork(items, active))`, `forkPointId`, all O(n) on every new array. `227-264`: `actionsOf` builds a new `MessageActionsConfig` and new closures for every message on every render. `335`, `343`: inline `onAnswer` and `onDecide` closures. `372-380`: `groupToolRuns` runs again inside render for every `Worked` block. `376`, `388`: new `items` arrays for every `ToolGroup`.
  - `stream/UserBubble.tsx:42`: `personMarkdown(text, ...)` (a regex pass over the whole message, see F4) runs on every render.
  - `features/chats/ChatView.tsx:70` and `features/agents/RunDetail.tsx:24` use `stream?.items ?? []`, a new array each render, which defeats `StreamView`'s `useMemo` before the stream exists. `ConversationView.tsx:114` already uses a shared `NO_ITEMS`.
- Problem (observed): the daemon throttles streaming text to one write per 50 ms per run (`apps/daemon/src/runs/writer.ts:9`), and each write is a `stream.item` carrying the whole item. Components are `observer()` (memo) through `babel-plugin-observing-components`, but the per-render objects defeat the memo. Every user bubble, answer row, question card, approval card, tool group and fold re-renders on every token, and the cost grows with the length of the chat. Several parents also scan `items` again (`ChatView.tsx:72,83`, `useEditMessage.ts:59,71`).
- Fix:
  - Keep the items ordered incrementally in `RunStream`: an array plus a `Map<id, index>`, with in-place replacement for an update, a push when `seq` is past the last one, and a binary insert otherwise. Use `observableShallow` on the array so `items` stops being a sort.
  - Fold incrementally. Finished turns do not change once a later user message exists, so cache `foldTurn` results by the identity of the turn's items (a `WeakMap` keyed by the first item, invalidated when any member item object changes) and recompute only the last turn.
  - Give message components stable props. Pass the item and the shared `messageActions` and let the component derive its row, or memoize per item id. Make `onAnswer` and `onDecide` take ids so one stable function serves every card. Hoist the `groupToolRuns` call for `Worked` into the memoized blocks.
  - Replace `?? []` with a module constant.
- Category: perf
- Effort: L. Risk: medium (`StreamView.test.tsx`, `turns.test.ts` and `StreamStore.test.ts` cover the behavior)

### F3. Opened streams are kept, updated and reloaded for the life of the window
- Where: `stores/StreamStore.ts:91-100` (`of` creates and keeps), `111-113` (`forget` is called only for `chat.deleted`, `stream.truncated` and a removed project: `RootStore.ts:363-365,447`), `116-120` (`reloadAll` refetches every non-idle stream). Creators: `stores/hooks.ts:42-51` (`useRunStream`, no release on unmount), `stream/useAgentActivity.ts:10-14` (each live sub-agent card opens its child's stream).
- Problem (observed): every chat the person opens and every sub-agent that was live on screen keeps its full item map, keeps applying upserts, and is fetched again on every resync. `updateOffer.ts:25-26` notes that the app stays open for weeks, so memory and resync cost grow with the session rather than with what is on screen.
- Fix: reference-count in `useRunStream`, acquiring in the effect and releasing in its cleanup. Evict streams with no references after a grace period, or keep an LRU of about 20. Have `reloadAll` reload only streams that have references. An evicted stream reloads on its next `load()`.
- Category: perf
- Effort: M. Risk: low

### F4. Task key lookups scan the whole board during render and subscribe every chip to every task
- Where: `stores/ProjectState.ts:367-391` (`taskOfKey` calls `#heldTaskOfKey` before the cheap `#mayBeKey` check, and `#heldTaskOfKey` iterates `tasks` and then `archivedKnown`). Render-time callers: `stream/markdown/components/InlineCode.tsx:31` (every inline code span in every message), `stream/UserBubble.tsx:42` through `stream/personMarkdown.ts:42`, `features/chats/MentionChip.tsx:37`.
- Problem (observed): each inline code span (file names, identifiers, any text in backticks) costs O(tasks + archived) per render. Because the scan reads every entry of an `observableShallow` map, each such component observes the whole board, and every `task.upserted` re-renders every visible message that contains a code span or a key-shaped token, which re-runs `personMarkdown` for user bubbles.
- Fix: run `#mayBeKey(key)` first, since it is pure string work and rejects almost every code span. Maintain an observable `Map<string, TaskId>` key index in `applySnapshot`, `#apply` (`task.upserted`, `task.deleted`) and `rememberArchived`. `observable.map.get(key)` tracks only that key, so a chip re-renders only when its own task changes.
- Category: perf
- Effort: S. Risk: low

### F5. Components scan whole `runs` and `chats` maps in render, and the visible selection is computed in three places
- Where:
  - Selection, written three times: `features/agents/Screen.tsx:28-29`, `stores/NavHistory.ts:143-144`, `features/agents/openNewChat.ts:28-35`. Each runs `visibleChats` (filter and sort of every chat) and then `resolveSelection`.
  - Full scans in render: `Screen.tsx:58-64` (all runs, plus `chatFolder` per busy run), `stream/SubagentCard.tsx:37` (`childOfCall(project.runs.values(), ...)` per card, `stream/subagents.ts:161-170`), `features/agents/agentTree.ts:525-527` (`chatOfRun` copies every chat into an array per call; callers `agentTree.ts:555`, `RunDetail.tsx:23`, `archiveChat.ts:64,91`), `AgentList.tsx:221,280`, `RunningAgents.tsx:198`.
  - `stores/ProjectState.ts:38-48`: `group()` does `groups.set(key, [...(groups.get(key) ?? []), item])`, which is quadratic per group. It backs `threadsByParent` (recomputed on every `chat.upserted`) and `tasksByStatus` (on every `task.upserted`).
- Problem (observed): the daemon emits `run.upserted` for status changes, context readings (`apps/daemon/src/runs/service.ts:1266`) and summaries (`1298`), several times per turn. `Screen`, the root of the Agents section, observes the whole runs map, so it re-renders on each of these events, and so does every sub-agent card in an open stream. Three copies of the selection logic must agree; `NavHistory`'s comment says it has to "match the chat the screen actually shows".
- Fix: add computed indexes to `ProjectState`: `chatByOrchestratorRun: Map<RunId, Chat>` (replaces `chatOfRun`), `childRunByToolCall: Map<string, Run>` (replaces `childOfCall`), and the busy orchestrators. Put one computed `selection` (visible roots plus the resolved selection) on a store that sees both `ProjectState` and `ProjectUi`, either a getter on `RootStore` for the selected project or a small class beside `NavHistory`, and use it in `Screen`, `NavHistory` and `openNewChat`. Replace `group()` with `Map.groupBy` (ES2024 is in `apps/desktop/tsconfig.json`).
- Category: perf | structure
- Effort: M. Risk: medium (selection fallbacks; `agentTree` and `NavHistory` tests cover them)

### F6. The fixture daemon ships in the production bundle and duplicates the daemon's rules
- Where: `daemon/config.ts:3-15`, `177-198` (static imports of `FixtureTransport`, `fixtureData`, `fixtureGit*`), reached from `root.ts:3`. Fixture code excluding tests: 8,868 lines, 373 KB of source. `daemon/fixtureTransport.ts` alone is 3,504 lines, and its `#apply` command switch runs from `1974` to `2539`.
- Problem (observed): `?fixtures` is used only through the Vite dev server (`apps/desktop/AGENTS.md`, "Checking the UI without a person"), yet nothing guards the import, so every packaged app carries the fixture daemon. `FixtureTransport` reimplements daemon behavior (task sync on run start and finish, the queue, worktrees, fork and edit, git scripts) that `AGENTS.md` says is "written to match the daemon's". Each daemon change needs a hand-made twin, and `config.ts` mixes production resolution with about 60 lines of fixture switch documentation and parsing.
- Fix:
  1. Load fixtures with `import.meta.env.DEV` and a dynamic `import('./fixtures')`. `createTransport` becomes async, or `root.ts` awaits it. Move the fixture switch parsing out of `config.ts` into that module.
  2. Split `FixtureTransport` by domain, as `fixtureTasks.ts` and `fixtureGit*.ts` already are: chats and queue, worktrees, agents, git.
  3. Longer term, seed the real daemon (`CLOWDY_ENGINE=fake`, temp data dir, as `AGENTS.md` already describes) for screenshots, so the second implementation can shrink.
- Category: perf | structure | dead-code
- Effort: S for step 1, L for steps 2 and 3. Risk: low for step 1

### F7. New-chat drafts live in two stores and are written to localStorage on every keystroke
- Where: `features/agents/DraftChat.tsx:136-141` calls `saveDraft` (`features/chats/composerDrafts.ts:29-56`, a module `Map` behind `useSyncExternalStore`) and then `ui.newChatDrafts.updateDoc` (`stores/NewChatDrafts.ts:182-185`, then `persist()`). The list reads it at `features/agents/AgentList.tsx:215`.
- Problem (observed):
  - Each keystroke in the new-chat composer replaces the `observableRef` `drafts` array and synchronously runs `JSON.stringify` over every draft, a `nonempty` walk of every draft's document, and `localStorage.setItem`.
  - `AgentList` (the 1,190-line `features/agents/AgentList.tsx`) reads `ui.newChatDrafts.drafts` and re-renders the whole sidebar on every keystroke.
  - The "worth keeping" filter is written three times (`persist` at `275-287`, `updateOperation` at `210-219`, `clearRefused` at `251-260`), and the write-and-verify block twice.
  - The key `new-chat-drafts:${projectId}` has no `clowdy:` prefix, and `UiStore.forgetProject` (`stores/UiStore.ts:891-898`) does not remove it, so drafts of removed projects stay in storage.
- Fix: make `NewChatDrafts` the one owner of the new-chat document and drop the parallel `saveDraft` key, or keep `composerDrafts` and stop mirroring the doc. Debounce persistence (about 300 ms, flushed on blur and `pagehide`). Keep the list's observable data (id, place, label) apart from the document, so typing does not touch what `AgentList` reads. Extract `#persistable()` and `#write({ verify })`. Rename the key with the prefix and remove it in `forgetProject`.
- Category: perf | structure | correctness
- Effort: M. Risk: medium (draft restore after a refused send; `NewChatDrafts.test.ts` covers it)

### F8. HttpTransport repeats request, SSE and backoff code
- Where:
  - Two GET helpers that differ only in whether the daemon's reason is kept: `daemon/httpTransport.ts:672-678` (`#read`, uses `refusal`) and `694-701` (`#get`, which throws `The daemon answered 503 for /v1/snapshot`). That text becomes `RootStore.loadError` (`RootStore.ts:177`) and shows on the Unreachable screen.
  - Hand-rolled fetch, `refusal`, JSON blocks: `212-236`, `514-553`, `590-608`, `617-627`.
  - SSE read loop (reader, `TextDecoder`, `SseParser`): `291-314` (clone), `332-355` (sync), `728-741` (feed), `httpFileSystem.ts:250-269` (watch).
  - Reconnect with backoff: `httpTransport.ts:703-752`, `httpFileSystem.ts:221-279` (same 500 ms and 10 s constants under other names, `34-35`), `terminalStream.ts:110-144`.
  - `sleepFor` three times (`httpTransport.ts:99`, `httpFileSystem.ts:37`, `terminalStream.ts:49`), while `@clowdy/lib/async` has `wait`.
  - Query strings built six ways: `?project=` (`180`), `?projectId=` (`557`, `586`), `placeQuery`, `pageQuery`, an inline `URLSearchParams` (`484`, `494-500`), and `?after=` (`461`).
- Problem (observed): about a third of the file is the same fetch and error handling written by hand, and the copies already differ: some keep the daemon's reason, some do not, and only the file-system watch closes its stream on every exit (F1).
- Fix: one `#request<T>(method, route, { query, json, body, signal, as: 'json' | 'blob' | 'none', allow404 })` that always uses `refusal()`. `readSse()` in `sse.ts`. A `followWithBackoff(attempt, { minMs, maxMs, signal, sleep })` helper shared by the feed, the watch and the terminal. One `query(record)` helper that drops `undefined` values. Expected net removal is about 250 lines; `httpTransport.test.ts` and the per-route transport tests pin the behavior.
- Category: reuse | simplify
- Effort: M. Risk: low

### F9. Four hand-rolled variants of latest-request-wins loading, one without a guard
- Where: `stores/RootStore.ts:204-237` (`refreshAgents`, `#fetchAgents`, sequence number, then waits for the newest), `stores/ModelsStore.ts:38-86` (the same written again: `#request`, `#newest`, `#settled`), `stores/ProjectState.ts:131-155` (`#loadId`), `stores/StreamStore.ts:32-63` (no guard). Status unions: `LoadStatus` (`ProjectState.ts:24`), `StreamStatus` (`StreamStore.ts:6`), `ModelsStatus` (`ModelsStore.ts:6`, identical to `StreamStatus`), and the inline `agentsStatus` literal (`RootStore.ts:69`).
- Problem (observed): `RunStream.reload()` can run twice at once: `reloadAll` during a resync while the first `load()` is still in flight. The second call resets `#pending`, and whichever reply lands last installs its items, so a reply that started earlier can overwrite a newer one. `ProjectState` guards this case and `RunStream` does not. Each store also re-derives its error text by hand (see F16).
- Fix: one small helper in `stores/`, for example `LatestRequest<T>` or `Resource<T>`, with `status`, `error`, `load()` (once unless failed), `reload()` (latest wins), `settled()` and a pending buffer hook for streams. Use it in all four places, with one `ResourceStatus` type.
- Category: reuse | correctness
- Effort: M. Risk: low-medium

### F10. A refused branch-prefix sync retries every 2 s forever and holds up the first load
- Where: `stores/RootStore.ts:143-157` (`load` awaits `branchPrefix.connect` before `phase = 'ready'`) and the copy at `404-418`. `features/chats/branchPrefix.ts` `flush()`: when `send` resolves `false`, it calls `setTimeout(() => void this.flush(), 2000)`. `send` maps both a refusal (`ok: false`) and an unreachable daemon to `false`.
- Problem (observed): a daemon that refuses `settings.setBranchPrefix` (an older minor without the command, or a value it validates differently) is asked again every 2 s for as long as the window is open, and again on each `connected`. When the prefix is pending at start, the project list waits for one command round trip before the window shows anything.
- Fix: make `send` return `'ok' | 'refused' | 'unreachable'`. On a refusal, clear `pending` and keep the daemon's value; retry only when the daemon was unreachable. Do not await `connect` inside `load()`. Fire it after `phase = 'ready'` and let `flush` run in the background.
- Category: correctness
- Effort: S. Risk: low

### F11. Command results are untyped, and protocol shapes are redeclared locally
- Where:
  - `packages/protocol/src/commands.ts:452` (`CommandResult<T = unknown>` has no map from command type to result). Casts: `stores/RootStore.ts:268`, `features/chats/forkChat.ts:43`, `features/agents/WorktreeCardHeader.tsx:82`, `features/worktrees/CreateWorktreeDialog.tsx:76`, `features/agents/useMainBranch.ts:85`. Hand parsers: `features/tasks/archiveRules.ts:64` (`archiveReply`), `features/tasks/taskView.ts` (`createdCommentId`, used at `CommentsSection.tsx:90`).
  - Payloads parsed with `as T`: every `httpTransport.ts` read, including `JSON.parse(frame.data) as ClowdyEvent` (`736`).
  - Local copies: `PlaceRef` (`daemon/transport.ts:99-102`) is protocol's `GitRemoteRequest` (`packages/protocol/src/git.ts:500-503`), and protocol itself repeats `folderId: string; workspaceId?: string` in about 8 request types (`git.ts:380,483,499,744,775,803,827`). `Notice` (`RootStore.ts:24-27`) is the `notice` event data.
- Problem (observed): each new caller of a command writes its own cast or parser, and a daemon change to a result shape is invisible to the type checker. Runtime validation of every payload is lower priority, because the protocol header already rejects other majors.
- Fix: add a `CommandResults` map keyed by `CommandType` to `packages/protocol`, type the daemon handlers against it, and make `RootStore.command`/`Transport.command` generic: `command<C extends CommandInput>(c: C): Promise<CommandResult<ResultOf<C['type']>>>`. Add a protocol `PlaceRef` that the git request types extend, and use it in `transport.ts`. Use `Extract<EventData, { type: 'notice' }>` for `Notice`.
- Category: safety | structure
- Effort: M (crosses into the daemon). Risk: low

### F12. `Transport` is one 60-method interface maintained in four places
- Where: `daemon/transport.ts:105-377`. `daemon/config.ts:114-175` lists every method in the `unconfigured` literal. `HttpTransport` and `FixtureTransport` implement it all. `root.ts:22` needs `instanceof HttpTransport` because `setAddress` is not part of the interface.
- Problem (observed): adding one route touches the interface, `HttpTransport`, `FixtureTransport` and `unconfigured`, plus tests. The interface doc comments also restate HTTP status semantics that belong to the protocol.
- Fix: compose `Transport` from domain interfaces (`GitTransport`, `TaskReads`, `TerminalTransport`, `FileTransport`, `AgentTransport`). `FixtureTransport` can then be split the same way (F6). Build `unconfigured` as a `Proxy` that answers `noDaemon` for any key, as `daemon/testing.ts` already does for overrides. Add an optional `setAddress?` to the interface, or have `createTransport` return `{ transport, setAddress }`.
- Category: structure
- Effort: M. Risk: low

### F13. Thirteen persisted-preference classes and a non-observable theme repeat one pattern
- Where: `features/chats/swipeReplyPreference.ts`, `busyEnter.ts`, `composerBannerPreferences.ts`, `newChatDefaults.ts`, `branchPrefix.ts`; `features/sidePanel/panelOrder.ts`; `features/changes/sourceControlPreferences.ts`, `sidebarLayout.ts`; `features/agents/chatListPreferences.ts`, `starCardState.ts`; `features/files/treeLayout.ts`; `features/openWith/openWithPreferences.ts`. Also `theme.ts:3-49` (a plain module variable and direct `localStorage`; `features/settings/AppearancePage.tsx:43` keeps a `useState` copy because the theme is not observable) and `stores/UiStore.ts:273-366` (`ProjectUi` hand-parses 19 stored fields, then lists the same 19 again in the persist reaction).
- Problem (observed): each class re-implements read, validate, default, set and write in 20 to 60 lines. The theme is a second pattern whose state is duplicated in a component. Adding a field to `ProjectUi` takes edits in three places (field, restore, reaction).
- Fix: add a `persisted(key, parse, fallback)` helper (a MobX box plus `writeStored`) or a small base class in `stores/storage.ts`. Make the theme one more observable preference that `AppearancePage` reads directly. Drive `ProjectUi` restore and persistence from one field table `{ name, parse }`.
- Category: reuse | simplify
- Effort: M. Risk: low

### F14. `RootStore` mixes the feed, the agents list and the project list, repeats snapshot intake, and imports features
- Where:
  - `stores/RootStore.ts:143-157` and `404-418`: the same `branchPrefix.connect` and `homeFolder.set` block.
  - The agents list is its own store inside: `66-70`, `83-85`, `204-237`, `378-388`. The feed lifecycle (banner, resync): `315-340`, `390-441`.
  - Stores import from features: `RootStore.ts:3` (`features/chats/branchPrefix`), `NavHistory.ts:3` (`features/agents/agentTree`), `NewChatDrafts.ts:5,9` (`features/agents/workspaceChoice`, `stream/MessageActions` types), `UiStore.ts:3` (`features/chats/draftSending`, another module store behind `useSyncExternalStore`).
  - `#resync` reloads every project state ever selected (`426`, since `#states` never evicts). One project whose snapshot keeps failing throws at `428` and retries every 2 s, which keeps the feed down for every project.
  - `RootStore.projects` and `ProjectState.project` both hold the project and both apply `project.upserted` (`345-352`, `ProjectState.ts:200-203`). `reorderProjects` (`289-304`) edits positions only in `RootStore.projects`, and its revert `this.projects = before` also discards any `project.upserted` that arrived during the await.
- Problem (observed): the class is the place every app-wide concern lands. The duplicated intake has to be kept in step by hand, and the dependency direction (stores to features) makes the stores hard to test or reuse alone.
- Fix: extract `#takeRootSnapshot(snapshot)`. Move the agents list into `AgentsStore`, built on F9's helper, and the feed into `FeedConnection` (subscribe, status, banner, resync). Move `branchPrefix`, `draftSending`, `samePath` and the selection functions that stores need into `stores/` or `shared/`. In resync, mark a project that cannot reload as failed and resume the feed for the rest. Let `ProjectState.project` read from the root's project map, and make the reorder revert touch positions only.
- Category: structure | correctness
- Effort: M. Risk: medium

### F15. `ProjectUi` is a 650-line class with six concerns, repeated reset and toggle code, and undisposed reactions
- Where: `stores/UiStore.ts:156-807`:
  - Navigation: `382-567`. The 7-field draft reset is written three times (`396-411`, `414-425`, `557-567`), and `show()` assigns `this.draft` twice (`402`, `405`).
  - Chat list layout: `570-641`. Side panel: `643-727`. Tasks screen: `729-806`. Completion read state: `368-380`. Comment drafts: `773-794`. Pending files: `226-234`.
  - Toggle-in-list written four times: `570-574`, `600-604`, `618-622`, `767-771`.
  - The two `reaction`s at `334-365` are never disposed. `forgetProject` (`891-898`) drops the object but a component still holding it can write the storage key back after `removeStored`. The persisted `seen` completions map (`246`, `376-380`) is never pruned for deleted chats.
- Problem (observed): any change to one screen's UI state touches the same file and constructor as every other screen's, and the class is the largest store.
- Fix: compose `ProjectUi` from `ProjectNavigation`, `ChatListUi`, `SidePanelUi` and `TasksUi`, keeping `ProjectUi` as a facade first so callers do not change. Add `#clearDraft()` and a `toggled(list, id)` helper. Keep the reaction disposers and call them in `forgetProject`. Prune `seen` to chats that exist when a snapshot arrives.
- Category: structure | simplify
- Effort: L. Risk: medium

### F16. Small helpers re-implemented beside `@clowdy/lib` and `shared/time.ts`
- Where:
  - Durations, three formatters with three outputs: `stream/turns.ts:27-41` (`Worked for 2m 4s`), `stream/reasoning.ts:5-21` (`Thought 2m 4s`), `shared/time.ts:41-51` (`formatDuration`, `2m 04s`).
  - `error instanceof Error ? error.message : String(error)` appears 19 times in the renderer, including `ProjectState.ts:148`, `StreamStore.ts:60`, `RootStore.ts:177,234,249` and `ModelsStore.ts:73`, while `errorMessage` from `@clowdy/lib/errors` is already used in `features/changes`.
  - `isRecord`/`isObject` three times: `stream/toolView.ts:23`, `stores/NewChatDrafts.ts:34`, `features/chats/modelSelection.ts:34`. `sleepFor` three times (F8), and `ProjectState.group` (F5).
- Problem (observed): the same "Xs, Xm Ys, Xh Ym" logic already disagrees on padding, and the copies drift as each is touched.
- Fix: one `formatSpan(ms)` in `shared/time.ts` used by both labels, after choosing one style. `errorMessage` everywhere. `isRecord` in `@clowdy/lib`. `wait` from `@clowdy/lib/async`.
- Category: reuse
- Effort: S. Risk: low (labels change only if the style is unified)

## Cross-area notes

- **packages/protocol:** a `CommandResults` map keyed by command type, consumed by the daemon's handlers and the renderer's `command()` (F11). A shared `PlaceRef` for git and fs requests (F11). Typed query builders next to `ROUTES` would remove the six query styles in `HttpTransport` (F8).
- **Daemon contract:** the daemon already heartbeats every 15 s. The renderer's feed and watch should treat a missing heartbeat as a dropped connection (F1). `run.upserted` for every context reading is a frequent event (`service.ts:1266`); if the renderer cannot narrow its subscriptions (F5), a daemon-side coalescing of context updates would help too.
- **packages/lib:** `isRecord`, and perhaps a `followWithBackoff` and a `readSse` (the daemon has its own SSE writer, not a reader, so the reader can stay in the renderer). `errorMessage` and `wait` already exist and are under-used (F16).
- **features/ (other researchers):** `composerDrafts.ts` and `draftSending.ts` are module stores behind `useSyncExternalStore` beside MobX (F7, F14). `features/agents/AgentList.tsx` (1,190 lines) re-renders on every chat, run and draft change through `worktreeCards(project.chats.values())`, `nativeAgentsByRoot(project.runs.values())` and the drafts list (F5, F7). `useDraftWorkspaceRow.ts`, `useSidebarWorktrees.ts`, `quickSearchChats.ts`, `useFolderRepair.ts` and `RemoveWorktreeDialog.tsx` also copy whole maps in render.
- **Testing:** `FixtureTransport` doubles as the test daemon for many feature tests (`screenHarness.tsx`, `modelTestKit.ts`, `projectsTransport.test.ts` at 2,463 lines). Splitting it or replacing it (F6) changes those harnesses.

## Not inspected / limits

- The visual stream components (`ToolCard`, `QuestionPanel`, `SelectionReply`, `useSwipeReply`, the markdown chip components except `InlineCode`) were read only where they touch the data layer. CSS was not reviewed.
- `daemon/fixtureTransport.ts` and `fixtureData.ts` were outlined, not read line by line. No claim is made about their parity with the daemon beyond their size and the duplicated responsibilities.
- `hotkeys/` (registry, dispatcher, React bindings, `listCursor`, `listNavigation`, `undo`) was reviewed and has no finding worth a change: the registry is observable at the right granularity, scopes and chords are tested, and the linear scans (`registry.ts:385`, `react.ts:21`) are fine at about 200 commands.
- `updateOffer.ts`, `main.tsx`, `daemon/terminalStream.ts` (apart from the backoff copy) and `stores/taskReveal.ts` showed no defect.
- The re-render claims in F2, F4 and F5 follow from the code (observer memo through `babel-plugin-observing-components` with `mobx-react-lite`, per-render props, whole-map iteration). They were not profiled. The connection-limit consequence in F1 is inferred, not reproduced.
- No tests were run.

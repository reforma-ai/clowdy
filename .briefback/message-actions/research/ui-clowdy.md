# Clowdy chat UI: where per-message actions would hook in

Snapshot 2026-11-20, `main` at `0d37a49` (working tree: only `.gitignore` and `packages/components/src/Scrollable/README.md` modified, unrelated). Research only: no plan, no design. Scope is the Clowdy renderer side (`apps/desktop/src/renderer`, `packages/components`, `packages/icons`, `packages/lib`, `packages/protocol` types as the renderer sees them). The daemon, ACP and the reference apps are covered elsewhere. No `.codegraph/` index exists in this repo, so everything below was read with Read/grep.

## Summary

- The chat page is `ChatView` (`features/chats/ChatView.tsx`): a `StreamView` (the message list) over one `Composer`. The list is plain DOM, **not virtualized**, scrolled by a native `overflow-y: auto` div with `useStickToBottom`. Native text selection works (no `user-select: none` on messages).
- Per-message UI is thin today: a user message is `UserBubble` (bubble plus an **always visible** `HH:mm` `<time>`), an assistant message is `AssistantMessage` (Markdown only, no footer). There are no hover actions, no copy buttons, no notion of "last message" in the list.
- The final answer of a turn is decided inside `stream/turns.ts` (`isAnswer`, `foldTurn`), but that knowledge is not exported and not attached to the rendered blocks. A finished turn renders as: user bubble, `Worked for Ns` fold, answer. A turn of the active run is rendered flat (no fold).
- The composer is a single component with state keyed by chat id (drafts and files live in module-level maps). It has no "edit" mode, no quote or reply model, no way to send anything but `chat.send`. A second composer instance on the same chat would share the draft and files unless given another key.
- There is **no fork, edit-history, or reply concept anywhere**: not in `packages/protocol` (commands, `Chat`, events), not in the renderer, not in the fixture daemon. `BACKLOG.md` lists "Copy answer / Fork thread / Other buttons" and "Edit message" as open items. The only parent link is `Chat.parentChatId`, which means "thread of" and carries behavior (list nesting, parent notifications, cascade archive and delete, the `Thread of <parent>` crumb).
- The stream store can only upsert items (`RunStream.upsert`); no event deletes or truncates a stream. "Delete newer history" has no renderer path today besides `RunStream.reload()` (a refetch).
- Chat settings are desktop-local (a MobX class over `localStorage`), no daemon involvement. A new boolean setting follows `busyEnter.ts` plus a `SettingsRow` with a `Switch`.
- The design system has what the UI needs except a floating selection toolbar, a reply or fork icon, and an `IconButton` (icon buttons are `Button iconOnly` with `tooltip`). Time format `19 Nov, 22:54` is `Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })` (verified in Node); the daemon has it as `formatMoment` (`apps/daemon/src/runs/limits.ts`), the renderer does not.

## How it works

### 1. Chat view and message list

- `features/agents/Screen.tsx` renders `<ChatView key={chat.id} chat=...>` (remounts per chat), or `DraftChat` (new-chat page), or `RunDetail` (a native sub-agent's run, read only).
- `ChatView` wraps everything in `ChatDropZone` (drop and paste of files, routes to `composer.current?.addFiles`), shows the `ThreadCrumb` line for a thread (`chat.parentChatId`), loading and failure states, then `StreamView`, then a `ContentColumn` holding `RunningAgents` (the "Agents running" `ComposerBanner` plate) above the `Composer` (or `ReadOnlyNotice` when the chat's provider cannot run).
- `ChatView` passes `StreamView` these: `items` (from `useChatStream(chat)`, i.e. the orchestrator run's stream), `active` (`isRunActive(run)`), `working`, `links` (task chips, attachment blobs, thread card links), `decorate` (puts the `ProgressCard` after the latest assistant item, `cardAfter`), `errorAction` (Compact on a context overflow), `onAnswer`.
- `StreamView` (`stream/StreamView.tsx`): `turnMarks(items)` for the right-hand `TurnRail`; `foldFinishedWork(items, active)` into blocks; each block is drawn by `renderItem(item)` (switch on `body.kind`). Layout: `.root > .scroll (div, overflow-y:auto, ref via useStickToBottom) > ContentColumn.content (flex column, gap --spacing-lg, padding --spacing-xxl)`. A "scroll to latest" button floats over it. A `shown` set (item ids present at first render) decides which user bubbles animate in.
- `StreamView` is shared with `RunDetail` (read-only sub-agent run), so any message actions must be opt-in per caller.

### 2. Data shape (renderer side = protocol types)

- `StreamItem` (`packages/protocol/src/domain.ts`): `{ id: string, runId, seq: number, at: number (epoch ms), body }`. Items are merged by `id` and sorted by `seq` in `RunStream.items` (`stores/StreamStore.ts`); streaming text updates one `assistant` item in place.
- `StreamItemBody` kinds: `user { text, attachments?, from? }`, `assistant { text, done }`, `tool { toolCallId, name, input, state, output?, error? }`, `note { text }`, `question {...}`, `error { text }`. No thinking-block kind exists. Tool calls, sub-agent cards, compaction lines and notes are all separate items.
- `user.from` (`MessageSource`): `{kind:'thread'}` or `{kind:'threadNotice'}` means an agent wrote it, so `StreamView` draws a card (`ThreadMessageCard`, `ThreadNoticeCards`) and not a `UserBubble`. Only items without `from` are the person's.
- A queued message shows in the stream only once the agent took it (`QueuedMessage` lives in `Chat.queue`, not in the stream). A steer therefore appears as a `user` item in the middle of a running turn.
- Timestamps: `item.at` only. Whether `at` of an `assistant` item is its first-token or last-update time is a daemon matter (not checked).
- No per-item model or token info on the stream item; the run carries `engine`, `model`.

### 3. Turns, the fold, and the final answer

`stream/turns.ts` `foldFinishedWork(items, active)`:
- Splits the stream into turns, **each starting at any `user` item** (a steer, a thread message and a thread notice start a "turn" too).
- The latest turn is returned as plain items while `active` (run not terminal); every other turn goes through `foldTurn`.
- `foldTurn`: the answer is the last item where `isAnswer` (non-exported): `assistant && done && text.trim() !== ''`. Items between the user item and the answer (minus errors and questions, which stay outside) become one `{ kind: 'worked', key, label, items }` block, label from `workedForLabel(turn[0].at, answer.at)` ("Worked for 8s"). Anything after the answer (the answer itself, trailing compaction line, note) stays as plain item blocks. A latest turn with no answer (stopped, failed) stays flat.
- `Worked` (`stream/Worked.tsx`): `Collapsible` with a `Button variant="inline"` trigger; the panel mounts children only while open (a closed fold costs nothing and its DOM does not exist).
- Consequences for actions: the answer is a plain `{ kind: 'item' }` block today with no marker; while a run is active, the flat latest turn has several `assistant` texts and no stable "final" one; `ChatView.cardAfter` separately computes "latest assistant item" for the progress card.

### 4. How messages render

- `UserBubble` (`stream/UserBubble.tsx`): `div.row[data-turn][data-animate]` (right-aligned column), optional `Attachments` above, `div.bubble` with the text as `Markdown fromPerson` (after `personMarkdown(text, taskOfKey)` turns `@path` and task keys into inline code so they chip), clamped by `Clamp` (16 lines) over 500 chars, then `<time className=time>{formatTime(at)}</time>` **always visible** (`shared/time.ts`, `HH:mm`, en-GB 24h). `data-turn` is what `TurnRail` scrolls to (`scrollStreamToTurn`).
- `AssistantMessage` (`stream/AssistantMessage.tsx`): `div.message > Markdown` with `streaming={!body.done}`. No wrapper data attributes, no footer.
- `Markdown` (`stream/Markdown.tsx`): Streamdown 2.7.1 with `STREAMDOWN_OPTIONS` (`stream/markdown/options.ts`: `controls: false`, so no built-in copy buttons; sanitize and harden; raw HTML only for agents). Custom components in `stream/markdown/components/` (paragraph is a `div`, code blocks via `CodeHighlighter`, file and task chips). `streaming` mode adds fading spans and a block caret; static after `done`. `.person [data-streamdown='p'] { white-space: pre-line }` keeps a person's single line breaks. Blockquote styling exists (`markdown.css`: 3px start border, muted text), so a `> quote` in a user message renders as a quote.
- Selection: nothing disables it in the chat; `user-select: none` appears only on controls (ToolCard head, Button, chips in some places). `window.getSelection().toString()` yields **rendered text**, not source Markdown (chips give their label, code fences lose the fence, paragraphs are `div`s). The source is `item.body.text`.
- No text-selection code exists in the app except `FindBar` (`shell/FindBar.tsx`, native `findInPage`, calls `removeAllRanges`).

### 5. Existing hover actions, timestamps, copy, last-vs-earlier

- Hover actions: none on messages. Convention elsewhere: `data-show={listBoxItemDataShow.itemHover}` for list rows (`packages/components/src/List/ListBox.tsx`), and `@media (hover: hover) { .row:hover .action { opacity: 1 } }` with `opacity: 0` at rest in `features/chats/ComposerBanner.module.css` (also `:focus-within`). `AGENTS.md` for components: row actions stay hidden until hover.
- Timestamps: `UserBubble` and `NoteLine` each draw `formatTime(at)`. Assistant messages have none.
- Copy: `@clowdy/components/CopyButton` (`CopyButton`, `copyText`, `copyWithFeedback`, `useCopyFeedback`: icon swaps to Check, tooltip "Copied", error toast "Couldn't copy"). `FileChip` copies a path on press. Clipboard writes are allowed from the app page (`apps/desktop/AGENTS.md`, Security invariants); the native Edit menu has `role: 'copy'` (`src/main/menu.ts`).
- Last vs earlier: no distinction. The closest hooks are `StreamView`'s `items.at(-1)` (`last`, used for `live`) and `ChatView`'s `cardAfter`.

### 6. The composer

Files: `features/chats/Composer.tsx` (315 lines), `ComposerSend.tsx`, `ComposerQueue.tsx`, `ComposerBanner.tsx`, `composerDrafts.ts`, `composerFiles.ts`, `useComposerFiles.ts`, `composerMentions.ts`, `useMentionTriggers.ts`, `MentionChip.tsx`, `busyEnter.ts`, `useModelChoice.ts`, `ModePicker`, `ModelPicker`, `ContextRing`.

- **Props:** `chat | undefined`, `run`, `start?` (new-chat page: `projectId`, `onStarted`, `defaults`), `minLines`, `ref: ComposerHandle` (`{ addFiles }` only).
- **Input:** `RichInput` from `packages/components/src/RichInput` (TipTap: Document, Paragraph, Text, HardBreak, History, Bold/Italic/Code and bullet/ordered lists as markdown input rules, `ComposerMention` atom with `@` and `/` triggers). **No blockquote node.** Value is a `ComposerDoc` (TipTap JSON). `submitOnEnter`, `onSubmit(doc, {mod})`, `onEscape` exists on `RichInput` but `Composer` does not use it, `onPasteFiles`.
- **State ownership:** `key = chat?.id ?? newChatDraftKey(projectId)`. Draft docs are in a module-level `Map` in `composerDrafts.ts` (`draftOf`, `saveDraft`; lives for the session, lost on reload); the component mirrors the last edit in `useState({key, doc})`. Files are in a module-level store in `composerFiles.ts` (`filesOf`, `setFiles`, `takeFiles`, `restoreFiles`, `releaseFiles`, subscribe via `useDraftFiles(key)`), because uploads outlive the component. Both use the same key, so **two composers on one chat share draft and files** unless the key differs (there is no `draftKey` prop).
- **Send flow** (`send` in `Composer.tsx`): `messageOf(doc)` (= `docToPlainText(doc, serializeMention).trim()`) plus ready files; clears draft; creates the chat when there is none (`chat.create` with the model choice and mode); `chat.send { chatId, text, attachmentIds?, mode }` through `perform` (toast on refusal); on refusal gives words and files back (`giveBack`); on success `releaseFiles`. `mode = sendMode(busyEnter.mode, mod)`: Enter steers or queues per Settings > Chat, Cmd/Ctrl+Enter the other way. `isRunBusy(run)` makes the placeholder "Queue another message…". The send button is `ComposerSend` (Stop while running with an empty field).
- **Mentions:** `useMentionTriggers(box)` gives `@` (tasks, docs, files) and `/` (skills) triggers anchored to the card; `serializeMention` writes `CAR-24`, `@path`, `Use the skill "name"`. Mention kinds are a closed union in `RichInput/types.ts` (`ComposerMentionKind`).
- **Attachment chip model:** `DraftFile` (`composerFiles.ts`: `key`, `name`, `mediaType`, `size`, `preview?`, `status uploading|ready|error`, `attachment?` the daemon's `Attachment`, `source?`). Rendered in `Composer` as `Attachments > PreviewableAttachment` (from `packages/components/src/Attachment`, which has `onRemove`, `loading`, `error`) in `.files` above the field. Send is held while any is uploading or failed. This is the existing "chip above the field" slot a quote chip could share or imitate; `Attachment` is built for files (preview or file icon, size).
- **Above the card:** `RunningAgents` (a `ComposerBanner` plate with "Agents running", rows, Stop and Stop all) is rendered by `ChatView` outside `Composer`, so "without the controls above" in edit mode is a `ChatView`-level choice. Inside the card, `ComposerQueue` (messages waiting, `chat &&` condition) sits at the top; `ReadOnlyNotice` replaces the composer for unwritable providers. Below the field: attach button, `ModePicker`, `ContextRing`, `ModelPicker`, send (`.row`, `.start`, `.end`).
- **Existing analog for "edit":** a queued message's Edit (`Composer.editQueued`): `chat.removeQueued { keepFiles: true }` (in `ComposerQueue`), then words go in front of the draft (`withTextFirst`) and files come back as ready `DraftFile`s (`restoreFiles`). That edits something that was never sent; editing sent history has no equivalent.
- **Width:** `ContentColumn` (`--content-width: 50.5rem` in `packages/styles/src/tokens/local/misc.css`); its docs say a subtree that needs another width sets `--content-width` itself. `.surface` has `container-type: inline-size`, and the model pill hides its level under 380px.
- **Colors:** `--color-chat-composer-header` exists in `packages/styles/src/tokens/variables/theme.css` (light and dark) and is not used by any app or component CSS (Reforma's composer header color).
- **Inserting a quote into the draft:** `Composer` has no method for it. `RichInputHandle.appendText(text)` exists but `ComposerHandle` does not expose it, and TipTap `insertContent(string)` parses HTML, so `\n` most likely collapses (inferred from TipTap behavior, not run here). The document-level route is `plainTextToDoc(text)` (splits on `\n` into `hardBreak`s inside ONE paragraph) or `appendTextToDoc` / `prependMentionInDoc` (exported by `RichInput/index.ts`, currently unused by the app) applied through `edit(...)`. `docToPlainText` writes a hard break as two spaces plus newline, then `messageOf` trims. So `> line1\n> line2\n\nanswer` survives a round trip as markdown, but each quoted line must carry its own `> `.

### 7. Chats, threads, creation, parent relations

- Creation: `chat.create` (`packages/protocol/src/commands.ts`: `projectId`, `title?`, `mode?`, `engine?`, `model?`, `effort?`) answers `{ chat }`. The new-chat page (`DraftChat` plus `Composer start`) creates on first send and calls `ui.openChat(chatId)`. `chat.send` has no edit, rewind or truncate option. No `chat.fork`.
- `Chat` (`domain.ts`): `id, projectId, title, mode, engine?, model?, effort?, orchestratorRunId?, parentChatId?, archivedAt?, queue?, queuePaused?, createdAt, updatedAt`. No `forkedFrom`.
- `parentChatId` = thread. Effects: `ProjectState.threadsOf/threadsBelow`, `features/agents/agentTree.ts` (`agentRows`: threads nested under their parent at any depth, folds), `AgentList`, `RunningAgents` (`threadsAtWork`), parent notices (`threadNotice`), archive and delete cascade, `ThreadCrumb` in `ChatView` ("Thread of <parent title>", opens the parent via `openChat`). Reusing it for forks would put forks under the source chat as threads and trigger those behaviors.
- Closest existing "from another chat" machinery: `features/chats/handoff.ts` (`startHandoff`, client-side only: builds a `<title>-conversation.md` transcript with `turnsOf`/`transcriptOf`, drops a sentence into the new-chat draft and a file into `ui.pendingFiles`, then `ui.openDraft([file])`). It is how `ReadOnlyNotice` offers "Hand off to a new chat". Not a fork (no history copied, no session).
- Opening a chat from code: `openChat(root, project, ui, chatId)` in `features/chats/archiveChat.ts` (un-archives first), or `ui.openChat(chatId)` (`stores/UiStore.ts` `ProjectUi`).
- Where an indicator could live: (a) `ThreadCrumb`-style slim line at the top of the stream (`ChatView.module.css .crumb`); (b) a row on `ComposerBanner` (`features/chats/ComposerBanner.tsx`, a plate above the card; `ComposerBannerStatus` has icon, text, optional action); (c) a divider in the list: `Marker variant="separator"` (`packages/components/src/Marker`, "labeled divider", documented for chat days) exists but only the default variant is used in the app (`NoteLine`, `CompactionLine`).
- Chat events: `chat.upserted`, `chat.deleted { chatId, runIds }` (`packages/protocol/src/events.ts`). No stream truncation event; `RootStore` handles `stream.item` by `streams.applyItem` (upsert only); a feed resync calls `streams.reloadAll()`.

### 8. Chat settings

- Page: `features/settings/ChatPage.tsx` (sidebar entry "Chat" in `features/settings/Screen.tsx`). Built from `SettingsPage > SettingsSection > SettingsCard > SettingsRow` (`features/settings/ui/`), plus `NewChatChoices`. Today: Messages section with one row (`Send a message while the agent is working`, a `ToggleButtonGroup` Steer or Queue), and New chats.
- Persistence is **desktop-local, in `localStorage`, via a small MobX class**: `features/chats/busyEnter.ts` (`BusyEnterPreference`, key `clowdy:enter-while-busy`, read once at construction, `makeAutoObservable`) and `features/chats/newChatDefaults.ts` (`clowdy:new-chat-engine`, `clowdy:new-chat-mode`); helpers `readStored`, `writeStored`, `browserStorage` in `stores/storage.ts` (JSON, try/catch, tolerate missing storage). No daemon setting is involved. Daemon-side settings that do exist are project settings (`ProjectSettings`) and per-agent boolean settings (`agent.update settings`), neither fits a UI gesture preference.
- Boolean control precedent: `Switch size="sm" isSelected onChange aria-label` inside a row (`features/settings/providers/ProviderSettings.tsx`, `skills/SkillRow.tsx`); inside the settings blocks that would be `SettingsRow title description` with the `Switch` as children (the row puts the control at its end).
- UI text rule (`AGENTS.md`): a single-sentence label, description or hint has no trailing period; two or more sentences keep periods (the existing Steer row description has two sentences and periods).
- Test pattern: `features/settings/ChatPage.test.tsx` (happy-dom, `observer(ChatPage)` because the babel observer plugin does not run under Vitest, resets preferences in `beforeEach`/`afterEach`).

### 9. Reusable design-system parts and icons

Import by subpath (`@clowdy/components/Button`), never the barrel (`apps/desktop/AGENTS.md` Traps).

- `Button` (`variant` filled/filling/ghost/bordered/transparent/inline; `size` xs/sm/md/lg; `iconOnly`, `rounded`, `tooltip`, `tooltipPlacement`, `isPending`). There is no `IconButton`. The hover-plate look is `variant="filling"` (as the attach button) or `ghost`.
- `CopyButton` (+ `copyText`, `copyWithFeedback`, `useCopyFeedback`) for Copy with Check feedback; `Tooltip`, `tooltipWithHotkey` (`@clowdy/components/Hotkey`); `toast` (`@clowdy/components/Toast`: `show/success/error/info/warning`, optional `action`); `Menu`/`MenuItem` and `PopoverScroll` (`@clowdy/components/List`, `Popover`); `Marker`; `Attachments`/`Attachment`/`PreviewableAttachment`; `Clamp` (app-level, `stream/Clamp.tsx`); `Scrollable` (used by `TurnRail`, `ComposerQueue`, tables; the stream itself uses a plain div); `Show`, `For`, `Box`, `Text`.
- Floating positioning: `Popover` is a thin React Aria popover (`offset=8`, `containerPadding=8`). A virtual anchor precedent: `Popover/useContextMenu.ts` makes a zero-size `position: fixed` DOM element at the pointer and passes it as `triggerRef`. A different precedent: `RichInput/RichInputTriggerMenu.tsx` portals to `body` and clamps a fixed-position box to a rect (`clampMenuPosition`, flips above or below by available room). **No selection toolbar component exists.** Z-index tokens: `--z-popover` 101000, `--z-tooltip` 101200 (`packages/styles/src/tokens/local/zIndex.css`).
- Icons (`@clowdy/icons/14`, PascalCase of the SVG name; verified exported): `Copy`, `Check`, `Close`, `Edit`, `EditPen`, `EditSquare`, `Quote`, `Undo`, `Revert` (curved arrow), `ArrowUpLeft`, `CornerBottomLeft`, `CornerTopLeft`, `Message`, `Refresh`, `RefreshLeft`, `Split`. 16 pack: `Duplicate`, `Undo`, `Redo`, `Pen`, `Replace`, `Close`, `Chat`; 12 pack: `Copy`, `Edit`, `Quote`, `Split`, `Check`, `Close`. **No reply and no fork or branch icon.** `Split` (two arrows diverging) is already the thread mark (`ThreadCrumb`, `ThreadCards`, `RunningAgents`, `ComposerQueue`), so using it for fork would collide in meaning. Icons are drawn in Reforma's Figma file and pulled with `./clowdy sync icons` (`packages/icons/README.md`); component source is generated into `dist/`.
- Time helpers: renderer `shared/time.ts` has `formatTime` (HH:mm, 24h en-GB), `formatDuration`, `formatRemaining`, `formatElapsed`, `describeRemaining`; `features/tasks/taskView.ts` `formatAgo`; `packages/lib/src/date.ts` has `formatDate(date, mask, locale)` with mask tokens (`d`, `MMM`, `HH`, `mm`, ...; quoted literals) and `formatChatDayLabel` (Today, Yesterday, `Mon, Jul 21`, uses en-US); daemon-only `formatMoment(at, now)` produces exactly "time today, `19 Nov, 22:54` on another day". Which year to show for older items is unspecified in all of them.
- Gestures: none. `packages/lib/src/events.ts` `normalizeWheelDelta` (deltaMode normalization, Shift to horizontal) is unused. `useStickToBottom` listens to `wheel` (passive) and only reads `deltaY`, so horizontal deltas do not affect it. `packages/styles/src/base.css` sets `overscroll-behavior: none`. No `swipe` or horizontal-wheel handler in main, preload or renderer.

### 10. Tests and how to run them

- `cd apps/desktop && bun run test [paths]` (Vitest 5, root rule: never bare `bun test`); verified here: `StreamView.test.tsx` and `UserBubble.test.tsx`, 15 tests pass in about 3 s. DOM tests opt in with `// @vitest-environment happy-dom` and use `createRoot` plus `act`. `vitest.setup.ts` makes every test a reduced-motion user.
- Chat UI tests: `stream/StreamView.test.tsx` (items builder `item(n, body)`, fold behavior), `stream/UserBubble.test.tsx` (`renderToStaticMarkup`), `UserBubbleClamp.test.tsx`, `stream/turns.test.ts`, `turnMarks.test.ts`, `ThreadCards.test.tsx`; `features/chats/ChatView.test.tsx` (421 lines, real `RootStore` on `FixtureTransport` and `createFixtureData`; mocks `stream/Markdown` because Shiki wasm cannot load under happy-dom; redraws by hand after store changes since the observer plugin does not run), `Composer.test.tsx` (504 lines, fake store with `command` spy, drives the TipTap editor via `contenteditable.editor.commands.insertContent`, drafts are per chat id for the session so each test makes its own chat id), `ComposerDraft.test.tsx`, `ComposerFiles.test.tsx`, `ComposerQueue.test.tsx`, `features/settings/ChatPage.test.tsx`.
- Fixture daemon: `daemon/fixtureTransport.ts` (1487 lines) implements every command in a `switch` (`chat.send` → `#sendMessage`, `#startTurn`, `#removeQueued`, ...) and `daemon/fixtureData.ts` the data. A new command in the protocol needs a fixture implementation or the dev `?fixtures` page and these tests cannot exercise it. Visual checks: `bun scripts/screenshot.ts` (see `apps/desktop/AGENTS.md`).

## Relevant files and modules

Message list and stream (`apps/desktop/src/renderer/`):
- `features/chats/ChatView.tsx`: chat page; builds `links`, `decorate` (`cardAfter`), mounts `StreamView`, `RunningAgents`, `Composer`, `ThreadCrumb`.
- `features/agents/Screen.tsx`: picks `ChatView` / `DraftChat` / `RunDetail`; `features/agents/DraftChat.tsx`: new-chat page and its composer.
- `stream/StreamView.tsx`: list, `renderItem`, stick-to-bottom, rail, scroll-to-latest button.
- `stream/turns.ts`: `foldFinishedWork`, `foldTurn`, private `isAnswer`, `workedForLabel`; `stream/Worked.tsx`: the fold UI.
- `stream/UserBubble.tsx` (+ `.module.css`): the user message and its `<time>`; `stream/AssistantMessage.tsx`: assistant text.
- `stream/Markdown.tsx`, `stream/markdown/options.ts`, `stream/markdown/markdown.css`, `stream/personMarkdown.ts`: rendering and person-text preprocessing.
- `stream/StreamLinks.ts`: context for task and chat links; `stream/ThreadCards.tsx`, `stream/threadMessages.ts`: agent-written cards.
- `stream/TurnRail.tsx`, `stream/turnMarks.ts`: right rail; `data-turn` attribute contract; `scrollStreamToTurn`.
- `stream/Clamp.tsx`, `stream/NoteLine.tsx`, `stream/CompactionLine.tsx`: neighbors that also draw times and `Marker`s.
- `stores/StreamStore.ts` (`RunStream`, `StreamStore`), `stores/hooks.ts` (`useChatStream`), `stores/RootStore.ts` (event application, `command`), `stores/ProjectState.ts` (`chats`, `runs`, `threadsOf`), `stores/UiStore.ts` (`ProjectUi.openChat`, `openDraft`, `pendingFiles`).
- `shared/time.ts`: `formatTime` and friends.

Composer:
- `features/chats/Composer.tsx`, `ComposerSend.tsx`, `ComposerQueue.tsx`, `ComposerBanner.tsx`, `RunningAgents.tsx`, `ReadOnlyNotice.tsx`, `ChatDropZone.tsx`.
- `features/chats/composerDrafts.ts` (`draftOf`, `saveDraft`, `messageOf`, `withTextFirst`, `newChatDraftKey`), `composerFiles.ts`, `useComposerFiles.ts`, `composerMentions.ts`, `useMentionTriggers.ts`, `MentionChip.tsx`, `busyEnter.ts`, `commands.ts` (`perform`).
- `packages/components/src/RichInput/` (`RichInput.tsx`, `composerDoc.ts`: `plainTextToDoc`, `docToPlainText`, `appendTextToDoc`; `types.ts`).

Protocol and daemon-facing:
- `packages/protocol/src/domain.ts` (`Chat`, `StreamItem`, `StreamItemBody`, `Attachment`, `QueuedMessage`, `MessageSource`), `commands.ts` (no edit or fork command), `events.ts`.
- `apps/desktop/src/renderer/daemon/transport.ts` (`Transport`, `CommandInput`), `fixtureTransport.ts`, `fixtureData.ts`, `httpTransport.ts`.

Settings:
- `features/settings/ChatPage.tsx`, `features/settings/Screen.tsx`, `features/settings/ui/*`, `features/chats/busyEnter.ts`, `features/chats/newChatDefaults.ts`, `stores/storage.ts`, `features/settings/ChatPage.test.tsx`.

Design system and icons:
- `packages/components/src/{Button,CopyButton,Tooltip,Popover,List,Toast,Marker,Attachment,Scrollable,hooks}`; `hooks/useStickToBottom.ts`; `Popover/useContextMenu.ts`; `RichInput/RichInputTriggerMenu.tsx`.
- `packages/icons/src/{12,14,16}/*.svg` (sources), `packages/icons/dist/` (generated).
- `packages/lib/src/date.ts`, `packages/lib/src/events.ts`.
- `packages/styles/src/tokens/variables/theme.css` (`--color-chat-*`), `tokens/local/zIndex.css`, `tokens/local/misc.css` (`--content-width`).

## Constraints

- **Shared list:** `StreamView` also draws read-only sub-agent runs (`RunDetail`); actions need an opt-in from `ChatView`.
- **Not every `user` item is the person's:** only items without `from` are; thread cards and notices should not get Edit.
- **Final answer is ambiguous while a run is active:** the latest turn is rendered flat with several assistant texts, and a streaming assistant item has `done: false`. A finished turn's answer is `turns.ts` `isAnswer` (last done, non-empty assistant item); the helper is private, so identification must be shared or re-derived consistently with the fold.
- **Folds and DOM:** the `Worked` panel children are not mounted while closed, so per-message UI inside folds exists only when open; actions under the answer sit outside the fold.
- **Layout shifts:** `useStickToBottom` pins to the bottom on content resize while stuck, and unlocks on upward scroll. Hover-revealed rows must not change height (opacity only, reserved space), or hovering shifts the list; actions that appear under the last message when streaming ends do grow the content once (handled by the stick logic).
- **`progress` card order:** `decorate` renders the `ProgressCard` right after the latest assistant item in the same flow; an action row under that message competes with it for "below the answer".
- **Turn rail contract:** `data-turn` on the user row root is read by `scrollStreamToTurn`; keep it on an element whose top is the message top.
- **`UserBubble` already shows a permanent time;** the requested hover-only timestamp replaces it (no test asserts on it today: `UserBubble.test.tsx` has no time check).
- **Selection to quote:** DOM selection text is rendered text; the whole-message path can use `body.text` exactly, the partial path cannot recover Markdown source without extra mapping. Selection while an assistant item streams is re-rendered by Streamdown. `FindBar` (native find) can set or clear selection, so a `selectionchange`-driven toolbar can fire from search. The stream container is the right scope for listeners; the composer is a contenteditable outside it.
- **Composer state:** one draft and one file store per key; `ChatDropZone` knows only one `ComposerHandle`; `autoFocus={!chat?.orchestratorRunId}` means an edit composer must set focus itself; `ComposerQueue` renders inside `Composer` when `chat` is set; `send()` is one monolithic function (create-chat, `chat.send`, give-back) with no injection point for another command.
- **Quote chip vs mention:** mention kinds are a closed union in the components package and serialize as text; adding a quote kind changes `RichInput` types, `serializeMention`, `MentionChip`. A separate per-key reply state (like `DraftFile`s) would need `hasMessage`, `send`, drafts and `giveBack` to include it.
- **No `parentChatId` reuse for forks** (see section 7).
- **No stream truncation path:** after an edit that deletes newer history, the renderer needs `RunStream.reload()` or a new event; `RunStream` today only upserts by id and sorts by `seq`.
- **Fixture daemon parity:** any new command or field must be added to `fixtureTransport.ts` and `fixtureData.ts` (and tests use them).
- **Repo rules:** subpath imports; no `observer()` in app code (babel plugin) but tests wrap with `observer`; UI text rules (no trailing period on one sentence); 13px chrome type; weights 400 and 500 only (`weight="medium"`, not `bold`); MobX 7 uses `observableRef`/`observableShallow`; comments, identifiers and test titles in English.
- **Icons:** a missing icon is drawn in Figma and synced; do not hand-add SVGs to `dist/`.
- **Settings:** per-computer preferences go in `localStorage` through the MobX-class pattern; tests need their own reset.
- **Windows:** hover and pointer gestures were not run on Windows (`apps/desktop/AGENTS.md` "Not verified" says nothing on Windows was run).

## Open questions

- Which message counts as "last" for always-visible actions: the last item of the stream, the last answer, or the last user message? And while the run is active, should the current turn's actions be hidden?
- Which messages get which actions: do thread cards, notices, queued messages, or error lines get any? Is Edit offered while the orchestrator works (stop first)?
- Copy for a user message: copy source text (`body.text`, includes chips' `@path` text) and for an assistant answer copy `body.text` Markdown, or rendered text? (Source seems the only lossless choice.)
- Timestamp for older dates: `19 Nov, 22:54` has no year; what to show past a year? Is a hover tooltip, inline text, or both wanted?
- Reply from a partial selection can only produce `> text`; whole-message Reply could be a chip. Does the chip serialize to the same `> text` at send, or travel separately (needs daemon support)? Settings toggle name and default for swipe-to-reply?
- Fork: which message is the fork point (the answer under the button, the turn, the whole chat), what title the new chat gets, and where the "Forked from <title>" fact lives (a durable `Chat` field vs client-only). If durable, "disappears after the first new message" could be derived from the stream (no `user` item after the fork point) rather than stored; not evaluated.
- Fork or edit while threads of the chat exist or run: what happens to them (daemon side, but changes what the UI must disable).
- How an edited message keeps its original attachments (they are already sent; `editQueued` works only because `removeQueued keepFiles` returns files to the uploaded-not-sent state).
- Icons for Reply and Fork: draw new ones in Figma (and sync) or reuse `Undo` / `Revert` / `Quote`; `Split` is taken by threads.
- Is `item.at` of an assistant item the time the message started or the last update (daemon)? Matters for the hover time on answers.

## Assumptions and limits

- Read: the renderer chat, stream, composer, settings, stores and fixture transport paths named above, the protocol `domain.ts`, `commands.ts`, `events.ts`, `packages/components` pieces named, `packages/icons` file names and exports, `packages/lib` date and event helpers, `apps/desktop/AGENTS.md`, `packages/components/AGENTS.md`, `BACKLOG.md`, `DESIGN.md` (grep only).
- Run: two Vitest files to confirm the harness (15 tests passed); a Node one-liner to confirm the `en-GB` format. The app was not launched and no screenshots were taken, so hover, selection and gesture behavior are reasoned from code, not observed.
- Not run: whether TipTap `insertContent(string)` collapses newlines in `RichInput` (inferred); how Streamdown's rendered DOM behaves for `Selection.toString()` with chips and code fences (inferred from component sources).
- Not read: `apps/daemon` (stream item ids, how `at` is set, what a rewind or fork would need), ACP adapters, Reforma or other reference apps, `spec.md` (the file does not exist at the repo root despite `AGENTS.md` naming it), `src/main` and `src/preload` beyond grep, `AgentList.tsx` internals, hotkeys registry.
- `.briefback/chat-controls` and `.briefback/threads` research notes were only skimmed for context, not relied on.

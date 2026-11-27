# Renderer UI quality: chats, the run stream and the app shell

## Summary

The chat, stream and shell code mostly builds on the design system (`Button`, `Marker`, `Alert`, `Collapsible`, `GridList`, `Menu`, `SortableList`, `Autocomplete`, `RichInput`, `Attachments`). The main problems are elsewhere:

- **Performance (the largest problem).** `ChatView` observes `stream.items`, so every streamed token (one write per 50 ms per run) re-renders the whole chat page: the 787-line `Composer` with its `RichInput`, the banners, `ConversationView`, and every message row whose props are rebuilt on each render.
- **State.** The composer's draft is split across four hand-rolled module stores. One global revision counter makes the whole chat list re-render on every keystroke in any message box.
- **Banners.** The running-agents banner fetches and keeps the full stream of every running sub-agent and thread just to show "N calls".
- **Reinvented UI.** The mode and model pills copy `ChipTrigger`. `ModelPicker` hand-builds a tab strip and a submenu that the design system already has. The stream card frame, the progress bar, the `+N −M` counts and the start-truncated path label are each written two to four times.
- **Size and layering.** `Composer.tsx` and `ModelPicker.tsx` are each about 790 lines and mix several concerns. `stream/` imports feature code, which creates a cycle with `features/chats`.
- **Contract.** The renderer detects a usage-limit pause by matching the daemon's English sentence.

## Findings

Paths are relative to `apps/desktop/src/renderer/` unless they start with `packages/` or `apps/`. Where a sibling page (`renderer-state.md`, `ui-tasks-agents-panels.md`) already covers the store-level or other-feature side, this page cross-references it and adds only the side in this scope.

### F1. Every streamed token re-renders the whole chat page, the composer included

- Where:
  - `features/chats/ChatView.tsx:70` reads `stream?.items`. `:72`, `:73-79` and `:81-84` scan it again (`openQuestion`, `useEditMessage`, `findLast` error).
  - Props rebuilt on every render in `ChatView.tsx`:
    - `:65-67`: `handoffTargets` builds new JSX icons.
    - `:101-116`: a new `messageActions` object.
    - `:117-136`: `editing`.
    - `:139`: `errorAction`.
    - `:157-184`: a new `<Composer onSendMessage={() => …} question={…}>`.
  - `features/chats/ConversationView.tsx:114` reads `stream.items` too. `:171-185` passes new `onAnswer` and `onDecide` closures to `StreamView` on every render.
  - `stream/StreamView.tsx`:
    - `:227-264`: `actionsOf` returns a new `MessageActionsConfig` per message per render.
    - `:366-381`: each `worked` fold re-runs `groupToolRuns` and builds its children JSX on every render, even though `Worked` mounts them only when open (`stream/Worked.tsx:25-33`).
  - `stream/turns.ts:189`: `mergeThoughts` makes a new item object for merged thoughts on each fold, so `ReasoningLine` gets a new `body`.
- Problem:
  - Observed: the daemon writes streaming text at most once per 50 ms per run (`apps/daemon/src/runs/writer.ts:9`). Each write replaces the item, so `RunStream.items` recomputes (`stores/StreamStore.ts:27-29`). Every component is `observer()`, so it is `React.memo` (the observer applies memo, `node_modules/mobx-react-lite/src/observer.ts:95`), but each of the props above is new on every render, which defeats the memo.
  - Observed: `Composer` re-renders on every token. Its `onSendMessage` is a fresh arrow, and `useModelChoice` returns a new `choice` object, so the `ModelPicker` and `RichInput` under it re-render as well.
  - Inferred: during a long reply, the page does O(items) work about 20 times a second, and that cost grows with the length of the chat.
  - The `RunStream` sort, the turn folding and `personMarkdown` costs are in `renderer-state.md` F2. This finding adds the page-level cascade.
- Fix:
  1. Stop `ChatView` from observing `items`. Add MobX computeds on `RunStream` (`openQuestion`, `lastErrorId`, `itemById(id)`) and read them in the small components that need them: the question slot, `CompactAction`, the edit hook.
  2. Make the `ChatView` → `ConversationView` → `StreamView` props stable:
     - Hold `messageActions` in a `useMemo`, or put the handlers in a context, since they all take ids.
     - Make `onAnswer` and `onDecide` take ids and wrap them in `useCallback`.
     - Wrap `onSendMessage` and `errorAction` in `useCallback`.
  3. In `StreamView`, give each row primitive flags (`showAlways`, `canFork`, `canEdit`) plus one stable handlers object, and let `MessageActions` build its own config.
  4. Memoize each fold's children by the fold's item identity, or pass `items` to `Worked` and build the children only when it is open.
- Category: perf
- Effort: M. Risk: medium (`ChatView.test.tsx` and `StreamView.test.tsx` cover the actions)

### F2. Composer drafts live in four hand-rolled stores, and a global counter re-renders the chat list on every keystroke

- Where:
  - Module-level `Map` or `Set` stores, each with a listener set and `useSyncExternalStore`:
    - `features/chats/composerDrafts.ts:30-46`
    - `features/chats/composerFiles.ts:33-100`
    - `features/chats/composerQuotes.ts:10-52`
    - `features/chats/draftSending.ts:1-26`
    - A fifth store: `features/chats/composerBridge.ts:61-70`.
  - Consumers:
    - `Composer.tsx:365-530`: `send` moves one draft between keys through four separate APIs (`takeFiles`/`restoreFiles`, `takeReplyQuote`/`restoreReplyQuote`, `saveDraft`, `setDraftSending`). `giveBack` (`:397-416`) undoes each of them by hand.
    - `features/agents/AgentList.tsx:164-165` subscribes to the global `useDraftRevision()` and `useDraftFilesRevision()`. It then calls `messageOf(draftOf(chat.id))` per row (`:724`) and for the new-chat drafts (`:609-612`).
- Problem:
  - Observed: `Composer.edit` (`Composer.tsx:306-311`) runs `saveDraft` on every keystroke, and that bumps the global revision. So the whole sidebar list re-renders and re-serialises every chat's draft document on every key pressed in any chat's message box.
  - Observed: the renderer's convention is MobX stores (`apps/desktop/AGENTS.md`, "The renderer"). These five modules re-implement subscribe and notify by hand.
  - `renderer-state.md` F7 covers the new-chat `NewChatDrafts` copy; this is the per-chat side.
- Fix:
  - One MobX `ComposerDrafts` store: `Map<key, { doc, files, quote, sending }>` held with `observableShallow`, with `take(key)`, `restore(key, draft)` and `move(from, to)`. `send` and `giveBack` then become a single take and a single restore.
  - A computed `hasDraft(key)`, so each list row observes only whether its own chat's draft is empty.
  - Fold the new-chat document into the same owner (`renderer-state.md` F7).
- Category: structure | perf
- Effort: M. Risk: medium (draft restore after a refused send; `composerDrafts.test.ts`, `ComposerDraft.test.tsx` and `handoff.test.ts` cover it)

### F3. The running-agents banner fetches whole streams to count tool calls, and copies `useAgentActivity`

- Where:
  - `features/chats/RunningAgents.tsx`:
    - `:39-49`: `AgentRow` calls `useRunStream(run.id)` and `stream.items.filter(tool)`.
    - `:90-92`: `ThreadRow` does the same.
    - `:192-197`: its own 1 s `setInterval`, instead of `shared/useNow.ts`.
  - The same count exists in `stream/useAgentActivity.ts:10-13`.
  - `stores/hooks.ts:42-51`: `useRunStream` loads the run's entire item list.
- Problem:
  - Observed: to show `3 calls`, the banner downloads the full stream of every running sub-agent and thread. Those streams stay in memory and are reloaded on resync (`renderer-state.md` F3).
  - Observed: each row re-renders and re-filters on every token of its run, and the 1 s tick re-renders every row.
  - The count logic exists twice.
- Fix:
  - Short term: use `useAgentActivity(run.id).calls` in both rows, and `useNow(1000)` for the tick.
  - Proper fix: have the daemon publish a `toolCalls` counter on `Run` (its `TurnWriter` already sees every call), or drop the metric. The banner then opens no streams at all.
  - `SubagentCard.tsx:37` scans `project.runs.values()` per card. That is `renderer-state.md` F5 (a `childRunByToolCall` index).
- Category: perf | reuse
- Effort: S (short term), M with the protocol field. Risk: low

### F4. The mode and model pills re-implement `ChipTrigger`

- Where:
  - `features/chats/ModePicker.tsx:61-79` (`Trigger`).
  - `features/chats/ModelPicker.tsx:127-153` (`Trigger`) and `:772-790` (`ModelPickerOff`).
  - The existing component: `features/agents/ChipTrigger.tsx:39-80`, with `icon`, `label`, `detail`, `isOpen`, `missing` and `tooltip`.
  - All three read `OverlayTriggerStateContext` into `data-open` and render `Button size="sm" variant="filling" rounded` with a chevron. The CSS copies are `ui-tasks-agents-panels.md` F13.
- Problem (observed): the three pills share one line of the composer (the folder and workspace pills are `ChipTrigger`, the mode pill is beside them), but they are three components and three stylesheets. A change to the open look needs three edits, and the copies already differ: only `ChipTrigger` turns its chevron over.
- Fix:
  - Move `ChipTrigger` to `shared/`.
  - Render it in `ModePicker` (`label`) and `ModelPicker` (`icon` is `ProviderIcon`, `label` is the model, `detail` is the level).
  - Add `isDisabled` to `ChipTrigger` for `ModelPickerOff`.
  - Delete the two `Trigger` components and their `[data-open]` and `.triggerContent` CSS.
- Category: reuse
- Effort: S. Risk: low

### F5. The stream's card frame is written twice, and the question and approval plate twice more

- Where:
  - `stream/ThreadCards.tsx:76-95` (`CardFrame`), with `ThreadCards.module.css:8-60` (`.card`, `.head`, `.body`, `.body::before`).
  - `stream/QuestionCard.tsx:27-51` (`SettledCard`), with `QuestionCard.module.css:16-59` (`.settled`, `.settledHeader`, `.settledBody`, `.settledBody::before`). The values are identical: 1px muted border, `radius-lg` squircle, float background, 36px header, `md lg` padding, inset rule.
  - The open frame: `QuestionCard.module.css:4-13` and `ApprovalCard.module.css:4-14` are the same plate, with different padding and gap.
- Problem (observed): the code comments themselves say these cards are "one family" and "built as an answered question is", yet each family member restates the frame. A change to the radius, the rule inset or the dark border has to be made in two or three places.
- Fix:
  - Move `CardFrame` into `stream/StreamCard.tsx` as `StreamCard({ icon, title, slot?, turn?, busy?, pressable?, children })`, and use it for `AgentCard`, `ThreadMessageCard` and `SettledCard`.
  - Give the question and approval frame one `.plate` class with a size modifier.
- Category: reuse
- Effort: S. Risk: low (`ThreadCards.test.tsx` and `QuestionCard.test.tsx` query by `data-slot`)

### F6. Long chats mount every turn, and the turn rail measures the DOM on every scroll event

- Where:
  - `stream/StreamView.tsx:363-409` renders every block. There is no windowing: `rg content-visibility` over the renderer finds nothing.
  - `stream/Markdown.tsx:20-37`: every answer is a Streamdown parse.
  - `stream/TurnRail.tsx`:
    - `:112-140`: `read()` runs on every `scroll` event, not throttled to animation frames, and calls `querySelector` and `getBoundingClientRect` for each turn above the fold.
    - `:26-44`: `applyWave` measures every tick on each `pointermove`.
- Problem:
  - Observed: finished turns fold their work (`Worked` mounts nothing while closed), so a chat mounts about two Markdown trees per turn: the person's bubble and the answer. A chat with hundreds of turns therefore parses and lays out hundreds of Markdown trees when it opens.
  - Inferred: the scroll handler forces layout reads while the stream is scrolling.
- Fix:
  - Quick win: `content-visibility: auto` with `contain-intrinsic-size: auto <estimate>` on rows of finished turns. Check `scrollPosition.ts` anchoring and `pageSearch.ts`, which skips only `content-visibility: hidden`.
  - Longer term: window finished turns (RAC `Virtualizer`, as `Select` already uses).
  - In `TurnRail`: track the current turn with an `IntersectionObserver` on the `[data-turn]` rows instead of measuring on scroll, and measure the tick rectangles once when the pointer enters.
- Category: perf
- Effort: M (content-visibility, rail), L (windowing). Risk: medium (scroll restore, stick-to-bottom)

### F7. `Composer.tsx` (787 lines) mixes draft state, send orchestration, attachments and layout

- Where: `features/chats/Composer.tsx`:
  - The new-chat page contract, `DraftJournal`: `:71-92`.
  - Draft key and state: `:195-225`.
  - Journal restore effect: `:231-253`.
  - Suggestion gating: `:266-287`.
  - Send blockers: `:289-304`.
  - Quote, reply, paste and mention: `:313-345`.
  - Imperative handle: `:347-360`.
  - `send`: `:365-530`, 165 lines covering create chat, journal writes, send and give back.
  - `submitEdit`, `editQueued` and `stop`: `:533-578`.
  - JSX: `:591-786`.
  - The attachment mapping `DraftFile → AttachmentData` (`:620-628`) duplicates `UserBubble.tsx:56-65`.
- Problem (observed): the send path is the riskiest code here (a refused create, a refused send, journal persistence, restoring the draft), and it is embedded in the view. It can only be tested through the 898-line `Composer.test.tsx` and `ComposerDraft.test.tsx`. Anyone who changes the layout has to read the command orchestration too.
- Fix:
  - Extract `features/chats/sendDraft.ts`: a pure async `sendDraft({ root, start, target, key, choice, mode, journal })` that returns an outcome. Its unit tests replace most of the UI-level send tests.
  - Extract `useComposerDraft(key, start)` for the shown and edited document, and `ComposerFiles` for the attachments row.
  - Move `DraftJournal` next to `NewChatDrafts`.
  - Add `toAttachmentData` helpers.
  - `Composer` keeps the layout and the wiring. Do this after F2, which simplifies `send` first.
- Category: structure
- Effort: L. Risk: medium

### F8. `ModelPicker` hand-builds a tab strip and a submenu that the design system has

- Where: `features/chats/ModelPicker.tsx` (790 lines, 7 components):
  - `ProviderStrip` (`:272-337`): a hand-rolled `role="tablist"` with roving `tabIndex` and its own Arrow, Home and End handling.
  - The "More models" flyout (`:339-368`, `:422-487`, `:558-592`): a `Popover` on `triggerRef`, a `requestAnimationFrame` loop of up to 20 frames to focus the first row, its own ArrowRight, ArrowLeft and Escape handling, picks on `onPointerUp` (`:374-376`, `:465`), and the `OWN_LAYERS` outside-press exception (`:156`).
- Problem (observed):
  - `ToggleButtonGroup` (RAC: single selection, arrow keys) already exists in `packages/components`.
  - The DS `Menu` already exports `SubmenuTrigger`, which `stream/ForkMenu.tsx:60-85` uses for exactly this: ArrowRight opens, ArrowLeft and Escape close, focus is managed.
  - The comments in the file describe workarounds for focus races that the DS components solve.
- Fix:
  - Use `ToggleButtonGroup` for the provider strip.
  - Render the model list as `Menu selectionMode="single"`, with a `SubmenuTrigger` for "More models". This removes `FlyoutBody`, `onRowsKeyDown`, `onFlyoutKeyDown`, `primary()` and `OWN_LAYERS`.
  - Split the file into `ModelTrigger`, `ModelFace`, `ModelList` and `ModelPanel` modules.
- Category: design-system | structure
- Effort: M. Risk: medium (`ModelPicker.test.tsx`, 1578 lines, pins the keyboard behaviour)

### F9. The `+N −M` counts and the start-truncated path label are copied between chats, the stream and Changes

- Where:
  - Counts:
    - `features/chats/LastRunPlate.tsx:53-64` and `:88-95`.
    - `features/changes/DiffCard.tsx:27-36`.
    - `features/changes/CommitBox.tsx:125-131`.
    - `features/changes/ChangesToolbar.tsx:50-57`.
    - `stream/ToolCard.tsx:95-100` (own `.added` and `.removed` classes).
  - Path label (`dir="rtl"` with `<bdi>` and `splitPath`): `features/chats/LastRunPlate.tsx:19-34` and `features/changes/DiffCard.tsx:39-50`.
  - String helpers for the counts: `features/chats/lastRunRows.ts:45-59`.
- Problem (observed): six renderings of the same pair, in three sizes and two class systems. The path trick, the hard part, is written twice.
- Fix: add `LineCounts({ additions, deletions, size })` and `FilePathLabel({ path, slot? })` in `shared/` (or exported from `features/changes`), and use them in all eight places. `plateTotals` and `rowCounts` then shrink to number formatting.
- Category: reuse
- Effort: S. Risk: low

### F10. "Stop the run" is written four times, and the chat rename field twice

- Where:
  - Stop:
    - `features/chats/Composer.tsx:572-578`.
    - `features/chats/ReadOnlyNotice.tsx:30,42-52`.
    - `features/chats/SubagentBox.tsx:30,37-45`: calls `root.command` with its own toast.
    - `features/chats/RunningAgents.tsx:61,107,167`: no pending state.
  - Rename: `features/chats/ConversationHeader.tsx:123-163` (`TitleField`) and `features/agents/AgentList.tsx:1137-1190` (`RenameField`). Both have the same `finished` ref, the same Enter commits and Escape cancels handling, and the same `chat.rename` call.
- Problem (observed): the copies already differ. One has try/finally, one has a custom toast, one has no pending state, and only one passes `isComposing` through `useCellEditMode`.
- Fix:
  - `useStopRun(run)` → `{ stop, isStopping }` in `features/chats`.
  - `useChatRename(chat, onDone)` → `{ value, setValue, commit, cancel }`, or a `ChatTitleField` that takes extra input props for the list's cell-edit mode.
- Category: reuse
- Effort: S. Risk: low

### F11. Three progress bars, plus a fourth in the usage badge

- Where:
  - `shell/CloneRepositoryForm.tsx:426-441` with `CloneRepositoryForm.module.css:121-135` (`role="progressbar"`).
  - `features/settings/providers/UsageRows.tsx:49-62` with `UsageRows.module.css:27-50` (`progressbar`, tones).
  - `features/chats/ContextRing.tsx:107-118` with `ContextRing.module.css:80-92` (`role="meter"`).
  - `shell/UsageStatus.tsx:184-189` (the week line).
- Problem (observed): the same track and fill (`height: --spacing-6`, full radius, `width: N%`, a 300 ms width transition, a reduced-motion override) and the same hand-written aria attributes appear in three stylesheets. `packages/components` has no progress or meter component.
- Fix: add `ProgressBar` to `packages/components`, built on RAC `ProgressBar` and `Meter`, with `value`, `tone` (`normal`, `warning`, `danger`), `size`, `label` and `kind: 'progress' | 'meter'`. Use it in all four places.
- Category: design-system
- Effort: M. Risk: low

### F12. `ToolCard` stringifies payloads on every render, even while closed

- Where:
  - `stream/ToolCard.tsx:118-134`: `payloadText(call.input)` and `payloadText(call.output)` run in `ToolCard`'s own render, as props of the `<Section>` children. `CollapsibleMotionContent` mounts those children only when open (`packages/components/src/Collapsible/Collapsible.tsx:163-185`), but the arguments are computed anyway.
  - `describeTool` runs twice per render (`:81` in `Header`, `:121`).
- Problem (observed): `JSON.stringify(value, null, 2)` of a whole input (a `Write` call carries the file's contents) runs when every tool card mounts, and again on each update of a running call. The 20,000-character cut applies only after the full string has been built.
- Fix: move the sections into a `ToolCardBody` component rendered inside `CollapsibleMotionContent`. Compute `describeTool` once in `ToolCard` and pass the view to `Header`.
- Category: perf
- Effort: S. Risk: low

### F13. `stream/` imports feature code, and helpers several features use live inside one feature

- Where:
  - Cycle: `stream/SubagentCard.tsx:1` imports `features/chats/archiveChat` (`openRun`), while `features/chats` imports `stream`.
  - Stream chips: `stream/markdown/FileChip.tsx:9-25`, `chipTarget.ts:1-2` and `chipFind.ts:3-8` import `features/openWith`, `features/files` and `features/sidePanel/currentPlace`.
  - `ProviderIcon` is in `features/settings/providers/` but is used by `shell/UsageStatus.tsx:12`, `features/chats/ModelPicker.tsx:25`, `features/chats/ChatView.tsx:8` and `features/agents/AgentMark.tsx:3`.
  - `perform` (`features/chats/commands.ts:8-14`) is identical to `sendCommand` (`features/tasks/commands.ts:9-15`). It is imported by `shell/UsageStatus.tsx:11`, `features/agents/AgentList.tsx` and `features/settings/projects/projectActions.ts`.
  - `features/settings/projects/ProjectFolders.tsx:8` imports `shell/FolderList`.
  - `shared/` holds single-feature components: `CardRow` (only `settings/projects/ProjectRow.tsx`) and `RailItem` (only `sidePanel/SidePanelRail.tsx`). `stream/AgentAvatar` is used only by `features/tasks/DetailSections.tsx:8`.
  - `shared/` importing features is `ui-tasks-agents-panels.md` F15.
- Problem (observed): `apps/desktop/AGENTS.md` describes `stream/` as the reusable piece shared by Chats and Agents, but it cannot be loaded or tested without `features/chats`, `features/files`, `features/openWith` and `features/sidePanel`. Generic helpers are found by searching, not by location.
- Fix:
  - Route the stream's app actions through `StreamLinks`, which already serves as the stream's port to the app: add `openRun`, and `openPath` / `pathMenu` for `FileChip`.
  - Move `openChat` and `openRun` to `stores` (a `ProjectUi` or `RootStore` action).
  - Move `ProviderIcon` to `shared/`.
  - Make `perform` a single `shared/commands.ts` (or `root.perform`) and delete `sendCommand`.
  - Move `FolderList` and `FolderRow` to `shared/`. Move `CardRow` and `RailItem` into their features, and `AgentAvatar` to tasks.
- Category: structure
- Effort: M. Risk: low (moves and import changes)

### F14. A usage-limit pause is detected by matching the daemon's English sentence

- Where:
  - `features/chats/ConversationView.tsx:23-29` (regex rewrite) and `:119-122` (`statusReason?.includes(' is at its usage limit until ')`).
  - The sentence is built in `apps/daemon/src/runs/scheduler.ts:115` and `apps/daemon/src/runs/driver.ts:1564`.
- Problem (observed): the renderer depends on the exact wording of a human-readable reason. Any copy edit in the daemon would silently remove the warning `Alert` and restore the raw text, and no type or test across the boundary would catch it. The reset time also arrives pre-formatted by the daemon, not as a timestamp the renderer can format with `shared/time.ts`.
- Fix: add a structured field to `Run` in `packages/protocol` (for example `pause: { kind: 'usage_limit'; engine; until: number }`, or a `statusCode` alongside `statusReason`, as `failureCode` already is). Render the message from it, and delete `usageLimitMessage`.
- Category: safety | structure
- Effort: M (protocol, daemon, renderer). Risk: low

### F15. The banner disclosure and the message wrapper are each written twice

- Where:
  - `features/chats/TasksBanner.tsx:30-98` and `features/chats/LastRunPlate.tsx:76-112` have the same skeleton: `ComposerBanner role="group"` > `Collapsible as="Fragment"` > `CollapsibleTrigger asChild` > `ComposerBannerHeader expanded`, then `{state.isExpanded && <ComposerBannerList>}`.
  - `stream/UserBubble.tsx:43-50,78` and `stream/AssistantMessage.tsx:26-39` both compute `swipes` the same way and both repeat `useSwipeReply`, `<Show when={swipes}><SwipeHint/></Show>` and the trailing `MessageActions`.
- Problem (observed): two copies of one composition in each pair.
- Fix:
  - `ComposerBannerDisclosure({ label, title, summary, listLabel, onAction, children })` in `ComposerBanner.tsx`.
  - `useMessageSwipe(actions, text)` → `{ ref, swipes }`, or a `MessageFrame({ actions, text, align, children })`.
  - Memoize `personMarkdown` in `UserBubble` (`:42`).
- Category: simplify
- Effort: S. Risk: low

### F16. Chips are assembled by hand at every call site in the chat and the stream

- Where:
  - `shared/AgentChip.tsx:23-33`
  - `shared/TaskChip.tsx:36-47`
  - `stream/markdown/ChatReferenceChip.tsx:12-27`
  - `features/chats/MentionChip.tsx:43-50,58-60,74-81`
  - `stream/markdown/FileChip.tsx:219-231`
  - Each writes `<span|button className={chip}><span className={icon}>…</span><span className={label}>…</span>`.
  - Tooltips are inconsistent: `TaskChipButton` uses `Tooltip`, the others use a native `title`.
  - Icons are sized by hand with `width={12} height={12}` (`AgentChip.tsx:30`, `ChatReferenceChip.tsx:15`, `MentionChip.tsx:21-23`).
- Problem (observed): seven call sites, one visual. The component itself (and the duplicate pills and tone maps) is specified in `ui-tasks-agents-panels.md` F2. This lists the sites in this scope that should adopt it.
- Fix: once the `Chip` of that finding exists, convert these seven sites. In-text chips use `Chip` with `inert` (no hover, no pointer), replacing `MentionChip.module.css`. Delete `RunStatusPill`'s unused `plain` prop (see F22).
- Category: design-system
- Effort: M (with the component). Risk: low

### F17. Floating plates in this scope use three different shadow recipes, one copied from `Popover`'s private variable

- Where:
  - `stream/SelectionReply.module.css:5-21` copies `Popover`'s private `--popover-shadow` literally, dark border override included (`packages/components/src/Popover/Popover.module.css:10,37`).
  - `shared/SlidingCard.module.css:2-19` uses `--shadow-xl`.
  - `shell/SyncBanner.module.css:3-21` uses `--shadow-md`.
  - The same raw shadow in the editor and the terminal is `ui-tasks-agents-panels.md` F14.
- Problem (observed): DESIGN.md says floats share one lift. Here the Reply float, the turn and project cards, and the sync banner each look different, and the popover shadow can only be reused by copying its value.
- Fix: add a float shadow token (with its dark variant) to `packages/styles/src/tokens/styles/shadows.css`, or a `float-plate` ruleset, and use it in `Popover` and in these plates.
- Category: design-system
- Effort: S. Risk: low

### F18. Find in page walks and styles the whole document on every keystroke

- Where:
  - `shell/FindBar.tsx:180-185` calls `search(value, true, true)` on every change.
  - `shell/pageSearch.ts:109-209` (`collect`) walks `document.body` and calls `getComputedStyle` for every element, then builds `Range`s for every match.
- Problem:
  - Observed: there is no debounce and no reuse between keystrokes or steps. Each step (Enter) collects again too, which the code does on purpose because the page may have changed.
  - Inferred: in a long chat with the side panel open, each key forces style resolution for thousands of elements.
- Fix: debounce typing (about 100 ms). Cache the `collect()` result while the bar is open, invalidated by a `MutationObserver` on `document.body`, so typing and stepping reuse it until the DOM changes.
- Category: perf
- Effort: S. Risk: low (`pageSearch.test.ts` and `FindBar.test.tsx`)

### F19. The shell and chat empty and loading states are rebuilt by hand

- Where:
  - `shell/Shell.tsx:93-100` with `Shell.module.css:72-79`: `Loader` + "Loading…".
  - `features/chats/ConversationView.tsx:150-155` with `ConversationView.module.css:13-21`: "Loading messages…".
  - `features/chats/ChatView.tsx:209-218` with `ChatView.module.css:1-9`: `EmptyChat`.
  - `shell/NoProject.tsx:13-24` and `shell/Unreachable.tsx:15-29` with `shell/Message.module.css`.
  - The design-system versions: `packages/components/src/Panel/PanelStates.tsx:25-32` (`PanelLoadingState`, fixed text "Loading") and `:35-60` (`PanelEmptyState`: icon, title, description, action).
- Problem (observed): `apps/desktop/AGENTS.md` ("Loading states") makes the `Loader` with a line of text the one pattern, but `PanelLoadingState` cannot take the text, so every caller with a custom line rebuilds it. The tasks side of this is `ui-tasks-agents-panels.md` F7.
- Fix: add a `label` prop to `PanelLoadingState`, or a generic `LoadingState`, and use it in `Shell` and `ConversationView`. Build `EmptyChat`, `NoProject` and `Unreachable` on `PanelEmptyState` with `action`, after deciding whether a full-window state keeps `heading-2`.
- Category: design-system
- Effort: S. Risk: low

### F20. `ReadOnlyNotice` re-implements `Alert`

- Where: `features/chats/ReadOnlyNotice.tsx:55-83` with `ReadOnlyNotice.module.css:5-42`, against `packages/components/src/Alert/Alert.tsx:23-60`.
- Problem (observed): it hand-builds icon, `heading-5` title, `sm` description and actions with its own plate CSS. `Alert` (`AlertIcon`, `AlertTitle`, `AlertDescription`, `AlertAction`) already draws exactly that anatomy, and the stream itself uses it (`ErrorLine`, `ConversationView`).
- Fix: render `Alert role="status"` with a class for the composer plate colour and radius. If the buttons must stay under the text, add an action placement option (`actionPlacement="below"`) to `Alert` rather than keeping a copy.
- Category: design-system
- Effort: S. Risk: low

### F21. CSS in scope that bypasses tokens

- Where:
  - Markdown headings in raw px: `stream/markdown/markdown.css:40-82` sets 22, 20, 18, 16, 15 and 14px. The scale has 13 (`--text-md`), 16 (`--text-lg`) and 18 (`--text-xl`). DESIGN.md: "Do not invent a type ramp in a feature file."
  - Composer ring colours in raw `rgba`: `features/chats/Composer.module.css:29-31,40-42`. Coral is close to `--color-primary`, blue to `--color-interactive`, and pink is outside the palette.
  - Raw durations and easings, all available as `--transition-duration-fast` (0.15s), `--transition-duration` (0.3s), `--ease` and `--ease-bounce`:
    - `shared/Chip.module.css:21`
    - `shared/RailItem.module.css:29,33`
    - `stream/ToolCard.module.css:39,111`
    - `stream/ThreadCards.module.css:22`
    - `stream/StreamView.module.css:68`
    - `stream/TurnRail.module.css:56`
    - `shared/SlidingCard.module.css:18`
    - `features/chats/ContextRing.module.css:91`
    - `shell/CloneRepositoryForm.module.css:133`
    - `features/chats/ModelPicker.module.css:108`
  - An implicit z-index ladder across three files on one page: `StreamView.module.css:63` (1), `TurnRail.module.css:4` (2), `ConversationView.module.css:30` (3).
  - Raw sizes:
    - `shell/Shell.module.css:9` (`--side-rail-width: 56px`; `--spacing-56` exists).
    - `stream/TurnRail.module.css:9,14,20` (420px three times), `:34` (8px) and `:50` (2px).
  - Primitive colour mixing instead of a semantic token: `features/chats/ComposerBanner.module.css:13-17`.
- Problem (observed): the DESIGN.md "Token File Rule" and Density Rule. The off-scale heading sizes are the most visible, since every agent answer shows them.
- Fix:
  - Map the headings to the scale (for example `--text-xl`, `--text-lg`, `--text-md`), keeping weight 600, which is allowed for authored text.
  - Express the ring colours with `color-mix` on `--color-primary` and `--color-interactive`, and drop or justify the pink.
  - Replace durations with the tokens.
  - Name the local layers in `ConversationView.module.css` as page-local custom properties (`--conversation-layer-*`).
  - Use `--spacing-56` and a single `--turn-rail-max` variable.
- Category: design-system
- Effort: S. Risk: low (visual)

### F22. Rule violations and dead code that no tool reports

- Where:
  - UI copy that is one sentence but ends with a period (against `AGENTS.md`): `features/chats/ModelPicker.tsx:122,124,202,206`.
  - Weight 700: `shell/CloneRepositoryForm.tsx:390` uses `<Text variant="sm" bold>`. `apps/desktop/AGENTS.md` ("Type weights") forbids `Text bold`; use `weight="medium"`.
  - Unused imports (confirmed with `tsc --noEmit --noUnusedLocals` in `apps/desktop`): `features/chats/Composer.tsx:3` (`ListBoxItem`), `features/chats/conversationHeaderPath.ts:1` (`chatOfRun`), `features/chats/handoff.ts:8` (`draftOf`).
  - `shared/RunStatusPill.tsx:14,25`: the `plain` prop is never passed. Its only callers are `features/tasks/DetailSections.tsx:65` and `FilterPopover.tsx:79`.
  - Hand-rolled buttons:
    - `shell/FolderList.tsx:160,169`: a raw `<button className={styles.add}>`, styled in `FolderList.module.css:56-80` with the undefined `--color-focus-ring` (`ui-tasks-agents-panels.md` F6).
    - `features/chats/ComposerQueue.tsx:261-277`: `<Pressable><div role="button" tabIndex={0}>`.
  - Visually-hidden CSS: `features/chats/ConversationHeader.module.css:64-71` (`ui-tasks-agents-panels.md` F20).
- Problem (observed): small, but each one is a rule the project wrote down. The unused imports pile up because `biome.json:106-107` turns off `noUnusedImports`.
- Fix:
  - Drop the periods, use `weight="medium"`, and delete the three imports and the `plain` prop.
  - Make the folder adders `Button variant="filling" fullWidth` and the queued-row preview a `Button variant="transparent"`.
  - Use react-aria `VisuallyHidden`.
- Category: correctness | dead-code
- Effort: S. Risk: low

## Cross-area notes

- **`packages/components`**:
  - `ProgressBar` / `Meter` (F11).
  - A `label` prop on `PanelLoadingState` (F19).
  - An action placement option on `Alert` (F20).
  - A `Chip` (`ui-tasks-agents-panels.md` F2).
  - An "expanded" look on `Button`, so pill triggers need no CSS (F4, `ui-tasks-agents-panels.md` F13).
  - Re-export react-aria `VisuallyHidden`.
  - Two ideas:
    - `Button` could default `aria-label` to a string `tooltip` when `iconOnly`. The renderer has 60 `iconOnly` buttons, and almost all of them repeat the same string twice.
    - A RAC-based `Slider` could replace the hand-rolled `ReasoningSlider` (`features/chats/ReasoningSlider.tsx`, its own pointer and keyboard logic).
- **`packages/styles`**: a float shadow token and its dark variant (F17). Consider a `focus-ring` ruleset (`ui-tasks-agents-panels.md` F6; the in-scope sites are `shell/FolderList.module.css:80` and `shared/CardRow.module.css:44`).
- **Modal preset.** `Modal.create` is called with the same form-dialog options `{ shadow, clickOut, closeOnEscape, closeButton, handle: false }` five times:
  - `shell/projectDialogs.tsx:14-22`
  - `shell/CloneRepositoryForm.tsx:28-36`
  - `features/tasks/CreateTaskDialog.tsx:37-47`
  - `features/worktrees/CreateWorktreeDialog.tsx:28-36`
  - `features/settings/projects/FolderWorkspaceDialog.tsx:68-75`

  Two calls also pass a raw `zIndex: 101100` (`--z-confirm`): `features/worktrees/RemoveWorktreeDialog.tsx:397` and `TidyWorktreesDialog.tsx:142`. An `openFormDialog({ width, component, onClose })` helper in `packages/components/src/modals` would hold the preset.
- **Protocol and daemon**:
  - `Run.toolCalls` (F3).
  - A structured usage-limit pause on `Run` (F14).
- **Stores**: the stream items order, folding and retention (`renderer-state.md` F2 and F3) are the store side of F1 and F3. A `childRunByToolCall` index is in `renderer-state.md` F5.
- **Duration formatting** (`stream/turns.ts:27-41`, `stream/reasoning.ts:5-21`, `shared/time.ts:40-50`, with three outputs) is `renderer-state.md` F16. `RunningAgents` shows `2m 05s` while the stream shows `2m 5s` for the same kind of span.

## Not inspected / limits

- **No profiling.** I did not run or profile the app. The performance findings come from reading the code (memo-defeating props, subscriptions, the daemon's 50 ms throttle). Their size in practice is inferred.
- **Tests.** I read none of them; the test file sizes are cited only as risk notes.
- **Read only partly**:
  - `features/agents`: only where it touches this scope (`ChipTrigger`, `AgentList` draft subscriptions and rename field).
  - Skimmed only, not reviewed in depth: `features/chats/mentionItems.tsx`, `modelSelection.ts`, `handoff.ts` (beyond `turnsOf`), `editSession.ts`, `pastedFiles.ts`, `branchPrefix.ts`; `stream/swipeReply.ts`, `subagents.ts`, `toolView.ts`, `selectedMessage.ts`; `shell/shellCommands.ts`, `keymap.ts`, `projectSwitch.ts`.
  - `shell/pageSearch.ts`: only `collect`.
- **No accessibility audit.** I did not audit keyboard access or screen-reader output beyond the components named above.
- **Daemon side of contracts.** I checked it by grep only (F3, F14).

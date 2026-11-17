# UI inventory for the MVP screens

## Verdict

`@clowdy/components` already covers the chrome of all four screens: panels, lists, tags, inputs, selects, toggles, collapsibles, markers, a stick-to-bottom scroller, RichInput, MarkdownEditor, Terminal, CodeHighlighter with diff notation, Resizable, Modal and Toast. Five pieces are missing: an app shell/rail, a tree, a kanban board, a progress bar, and the chat/agent stream UI. Mirror the shell from Reforma's `EditorRail` + `Header` and build the tree on RAC `Tree`. For the stream, port the generic shells from Reforma's `packages/components/src/chat`, which takes about a day. Reforma's `@reforma/file-manager` already implements most of the Documents screen and is worth porting whole. Don't port the Reforma message/tool renderers wholesale: they are bound to `@reforma/types` and the `ai` SDK's `UIMessage`.

## Key facts

- Clowdy's component tree is Reforma's minus three folders: `chat`, `openui`, `Loader` (checked with `diff` on the directory listings). 66 folders, built on React Aria Components (resolves to 1.22.1, though the manifest says `^1.17.0`), MobX and `motion`.
- The renderer must import by subpath (`@clowdy/components/Panel`), not from the barrel, because the barrel pulls in TipTap, CodeMirror and Shiki (`apps/desktop/AGENTS.md`). A subpath resolves to `src/<Folder>/index.ts`.
- Not in Clowdy: Tree (only `TreeChevron`), kanban, progress/meter, rail/app shell, chat UI. RAC 1.22 exports `Tree`, `TreeItem`, `TreeItemContent` and `useTreeData`; render props include `level`, `isExpanded` and `hasChildItems`, and rows carry `[data-level]`. `@dnd-kit/react` 0.5.0 is already a components dependency (used by `SortableList`).
- Stick-to-bottom exists twice: `useStickToBottom` (`@clowdy/components/hooks`) and the `Scrollable` prop `stickToBottom={{ threshold }}`, with `useScrollable().stickToBottom.scrollToBottom()` and the overlay slot `SCROLLABLE_OVERLAY_SLOT`.
- Chat tokens are defined: `--color-chat-composer`, `--color-chat-composer-header`, `--color-chat-message`, `--color-chat-message-content`, `--color-chat-overlay`, `--color-chat-shadow`.
- The renderer already does what Reforma's window chrome does: `windowChrome.ts` sets `data-window-material` / `data-window-buttons-leading`, and `base.css` defines `--titlebar-inset`, `--titlebar-inset-end`, `--titlebar-height` and `--titlebar-leading-height` plus the drag band. macOS traffic lights sit at `{ x: 17, y: 17 }` in a 48px band.
- `packages/protocol` (stage 1) defines `StreamItemBody` kinds `user | assistant | tool | note | question | error` and `ToolState = 'running' | 'done' | 'error'`. Reforma's tool chrome uses AI SDK states (`input-streaming`, `input-available`, `approval-requested`, `output-available`, `output-error`, `output-denied`), so a three-line mapping is needed.
- Reforma chat is about 15.8k lines (no tests or stories). 65 files import `@reforma/types` and 12 import `ai`.
- `@reforma/file-manager` is about 4.9k lines. It never imports `@reforma/types` and is built on a `FileSystemProvider` (list/read/write with `expectedVersion`, a `Conflict` error and `watch`). `TextDocument` already has `dirty`, a `conflict` state ("Changed on disk"), save and overwrite. Its tree uses `react-arborist`.

## How to use it

### Wireframe element → component

| Element | Component (import path) | Props that matter |
|---|---|---|
| **Shell** top band, 48px | own `header` (mirror Reforma `Header.module.css`) | `height: var(--spacing-48)`; `padding-right: var(--titlebar-inset-end)`; `padding-left: max(0px, var(--titlebar-inset) - <railWidth>)` |
| Project select | `Button` (`/Button`) in `PopoverTrigger` + `Popover` (`/Popover`) holding `Menu`/`MenuItem`/`MenuSection` (`/List`), like Reforma's `ProjectMenuTrigger` | `variant="filling" truncate isPressed={overlayState.isOpen}`; content: icon 14/`Folder`, `Text weight={500} truncate`, 8/`ChevronDown`. `Select showSearch` works for a plain list, but "Create project…" / "Open existing…" are actions, so use Menu |
| Rail item (icon + label) | `Button` + `Text` (see snippet), copy of Reforma `RailItem` | `variant="filling" color="secondary" size="unset" fullWidth isPressed tooltip tooltipPlacement="right" contentClassName` |
| Rail icons | `@clowdy/icons/16`: `Chat`, `Team`, `File`, `Settings`; Tasks: `Checkbox` / `TaskProgress` from `/14` at `size={16}` (the 16 pack has no checkbox; `DoneBold` is the alternative) | every icon takes `size`, `title`, `className` |
| Section split, side panels | `Panel`, `PanelHeader` (`.Actions`, `.Button`), `PanelContent`, `PanelSearch`, `PanelSearchButton`, `PanelEmptyState`, `PanelLoadingState` (`/Panel`) | `side="left" \| "right"`; width via the CSS var `--panel-width` (default 250px; wireframes want 270, 375, 330 and 400px) |
| Resizable split (optional) | `ResizablePanelGroup`, `ResizablePanel`, `ResizableHandle`, `useDefaultLayout` (`/Resizable`) | `orientation="horizontal"`, `minSize`, `collapsible`, `groupResizeBehavior="preserve-pixel-size"` |
| Daemon connection problem | `Alert`, `AlertTitle`, `AlertDescription`, `AlertAction` (`/Alert`); `toast.error({ message })` + `<ToastRegion/>` (`/Toast`) | `color="danger"` |
| **Chats** list | `GridList` + `GridListItem` (`/List`) inside `PanelContent` | `selectionMode="single" selectedKeys onSelectionChange items`; item `id text icon={<Message/>} endAffix`; hover-only row actions via `data-show={listBoxItemDataShow.itemHover}` |
| "New chat" | `PanelHeader.Button` with 14/`Plus`, or `Button variant="bordered" fullWidth` as in the wireframe | `tooltip` |
| Chat header status pill | `Badge` (`/Tag`) | `color` (SemanticColor), `size="sm"`, `rounded`, `icon={<Dot/>}` |
| Stop | `Button variant="bordered"` with 16/`StopBold`; `ConfirmButton` (`/ConfirmButton`) if Stop must arm first | `confirmColor="danger"` |
| Conversation scroller | port `Conversation` + `ConversationScrollButton` (Reforma); otherwise `Scrollable` (`/Scrollable`) | `stickToBottom={{ threshold: 100 }} edgeFade`; the scroll button lives in `slot={SCROLLABLE_OVERLAY_SLOT}` |
| User bubble, time | own small component using Reforma's `.messageBubble/.userBubble/.userMessageClamp` CSS and its `UserMessageClamp` | `background: var(--color-chat-message)` |
| Orchestrator message | `Avatar` (`/Avatar`) with 16/`Layers` fallback + `Text` + markdown body (see risks) | Avatar `size="sm" fallback title description` |
| Progress card | `Card` (`/Card`) + `Text` + own progress bar (RAC `ProgressBar`, 1 CSS module) + `TagGroup` of task chips (`/Tag`) | Card `variant="bordered" size="md"`; TagGroup `items onAction size="xs"`; icon 14/`LinkChain`. Reforma `TodoRows` gives the status-icon rows |
| Event line "2 executors started" | `Marker`, `MarkerIcon`, `MarkerContent` (`/Marker`) | `variant="default"`; icon 14/`BoltFilled`; `variant="separator"` for day dividers |
| Live "working…" line | `Marker` + `MarkerIcon` holding `<Spinner size="xs"/>` (`/Spinner`) + `<MarkerContent shimmer>` | `role="status"` while live |
| Semi-manual question card | `Card` + `Radio` (`/Radio`) or `ListBox` + `Textarea` (`/Textarea`) + `Button`; or port Reforma `AskUserQuestionTool` (674 lines) | maps to protocol `question {options, recommended, consequence}` |
| Composer box | `RichInput` (`/RichInput`) | `value onChange submitOnEnter onSubmit onPasteFiles placeholder minHeight maxHeight={280} triggers renderMention`; `ref: RichInputHandle` |
| Attach | `Button iconOnly` with 14/`Clip` + hidden `<input type=file multiple>` (Reforma pattern); `ButtonUpload` (`/ButtonUpload`) takes a single file; `FileDropOverlay` (`/FileDropOverlay`) + `useFileDrag` / `useFilePaste` (`/hooks`) | attachment tiles: port Reforma `Attachments`/`Attachment` |
| Mode select | `Select` (`/Select`) + `ListBoxItem` | `size="sm" variant="transparent" items aria-label selectedKey onSelectionChange` (passed through to RAC); `ToggleButtonGroup` if both modes should show |
| Send / stop | `Button iconOnly rounded color="primary" variant="filled" size="sm"` with 16/`SendBold` / 16/`StopBold` | `isPending`, `tooltip={tooltipWithHotkey('Send','enter')}` (`/Hotkey`) |
| Banner above composer (running executors) | port Reforma `ComposerBanner` + `ComposerBannerStatus` | `icon={<Robot/>} action="Stop" onAction onPress` |
| **Tasks** header/toolbar | `Text variant="heading-4"` + `Text color="secondary"`; `ToggleButtonGroup` + `ToggleButtonGroupItem` (`/ToggleButtonGroup`); `SearchInput` (`/Input`); `Button variant="bordered"` with 14/`Sliders` opening `Popover`+`Menu`; `Button color="primary" size="sm"` with 14/`Plus` | TBG `selectedKeys onSelectionChange size="sm"`, items `value iconOnly tooltip` with 14/`Columns` and 14/`List`; SearchInput `size="sm" value onChange placeholder` |
| Kanban column | `Box` + `Badge` (status pill + count) + vertical `Scrollable`; the board is a horizontal `Scrollable` | Badge `count`; status icons from 14: `Circle`, `Dot`, `TaskProgress`, `CheckCircleSolid` |
| Kanban card | `Card` + `Box` + `Text` + `Badge` agent chips | `variant="filled" hoverable isActive={selected}`; key icon 14/`Box` (alias it, the name clashes with the `Box` component), agent chip icon 14/`User` or 14/`Robot` |
| Drag between columns | `@dnd-kit/react` directly; `SortableList` handles one list or a nested tree, not columns | skip in the MVP and change status from the detail panel |
| List view | `Table`, `TableHeader`, `TableBody`, `TableRow`, `TableCell` (`/Table`) inside `Card`; or `GridList` rows | Table `maxHeight` gives a sticky header; one `TableHead isRowHeader` |
| Detail panel | `Panel side="right"` + `PanelHeader` (key `Badge` + `PanelHeader.Button` 14/`Close`) + `PanelContent` | sections: `Text variant="heading-6"`; description in `Card variant="filled"`; executors and results as `GridList` rows with Badge pills; dependencies via `Checkbox` (`/Checkbox`) `isReadOnly`; "Open in Linear" is `Button href target="_blank"` with 14/`ArrowUpRight`, shown only when `task.external?.url` |
| **Agents** tree | RAC `Tree`/`TreeItem`/`TreeItemContent` styled with `List/ListBox.module.css` row classes + `TreeChevron` (`/Panel`) | `selectionMode="single" expandedKeys onExpandedChange`; indent and connector lines from `[data-level]` |
| Tree row content | `Text` (name, `bold`), `Text color="secondary" truncate` (current work), `Badge` status, `Badge` task chip with `onPress` | status → color: running `success`, waiting_* and blocked `warning`, failed and interrupted `danger`, succeeded and cancelled `secondary` |
| "Show finished" | `Switch` (`/Switch`) in `PanelHeader.Actions` | `size="sm" isSelected onChange` |
| Agent search | `PanelSearch` | `value onChange placeholder="Find agent…"` |
| Agent header | `Avatar` + `Text` + `Badge`s ("Task CAR-24", "Parent: …") + Stop button | parent as `Button variant="inline"` |
| Tool card (read/search/edit/command) | port `ToolShellCard`, `ToolShellCardHeader`, `ToolShellCardContent` (Reforma) on top of `Collapsible`/`CollapsibleTrigger`/`CollapsibleMotionContent` (`/Collapsible`); fallback: `Collapsible` + `Card` | header `state title titleInProgress icon statusDetail`; icons 14: `Page`, `Search`, `Edit`, `Terminal`, `Tool` |
| Diff stat +42 −18 | port `ToolLineCounts` (36 lines: two `Text color="success"/"danger"`) | `added removed` |
| Diff body | `CodeHighlighter` (`/CodeHighlighter`) + `transformerNotationDiff()` (`/CodeHighlighter/transformers`) + Reforma `formatEditDiff.ts` | `language code collapseThresholdLines`; input is jsdiff `structuredPatch` hunks `{oldStart, oldLines, newStart, newLines, lines}` |
| Command output + success badge | `Terminal`, `TerminalHeader`, `TerminalTitle`, `TerminalStatus`, `TerminalContent` (`/Terminal`) + `Badge color="success"` | `output isStreaming autoScroll` (ANSI through `anser`) |
| Path chips in tool headers | port Reforma `Chip` family (ChipIcon on `FileIcon` `/FileIcon`) | `item {path,label,cursor} onAction` |
| **Documents** tree | port `@reforma/file-manager` `Explorer`; or RAC `Tree` + `FileIcon` + `TreeChevron` | Explorer is virtualized (react-arborist) and has rename, drag-and-drop and a context menu |
| Doc search | `PanelSearch` / `SearchInput` | |
| Breadcrumbs | `Breadcrumb`, `Breadcrumb.Link`, `Breadcrumb.Page` (`/Breadcrumb`) | `variant`; Link `onPress` |
| Dirty dot | CSS dot (`.dirtyDot` in file-manager `EditorArea.module.css`) | |
| Save | `Button variant="bordered" size="sm"` | `isDisabled={!dirty}`, `tooltip={tooltipWithHotkey('Save',['mod','s'])}` |
| Editor / Markdown / Preview | `ToggleButtonGroup`; Editor = `MarkdownEditor` (`/MarkdownEditor`, lazy); Markdown = `CodeTextarea` (`/CodeTextarea`) with `codeLanguage('md')` (`/codeLanguages`); Preview = `MarkdownEditor editable={false}` | MarkdownEditor `value onChange onUnsupported unsupportedAction resolveImageSrc editable`; its toolbar (text style, bold, italic, link, lists, checklist, quote, code) is built in and hidden when `editable={false}` |
| Unsaved-changes guard | `confirmDiscardChanges`, `openConfirmModal` (`/modals`) | |
| Settings (rail bottom) | `Modal.create` + `SettingsLayout` (`.Sidebar`, `.Content`, `.Pane`, `.Empty`) + `SettingsField` | `items={SettingsNavItem[]} defaultSelected`; Content `saveable headerRight`; Reforma `SettingsWindow.tsx` is the pattern |

### Shell layout (mirrors Reforma `EditorLayout` / `EditorRail` / `Header`)

```css
.app   { display: flex; height: 100vh; }
.rail  { width: var(--rail-width); flex-shrink: 0; display: flex; flex-direction: column;
         padding-top: var(--titlebar-leading-height); /* below the macOS lights; 0 on Windows */ }
.main  { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.header{ height: var(--spacing-48); display: flex; align-items: center; gap: var(--spacing-8);
         padding-left: max(0px, var(--titlebar-inset) - var(--rail-width)); /* lights reach past the rail */
         padding-right: var(--titlebar-inset-end); /* Windows caption buttons */ }
.settings { margin-top: auto; }
```

Reforma puts its content in rounded plates (`border-radius: calc(var(--radius-xl) * var(--squircle-radius-factor)); corner-shape: superellipse(var(--squircle-value))`) on the tinted page background. With vibrancy, `body` is `color-mix(--color-background 60%, transparent)`. The wireframe puts the project select in the band itself and starts the rail below it, which is the same geometry. Reforma's rail is 58px; the wireframe draws about 115px.

### Rail item

```tsx
import { Button } from '@clowdy/components/Button';
import { Text } from '@clowdy/components/Text';
import { Chat } from '@clowdy/icons/16';

<Button className={ s.item } contentClassName={ s.itemContent } variant="filling" color="secondary"
        size="unset" fullWidth isPressed={ section === 'chats' } tooltip="Chats" tooltipPlacement="right"
        onPress={ () => ui.open('chats') }>
    <span className={ s.glyph }><Chat aria-hidden /></span>
    <Text variant="xs" weight="medium" align="center">Chats</Text>
</Button>
```

Copy `EditorRail.module.css` (`.item`, `.itemContent`, `.glyph`, `.badge`, `breathe` for busy) and rename `--reforma-button-*` to `--clowdy-button-*`. The pressed item uses `--color-text`, or `--color-primary` for the accent item.

### Side list panel

```tsx
<Panel side="left" style={ { '--panel-width': '17rem' } as CSSProperties }>
    <PanelHeader>
        Chats
        <PanelHeader.Actions>
            <PanelHeader.Button tooltip="New chat" onPress={ createChat }><Plus /></PanelHeader.Button>
        </PanelHeader.Actions>
    </PanelHeader>
    <PanelSearch value={ q } onChange={ setQ } placeholder="Find chat…" />
    <PanelContent>
        <GridList aria-label="Chats" selectionMode="single" selectedKeys={ chatId }
                  onSelectionChange={ keys => open([...keys][0]) } items={ chats }>
            { c => <GridListItem id={ c.id } text={ c.title } icon={ <Message /> } /> }
        </GridList>
    </PanelContent>
</Panel>
```

### Porting the Reforma chat: what is generic

| Piece (Reforma path under `packages/components/src/chat/`) | Lines | Reforma coupling | Effort |
|---|---|---|---|
| `Conversation/Conversation.tsx` (scroller, scroll button, empty state) | 162 | none; Clowdy has `Scrollable`, `SCROLLABLE_OVERLAY_SLOT`, `Shimmer`, `MOTION_EASE_UI`, 14/`ArrowDown`, assets/`Sparkle` | 0.5h, rename imports |
| `Tool/shell/ToolShell.tsx`, `ToolShellCard.tsx`, `ToolShellStatusIcon.tsx`, `ToolLineCounts.tsx`, `ToolSummaryBadge.tsx`, `toolProgress.tsx` | 900 | AI SDK state strings; `helpers.ts` (whose `getToolName` pulls in `@reforma/types`); `useMessageStreaming` from the MobX turn store | 2–3h: copy `isToolInvocationInProgress`, `isToolInvocationStalled` and `TOOL_INTERRUPTED_MESSAGE` (20 lines), replace `useMessageStreaming` with a `live` context fed from `Run.status`, map `running→input-available`, `done→output-available`, `error→output-error` |
| `ComposerBanner/` | 97 | none | 0.5h |
| `TodoRows/` | 68 | `ThreadTodo {id, content, status: pending\|in_progress\|completed\|cancelled}` (copy the type) | 0.5h |
| `Chip/` (+ helpers) | 730 | none (`ChipItem` is local) | 1–2h |
| `Attachment/` | 366 | `AttachmentData` (8 optional fields; copy it); `ChipIcon`/`getFileKind` | 1–2h after Chip |
| `Approval/` | 190 | `ChatContext` (swap for props) | 1h |
| `Message/streamdown/` (`MessageText` + components + CSS) | ~600 | new deps `streamdown@2.5.0`, `@streamdown/cjk@1.0.3`, `@streamdown/code@1.1.1`; code citations reach into `ChatContext`/`Chip` | 0.5–1 day |
| `Tool/edit/formatEditDiff.ts` + `EditTool` | 330 | `EditDiffHunk` (copy); Reforma Edit input is `{path, edits:[{search, replace}]}`, while Claude uses `{file_path, old_string, new_string}` and Codex emits `apply_patch`/`file_change` | 2–4h with an input adapter |
| `Tool/bash/BashTool.tsx` | 264 | input `{command, description, background}`, close to Claude `Bash` | 2–3h |
| `Message/turn/*`, `segments/*`, `MessageTurnStore` (assistant body, phase grouping, "worked" collapse) | ~3.5k | `ReformaUIMessage` parts, `ai`, MobX store | 2–3 days; skip for the MVP and render a flat list of `StreamItem`s |
| `Tool/Tool.tsx` registry + 40 tool renderers | ~9k | Reforma sandbox tool names and schemas | not worth it; write 5 renderers (read, search, edit, command, default) on `ToolShellCard` |
| Reforma front `composer/ChatComposerInput.tsx` (attach, RichInput, send/stop) | 633 | runtime, credits, grade, plan mode | 2h to reimplement from its JSX (lines 447–632) |

Only the shells and chips are generic. Every content renderer reads Reforma's message or tool schemas. Put the generic shells in `packages/components/src/chat` with no protocol imports, and keep the `StreamItem` → component mapping in the renderer.

### Documents via `@reforma/file-manager`

Copy `packages/file-manager` to `packages/file-manager` in Clowdy and rename `@reforma/*` to `@clowdy/*`. Add `react-arborist` (peer), `minimatch`, `use-resize-observer` and `@codemirror/{autocomplete,commands,search,state}`. Replace the one missing icon, `@reforma/icons/logo` `Reforma`, used in the empty state; every 14- and 8-pack icon it imports exists in Clowdy. Then implement a `FileSystemProvider` over the daemon's docs routes: `list`, `read`, `write(expectedVersion)` throwing `FileSystemError('Conflict')`, and `watch` from SSE. It uses MobX `@observable accessor`, which the desktop Vite config already handles (`@babel/plugin-proposal-decorators` 2023-05). `FileManagerView` already provides a `Panel` with an explorer and search, tabs with a dirty dot, a source/rich toggle and a lazy `MarkdownPane` around `MarkdownEditor`. Breadcrumbs, the Save button and the third Preview tab are additions. Effort: 0.5–1 day.

## Limits and risks

- Scale: hundreds of runs need virtualization. `GridList`, `ListBox` and RAC `Tree` work with RAC `Virtualizer`/`ListLayout` (`Select isVirtualized` shows the setup). `Scrollable`/`Conversation` don't virtualize, so cap or page agent streams by `seq`.
- `ComposerMentionKind` is a closed union of Reforma kinds (`file | variable | layer | command | link | integration`). Add `task | agent | doc` before using `@` mentions.
- Protocol tool items have no diff stat or hunks. Either the daemon normalizes Edit/Write/`apply_patch` output to `{ hunks }` or `{ added, removed }`, or the renderer diffs `old_string`/`new_string` itself (`@sanity/diff-match-patch` is already a dependency).
- Spec §5.5 forbids showing hidden reasoning, so skip Reforma `Reasoning`. Its `pendingLoaderPhrase.ts` (217 lines, generic) can feed the live line.
- `Panel` animates in from the side on mount (`panel-side-enter-*`). Keep side panels mounted across selection changes, or the animation replays.
- `MarkdownEditor` is TipTap. Lazy-load it as Reforma's `MarkdownPane` does, and never use it to render chat messages (one editor per message).
- Windows chrome (`--titlebar-inset-end`, Mica) builds but has never been run on Windows.
- The docs folder name differs: the spec says `.factory/docs/`, `plan.md` says `.clowdy/docs/`. It's a single constant.

## Open questions

1. Rail width: the wireframe's ~115px or Reforma's 58px plus labels?
2. Message markdown: port streamdown (best for streaming text, 3 deps), or render settled text with `marked` (already a dependency) and accept no streaming-aware parsing?
3. Documents: port `@reforma/file-manager` whole (recommended), or build a thin tree plus `MarkdownEditor` and write conflict handling again?
4. Kanban drag-and-drop in the MVP, or status changes only from the detail panel?

## Sources (local)

- Clowdy: `packages/components/AGENTS.md`, `packages/components/src/{Panel,List,Tag,Button,Input,Select,Switch,ToggleButtonGroup,Scrollable,Collapsible,Marker,MarkdownEditor,RichInput,CodeHighlighter,Terminal,Resizable,SettingsLayout,SortableList,hooks}/`, `packages/icons/dist/{8,12,14,16}/index.d.ts`, `packages/styles/src/tokens/`, `apps/desktop/src/renderer/{windowChrome.ts,base.css}`, `apps/desktop/src/main/security.ts`, `apps/desktop/vite.config.ts`, `packages/protocol/src/domain.ts`, `.briefback/mvp/ui-wireframes.md`, `spec.md` §5.
- Reforma: `packages/components/src/chat/**` (Conversation, Tool/shell, Tool/edit, Tool/bash, ComposerBanner, TodoRows, Chip, Attachment, Message/streamdown, Message/turn), `apps/front/src/editor/{EditorLayout.tsx,EditorLayout.module.css,EditorRail.tsx,EditorRail.module.css}`, `apps/front/src/editor/common/Header/{Header.tsx,Header.module.css}`, `apps/front/src/common/windowButtons.ts`, `apps/front/src/editor/chat/{composer/ChatComposer.tsx,composer/ChatComposerInput.tsx,composer/ChatComposerSubagents.tsx,thread/ThreadMessage.tsx,summary-panel/todos/ChatTodos.tsx}`, `apps/front/src/admin/modals/SettingsWindow.tsx`, `packages/file-manager/src/{provider.ts,documents/TextDocument.ts,react/FileManagerView.tsx,react/editor/{EditorArea,MarkdownPane}.tsx,react/explorer/Explorer.tsx}`, `packages/types/src/{attachment.ts,sandbox/tools/edit.ts,sandbox/todos.ts}`.
- RAC Tree API: `node_modules/react-aria-components/dist/types/src/Tree.d.ts` (1.22.1).

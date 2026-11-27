# Design-system migration (wave 2)

What Stage 1 Part 1 added to `packages/components` and `packages/styles`, and what each piece replaces in `apps/desktop/src/renderer`. Import by subpath only. Paths below are relative to the renderer.

## Tokens (`@clowdy/styles`)

| Token or ruleset | Use | Replaces |
| --- | --- | --- |
| `@ruleset focus-ring` (needs `@reference '@clowdy/styles/rulesets'`) | Inside the state selector: `.row:focus-visible { @ruleset focus-ring; }`. 4px `--color-focus-ring`, no offset | Every local `outline:` and box-shadow ring (`ui-settings-changes-css` F9 list, `ui-tasks-agents-panels` F6) |
| `--color-focus-ring` | Now defined (Terracotta-muted). The 5 `var(--color-focus-ring, currentcolor)` sites now draw it at 2px: switch them to the ruleset | `shared/CardRow.module.css:44`, `shell/FolderList.module.css:80`, `features/worktrees/ManageWorktrees.module.css:140`, `features/settings/projects/ProjectDetail.module.css:42,83` |
| `--color-secondary-muted-text` | The dim text colour. `--color-secondary-text` does not exist: replace it with this | `features/changes/BranchPullRequestList.module.css:13`, `features/settings/projects/ProjectDetail.module.css:69` |
| `--shadow-float` | Lift of a small float, dark theme remapped. Border stays `1px solid var(--color-surface-border)` | The copied `0 16px 32px dark-a10` / `black-a50` pairs: `stream/SelectionReply.module.css`, `features/terminal/TerminalTab.module.css`; also `shared/SlidingCard`, `shell/SyncBanner`, `hotkeys/ChordHud`, `shell/FindBar` |
| `@ruleset visually-hidden` | Screen-reader-only text | `features/tasks/TaskList.module.css:37`, `features/worktrees/ManageWorktrees.module.css:73`, `features/chats/ConversationHeader.module.css`, `features/changes/BranchMergeDialog.module.css:52` |

Not added (dropped from Part 1): `--ease-ui`/`--ease-out`, `VisuallyHidden` component. Use `var(--transition-duration-fast) ease-out` for the 150ms button timing.

## Components

**`Chip`** — `@clowdy/components/Chip`. Props: `tone?: 'neutral' | 'primary' | 'accent' | 'success' | 'warning' | 'danger'` (none = the plain chat chip; matches `StatusTone` in `shared/runStatus.ts`), `size?: 'xs' (20px) | 'sm' (24px)`, `shape?: 'squircle' | 'pill'`, `icon?`, `children`, `tooltip?`, `tooltipPlacement?`, `onPress?` (renders a RAC button with hover, focus ring and press), `isDisabled?`, any span attributes. A static chip with `tooltip` becomes focusable (`role="img"`, named by its string label or `aria-label`). Replaces `shared/Chip.module.css`, `shared/StatusTone.module.css`, `shared/RunStatusPill.module.css` (use `shape="pill"`), `features/tasks/Pill.module.css`, `features/tasks/TaskChips.module.css`, `features/tasks/DetailPanel.module.css:20-32` (`.key`), `features/changes/CommitCountBadge.module.css`. Wrappers (`AgentChip`, `TaskChip`, `RunStatusPill`, `Pill`) keep only their data logic. `StatusDot` keeps its own dot.

**`Badge`** — `@clowdy/components/Tag`. Same props as before (`color`, `size`, `rounded`, `icon`, `tooltip`, `textValue`, `className`, `children`), now a `Chip` span: no grid, no tab stop. `count`, `onPress`, `href`, `onRemove` and the `TagGroup` props are gone (no caller). New code uses `Chip`.

**`Button` `disabledReason`** — `@clowdy/components/Button`. `disabledReason?: ReactNode`: while `isDisabled`, the button sits in a focusable stand-in (`role="button"`, `aria-disabled`, named by `aria-label` or the string children) that shows the reason as a tooltip (`tooltipPlacement` applies). `fullWidth` stretches the stand-in. Replaces `shared/Unavailable.tsx` (+ `.module.css`) in its 11 files, and fixes `features/agents/AgentList.tsx:535` (pass the reason as `disabledReason`). The disabled opacity is the design system's; a "readable while off" dim is not a prop.

**`FoldButton`** — `@clowdy/components/Panel`. Props: `isExpanded`, `label` (aria-label, e.g. `Collapse CLO-12`), `onToggle`, `size?: 'xs' (24px) | 'xxs' (16px)`, plus Button props (`excludeFromTabOrder`, `className`, …). 8px chevrons, `aria-expanded`, `preventFocusOnPress`. Replaces `Fold` in `features/agents/AgentList.tsx:963`, the inlined copy in `features/agents/WorktreeCardHeader.tsx:106-135`, and the raw chevron buttons in `features/tasks/TaskList.tsx:92-111` and `features/tasks/ArchiveView.tsx:174-186` (`size="xxs"`, delete their `.chevron` CSS). Inside a row wrap it in `RowControls`.

**`RowControls`, `RowActionButton`** — `@clowdy/components/List`. `RowControls`: a span (any span props) that stops click, double click, pointerdown, keydown and contextmenu from reaching the row. Replaces `ownEvents` in `features/agents/AgentList.tsx:125`, `ArchiveButton.tsx:138`, `WorktreeCardHeader.tsx`, `features/tasks/TaskList.tsx`, `TaskChips.tsx:51`. `RowActionButton`: `icon`, `label` (aria-label and default tooltip; `tooltip={null}` for none) + Button props; `xs`, `filling`, `secondary`, `iconOnly`, `preventFocusOnPress`. Replaces the 12 hand-set button prop sets in AgentList, WorktreeCardHeader, ArchiveButton.

**`DiffStat`** — `@clowdy/components/DiffStat`. `added`, `removed`, `className`. `+N −M` in code type, success and danger colours. Replaces `stream/ToolCard.tsx:95-100` (`.diff`, `.added`, `.removed`) and any other `+N −M`.

**`PathText`** — `@clowdy/components/PathText`. `path`, `emphasizeName?` (default true: dim folder, medium name), `className`. Cut at its start, whole path as native tooltip. Replaces `PathLabel` in `features/changes/DiffCard.tsx:38-49` and its `.path` CSS.

**`ProgressBar`, `Meter`** — `@clowdy/components/ProgressBar`. RAC props (`value`, `minValue`, `maxValue`, `aria-label`, `isIndeterminate` for ProgressBar), `tone?: 'primary' | 'success' | 'warning' | 'danger'`, `className`. A 6px track; custom colours through `--clowdy-progress-fill` and `--clowdy-progress-track` on `className`. `ProgressBar` replaces `shell/CloneRepositoryForm.tsx:426-441`; `Meter` replaces `features/settings/providers/UsageRows.tsx:49-62`, `features/chats/ContextRing.tsx:107-118` (set `--clowdy-progress-fill: var(--context-color)` and the currentColor track) and `shell/UsageStatus.tsx:184-189`. Delete their track, fill, transition and reduced-motion CSS.

**`SplitButton`** — `@clowdy/components/SplitButton`. Main: `children`, `onPress`, `variant`, `color`, `size`, `isDisabled`, `disabledReason`, `isPending`, `spinnerPlacement`, `tooltip`, `tooltipPlacement`, `contentClassName`, `aria-label`, `aria-describedby`. Menu: `menu` (a `Menu` element), `menuLabel`, `menuTooltip?`, `isMenuDisabled?`, `menuPlacement?` (default `bottom end`), `menuWidth?`, `menuIcon?`. Layout: `wrap?` (multi-line label, both halves grow), `fullWidth?`, `className`. Square inner corners, 2px gap. Replaces `features/changes/RemoteMenu.tsx:156-200`, `CommitBox.tsx:546-585`, `BranchMergeDialog.tsx:544-608` and their `[data-size][data-variant]` overrides.

**`useRowContextMenu`** — `@clowdy/components/Popover`. `useRowContextMenu({ rowSelector, isKnown? })` → `{ areaProps: { onContextMenu, onKeyDown }, rowKey, isOpen, popoverProps, openAt, close }`. Spread `areaProps` on an element around the list; rows carry `data-key`. Right click opens at the pointer; ContextMenu or Shift+F10 opens under the focused row (follows `aria-activedescendant`). Closes on unmount. Render `<Show when={menu.isOpen}><Popover {...menu.popoverProps} placement="bottom start">` as with `useContextMenu`. Replaces `features/changes/CommitBox.tsx:168-220` (`'[role="row"][data-key]'`) and `BranchList.tsx:47-107` (`'[role="option"][data-key]'`); use its `onKeyDown` in the `DiffCard` header.

**`PanelLoadingState`, `PanelEmptyState`** — `@clowdy/components/Panel`. `PanelLoadingState({ label?, className? })`: Loader + label (default `Loading`), `role="status"`. Replaces the Loader + Text pairs in `shell/Shell.tsx:96`, `features/chats/ConversationView.tsx:152`, `features/settings/skills/SkillsSection.tsx:37`, `features/settings/providers/ProvidersPage.tsx:44`, `features/tasks/OpeningTask.tsx:49`, `CommentsSection.tsx:105`, `ArchiveView.tsx:85`. `PanelEmptyState({ icon?, title?, label?, description?, action?, fill?, className? })`: `title` is a heading-4, `label` a one-line quiet note in its place; `fill={false}` keeps it in a section's flow instead of filling the panel. Replaces `features/tasks/ScopeEmpty.tsx`, ArchiveView's empty state, `features/chats/ChatView.tsx` `EmptyChat`, `shell/NoProject.tsx`, `shell/Unreachable.tsx`, the `.empty` notes (`Board`, `QuickSearch`, `PickerPopover`, `FolderList`, agents) — or `PanelEmptyRow` for a note inside a list.

## Dialogs

**`Modal`** is now `role="dialog"` (option `role: 'alertdialog'`), `aria-modal` when it has a backdrop, named by its title element, `ariaLabel` option, or its own `title`. Tab and Shift+Tab stay inside a modal with a backdrop. `modal.setDismissable(false)` blocks Escape, outside click and the close button (which shows disabled) until `setDismissable(true)`; `modal.cancel()` still closes. `useModalTitleId()` (`@clowdy/components/Modal`) returns an id to put on a dialog's own heading. Delete the local `role="dialog"`, `aria-modal`, Escape handler and close button in `features/changes/BranchMergeDialog.tsx:456-488` and `RemoveWorktreeDialog.tsx:86-98`: open them with `closeButton: true` and call `setDismissable(false)` while the work runs.

**`openFormDialog`** — `@clowdy/components/modals`. `openFormDialog({ width, component, layer?: 'modal' | 'confirm', ...anyModalOption })` with `shadow`, `clickOut`, `closeOnEscape`, `closeButton: true`, `handle: false`; `layer: 'confirm'` sets `zIndex: Z_INDEX.confirm`. Replaces the option sets in `shell/projectDialogs.tsx:15`, `shell/CloneRepositoryForm.tsx:29`, `features/worktrees/CreateWorktreeDialog.tsx:29`, `features/tasks/CreateTaskDialog.tsx:39`, `features/changes/BranchMergeDialog.tsx:166`, `features/worktrees/RemoveWorktreeDialog.tsx:396`, `TidyWorktreesDialog.tsx:141`, `features/settings/projects/FolderWorkspaceDialog.tsx:69`.

**`DialogLayout`** — `@clowdy/components/modals`. `title` (an `h2`, names the modal), `description?`, `children`, `actions?` (end-aligned row), `onSubmit?` (makes it a `form`, default prevented), `className`. 20px padding, 20px gap. Replaces the `.form`/`.heading` blocks of `CloneRepositoryForm`, `FolderWorkspaceDialog`, `BranchMergeDialog`, `shell/AddProjectForm`, `CreateTaskDialog`, `ManageWorktrees` and their span titles.

**`Z_INDEX`** — `@clowdy/components/modals`. `{ modal, popover, confirm, tooltip, toast }`, the numbers of `--z-*`. Replaces the raw `zIndex: 101100` in `RemoveWorktreeDialog.tsx:397` and `TidyWorktreesDialog.tsx:142`.

**`openConfirmModal` / `ConfirmModalContent`** — new `isConfirmDisabled?: boolean` (Confirm off, Enter idle). Confirms are `alertdialog`s named by their title, and cannot be dismissed while `onConfirm` runs. Render the worktree dialogs' message and choice through it.

## Forms and settings

**`FormField` + `Textarea`** works: the label links, the disabled and invalid state reach the textarea, no React prop leaks. Replace the hand-built fields in `features/settings/projects/FolderWorkspaceDialog.tsx:249-292` (and `.field`/`.copy` CSS) and the label in `features/tasks/CreateTaskDialog.tsx:117`.

**Settings kit** — `@clowdy/components/SettingsLayout`, members of `SettingsLayout`:
- `Page({ description?, children })` — replaces `features/settings/ui/SettingsPage.tsx`.
- `Section({ title, aside?, description?, children })` — an `h2` that labels the `section`. Replaces `ui/SettingsSection.tsx`.
- `Card({ as?: 'div' | 'ul' | 'section', divided?, ...attrs })` — replaces `ui/SettingsCard.tsx`.
- `Block({ as?: 'div' | 'li', ...attrs })` — replaces `ui/SettingsBlock.tsx`.
- `Row({ title, description?, children, stacked?, footer?, as?: 'div' | 'li', inset? (default true), controlWidth?, ...attrs })` — a switch, checkbox, text field, select, radio group or toggle group in it is labelled by the title and described by the description, so drop the per-row `aria-label` constants. `inset={false}` for a row inside a block or a list of its own; `controlWidth="14rem"` replaces `FilesPage.module.css:2-4`, `BranchPrefixRow.module.css:2-5`, `ProjectDetail.module.css:6-11`. Replaces `ui/SettingsRow.tsx` and the hand rows in `providers/ProviderSettings.tsx:24-54,138-145,173-180,251-258` and `skills/SkillsSection.tsx:92-108`.
- `SettingsEmpty` has no kit twin: use `PanelEmptyState fill={false} label=…` or keep it with the squircle fix.

`SettingsField` is deleted (no caller).

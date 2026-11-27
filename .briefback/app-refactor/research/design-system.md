# Design system

## Summary

`@clowdy/components` is a direct fork of Reforma's design system: 70 component folders, every one exported. The renderer imports about 40 of them, always by subpath (`@clowdy/components/Text`). The core is solid and widely used: Button and Text (94 files each), toast (48), Popover (28), Modal (22), Menu (20), Show (26). Next to it sits about 8,400 lines of TS and 2,400 lines of CSS from Reforma's design-tool controls that nothing in the repo imports: angle, color, gradient, layout grid, unit inputs, CodeTextarea, Terminal, Avatar, HoverCard and more.

The biggest problems:

1. The imperative `Modal` (1,805 + 631 lines) has no dialog semantics and no focus containment. One app dialog patches this locally.
2. The renderer rebuilds what the system should give it: chips and pills (6 implementations, 3 tone maps), loading and empty states (16 hand-made), the dialog preset (repeated in 8 call sites), item rows (3 copies), and a disabled-reason tooltip (`shared/Unavailable`, 11 files).
3. The system's own `Badge` is a one-item React Aria TagGroup, so every static label is a focusable grid.
4. `FileIconColorScheme` is never provided, so file icons always use their dark variants.
5. `packages/components/AGENTS.md`, the Scrollable docs, the icons README and DESIGN.md all have claims that disagree with the code: Reforma names, a wrong import rule, wrong colours and weights, APIs that do not exist.

Counts below are files under `apps/desktop/src/renderer` that import the name (R). FM is `packages/file-manager/src`. Tests are excluded.

## Catalog

Import by subpath only: `import { Button } from '@clowdy/components/Button'`. Each folder is a subpath, plus `hooks`, `modals` and `codeLanguages`. The root barrel pulls TipTap, CodeMirror and Shiki in.

### Layout and primitives
- **Box** (R13, FM3): flex or grid `div`. `direction` (default `column`; a row centres items by default), `align`, `justify`, `gap` (xxs..xxl), `padding`/`paddingX`/`paddingY` (xxs..xxl or `'0'|'10'|'20'|'36'`), `wrap`, `fullWidth`, `fullHeight`, `grow`, `as`. Unused: `columns`, `background`, `radius`, `equalWidth`.
- **Text** (R94, FM1): typographic span. `variant` xl|lg|md|sm|xs|heading-1..6|label|code (no variant = inherit), `color` default|secondary|primary|accent|success|warning|danger|inherit, `weight` (named or numeric), `bold`, `truncate`, `italic`, `decoration`, `transform`, `select`, `align`, `wrap`, `whitespace`, `as` (h1..h6, p, label, kbd…). Also `inlineLink` class (R2).
- **Show** (R26, FM5): `when`, `fallback`, children or `(value) => node`. **For** (R14, FM2): `each`, `children(item, i, {isFirst,isLast})`, `fallback`.
- **ContentColumn** (R4): holds content at `--content-width`, centred. Goes inside the scroll container.
- **Separator** (R3): `orientation`, `spacing` (Spacing | 0).
- **Card** (R1): Box plus `variant` filled|bordered|transparent, `color`, `size` sm|md|lg, `hoverable` (bool|'outline'), `isActive`.
- **Resizable**: `ResizablePanelGroup`/`ResizablePanel`/`ResizableHandle`/`usePanelRef` (R3, FM1), `SIDEBAR_MIN_WIDTH` (R2). Wraps react-resizable-panels.
- **Scrollable** (R8): custom scrollbars. `vertical`/`horizontal`, `edgeFade`, `stickToBottom`, `scrollbar`, `alwaysShowScrollbar`, `gap`, `containerClass`/`contentClass`, overlay slot. Headless `useScrollChrome` + `elementScrollAxisSource` + `ScrollChromeRoot`/`ScrollChromeBars` (FM3). `useScrollable`, `ScrollContainer`, `ScrollExpandChevronButton`: 0.
- **Panel** family: `Panel` (R2, FM1; `side` left|right), `PanelHeader` with `.Actions`/`.Button` (R2, FM2; 40px bar), `PanelContent` (R1), `PanelTab` (FM1), `PanelEmptyState` (R2, FM1; `icon`/`title`/`description`/`action`), `PanelEmptyRow` (FM1; centred secondary note), `PanelLoadingState` (R3, FM2; fixed text "Loading"), `TreeChevron` (FM1). `PanelHeaderBack`, `PanelTabHeader`, `PanelSearch`, `PanelSearchButton`: 0.
- **SettingsLayout** (R3): settings window chrome. `.Sidebar`, `.Content` (`headerRight`), `.Pane` (`paneKey`), `.Intro`; `selectedId`/`onSelectedChange`, `stack`/`onStackChange`. `.Empty`, `saveable`, `useSettingsSave`, `useSettingsLayout`: 0.
- **TabStrip** + **Tab** (R1, FM1): 40px scrolling tab row. Tab takes `label`, `icon`, `active`, `dirty`, `deleted`, `closeLabel`, `onSelect`, `onClose`.
- **Slot**, `SlotContext`, `useSlotContextProps`, `filterSlots`, **AsChild**: internal slot plumbing (0 in app).

### Actions
- **Button** (R94, FM6): `variant` filled|filling|ghost|bordered|transparent|inline; `color` primary|secondary|accent|success|warning|danger|contrast|inherit (default secondary, inherit for inline/transparent); `size` xs|sm|md|lg|unset; `iconOnly`, `rounded`, `fullWidth`, `truncate`, `href`/`target`, `tooltip`/`tooltipPlacement`/`tooltipOffset` (not shown while disabled), `isPressed`, `isPending` + `spinnerPlacement` center|start|none. A trailing `Hotkey` is positioned for you.
- **ConfirmButton** (R2): arms on press, then Confirm + cancel. `onConfirm`, `confirmLabel`, `confirmColor`/`confirmVariant`.
- **CopyButton** (R4): `value`, `copiedLabel`, `tooltip`. Pass `aria-label` when it shows only the icon. Helpers: `copyText`, `copyWithFeedback` (R3), `useCopyFeedback` (R1).
- **ToggleButtonGroup** + **ToggleButtonGroupItem** (R3, FM1): segmented control. `variant` filled|transparent|multiselect|text, `size` xs..lg, `selectedKeys`; item takes `value`, `iconOnly`, `tooltip`. `ToggleButtonGroupSelectItem`: 0.
- **Pressable** (R2): React Aria re-export. **ButtonUpload**: 0.

### Forms
- **Input** (R13, FM1): `type` is required (text|email|password|search|tel|url|number). `variant` filled|bordered|transparent|inline, `size` xs..lg, `prefix`/`suffix` (string or slot), `hug`, `isInvalid`/`isDisabled`/`isReadOnly`, `autoSelect`, `onSubmit`, number options. **SearchInput** (R2, FM1): search icon + clear button. `PasswordInput`, `UnitInput`, `AngleUnitInput`, `INPUT_CONTROL_AFFIX`: 0.
- **Textarea** (R7): `variant` filled|bordered|transparent|inline, `size` xs..lg, `autoResize`, `isResizable`, `endAction`, `onRowCountChange`.
- **Select** (R7): `items` + `children(item)`, `size` xs..lg, `variant` filled|filling|bordered|transparent, `color` default|primary, `showSearch`, `isVirtualized`, `valueDisplay`.
- **Checkbox** (R7; `size` sm|md|lg), **Radio**/**RadioGroup** (R2; `size`, `items`), **Switch** (R9; `size` sm|md|lg, `isPending`). `CheckboxGroup`: 0.
- **FormField** (R6): `.Label`/`.Description`/`.Error` slots. `size` xs..lg, `layout` horizontal|vertical, label placement and align. **SettingsField**: 0.
- **Autocomplete** (R1) + `useAutocompleteEnterAction` (R1): search field and list shell inside a Popover. `maxHeight`, `showSearch`, `childrenOwnScroll`.
- **RichInput** (R1) and composer doc helpers: `emptyComposerDoc` (R13), `plainTextToDoc` (R7), `docToPlainText` (R4), `ComposerDoc` types. TipTap-based message box.
- **MarkdownEditor** (R1, FM lazy): TipTap markdown file editor.
- Dead (0 anywhere): CodeInput, CodeTextarea, ColorInput, ColorArea, ColorSlider, Swatch/ColorSwatch/ImageSwatch, PreviewInput, ControlGroup*, AngleControl, GradientStopRange, LayoutGridControl, FileUploadZone.

### Lists, menus, overlays
- **Menu**, **MenuItem**, **MenuTrigger**, **MenuSection**, **MenuSeparator**, **MenuHeader**, **SubmenuTrigger** (R20/20/14/6/9/3/4): `size` sm|md|lg. Row slots: `icon`, `description`, `startAffix`, `endAffix`, `stacked`.
- **ListBox**/**ListBoxItem**/**ListBoxSection**/**ListBoxHeader** (R2/10/2/2). `listBoxItemDataShow` (R4) reveals row actions on hover. **GridList**/**GridListItem**/**GridListSection**/**GridListHeader** (R6/8/2/1). `useCellEditMode` (R2), `useListHoverHighlight` (FM1). `AppearanceSubmenu`: 0.
- **Popover**/**PopoverTrigger** (R28/8): `spacing` (Spacing|none), `width`. **PopoverScroll** (R11): `maxHeight`. **useContextMenu** (R8, FM2): right-click, `openAt(x,y)`. `installLongPressContextMenu` (R2), `OverlayTriggerStateContext` (R2).
- **Tooltip** (R11): `content`, `placement`, `delay`, `warmUp`, `wrapTrigger`, `arrow`. `TooltipTrigger`/`TooltipContent` (R1). Hotkey text helpers: `tooltipWithHotkey` (R3), `tooltipWithSequence` (R1). `HelpTip`, `HoverCard`: 0.
- **Modal** (R22): `Modal.create(options)` opens an imperative window or overlay. Options the app uses: `width`, `shadow`, `clickOut`, `closeOnEscape`, `closeButton`, `handle:false`, `zIndex`, `tabs`, `position`, `padding`, `scrollable`. **Dialog** (R1): declarative version (`isOpen`/`onOpenChange`). `useModalContext` (R10).
- **openConfirmModal** (R11, FM1): `title`, `message`, `confirmLabel`, `cancelLabel`, `destructive`, `showCancel`, `initialFocus`, `errorIn`, `onConfirm`. `confirmDiscardChanges`, `ConfirmModalContent`: 0.
- **Lightbox** (R1): image preview. **toast** (R48): `.show/.success/.error/.info/.warning({title,message,type,timeout,action,contrast})`. **ToastRegion** (R1).

### Feedback and status
- **Alert** + `AlertIcon`/`AlertTitle`/`AlertDescription`/`AlertAction` (R13/12/0/13/6, FM1): in-page callout. `color` is a SemanticColor. `role` defaults to `alert`.
- **Marker**/`MarkerIcon`/`MarkerContent` (R3/2/3): inline status or a labelled divider. `variant` default|separator, `shimmer`.
- **Spinner** (R14, FM1): inline wait. `size` xxs..xxl|inherit|unset, colour is `currentColor`. **Loader** (R7): Lottie brand mark for a waiting page, size as Spinner. `SpinnerLabel`: 0.
- **Shimmer** (R4): sweeping text. **ShimmerBlock** (R1): `variant` sweep|dots.
- **Badge** (R5): one Tag inside a TagGroup. `color`, `size` xs..lg (xs = 20px), `rounded`, `icon`, `count`, `tooltip`. `Tag`/`TagGroup` directly: 0.
- **Hotkey** (R3, FM2): key capsule(s). `hotkey` or `sequence`, `size` xs|sm|md. `hotkeysToSymbols`: 0.
- **Breadcrumb** (R2): `.Link`/`.Page`, `variant`.
- **Collapsible**/`CollapsibleTrigger`/`CollapsibleContent`/`CollapsibleMotionContent`/`useCollapsible` (R6/6/3/2/4): `open`/`defaultOpen`/`onOpenChange`/`isDisabled`.
- **SortableList** (R6): drag to reorder, flat or nested. `renderItem`, `canDrop`, drag handle options. Pointer only.
- **Table** family (R1): React Aria table. `size` xs|sm|md, `maxHeight`, `align`.
- **Attachments**/**PreviewableAttachment** (R2/2): file cards. **FileIcon** (R4, FM2): `path`, `kind`, `open`. **FileDropOverlay** (R1): `open`, `label`, `icon`. **Image** (R3): `<img>`, not draggable.
- **CodeHighlighter** (R1): Shiki block. `codeLanguages` subpath: `codeLanguage`, `codeHighlighter` (FM2).
- Hooks: `useStickToBottom` (R1), `useFileDrag` (R1), `useFilePaste` (R1); `useClickout` and `useControlledState` are internal. Dead: **Avatar**, **Terminal**, **Lottie** (only used by Loader).

### Tokens (`@clowdy/styles`; CSS modules use `@reference '@clowdy/styles/rulesets'` + `@ruleset typography-*`)
- **Colors**. Primitives: `--color-{primary|secondary|interactive|accent|success|warning|danger|light}-{50..950}`, alpha steps `-a{5,8,10,15,20,30,40,50,60,70,80,90}` (not for secondary), `--color-{dark|black}-a*`, `--color-white|black|light|dark`. Semantic tokens, per role R in primary/secondary/interactive/accent/success/warning/danger: `--color-R`, `-light`, `-border`, `-border-hover`, `-content` (on the fill), `-text` (as text), `-muted`, `-muted-light`, `-muted-border`, `-muted-border-hover`, `-muted-content`, `-muted-text`. Surfaces: `--color-surface`, `-surface-float`, `-surface-border`, `--color-background`, `--color-text`, `--color-contrast`, `-contrast-light`, `-contrast-content`, `--color-modal-{background,border,overlay}`, `--color-tooltip(-foreground)`, `--color-chat-{composer,composer-header,message,message-content,overlay,shadow}`, `--color-border-ai`. Plus `--opacity-{disabled,inactive,hover,placeholder}` and `--scrollbar-*`. Dark theme: `.dark` / `[data-theme=dark]` remaps the same names.
- **Spacing**: named `--spacing-{xxs 2, xs 4, sm 6, md 8, lg 12, xl 16, xxl 20}px`; numeric `--spacing-{2..288}` (the number is px, written in rem); `--spacing-0|1|auto|full` (in `base.css`). `--content-width` 50.5rem.
- **Radii**: `--radius-{xs 4, sm 6, md 8, lg 10, xl 12, xxl 24, 2xl 40, full}`. Always `calc(var(--radius-X) * var(--squircle-radius-factor))` with `corner-shape: superellipse(var(--squircle-value))`.
- **Typography**: `--text-{xxs 8, xs 11, sm 12, md 13, lg 16, xl 18, xxl 36}` and `--leading-{xxs..xxl}`. Rulesets: `typography-heading-1..6`, `text-{xl,lg,md,sm,xs}`, `text-code-{sm,xs}` (Menlo), `button-{lg,md,sm,xs}`, `tab-tab-{lg..xs}`, `label-sm`, `avatar-*`, `badge-*` (unused).
- **Shadows**: `--shadow-{xs,sm,md,lg,xl}` (floats only), `--effect-ai`.
- **Z-index**: `--z-base 0`, `-raised 10`, `-dropdown 100`, `-overlay 1000`, `-modal 100999`, `-popover 101000`, `-popover-elevated` (equals `-popover`), `-confirm 101100`, `-tooltip 101200`, `-toast 102000`, `-max 109999`.
- **Motion**: `--ease-linear`, `--ease`, `--ease-in-out`, `--ease-bounce`; `--transition-duration` .3s, `-fast` .15s, `-slow` .65s, `-snail` 1.5s; `--transition-delay(-fast|-slow|-snail)`. Keyframes: `spin`, `fadeIn/Out`, `slideUp/Down`, `scaleIn`, `slide-in-from-right`, `slide-out-to-right`, `mask-scan`. JS: `@clowdy/constants` `MOTION_EASE_UI` [0.32,0.72,0,1], `MOTION_TRANSITION_COLLAPSE`.
- **Breakpoints** (`@custom-media`): `--tablet`, `--desktop-sm`, `--desktop`, `--desktop-md`, `--fhd`, `--qhd`, `--uhd`, each with a `-max`.
- **Utilities**: `.chevron`, `.chevron.next`, `.visibility-hidden/visible`, `.inset-0`. UnoCSS (presetMini) is mapped to the tokens: `m-/p-/gap-/inset-` to `--spacing-*`, `rounded-*` to `--radius-*` (no squircle), `text-*`, `leading-*`, `bg-*`/`color-*`/`border-color-*` to `--color-*`, `opacity-*`, `shadow-*`, and `w-/h-N` to `--spacing-N`.

## Findings

### F1. The Modal is not a dialog to assistive technology and does not hold focus
- Where: `packages/components/src/Modal/views/Modal.tsx:61-70` (the window `div` has no `role`, no `aria-modal`, no `aria-labelledby`/`aria-label`). `Modal/Modal.ts:809-825`: the only keyboard handling is Escape; `focus()` at `Modal.ts:1601-1617` focuses the overlay once. No `inert` or focus trap anywhere in `packages/components/src` (the grep finds only SettingsLayout panes). `modals/ConfirmModal.tsx:94-100`: no role on confirms (11 renderer files). `apps/desktop/src/renderer/features/changes/BranchMergeDialog.tsx:459-469` adds `role="dialog"` + `aria-labelledby` + `h2` by hand. App dialog titles are spans: `CreateWorktreeDialog.tsx:86`, `TidyWorktreesDialog.tsx:41`, `shell/AddProjectForm.tsx:74`, `shell/CloneRepositoryForm.tsx:216`.
- Problem (observed): a screen reader does not announce the Settings window, the confirms or the create dialogs as dialogs, and they have no name. Tab can move to the page behind the backdrop. 1 of 9 app dialogs works around it.
- Fix: in `views/Modal.tsx`, render `role="dialog"` (`alertdialog` for ConfirmModal), `aria-modal="true"`, and `aria-labelledby` pointing at the title. Expose a `titleId` through `ModalContext`, or add an `aria-label` option. Wrap the window in react-aria `FocusScope contain restoreFocus`, or make the root's siblings `inert` while a modal is open. Then delete the local role from BranchMergeDialog.
- Category: correctness (a11y) | design-system. Effort: M. Risk: medium (focus behaviour of every dialog; Modal tests).

### F2. Chips, pills and badges are built six times, and the system's Badge is a grid
- Where: chip CSS in `shared/Chip.module.css:4-48`, used by `AgentChip.tsx`, `TaskChip.tsx`, `stream/markdown/ChatReferenceChip.tsx`, `stream/markdown/FileChip.tsx` and `features/chats/MentionChip.tsx`. A near copy in `features/tasks/TaskChips.module.css:4-23`. Pills in `features/tasks/Pill.tsx` + `Pill.module.css:3-19` and `shared/RunStatusPill.module.css:3-41`. Count badges in `features/changes/CommitCountBadge.module.css:1-14` and the `.badge` of `features/tasks/DetailSections.tsx:30`. Three tone maps: `shared/StatusTone.module.css`, `RunStatusPill.module.css:23-41`, `StatusDot.module.css:13-27`. In the system, `Tag/Badge.tsx:39-90` wraps a single `Tag` in a `TagGroup`. React Aria gives that `role="grid"` (`node_modules/react-aria/dist/private/tag/useTagGroup.mjs:71`) and a tag with `tabIndex=0` (`useTag.mjs:75-76`). Badge is used for static labels: `shell/FolderRow.tsx:51` ("Main"), `features/settings/projects/ProjectRow.tsx:59,64`, `features/worktrees/WorktreeRow.tsx:91`, `shell/UsageStatus.tsx:228`, `features/settings/providers/Account.tsx:103`.
- Problem: the same 20px squircle or pill with a muted plate and a tone is defined in six CSS files. The DESIGN.md "chips" rule is not enforced and has already drifted (11px type here, "12px" in the doc). Each static Badge is a tab stop that a screen reader announces as a grid, and it builds a React Aria collection per label (observed in code; the screen-reader effect is inferred from the roles).
- Fix: add a DS `Chip`. It renders a `span`, or a `button` when it has `onPress`. Props: `tone` neutral|accent|success|warning|danger, `size` xs (20px) and sm, `shape` squircle|pill, `icon`, `dot`, `tooltip`. Re-implement `Badge` as that plain span. Keep `Tag`/`TagGroup` only for selectable or removable lists. Move the one tone map into the DS. Delete `Chip.module.css`, `TaskChips.module.css`, `Pill.module.css`, `RunStatusPill.module.css`, `StatusTone.module.css` and `CommitCountBadge.module.css`. The app wrappers (AgentChip, TaskChip, RunStatusPill) keep only their data logic.
- Category: reuse | design-system | correctness (a11y). Effort: M. Risk: low-medium (visual diffs).

### F3. About 10k lines of forked design-tool components that nothing uses
- Where (TS / CSS lines, in `packages/components/src`): AngleControl 1713/231, ColorInput 1942/234, LayoutGridControl 852/526, GradientStopRange 636/150, `Input/UnitInput.tsx` 686, `Input/AngleUnitInput.tsx` 221, CodeTextarea 357/353, Swatch 195/127, HoverCard 227/54, ControlGroup 179/134, Terminal 178/87, PreviewInput 145/26, CodeInput 129/97, ColorArea 119/62, FileUploadZone 113/58, ColorSlider 111/82, Avatar 82/113, ButtonUpload 43, SettingsField 26/44, `utils/colorValue.ts` 222, `Input/PasswordInput.tsx`, `Checkbox/CheckboxGroup.tsx`, `List/AppearanceSubmenu.tsx`, `Tooltip/HelpTip.tsx`, `Panel/PanelSearch.tsx`, `Scrollable/ScrollContainer.tsx`, `ScrollExpandChevronButton.tsx`, `Spinner/SpinnerLabel.tsx`, `utils/children.ts` (`filterChildren`), `constants.ts`. There are also number and scrub paths in `Input/Input.tsx` (`scrubHandle`, `hug`, `interactionStep`, `roundTo`: no caller).
- Problem: verified with word-boundary greps over `apps/` and `packages/` (excluding `packages/components`) plus dynamic imports. No caller, test or string reference outside each component's own folder and `index.ts`. They grow typecheck, test and lint time, carry deps that only they use (`@uiw/react-codemirror` for CodeTextarea, `anser` for Terminal), and make the catalog hard to scan for agents.
- Fix: delete these folders and files, drop them from `index.ts`, and remove `@uiw/react-codemirror` and `anser` from `packages/components/package.json`. Their own tests go with them (AngleControl, GradientStopRange, LayoutGridControl, CodeInput, Terminal). Keep `AsChild`, `useClickout`, `useControlledState`, `resolveOverlayWidth` and `useMergedRef`, which live components use.
- Category: dead-code. Effort: M (mechanical). Risk: low.

### F4. Button keeps a tooltip that never shows when it is disabled
- Where: `packages/components/src/Button/Button.module.css:519-523` (`pointer-events: none` on `[data-disabled]`; `cursor: not-allowed` beside it is dead), while `Button.tsx:174-180` still wraps it in Tooltip. The app works around it with `shared/Unavailable.tsx`, used in 11 files (ComposerQueue, RemoteMenu, WorktreeRow, SidePanelSizes, SubagentBox, SubtasksSection, TasksHeader, Composer, WorkspaceChips, ScopeHeader, CommitBox). A case still broken: `features/agents/AgentList.tsx:535-536` sets `tooltip={isMissing ? 'This folder no longer exists' : …}` with `isDisabled={isMissing}`, so the reason is never shown.
- Problem: the DS API invites a pattern that silently fails. The fix exists, but in the app only.
- Fix: move `Unavailable` into the DS. Either add a Button prop (`disabledReason`), or render the focusable stand-in inside Button when `isDisabled && tooltip`. Remove `shared/Unavailable` and the dead `cursor`.
- Category: design-system | correctness. Effort: S-M. Risk: low.

### F5. Loading and empty states are built by hand
- Where: Loader + Text pairs at `shell/Shell.tsx:96`, `features/chats/ConversationView.tsx:152`, `features/settings/skills/SkillsSection.tsx:37`, `features/tasks/OpeningTask.tsx:49`, `features/tasks/CommentsSection.tsx:105`, `features/tasks/ArchiveView.tsx:85`, `features/settings/providers/ProvidersPage.tsx:44`. Each has its own wrapper div and CSS. The DS `Panel/PanelStates.tsx:25-32` `PanelLoadingState` hardcodes "Loading" with no ellipsis (the app convention is `Loading…`) and takes no label. Empty notes in `.empty` rules: `shared/PickerPopover.module.css`, `features/quickSearch/QuickSearch.module.css`, `features/tasks/Board.module.css`, `shell/FolderList.module.css`, `features/agents/ArchiveButton.module.css`, `features/agents/AgentList.module.css`, `features/chats/ChatView.module.css`, `features/agents/Screen.module.css`, `features/settings/ui/SettingsEmpty.module.css` (radius without the squircle factor). `PanelEmptyRow` exists and is used only in file-manager.
- Problem: 16 copies of two patterns with differing padding and type sizes. The DS versions are panel-named and too rigid to reuse.
- Fix: in the DS, provide `LoadingState({label})` and `EmptyState`/`EmptyNote` (keep the Panel names as aliases or rename them). Give them a `label` prop, `role="status"`, and a `size`/`fill` option. Migrate the 16 sites and delete their CSS.
- Category: reuse | design-system. Effort: M. Risk: low.

### F6. The dialog preset, z-index and layout are repeated in every dialog
- Where: `Modal.create({ width, shadow: true, clickOut: true, closeOnEscape: true, closeButton: true, handle: false, … })` in `shell/projectDialogs.tsx:15-20`, `shell/CloneRepositoryForm.tsx:29-34`, `features/worktrees/CreateWorktreeDialog.tsx:29-34`, `features/tasks/CreateTaskDialog.tsx:39-45`, `features/changes/BranchMergeDialog.tsx:166-171`, `features/worktrees/RemoveWorktreeDialog.tsx:396-401`, `features/worktrees/TidyWorktreesDialog.tsx:141-146`, `features/settings/projects/FolderWorkspaceDialog.tsx:69-74`, `features/quickSearch/QuickSearch.tsx:292-298`. The Modal default `handle: '[data-modal-title]'` (`Modal.ts:278`) is switched off in all of them. Raw `zIndex: 101100` at `RemoveWorktreeDialog.tsx:397` and `TidyWorktreesDialog.tsx:142` duplicates `CONFIRM_MODAL_Z_INDEX` (`modals/ConfirmModal.tsx:38`, not exported) and `--z-confirm`. Each body re-declares `.form { flex column; gap; padding: var(--spacing-20) }` plus a `.heading`: `CloneRepositoryForm.module.css:7`, `FolderWorkspaceDialog.module.css:7`, `BranchMergeDialog.module.css:11`, `shell/AddProjectForm.module.css:5`, `CreateTaskDialog.module.css:5`, `ManageWorktrees.module.css:7`.
- Problem: a change to dialog behaviour or spacing has to be made nine times, and the z-index comment in `zIndex.css:23` already relies on keeping numbers in sync by hand.
- Fix: in `packages/components/src/modals`, add `openDialog(component, { width, layer?: 'confirm' })` with the app's defaults, and export the z constants. Add a `DialogLayout` (an `h2` title wired to `aria-labelledby` from F1, description, body, actions row) and use it in `ConfirmModalContent` too. Change the Modal default `handle` to `false`.
- Category: reuse | design-system. Effort: M. Risk: low.

### F7. The settings row duplicates SettingsField, and every row repeats its label by hand
- Where: `features/settings/ui/SettingsRow.tsx:21-45` renders the title as a plain `Text`, with no label link and no `aria-describedby` for the description. It has 32 usages; each control repeats the title through a constant (`ChatPage.tsx:18-19,29,41-46,63-66`, `SourceControlPage.tsx:20-22,50,67,87`, `FilesPage.tsx:64-67`…). DS `SettingsField/SettingsField.tsx` (built on FormField, which wires label and description through slots) has 0 users.
- Problem: two row components for one job. In the live one, accessible names hold only because each call site remembers to repeat the text, and descriptions are never announced (observed: no `aria-describedby` anywhere in SettingsRow).
- Fix: give the title and description ids in SettingsRow and pass `aria-labelledby`/`aria-describedby` to the control through React Aria `LabelContext`/`SlotContext`, as FormField does. Delete the per-row label constants and the DS `SettingsField`. If SettingsLayout stays in the DS, move the settings blocks (Page, Section, Card, Row, Block, Empty) next to it.
- Category: reuse | correctness (a11y). Effort: M. Risk: low.

### F8. Three copies of the icon, title and actions row
- Where: `shared/CardRow.tsx` + `CardRow.module.css:1-75`, `shell/FolderRow.tsx:31-70` + `FolderRow.module.css:1-45`, and WorktreeRow (styles in `features/worktrees/ManageWorktrees.module.css:144-235`). The `.icon`/`.text`/`.title`/`.actions` rules are identical (gap md, column gap xxs, title row gap md). Actions revealed on hover are also hand-made in `ManageWorktrees.module.css:159-161`, `features/tasks/DependencyList.module.css:82-83` and `features/tasks/Comment.module.css:43`.
- Problem: one visual pattern with three implementations. A change to spacing or truncation drifts between Settings, the folder list and worktrees.
- Fix: make one `ItemRow` with `icon`, `title`, `marks`, `children` lines and `actions`, `variant: 'card' | 'plain'`, `revealActions` and an optional `onPress` body. Extend `CardRow` or add it to the DS. FolderRow and WorktreeRow become wrappers.
- Category: reuse | structure. Effort: M. Risk: low-medium.

### F9. The busiest components create a new callback ref on every render
- Where: `mergeRefs(...)` called during render in `Button/Button.tsx:77`, `Input/Input.tsx:344,374`, `Textarea/Textarea.tsx:153`, `List/ListBox.tsx:104,135`, `List/GridList.tsx:117`, `List/Menu.tsx:138`, `Collapsible/Collapsible.tsx:127`, `Modal/views/ModalData.tsx:27` and `AsChild/AsChild.tsx:26`. The package already has `hooks/useMergedRef.ts` for this, and `Scrollable/Scrollable.tsx:172` explains why it matters.
- Problem: on every render React calls the old ref with `null` and the new one with the node, for every Button (94 files), list and menu. Parent callback refs see a null flicker, and React Aria's object refs are rewritten (observed pattern; perf cost inferred).
- Fix: replace with `useMergedRef(a, b)` (for more than two refs, memoise the `mergeRefs`).
- Category: perf. Effort: S. Risk: low.

### F10. File icons never use their light variants
- Where: `FileIcon/fileIconTheme.ts:29` (`FileIconColorScheme = createContext('dark')`), read at `FileIcon/FileIcon.tsx:19`. No provider anywhere in `apps/` or `packages/`. `packages/components/AGENTS.md:64` says "which the app provides". The manifest has 264 light associations (32 extensions, 179 file names, 25+25 folders).
- Problem: in the light theme, files and folders that have a light icon variant show the dark one (observed: context default plus no provider).
- Fix: provide `FileIconColorScheme` at the renderer root from the theme store (`theme.ts`), or derive it in FileIcon from the `<html>` `.dark` class.
- Category: correctness. Effort: S. Risk: low.

### F11. An undefined token, and six focus-ring recipes
- Where: `--color-secondary-text` is not defined anywhere, yet `features/changes/BranchPullRequestList.module.css:13` and `features/settings/projects/ProjectDetail.module.css:69` use it, so the text is not dimmed. `--color-focus-ring` is undefined and falls back to `currentcolor` in `shared/CardRow.module.css:44`, `shell/FolderList.module.css:80`, `features/worktrees/ManageWorktrees.module.css:140` and `ProjectDetail.module.css:42,83`. The renderer has six `outline:` recipes (2px currentcolor, 1px primary, 1px text, `--spacing-2`/`--spacing-4` primary-muted, none), against the DS ring at `packages/styles/src/base.css:20-23` and `Button.module.css:68-71` (4px primary-muted).
- Problem: inconsistent, sometimes low-contrast keyboard focus, and two muted texts that are not muted.
- Fix: use `--color-secondary-muted-text`. Add `--focus-ring-width`/`--focus-ring-color` tokens, or a `focus-ring` ruleset, in `@clowdy/styles`, use them in the DS and the app, and delete the local outlines.
- Category: design-system | correctness. Effort: S. Risk: low.

### F12. Motion tokens do not cover the easing the app uses
- Where: `packages/constants/src/animations.ts:2` `MOTION_EASE_UI = [0.32, 0.72, 0, 1]` has no CSS twin. `features/chats/ModelPicker.module.css:108,116-117` hardcode it. `shared/Chip.module.css:21` and `shared/RailItem.module.css:29` use `150ms ease-out` (the DESIGN.md button timing); `RailItem.module.css:33` and `features/agents/AgentList.module.css:40` use other curves. 35 raw durations in renderer CSS against 18 token uses; 16 raw values in DS CSS.
- Problem: motion is not centralised, and JS and CSS animations do not match.
- Fix: add `--ease-ui` (same value as `MOTION_EASE_UI`) and `--ease-out` to `tokens/variables/primitives-motion.css`, and replace the raw durations and curves with tokens.
- Category: design-system. Effort: S-M. Risk: low.

### F13. The composer copies the AI palette instead of using a token
- Where: `features/chats/Composer.module.css:29-31,40-42` (`rgba(250,136,84)`, `rgba(91,141,239)`, `rgba(255,161,231)` per theme) are the stops of `packages/styles/src/tokens/styles/colors.css:2-7` `--color-border-ai`. `--color-border-ai` and `--effect-ai` have no users.
- Problem: a brand moment defined twice, against the DESIGN.md Token File Rule.
- Fix: define per-stop tokens (`--color-ai-coral|blue|pink`, with `.dark` values) in `colors.css`/`theme.css` and use them in the composer. Delete the unused gradient token, or rebuild it from the stops.
- Category: design-system. Effort: S. Risk: low.

### F14. Similar components use different prop names
- Where:
  - Sizes: Button xs..lg|unset; Checkbox, Radio and Switch sm|md|lg; Avatar xxs|sm|md; Hotkey xs|sm|md; Table xs|sm|md; Spinner xxs..xxl|inherit|unset; Attachments sm|md.
  - Variants: Button filled|filling|ghost|bordered|transparent|inline; Select has no `ghost`/`inline`; Input and Textarea have no `filling`/`ghost`; ToggleButtonGroup filled|transparent|multiselect|text.
  - Colours: Select `default|primary` (`Select/Select.tsx:27`); Avatar `secondary|primary`; Text `default`; Toast `type: 'error'` (`Toast/Toast.tsx:20`) where everything else says `danger`.
  - State: `open` (Collapsible, FileDropOverlay) vs `isOpen` (Dialog, Lightbox, HoverCard); `active` (TabStrip `Tab`) vs `isActive` (Card, Input, Select); `loading` (Attachment) vs `isPending` (Button, Switch); `disabled` (FileUploadZone, RichInput, SortableList) vs `isDisabled`.
- Problem: agents guess wrong names, and wrappers carry translation code.
- Fix: settle on React Aria names (`isOpen`/`isActive`/`isPending`/`isDisabled`), SemanticColor for colour (`danger` in toast, with `error` kept as an alias), one size scale `xs|sm|md|lg` for controls, and one variant vocabulary. Document it in AGENTS.md. Do this after F3, which removes half the outliers.
- Category: design-system | simplify. Effort: M. Risk: medium (API rename; few live call sites).

### F15. Other accessibility gaps in the components
- Where:
  - (a) Icon-only buttons with no name: `Input/SearchInput.tsx:71-83` (Clear; R2, FM1), `Tooltip/HelpTip.tsx:26`, `Input/PasswordInput.tsx:38`, `Panel/PanelSearch.tsx:72`. `CopyButton/CopyButton.tsx:54-90` gives no default `aria-label` (current callers pass one).
  - (b) `SortableList/SortableList.tsx:265` `sensors={[PointerSensor]}`: reordering in `shell/FolderList.tsx`, `features/settings/projects/ProjectsPage.tsx`, `features/settings/PanelOrderSettings.tsx` and `features/chats/ComposerQueue.tsx` has no keyboard path (no Move up/down alternative found).
  - (c) `Alert/Alert.tsx:23` defaults to `role="alert"`; 8 of 16 renderer usages override it, and `stream/ErrorLine.tsx:9` announces past errors assertively every time a chat mounts.
  - (d) `TabStrip/TabStrip.tsx:73-107`: the tablist's children are wrapper divs holding a tab button and a close Button, with no arrow-key roving, so each tab is two tab stops and the tablist owns non-tabs.
  - (e) 28 `Text variant="heading-*"` render spans (dialog titles above, `features/tasks/DetailSections.tsx:29`), so headings navigation finds nothing.
- Fix:
  - (a) Give these buttons `aria-label`, and default CopyButton's label to its tooltip text.
  - (b) Add a keyboard sensor, or document Move up/down actions in `renderItem`.
  - (c) Default Alert to `role="status"`, or none, with an `urgent` opt-in.
  - (d) Build TabStrip on React Aria `Tabs`/`TabList`, with close as a separate action (Delete key and a middle click).
  - (e) Let a heading variant default `as` to the matching `h*`, or add a `Heading` component.
- Category: correctness (a11y). Effort: M. Risk: low-medium.

### F16. The import rule in the components guide is wrong, and the barrel has leftovers
- Where: `packages/components/AGENTS.md:3` says to import from `'@clowdy/components'`. `apps/desktop/AGENTS.md:190` says subpaths only, because the barrel pulls TipTap, CodeMirror and Shiki. No code imports the barrel. `src/Scrollable/README.md:9-20` also imports from the root. `src/index.ts:49-50` exports RichInput twice. `src/index.css` is empty (one TODO), yet `apps/desktop/src/renderer/styles.ts:3` imports it.
- Problem: an agent following the package guide would bloat the bundle.
- Fix: change the guide and the README to subpath imports. Optionally add a Biome `noRestrictedImports` for the bare `@clowdy/components` in `apps/`. Delete `index.ts:50`. Drop `index.css` and its import, or put the package's global rules in it.
- Category: docs | perf. Effort: S. Risk: low.

### F17. `packages/components/AGENTS.md` and the Scrollable docs disagree with the code
- Where: the table omits heavily used parts: Checkbox (R7), Textarea (R7), Collapsible (R6), SortableList (R6), Tag/Badge (R5), Shimmer (R4), Hotkey (R3), Resizable (R3), RichInput, `openConfirmModal` (R11), hooks. Wrong entries:
  - line 31-32: the Text variants are not "body/heading/label/code".
  - Box: the padding list misses `xxl` and `'0'|'10'|'20'|'36'`, and `columns`/`background`/`radius`/`grow`/`fullHeight` are undocumented.
  - Avatar: the sizes are xxs|sm|md, not "sm/md".
  - Spinner: the sizes are not "xs/sm/md/lg".
  - Panel lists PanelTabHeader/PanelHeaderBack/PanelSearch, which nothing uses.
  - "Omnibox", a Reforma name, appears in Select.
  - FileIcon claims the app provides the scheme (F10).
  - The "Prefer For, Show, Box, Text" rule is not the codebase's practice: 369 `&& <` against 61 `<Show>`, 255 `<div className` against 27 `<Box>`.
  
  In the Scrollable docs, `README.md:86,103,114` name `LayersPanel`, `FramePageScrollChrome` and `PanZoom` as "In Clowdy" (Reforma components that do not exist here). The real users are file-manager's Explorer, CodeEditor and DiffView, and Autocomplete. Storybook is referenced at `AGENTS.md:3` and `README.md:136`; there is no Storybook.
- Problem: the guide every UI agent reads first misleads them in both directions: it hides real components and advertises dead ones.
- Fix: regenerate the table from the Catalog above (after F3), and fix the Scrollable docs. Decide For/Show/Box with the owner: either drop the rule, or keep it for new code only.
- Category: docs. Effort: S-M. Risk: low.

### F18. DESIGN.md disagrees with the tokens
- Where:
  - Front matter: `secondary #e9e5df`, `secondary-content #282522` and `text`/`contrast #191715`, while `tokens/variables/primitives-color.css` has `#e9e7df`, `#242526` and `#1b1c1d`.
  - Headings: "600 on heading 1–2" and front matter `fontWeight: 600`, but `tokens/styles/typography.css:4,12` use 500.
  - "heading-3–heading-6: 18px down to 13px", but heading-6 is `--text-sm` (12px).
  - Dark surface "goes to `--color-secondary-950`", but `theme.css:129` maps it to `secondary-900` (950 is `surface-float`).
  - Chips "12px type", but the app's chips use `typography-text-xs` (11px; the comment at `TaskChips.module.css:3` also says 12px).
  - The "Variable galleries" section is Reforma product behaviour.
  - The package body is 16px (`packages/styles/src/base.css:6-9`), against the Density Rule; only `apps/desktop/src/renderer/base.css:6-8` fixes it.
- Problem: designers and agents copy values that do not exist.
- Fix: regenerate the front matter from the token files, fix the weight, size and dark-surface lines, delete "Variable galleries", set the package body to `typography-text-md`, and drop the renderer override.
- Category: docs. Effort: S. Risk: low.

### F19. The icons README describes Reforma's API, and `title` makes icons unlabeled
- Where: `packages/icons/README.md`:
  - Usage shows `import { Icon } from '@clowdy/icons'` with `pack`/`name`, but `dist/index.js` exports only the packs and `IconWrapper`.
  - It names icons `AddIcon`/`CloseIcon`; the real names are `Add` and `Close`.
  - The types `IconPack`/`IconName`/`IconCollection`/`IconSize`/`IconComponent` do not exist.
  - The Accessibility section claims `role="img"`, `aria-label` and `<title>`, but `src/IconBase.tsx:28-33` puts `title` as a raw `<svg>` attribute and drops `aria-hidden`.
  
  `dist/registry.js` (`ICON_PACKS`, `scripts/build.js:249,380`, "for Storybook") has no consumer.
- Problem: wrong docs. Worse, an icon given `title` is neither hidden nor named: an SVG takes its name from a `<title>` child or `aria-label`, not a `title` attribute (inferred from the accessible name rules; observed in code).
- Fix: rewrite the README's Usage, Types and Accessibility sections. In `IconWrapper`, render a `<title>` child plus `role="img"` and `aria-label` when `title` is given. Drop the registry export from the build.
- Category: docs | correctness (a11y) | dead-code. Effort: S. Risk: low.

### F20. Unused Reforma machinery inside live components
- Where:
  - `SettingsLayout/SettingsLayout.tsx:499-743` (≈245 lines: `SaveableContent`, `SaveNotice`, Cmd+S, the leave guard), plus `useSettingsSave`/`useSettingsLayout`/`.Empty`. The app uses only Sidebar, Content, Pane and Intro (`features/settings/SettingsWindow.tsx:77-81`, `ui/SettingsPage.tsx:20`, `projects/ProjectsPage.tsx:37-44`).
  - `Modal/ModalInteractions.ts` (631 lines: drag, resize, maximize, restore, double-click), `views/ModalResizeHandles.tsx`, `views/ModalResponsiveToggle.tsx`, `views/ModalActions.tsx` and the `responsiveModes`/`resizable`/`modalActions`/`hideOnClose`/`moveAxis`/`positionFrom`/`limit`/`theme` options. No app caller: every app dialog sets `handle: false`, ConfirmModal has no title, and Settings and Lightbox are overlays. `tabs` is used (FolderWorkspaceDialog) and stays.
- Problem: the two largest components are mostly code paths nobody runs, so every change to dialogs or settings costs more to read and test.
- Fix: delete the save path (and its tests in `SettingsLayout.test.tsx`). Trim Modal to window or overlay, position, tabs and close. Do this in the same stage as F1/F6, behind the existing Modal tests.
- Category: dead-code | simplify. Effort: L. Risk: medium.

### F21. Box has unused props, and one of them is broken
- Where: `Box/Box.tsx:123` maps `background="contrast"` to `'bg-contrast bg-contrast-content'`; it should be `color-contrast-content`, as the other entries are. `background`, `radius`, `columns` and `equalWidth` have no caller in apps or packages.
- Problem: a latent bug (a contrast Box would paint the content colour as its background), plus API surface nobody needs.
- Fix: delete the four props, or at least fix the class.
- Category: correctness | dead-code. Effort: S. Risk: low.

### F22. Some DS CSS sits outside `@layer components`
- Where: `Modal/styles/Modal.module.css`, `Modal/styles/Overlay.module.css`, `Lightbox/Lightbox.module.css`, `Terminal/Terminal.module.css`, `Input/UnitInput.module.css`. Every other DS module wraps itself, as `packages/components/AGENTS.md` ("CSS modules") requires.
- Problem: unlayered DS rules outrank the `utilities` layer and compete with app CSS by specificity instead of losing to it, so overriding the modal from a feature is fragile (inferred from the cascade-layer rules).
- Fix: wrap Modal, Overlay and Lightbox in `@layer components` (Terminal and UnitInput go with F3), and check that the Settings dialog `class` overrides still apply.
- Category: design-system. Effort: S. Risk: low-medium.

### F23. Small gaps the app fills by hand
- Where:
  - A visually-hidden class is copied 4 times: `features/chats/ConversationHeader.module.css:64`, `features/worktrees/ManageWorktrees.module.css:73`, `features/changes/BranchMergeDialog.module.css:52`, `features/tasks/TaskList.module.css:37`.
  - The section block (title, count or aside, description, body) is built twice: `features/tasks/DetailSections.tsx:25-36` and `features/settings/ui/SettingsSection.tsx:18-37`.
  - `shared/PickerPopover.tsx` (275 lines, imports only the DS, lib and icons) overlaps `Autocomplete` and `Select showSearch`.
  - A key hint is written by hand: `features/settings/ChatPage.tsx:22` `'⌘ Enter' : 'Ctrl+Enter'` instead of `Hotkey`/`hotkeysToSymbols`.
  - About 38 native `title=` tooltips (20 on raw elements, 18 on `Text`) beside the DS Tooltip, mostly for truncated text.
- Problem: small duplications that agents keep copying.
- Fix:
  - Add `.visually-hidden` to `packages/styles/src/utilities.css`, or re-export React Aria's `VisuallyHidden`.
  - Add a DS `Section` (heading semantics per F15e).
  - Move PickerPopover into the DS as `Picker`, and have `Select showSearch` reuse it.
  - Use `Hotkey` for the key text.
  - Give `Text truncate` a `tooltip` option that shows only when the text is cut.
- Category: reuse | design-system. Effort: M (split per item). Risk: low.

### F24. Small internal duplications and hazards
- Where:
  - `Radio/Radio.tsx:8` and `Radio/Radio.types.ts:3` both declare `RadioSize`.
  - `Tooltip/Tooltip.tsx:4` imports `react-aria/private/interactions/useFocusable`, a private path that can break on any react-aria upgrade.
  - `tokens/local/zIndex.css:21` `--z-popover-elevated: calc(var(--z-modal) + 1)` equals `--z-popover` (101000), so the token is redundant.
  - `packages/styles/src/utilities.css:13-16` `.inset-0` (absolute + inset) collides with UnoCSS's `inset-0` (inset only); unused.
  - `Resizable/index.ts:4` `SIDEBAR_MIN_WIDTH` is an app layout constant inside the DS.
  - The typography rulesets `badge-*` and `avatar-*` have no live users.
  - `tokens/local/playground.css` is empty but still imported.
- Fix: keep one `RadioSize`. Replace the private import with React Aria's public `Focusable`, or pin and comment it. Delete `--z-popover-elevated`, `.inset-0` and the unused rulesets. Move `SIDEBAR_MIN_WIDTH` to `apps/desktop/src/renderer/shared/sidebarWidth.ts`.
- Category: simplify | safety. Effort: S. Risk: low.

## Cross-area notes

- New or extended DS parts:
  - `Chip`, and Badge as a plain span (F2).
  - Button `disabledReason`, which absorbs `shared/Unavailable` (F4).
  - `LoadingState` and `EmptyState`/`EmptyNote` with labels (F5).
  - `openDialog` + `DialogLayout` + exported z constants (F6).
  - Accessible SettingsRow, or the settings blocks moved next to SettingsLayout (F7).
  - `ItemRow` (F8), `Section`/`Heading` (F15e, F23), `Picker` from `shared/PickerPopover` (F23).
  - `.visually-hidden` and focus-ring tokens in `@clowdy/styles` (F11, F23).
  - `--ease-ui` and `--ease-out` tokens mirroring `@clowdy/constants` (F12).
- Agents working on renderer features (tasks, agents, chats, changes, settings, worktrees) should migrate to these instead of adding more `.chip`, `.empty`, `.form`, `.heading` or `.visuallyHidden` rules. The heaviest sites are `features/tasks/*` (Pill, TaskChips, DetailSections), `shared/*` (Chip, RunStatusPill, StatusTone, CardRow, Unavailable, PickerPopover) and the nine `Modal.create` callers.
- `FileIconColorScheme` (F10) needs the renderer's theme store (`theme.ts`). The file-manager renders FileIcon too, so provide it above both.
- Status tone logic now spans `shared/runStatus.ts` (`RUN_STATUS_VIEW`), `features/tasks/status.tsx` and three CSS tone maps. With F2 the CSS map moves to the DS. The data mapping (status to tone) stays app-side, maybe in `@clowdy/protocol` next to `shownRunStatus`.
- `apps/desktop/AGENTS.md` repeats DS rules (Loader sizes, ContentColumn, the subpath rule). Keep the authoritative copy in `packages/components/AGENTS.md` and link to it from there.

## Not inspected / limits

- No visual or runtime check. The a11y conclusions come from markup and React Aria source, not from a screen reader. The perf cost of F9 is inferred from React's ref semantics, not measured.
- Not reviewed internally: RichInput (778 lines), MarkdownEditor, CodeHighlighter, SortableList internals beyond the sensors, useStickToBottom, Scrollable and useScrollChrome internals, the Select/ListBox virtualisation.
- Usage counts come from parsing named imports of `@clowdy/components*` in `apps/desktop/src/renderer` and `packages/file-manager/src`, excluding tests. Dead-code claims were also checked with word-boundary greps over all of `apps/` and `packages/` (callers, tests, dynamic imports, string references). Re-check once more before deleting.
- `apps/desktop/AGENTS.md` was only grepped for DS topics. The file-manager's own UI was counted, not reviewed.
- The icons build script (`packages/icons/scripts/build.js`) and the Figma sync were not reviewed beyond the registry output.

# Renderer UI quality: Settings, Changes, hotkeys, and a renderer-wide CSS audit

Paths are relative to `apps/desktop/src/renderer/` unless they start with `packages/` or `apps/`.

## Summary

The Settings and Changes features work and are well commented, but both build their own UI kits next to the design system. Settings has a parallel settings kit (`SettingsCard`, `SettingsRow`, `SettingsBlock`, `SettingsSection`, `SettingsPage`, `SettingsEmpty`, 96 usages) while `SettingsField` in `packages/components` has no consumer at all and `Card` is used once in the whole renderer. Settings also re-implements its own `SettingsRow` four more times inside the providers and skills pages.

Changes repeats the same pieces across files. The changed-file row (kind glyph, start-truncated path, `+N −M` counts) is drawn in DiffCard, CommitBox and LastRunPlate. The split button is built three times with 21 specificity overrides of Button internals. The row context menu is copy-pasted, and the two copies have drifted. BranchMergeDialog (643 lines, 11 `useState`) and CommitBox (607 lines) hold orchestration and 30+ derived labels inside the component.

The CSS is mostly tokenized: 7 raw hex colors, all in mask gradients, and 59 squircle radii done right. The problems are structural. Box is used 27 times against 188 layout-only flex rules. There are 5 focus-ring recipes, two of them on CSS variables that do not exist (a confirmed visual defect), a float shadow that is not a token, 45 raw durations, 21 raw opacities, and CSS modules shared across components and features.

Dead production code: `DiscardButton.tsx` and `discardFocus.ts` are kept alive only by a test harness, and three `gitSummary` helpers have no callers. The hotkeys layer is sound. It has only nits.

## Findings

### F1. One changed-file row, drawn three times (glyph, path, line counts)
- Where:
  - Kind glyph: `features/changes/DiffCard.tsx:195-204`, `features/changes/CommitBox.tsx:136-138`, `features/chats/LastRunPlate.tsx:46-50`. Identical CSS: `features/changes/DiffCard.module.css:74-80` (`.kind`), `features/changes/CommitBox.module.css:84-90` (`.glyph`), `features/chats/LastRunPlate.module.css:15-21` (`.glyph`).
  - Start-truncated path (`dir="rtl"` + `<bdi>`, folder dimmed, name strong): `features/changes/DiffCard.tsx:39-50` and `features/chats/LastRunPlate.tsx:19-34` (the comment says it copies the cards). A third variant is in `features/changes/CommitBox.tsx:135-146`.
  - `+N −M` counts in success/danger: `features/changes/DiffCard.tsx:27-36`, `features/changes/CommitBox.tsx:125-130`, `features/chats/LastRunPlate.tsx:53-62`, `features/changes/ChangesToolbar.tsx:50-57`, `stream/ToolCard.tsx:95-99`. CSS `.counts`: `DiffCard.module.css:109-116`, `CommitBox.module.css:102-107`, `LastRunPlate.module.css:8-13`.
- Problem (observed): one visual, five hand-copied renderings. They already differ in size, in the gap token (`--spacing-4` against `--spacing-xs`) and in a11y: LastRunPlate hides the counts with `aria-hidden`, while DiffCard gives them an `aria-label`. A change to the minus sign or the colors has to be made in five places.
- Fix: add `features/changes/ChangedFileParts.tsx` (move it to `shared/` if the chat and the stream keep using it) with three pieces. `<ChangeKindGlyph kind size />` reads `CHANGE_KIND_VIEW`. `<FilePathLabel path size slot? />` is the rtl/bdi start-cut path. `<LineCounts additions deletions size hidden? />`. Use them in DiffCard, CommitFileRow, LastRunPlate Row, the ChangesToolbar Summary and ToolCard. Delete the three `.kind`/`.glyph` blocks and the `.counts` blocks.
- Category: reuse
- Effort: S. Risk: low

### F2. Two CSS variables that do not exist, with visible effects
- Where: `--color-secondary-text`: `features/changes/BranchPullRequestList.module.css:13`, `features/settings/projects/ProjectDetail.module.css:69`. `--color-focus-ring` (with a `currentcolor` fallback): `features/settings/projects/ProjectDetail.module.css:42,83`, `shell/FolderList.module.css:80`, `shared/CardRow.module.css:44`, `features/worktrees/ManageWorktrees.module.css:140`. A script that collected every custom property defined in `packages/styles`, `packages/components`, `packages/file-manager` and the renderer found neither. The only other undefined property, `--streamdown-font-factor`, is an intentional opt-in with a fallback.
- Problem (observed): `color: var(--color-secondary-text)` is invalid at computed-value time, so `color` falls back to inherit. App CSS is not layered, so it beats `@layer components`. The result: the "Archived PR" `Button` (`BranchPullRequestList.tsx:59-68`) and the icon-reset button take their parent's text color instead of the secondary color. The focus outlines are a 2px text-colored line instead of DESIGN.md's 4px Terracotta-muted ring. The focus-ring half is also reported in `ui-tasks-agents-panels.md` F6.
- Fix: replace `--color-secondary-text` with `--color-secondary-muted-text`. Replace the focus outlines with the shared ring from F9.
- Category: correctness
- Effort: S. Risk: low

### F3. Dead production code kept alive by tests
- Where:
  - `features/changes/DiscardButton.tsx` (54 lines) and `features/changes/discardFocus.ts` (80 lines). Their only consumer is `features/changes/DiscardChanges.test.tsx:26,83`, which portals the button into the cards as "the retained discard trigger in the test harness" (`:363`). The same file asserts that production "does not offer discard on diff cards" (`:238`). The focus tests (`:746-785`) cover behavior that only this test-only button has.
  - `features/changes/gitSummary.ts:47-52`: `hasBranchFiles`, `additionsWords`, `deletionsWords` have zero references in the repo. `aheadBehindWords` (`gitSummary.ts:14`), `commitOfScope` (`changeScopes.ts:85`) and `filterChanged` (`changeFilter.ts:113`) are referenced only by their tests.
  - Exported without importers: `headName` (`features/changes/ChangesSidebar.tsx:27`), `FILTER_PLACEHOLDER` (`features/changes/ChangesToolbar.tsx:22`).
  - Unused CSS classes (renderer-wide scan of `styles.x` references against every module): `features/agents/Screen.module.css:16` `.empty`, `features/agents/ChatFolder.module.css:31` `.checkout`, `features/worktrees/ManageWorktrees.module.css:10,23` `.heading`, `.notice`.
- Problem (observed): about 140 lines of production code, plus test scaffolding that portals UI into production components, maintain a feature the product removed. Readers of `DiscardChanges.test.tsx` cannot tell what ships.
- Fix: delete `DiscardButton.tsx` and `discardFocus.ts`, and drop the "retained discard trigger" and "focus after a discard" describes, or rewrite them against the checklist's menu, which is the real path. Delete the three unreferenced helpers. Inline `filterChanged` into its test or delete it. Delete `aheadBehindWords` and `commitOfScope` with their tests unless a caller is planned. Un-export `headName` and `FILTER_PLACEHOLDER`. Delete the four CSS classes.
- Category: dead-code
- Effort: S. Risk: low

### F4. Settings ships a parallel settings kit; the design system's `SettingsField` has no consumer
- Where:
  - App kit: `features/settings/ui/SettingsCard.tsx` and `.module.css:7-18` (a bordered plate on `--color-surface-float` with `radius-xl` squircle, which is `Card variant="bordered"` with another surface), `ui/SettingsRow.tsx:21-46` (label, description and a control at the end, which is `SettingsField`/`FormField layout="horizontal"`), `ui/SettingsBlock.tsx`, `ui/SettingsSection.tsx`, `ui/SettingsPage.tsx`, `ui/SettingsEmpty.tsx`. Usage: 29 `SettingsRow`, 21 `SettingsCard`, 22 `SettingsSection`, 13 `SettingsPage`, 8 `SettingsBlock`, 3 `SettingsEmpty`.
  - `packages/components/src/SettingsField/SettingsField.tsx:13-21`: no file outside its own folder references it.
  - The kit is itself re-implemented four times: `features/settings/providers/ProviderSettings.tsx:24-54` (`SettingRow`: the same title/description/Switch markup, and the CSS comment at `ProviderSettings.module.css:12` says "as in a SettingsRow"), `ProviderSettings.tsx:138-145,173-180` (Program and Environment fields), `ProviderSettings.tsx:251-258` (the Permissions header), and `features/settings/skills/SkillsSection.tsx:92-108` ("Enable system skills"). `SettingsRow` cannot be an `li` and always brings its own inset, so these were rebuilt by hand.
  - The control-width rule is repeated: `features/settings/FilesPage.module.css:2-4` and `BranchPrefixRow.module.css:2-5` (`14rem`), `projects/ProjectDetail.module.css:6-11` (`18rem`).
  - `SettingsEmpty.module.css:4` uses `radius-lg` without the squircle factor, against the Squircle Rule.
- Problem (observed): two sources of truth for the settings row. The app kit wins in practice, the design-system one rots, and every new page re-learns which to use. The hand-built rows drift: the gap is `--spacing-xs` in SkillsSection and `--spacing-2` in ProviderSettings.
- Fix: decide on one kit and put it in `packages/components` beside `SettingsLayout`, which already owns `Intro` and `Empty`. Add `SettingsLayout.Section`, `SettingsLayout.Card` (a `Card` with a `surface="float"`/`radius="xl"` option rather than a new plate) and `SettingsLayout.Row`. Split the row's layout (`title`, `description`, `control`, `footer`, `stacked`, `as`) from the card inset, so it works as an `li` and inside a block. Add a `controlWidth` option (or a `--settings-control-width` variable) for the 14rem/18rem rule. Rebase the row on `FormField` and delete `SettingsField`, or delete the app copy. Then replace the four hand-built rows.
- Category: design-system
- Effort: M. Risk: medium (every Settings page re-renders through the new kit; visual check needed)

### F5. The split button is built three times, with 21 overrides of Button internals
- Where: `features/changes/RemoteMenu.tsx:156-200` with `RemoteMenu.module.css:18-64,159-165`; `features/changes/CommitBox.tsx:546-585` with `CommitBox.module.css:117-121,146-174`; `features/changes/BranchMergeDialog.tsx:544-608` with `BranchMergeDialog.module.css:58-88`. Renderer-wide there are 23 `[data-size][data-variant]` selectors, and 21 of them are in `features/changes` (RemoteMenu 6, CommitBox 5, BranchMergeDialog 5, BranchPicker 2, DiffCard 1, CreatePullRequest 1, ChangesToolbar 1).
- Problem (observed): each copy squares inner corners, lets the label wrap, stretches the height, and raises specificity to beat `@layer components`. Any internal change to `Button` (attribute names, padding variables) silently breaks them. They already disagree: `RemoteMenu.module.css:17` says it matches "the commit box's Commit and its menu", but CommitBox uses a `--spacing-sm` gap with round corners, while the other two use `--spacing-2` and squared joins. RemoteMenu also overrides the disabled opacity to 0.7 (`:53-55`).
- Fix: add `SplitButton` to `packages/components`. Props: main `children`/`onPress`, `color`, `size`, `isDisabled`, `isPending`, `wrap` (a multi-line label, which also belongs on `Button`), `menu` (the `Menu` content), `menuLabel`, `isMenuDisabled`, `menuPlacement`, `menuWidth`. Rebuild the three on it, delete the `[data-size][data-variant]` blocks, and keep "disabled but readable" as an `Unavailable` concern or a documented `--clowdy-button-opacity--disabled` hook.
- Category: design-system
- Effort: M. Risk: medium (visual, three main actions)

### F6. The row context menu (right-click, ContextMenu key, Shift+F10) is copy-pasted and has drifted
- Where: `features/changes/CommitBox.tsx:168-220` (`CommitFileList`), `features/changes/BranchList.tsx:47-107`. `features/changes/DiffCard.tsx:128,183` uses only `contextMenu.areaProps` (right-click, no keyboard).
- Problem (observed): the same 40 lines (find the row by `data-key`, check it is known, store the key, `openAt(rect.left, rect.bottom)`, close on unmount) appear twice. BranchList resolves `aria-activedescendant` (`:70-72`) and CommitBox does not, so the keyboard path differs between two lists of the same panel. The DiffCard header has no keyboard way to its menu.
- Fix: add `useRowContextMenu({ rowSelector, isKnown })` to `packages/components/src/Popover/` next to `useContextMenu`. It returns `{ areaProps: { onContextMenu, onKeyDown }, key, isOpen, popoverProps, close }` and handles `aria-activedescendant`. Use it in both lists, and its keyboard half in the DiffCard header.
- Category: reuse
- Effort: S. Risk: low

### F7. "Edit and save on blur" text fields, written three times in Settings
- Where: `features/settings/BranchPrefixRow.tsx:17-51`, `features/settings/projects/ProjectDetail.tsx:60-97` (`NameRow`), `features/settings/providers/ProviderSettings.tsx:103-159` (Program path). `features/tasks/EditableText.tsx` already implements the contract: draft, commit on blur, Escape reverts, outside change shows.
- Problem (observed): each copy keeps a `draft` in state, clears it when the saved value matches, blurs on Enter and commits on blur. They differ: Escape is handled in 2 of 3, and the target is `event.target as HTMLInputElement` in 2 places and `event.currentTarget` in the third. BranchPrefixRow writes every keystroke to the store, even invalid ones, and relies on the store to ignore them.
- Fix: add a `useDraftValue({ value, commit, validate })` hook (or a `CommitInput` wrapper over `Input`) to `shared/`. It should return `{ value, onChange, onBlur, onKeyDown, problem }`. Port the three rows and `EditableText` to it.
- Category: reuse
- Effort: S. Risk: low

### F8. Async read, loading and failed states are re-invented per page
- Where:
  - `let current = true` effect boilerplate: `features/settings/AboutPage.tsx:154-177,186-197`, `SleepSettings.tsx:25-38`, `projects/FolderWorkspaceDialog.tsx:153-166`, `skills/useSkills.ts:24-37`, `features/changes/BranchMergeDialog.tsx:248-311`. There are 14 copies renderer-wide (`rg "let (current|cancelled|active|stale) ="`).
  - Identical loading and failed screens: `features/settings/providers/ProvidersPage.tsx:40-62` and `features/settings/skills/SkillsSection.tsx:33-55`.
  - `Loader size="xs"` plus a `Text` line, hand-built 7 times (`ProvidersPage.tsx:44`, `SkillsSection.tsx:37`, `shell/Shell.tsx:96`, `tasks/ArchiveView.tsx:85`, `tasks/CommentsSection.tsx:105`, `tasks/OpeningTask.tsx:49`, `chats/ConversationView.tsx:152`), while `PanelLoadingState` (`packages/components/src/Panel/PanelStates.tsx:25-32`) hardcodes the word "Loading".
  - Visibility-gated polling repeated: `ProvidersPage.tsx:29-38`, `projects/useProjectsInfo.ts:101-133`.
- Problem (observed): every page re-decides stale-answer guarding, error text extraction (`error instanceof Error ? error.message : String(error)`) and the retry UI. SleepSettings never resets `error` on success. The pattern also overlaps `renderer-state.md` F9 and `ui-tasks-agents-panels.md` F18.
- Fix: add `useAsync(load, deps)` returning `{ status, value, error, reload }` (renderer `shared/` or `packages/lib`), plus `useVisibleInterval(fn, ms)`. Give `PanelLoadingState` a `label` prop and use `PanelEmptyState` with `action` for the failed state, or `SettingsLayout.Empty` inside Settings.
- Category: reuse
- Effort: M. Risk: low

### F9. Focus rings: 5 recipes in 21 declarations
- Where: DESIGN.md ring (4px `--color-primary-muted-border`): `stream/ThreadCards.module.css:117`, `features/chats/ComposerBanner.module.css:198`, `features/chats/ModelPicker.module.css:260`, and as box-shadow `features/tasks/TaskCard.module.css:81`, `TaskChips.module.css:37`. 2px muted: 8 places in `features/tasks/*` and `features/chats/ComposerQueue.module.css:31`. 2px `currentcolor` through the undefined variable: the 5 places in F2. 1px primary: `features/tasks/ArchiveView.module.css:89`, `TaskList.module.css:114`. 1px text: `stream/TurnRail.module.css:44`.
- Problem (observed): the ring a keyboard user sees depends on the screen. There is no token or ruleset, so each author picks a value. Also reported for tasks in `ui-tasks-agents-panels.md` F6. This entry gives the renderer-wide count.
- Fix: add `--focus-ring-width`/`--focus-ring-color` and a `@ruleset focus-ring` to `packages/styles` (the Button's recipe), and replace all 21. Most raw `<button>`s that need it (30 renderer-wide, 2 in scope at `projects/ProjectDetail.tsx:141,151`) should become `Button`, which also removes their CSS. `ButtonUpload` exists for the icon picker's file input (`ProjectDetail.tsx:126-149`).
- Category: design-system
- Effort: S. Risk: low

### F10. Hand-made badges, pills and icon counts beside `Badge`
- Where: `features/settings/providers/ProviderSettings.tsx:274-276` with `ProviderSettings.module.css:92-100` (the "Default" pill); `features/changes/CommitCountBadge.tsx` with `.module.css` (arrow and count in a pill); `features/changes/RemoteMenu.tsx:36-56` with `RemoteMenu.module.css:131-146` (the same arrow and count without a pill, in the same feature, rendered next to `CommitCountBadge` at `RemoteMenu.tsx:178-180`); `features/changes/PullRequestChip.tsx:27-41` (icon and count).
- Problem (observed): `Badge` from `@clowdy/components/Tag` is already used in 5 renderer files, `Account.tsx:103` among them. Ahead/behind counts have two renderers inside Changes, so the same number looks different in the button and in its menu.
- Fix: use `<Badge size="xs">` for "Default". Add one `IconCount` (`icon`, `count`, `tone`, `pill`) in `features/changes/`, or in `packages/components` if the tasks chips adopt it, and use it for CommitCountBadge, RemoteMenu `Counts` and PullRequestChip.
- Category: design-system
- Effort: S. Risk: low

### F11. The theme picker hand-rolls a toggle button on a card
- Where: `features/settings/AppearancePage.tsx:72-122`.
- Problem (observed): a `Card` div with `role="button"`, `aria-pressed`, `tabIndex`, a manual Enter/Space `onKeyDown`, and a `data-active` that duplicates the one `Card` sets. Light, Dark and System exclude each other, so assistive tech should hear a radio group, and arrow keys should move. Three tab stops each announce "toggle button, pressed". The theme lives in module state (`theme.ts`) that `useState(getTheme)` copies once.
- Fix: use `RadioGroup`/`Radio` with the card as the radio's content (the pattern `PermissionPresets` and `NewBranchForm` already use), or RAC `ToggleButtonGroup` with single selection. Drop the manual key handling. Make the theme an observable preference (see `renderer-state.md` F13) so the picker reads it directly.
- Category: design-system
- Effort: S. Risk: low

### F12. `FormField` breaks with `Textarea`, so a dialog builds fields by hand
- Where: the workaround is at `features/settings/projects/FolderWorkspaceDialog.tsx:249-292` (comment at `:249`) and `FolderWorkspaceDialog.module.css:24-34`. The cause is at `packages/components/src/FormField/FormField.tsx:189-208`, where `TextAreaContext` gets `fieldProps` with `isDisabled`/`isInvalid`.
- Problem (inferred from code; not rendered): RAC's `TextArea` is a plain `<textarea>` that spreads its context props, so `isDisabled`/`isInvalid` reach the DOM and React warns, as the comment says. Two fields in the same dialog are therefore hand-built with their own ids, label, hint and gap, and they differ from the `FormField`s above them.
- Fix: in `FormField`, give `TextAreaContext` DOM-safe props (`id`, `disabled`, `aria-invalid`, `aria-describedby`), or rely on `SlotContext`, which `Textarea` already reads (`Textarea.tsx:49`). Then use `FormField` for Files to copy and Command, and delete `.field`/`.copy`.
- Category: design-system
- Effort: S. Risk: low

### F13. Dialog body and header rebuilt in every `Modal.create` dialog; BranchMergeDialog rebuilds the chrome
- Where: the body shell `.form { flex column; gap xxl; padding 20 }` is identical in `features/settings/projects/FolderWorkspaceDialog.module.css:3-8`, `shell/AddProjectForm.module.css:1`, `shell/CloneRepositoryForm.module.css:1`, `features/tasks/CreateTaskDialog.module.css:1` and `features/worktrees/ManageWorktrees.module.css:1`. A variant is in `features/changes/BranchMergeDialog.module.css:8-12`. The `heading-3` plus description header is in 8 dialogs (`rg 'variant="heading-3"'` in files with `Modal.create`), and none passes `Modal`'s `title`. BranchMergeDialog draws its own `role="dialog"`, `aria-modal`, Escape handler and absolutely positioned close button (`BranchMergeDialog.tsx:456-488`, `.module.css:19-23`), and opens with `closeButton: false, closeOnEscape: false` (`:163-174`). It does this because `Modal` cannot be made non-dismissible while it works. `RemoveWorktreeDialog` does the same.
- Problem (observed): eight copies of the dialog rhythm, and two copies of the dismissal chrome, inside an element the Modal already marks as a dialog: a nested `role="dialog"`.
- Fix: add `ModalBody` (or `DialogLayout`: `title`, `description`, `children`, `actions`) to `packages/components/src/Modal`. Add a way to block dismissal from inside, such as `useModalContext().setDismissable(false)` or a reactive `isDismissable`, so the Modal's own close button and Escape are disabled while a merge runs. Then delete the local chrome and the `.form`/`.heading` blocks.
- Category: design-system
- Effort: M. Risk: medium

### F14. Hand-made plates beside `Card`, and a float shadow that is not a token
- Where:
  - In-flow plates: `Card` is used once in the renderer (`features/settings/AppearancePage.tsx:85`), and about 12 modules re-declare a plate (background, radius, padding and border). In scope: `features/settings/ui/SettingsCard.module.css:7-18`, `providers/Account.module.css:13-24` (the sign-in panel is exactly `Card variant="filled"`), and `features/changes/BranchMergeDialog.module.css:31-38` (a filled plate with `radius-md` and no squircle factor, against the Squircle Rule). Elsewhere: `stream/ApprovalCard`, `stream/QuestionCard`, `features/tasks/TaskCard`, `features/agents/StarCard`, `features/chats/ReplyCard`, `features/worktrees/ManageWorktrees.module.css:98`.
  - Floats: the shadow `0 16px 32px dark-a10` (dark `black-a50`) is copied in `stream/SelectionReply.module.css:14,20`, `features/terminal/TerminalTab.module.css:57,62` and `packages/file-manager/src/react/editor/selectionAction.module.css:7,12`. Other floats use `--shadow-md` (`hotkeys/ChordHud.module.css:25`, `shell/FindBar.module.css:18`, `shell/SyncBanner.module.css:19`) or `--shadow-xl` (`shared/SlidingCard.module.css:15`), though DESIGN.md names xl as the float lift.
- Problem (observed): plate radius, padding and hover rules drift per file. A dark-mode shadow fix has to touch three packages.
- Fix: use `Card` for in-flow plates, adding a float surface option if Settings needs one (see F4). Add `--shadow-float` with its `.dark` remap to `packages/styles/src/tokens/styles/shadows.css`, or decide that floats use `--modal-box-shadow`, and use it in all six floats.
- Category: design-system
- Effort: M. Risk: low

### F15. BranchMergeDialog and CommitBox keep their state machine and view logic inside the component
- Where: `features/changes/BranchMergeDialog.tsx:176-643` (11 `useState`, a `previewRound` ref, an `active` flag, and fetch, preview, merge, sync and abort orchestration in `compare`, `load` and `run` at `:216-411`). `features/changes/CommitBox.tsx:340-433` (about 30 derived values: `heading`, `count`, `label`, `reason`, `commitAndSync`, `truncationNotice`…). `features/changes/ChangesSidebar.tsx:51-95` mixes branch and PR derivation with three store-writing effects.
- Problem (observed): the feature's other flows are MobX models with unit tests (`CommitDraft`, `RemoteActions`, `BranchSwitch`, `PlaceChanges`). The merge dialog's rules (strategy re-preview, auto-sync after a merge, conflicts) can only be tested by rendering. CommitBox's label rules are spread through render code that is hard to read or test. Perf (inferred): `draft.message` is read in CommitBox's own render (`:489`), so every keystroke re-renders the whole box, rebuilds `names = files.map(...).join('\0')` (`:353`) and, during a merge, `mergeChecklist` creates new arrays, which also re-renders the memoized `CommitFileList`.
- Fix: extract a `BranchMerge` model (like `BranchSwitch`) with `load`, `pick`, `setStrategy`, `merge`, `sync` and `abort`, plus a pure `mergeTitle`/`mergeStatus` view, and test it like `BranchSwitch.test.ts`. For CommitBox, move the derived labels into `CommitDraft` getters or a pure `commitBoxView(draft, status, shiftHeld)`, and move the message `Textarea` into a `CommitMessageField` component so typing re-renders only that component. Pull ChangesSidebar's derivation into a pure `sidebarView(facts, git, history)`.
- Category: structure
- Effort: L. Risk: medium

### F16. Each changed-file card and each diff runs its own IntersectionObserver
- Where: `features/changes/useNearViewport.ts:32-66` (one observer per `DiffCard`), `packages/file-manager/src/react/diff/DiffView.tsx:103-113` (another per open `DiffView` with `lazy`), and `features/changes/ChangesList.tsx:104-114`. Both use an 800px margin.
- Problem (inferred, not measured): a scope lists up to `MAX_GIT_CHANGED_FILES = 500` (`packages/protocol/src/git.ts:167`), which means up to 500 observers for the cards plus one per open diff. Each callback does a `setState`. The card already knows when it is near, and DiffView asks the same question again.
- Fix: one observer per scroll root. `ChangesList` provides a small `NearObserver` context (`observe(element, callback)`), and `useNearViewport` subscribes to it. Give `DiffView` a `visible`/`near` prop so the card drives it and DiffView skips its own observer. Measure with 500 files before and after.
- Category: perf
- Effort: M. Risk: medium

### F17. Renderer CSS bypasses Box and Text; proposed styling rule
- Where (renderer-wide counts):
  - Box: 27 `<Box>` against 239 `<div className={styles.*}>`. 188 CSS rules contain only flex layout (display, direction, gap, align, padding) in 77 modules. Worst: `features/changes/BranchPicker.module.css` (10), `features/worktrees/ManageWorktrees.module.css` (9), `features/settings/providers/ProviderSettings.module.css` (8), `shell/CloneRepositoryForm.module.css` (6), `features/changes/CommitBox.module.css` (5), `features/settings/projects/FolderWorkspaceDialog.module.css` (5). The most repeated bodies: `flex; column; gap md` (9 files), `flex; align center; gap md` (9), `flex; column; gap sm` (7), `flex; align center; gap md; min-width 0` (8).
  - Text: 26 hand-written ellipsis triplets (overflow, text-overflow, white-space) against `Text truncate`, for example `features/changes/DiffCard.module.css:96-103`. 10 bare `font-size: var(--text-*)` without the typography ruleset, which gives the wrong line height (`features/changes/CommitCountBadge.module.css:11`, `PullRequestChip.module.css:52`, `RemoteMenu.module.css:143`, `CommitBox.module.css:164`, `DiffCard.module.css:159`, `stream/QuestionPanel.module.css:63`, …). 4 spacing tokens used as font sizes (`features/sidePanel/SidePanelSizes.module.css:16,27,79`, `shared/RailItem.module.css:50`).
  - Visually-hidden copied 3 times in scope (`features/changes/BranchMergeDialog.module.css:52-59`, `features/worktrees/ManageWorktrees.module.css:71`, `features/chats/ConversationHeader.module.css:55`). Also in `ui-tasks-agents-panels.md` F20.
  - UnoCSS is loaded (`styles.ts:4`, `vite.config.ts:67-70`), but the renderer uses it for exactly two classes (`className="select-text"` at `features/changes/BranchMergeDialog.tsx:153`, `features/worktrees/CreateWorktreeDialog.tsx:121`), while `Text select="text"` exists and is used in `CommitBox.tsx:51`. Static inline styles: `stream/WorkingLine.tsx:21` (`cursor: 'default'`), `shared/SidebarLayout.tsx:60` (`overflow: 'clip'`). The other 22 `style={}` are runtime values, which is fine.
- Problem (observed): there is no written rule. Each file mixes CSS modules for layout, `Text` or rulesets for type (or neither), and one-off utilities. Layout lives in two places (JSX and CSS), and the repeated flex blocks are the main source of drift.
- Fix: adopt and document this rule in `apps/desktop/AGENTS.md` ("The renderer"):
  1. Layout through `Box` props. A CSS module only for what Box cannot say: grid templates, container queries, sticky, `:has`, and state attributes.
  2. Type through `<Text variant>`. In CSS only `@ruleset typography-*`, never a bare `font-size`, never a spacing token as a size.
  3. Surfaces through `Card`/`Popover` and the float token (F14). No hand-made plates.
  4. A design-system component is changed through its props, variants or documented `--clowdy-*` hooks, never through `[data-size][data-variant]` specificity (F5).
  5. Inline `style` only for runtime values (percentages, custom properties from data).
  6. Either drop UnoCSS from the renderer (`virtual:uno.css`, the Vite plugin) or allow it only for single-property utilities with no component prop. Either way, replace the two `select-text`.
  7. Re-export react-aria's `VisuallyHidden` from `@clowdy/components` and delete the copies.
  8. The squircle pair (`border-radius: calc(var(--radius-X) * var(--squircle-radius-factor)); corner-shape: …`, 59 copies in the renderer and 60 in components) becomes `@ruleset squircle-{sm,md,lg,xl}`.
- Category: design-system
- Effort: L across the renderer (S per file as files are touched). Risk: low

### F18. Raw motion, opacity and z-index values
- Where:
  - Durations: 45 raw against 18 token uses. `150ms ease-out` appears about 20 times, among them `features/settings/AppearancePage.module.css:17`, `features/settings/skills/SkillRow.module.css:15` and `shared/Chip.module.css:21`. `300ms ease-out` on the three progress bars (`features/settings/providers/UsageRows.module.css:39`, `shell/CloneRepositoryForm.module.css:133`, `features/chats/ContextRing.module.css:91`), plus `features/settings/AppearancePage.module.css:34`. Custom curves: `features/chats/ModelPicker.module.css:108`, `features/agents/AgentList.module.css:40`, `shared/RailItem.module.css:33`. `hotkeys/ChordHud.module.css:26` (`100ms`).
  - `@keyframes spin` re-declared in `features/settings/providers/UsageRows.module.css:72-76`, while `packages/styles/src/animations.css:27` has it.
  - Opacity: 21 raw values while `--opacity-disabled`, `-inactive` and `-hover` exist. The "off but readable" dim is three values in Settings alone: 0.6 (`providers/ProviderCard.module.css:57`, `ProviderSettings.module.css:71`, `UsageRows.module.css:13`) and 0.55 (`skills/SkillRow.module.css:20`). `features/changes/PullRequestChip.module.css:4` already uses `--opacity-inactive`.
  - z-index: 17 raw integers (for example `features/settings/projects/ProjectDetail.module.css:59`, `features/terminal/TerminalTab.module.css:52`, `features/chats/ConversationView.module.css:30`). `shell/FindBar.module.css:5` borrows `--z-confirm` for a non-confirm layer.
- Problem (observed): retuning motion means grepping literals. The disabled and dim states differ by page.
- Fix: map to `--transition-duration-fast|…` and `--ease` (add `--ease-out` to `primitives-motion.css` if the curve must stay). Use the global `spin`. Use `--opacity-inactive` for the off-but-readable dim. Keep small local integers only inside an element with `isolation: isolate`, and give FindBar its own `--z-*` slot. The tasks part is in `ui-tasks-agents-panels.md` F19.
- Category: design-system
- Effort: M. Risk: low

### F19. A progress bar built three times
- Where: `features/settings/providers/UsageRows.tsx:49-63` with `.module.css:27-48`, `shell/CloneRepositoryForm.tsx:430-438` with `.module.css:121-134`, `features/chats/ContextRing.tsx:109-118` with `.module.css:80-92`. The track and fill CSS is byte-identical between UsageRows and CloneRepositoryForm.
- Problem (observed): three `role="progressbar"`/`"meter"` implementations with hand-set ARIA attributes, the same raw `300ms ease-out`, and duplicated reduced-motion rules.
- Fix: add `ProgressBar` (`value`, `max`, `tone`, `label`, `kind: 'progress' | 'meter'`) to `packages/components` on RAC `ProgressBar`/`Meter`, and replace the three.
- Category: design-system
- Effort: S. Risk: low

### F20. CSS modules shared across components and features
- Where: `features/changes/BranchPicker.module.css` is imported by 5 components, one of them in another feature (`features/agents/BranchPickerWithCreate.tsx`). `features/changes/ChangesView.module.css` is imported by `ChangesToolbar.tsx` and `ChangesSidebar.tsx` for `.pickerHeader`. `features/settings/projects/ProjectDetail.module.css` is imported by `ProjectFolders.tsx` for `.value`. `features/worktrees/ManageWorktrees.module.css` is imported by 5 components and carries 2 dead classes (F3).
- Problem (observed): a module with several owners cannot be cleaned safely. Nobody knows which class belongs to whom, and that is how the dead classes in F3 stay.
- Fix: one module per component, next to it. A style two components share is a component (for example a `BranchPickerShell`, or a `PanelHeader` variant for `.pickerHeader`). Add this to the F17 rule.
- Category: structure
- Effort: S. Risk: low

### F21. Explicit `observer()` against the renderer rule
- Where: `features/settings/SourceControlPage.tsx:29`, `SettingsDialog.tsx:12`, `SettingsWindow.tsx:60`, `features/changes/ChangesToolbar.tsx:25`, plus `features/agents/ProjectMenu.tsx:20`, `features/agents/AgentList.tsx:1090`, `features/quickSearch/QuickSearch.tsx:159`.
- Problem (observed): `apps/desktop/AGENTS.md:88` says "No `observer()`": `babel-plugin-observing-components` wraps every component and skips already-wrapped ones (`node_modules/babel-plugin-observing-components/dist/esm/index.js:146-150`). The wrappers are noise and suggest the plugin is optional. Also reported in `ui-tasks-agents-panels.md` F16.
- Fix: remove the wrappers and the `mobx-react-lite` imports.
- Category: simplify
- Effort: S. Risk: low

### F22. The single-choice `ToggleButtonGroup` needs boilerplate at every call
- Where: `features/settings/NewChatChoices.tsx:62-67,92-97`, `features/settings/ChatPage.tsx:47-52`, `features/tasks/TasksHeader.tsx:112-118`. The same `keys === 'all' ? … : [...keys][0]` decoding sits on `Menu`/`Select` in `features/chats/ModelPicker.tsx:516,584`, `features/chats/ModePicker.tsx:39` and `features/agents/ProjectMenu.tsx:72`.
- Problem (observed): each call site turns RAC's `Set<Key>` into one value with its own guards (`typeof next === 'string'`, `next !== engine`). ChatPage uses `CHOICES.find(...)`, the others take `[...keys][0]`.
- Fix: add single-selection `value` and `onValueChange(key)` props to `ToggleButtonGroup` (and optionally to `Menu` with `selectionMode="single"`) in `packages/components`, and simplify the call sites.
- Category: design-system
- Effort: S. Risk: low

### F23. Small correctness items in scope
- Where and problem (observed):
  - `features/changes/NewBranchForm.tsx:97,103`: a hardcoded `id="new-branch-start"` for `aria-labelledby`. The form is rendered by both `features/changes/BranchPicker.tsx:103` and `features/agents/BranchPickerWithCreate.tsx:45`, so two mounted forms share one id. Use `useId()`, as the rest of the codebase does.
  - `features/changes/ChangesView.tsx:43`: the focus is restored with `document.querySelector('[data-sidebar-toggle]')`, a page-wide query. Use a ref passed to the toggle.
  - `features/settings/providers/InlineCode.tsx:5-18`: with an odd number of backticks the last part is shown as plain text, but its opening backtick is dropped: the text "Run" followed by a lone backtick and "foo" renders as "Run foo".
  - `features/settings/ChatPage.tsx:22`: the description hardcodes `'⌘ Enter' : 'Ctrl+Enter'`. The key names should come from the hotkeys formatter (`hotkeysToSymbols` or a `Hotkey` inline), so they follow the platform names used everywhere else.
  - `features/settings/ShortcutsPage.tsx:19-20`: `useMemo(..., [order])`, where `order` is a string the callback never reads, only there to bust the memo. `shortcutEntries()` builds a full registry each time. Make it a MobX `computed` keyed by `panelOrder.order`, or memoize on the order array itself.
- Fix: as above.
- Category: correctness
- Effort: S. Risk: low

### F24. Hotkeys: sound, one perf nit
- Where: `hotkeys/dispatcher.ts:153-181,227`.
- Problem (observed): the layer is clean. Registry, dispatcher, scopes, a keymap test that checks for collisions, and no dead exports (scan over `hotkeys/*.ts`). The one nit: every keydown, including each character typed in the composer, builds a candidate for every sequence of every command (`starts()`) and runs `matchKeybindingPress` on each, before the text-target check that drops nearly all of them. `isOverlayOpen` also runs a `document.querySelector` per keydown.
- Fix: compute `isTextTarget` and `isOverlayOpen` once per event, before building candidates, and pre-filter entries by `inInputs`/`inOverlays`. Optionally index entries by the key of their first press.
- Category: perf
- Effort: S. Risk: low

## Cross-area notes

- **`packages/components`, new or extended:**
  - Settings kit in `SettingsLayout` (`Section`, `Card`, `Row` with an `as` prop and no forced inset), deleting the unused `SettingsField` or rebasing on it (F4)
  - `SplitButton`, and a `wrap` prop on `Button` (F5)
  - `useRowContextMenu` next to `useContextMenu` (F6)
  - A `label` prop on `PanelLoadingState` (F8)
  - `ModalBody`/`DialogLayout`, and a way to block dismissal from inside a Modal (F13)
  - A float surface option on `Card` (F14)
  - `ProgressBar`/`Meter` (F19)
  - A `VisuallyHidden` re-export (F17)
  - Single-value `value`/`onValueChange` on `ToggleButtonGroup` (F22)
  - The `TextAreaContext` prop leak fix in `FormField` (F12)
- **`packages/styles`:**
  - A focus-ring token and ruleset (F9)
  - `--shadow-float` with a dark remap (F14)
  - `@ruleset squircle-{sm,md,lg,xl}` (F17)
  - An optional `--ease-out` (F18)
- **`packages/file-manager`:** a `visible`/`near` prop on `DiffView` so the Changes list drives it (F16). `selectionAction.module.css` should take the shared float shadow token (F14).
- **`packages/lib` or renderer `shared/`:** `useAsync` and `useVisibleInterval` (F8), and `useDraftValue` (F7), which `features/tasks/EditableText.tsx` should also adopt.
- **Docs:** add the styling rule (F17 and F20) to the "The renderer" section of `apps/desktop/AGENTS.md`, and point `packages/components/AGENTS.md` at `SettingsLayout` as the only settings kit.
- **Overlap with sibling pages:** focus rings (`ui-tasks-agents-panels.md` F6), `observer()` (F16 there), async hooks (F18 there, and `renderer-state.md` F9), visually-hidden (F20 there), CSS token bypass in tasks (F19 there) and the "Add to chat" float (F14 there) overlap F9, F21, F8, F17, F18 and F14 here. Here they are counted renderer-wide, and the coordinator should merge them.

## Not inspected / limits

- The app was not run and no test suite was run. Visual effects of F2 and F11 are reasoned from CSS and ARIA semantics. The F12 cause and the perf claims in F15 and F16 come from reading the code, not from measurement or a React warning seen at run time.
- Read in full: the Settings UI kit, every Settings page, and the providers, skills and projects views. In Changes: DiffCard, ChangesList, ChangesView, ChangesToolbar, CommitBox, BranchMergeDialog, BranchPicker, NewBranchForm, PullRequestChip and DiscardButton. All of the hotkeys layer. The model and logic files of Changes (`gitFacts.ts`, `branchPullRequests.ts`, `PlaceChanges.ts`, `CommitDraft.ts`, `RemoteActions.ts`, `BranchSwitch.ts`, `changesActions.ts`, `fileSides.ts`, `viewedMarks.ts`) were only skimmed for the APIs the views use. Their logic was not reviewed.
- The CSS audit is script-based across all 158 renderer CSS files: raw values, duplicate rule bodies, undefined custom properties, unused classes, shared modules. Outside Settings and Changes, findings are counted and located but not reviewed in context. `features/settings/ThemePreview.module.css` (33 raw px) and `stream/markdown/markdown.css` (raw line heights) were treated as intentional exceptions: a miniature drawing and markdown typography.
- `apps/desktop/AGENTS.md` was read only through grep of "The renderer" section.

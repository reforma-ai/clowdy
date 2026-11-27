# @clowdy/components

Clowdy's design system: React components on React Aria Components, styled with `@clowdy/styles` tokens. Forked from Reforma; the fork is Clowdy's own (`NOTICE`), so unused parts are deleted, not kept for parity.

## Rules

- **Import by subpath only:** `import { Button } from '@clowdy/components/Button'`. Each folder under `src/` with an `index.ts` is a subpath (`./*` in `package.json`), the lowercase `hooks`, `modals` and `codeLanguages` too; `utils` has none and is internal. Never import the root `@clowdy/components`: its barrel pulls TipTap, Shiki and Lottie into the bundle.
- **Extend, do not parallel.** A pattern the app repeats becomes a prop or a component here; an existing component gets the option (`PanelEmptyState` got `label`) instead of a second component beside it.
- **CSS modules** wrap their rules in `@layer components` (app CSS stays unlayered, so it wins). Use tokens only: no raw colours, durations, z-index or shadows. Type through `@ruleset typography-*`, the focus ring through `@ruleset focus-ring`, screen-reader text through `@ruleset visually-hidden` (all need `@reference '@clowdy/styles/rulesets'`). Radii are squircles: `calc(var(--radius-X) * var(--squircle-radius-factor))` with `corner-shape: superellipse(var(--squircle-value))`.
- **Customise a component through its props or its documented `--clowdy-*` variables**, never by out-ranking `[data-size][data-variant]` selectors from outside.
- **Hidden focusable inputs and nested scrolling:** React Aria places its real checkbox, radio and switch input in an absolutely positioned visually hidden wrapper. Anchor the wrapper to the visible control (`position: relative` on the control root). Otherwise the input can be laid out outside an inner scrollport, and focusing it scrolls an outer ancestor far past its visible content, leaving a blank dialog without an error. `Scrollable`'s chrome wrapper uses `overflow: clip`, not `hidden`, so only the actual scrollport can scroll on focus. Check with real Chromium after scrolling a long nested list, since happy-dom has no layout.
- **Refs:** merge refs with `useMergedRef` (`hooks/useMergedRef.ts`), not `mergeRefs(...)` in render, so a callback ref keeps its identity.
- **Tests:** Vitest with happy-dom (`// @vitest-environment happy-dom`), `bun run test` here. Test what a caller sees (roles, names, focus, what a press does) through the public component.
- **UI text** that is one phrase has no final period (root `AGENTS.md`).

List row actions (rename, overflow menu) stay hidden until the row is hovered: put `data-show={listBoxItemDataShow.itemHover}` on the control.

## Catalog

Layout and text
- `Box` — flex `div`: `direction` (default column), `align`, `justify`, `gap`, `padding`/`paddingX`/`paddingY`, `wrap`, `fullWidth`, `fullHeight`, `grow`, `equalWidth`, `as`.
- `Text` — typographic span: `variant` (`xl`…`xs`, `heading-1`…`heading-6`, `label`, `code`), `color`, `weight`, `truncate`, `wrap`, `whitespace`, `select`, `as`.
- `Show`, `For` — conditional and list rendering helpers.
- `ContentColumn` — holds content at `--content-width`; put it inside the scroll container.
- `Separator` — divider: `orientation`, `spacing`.
- `Card` — plate on `Box`: `variant` filled|bordered|transparent, `color`, `size`, `hoverable`, `isActive`.
- `Resizable` — `ResizablePanelGroup`, `ResizablePanel`, `ResizableHandle`, `usePanelRef`.
- `Scrollable` — custom scroll chrome; headless `useScrollChrome`, `ScrollChromeRoot`, `ScrollChromeBars`, `elementScrollAxisSource` (see `src/Scrollable/README.md`).
- `Panel` — side panel: `Panel`, `PanelHeader` (`.Actions`, `.Button`), `PanelContent`, `PanelTab`, `PanelEmptyState` (`icon`, `title` or one-line `label`, `description`, `action`, `fill`), `PanelEmptyRow`, `PanelLoadingState` (`label`), `TreeChevron`, `FoldButton` (chevron toggle with `aria-expanded`).
- `TabStrip`, `Tab` — 40px scrolling tab row.
- `SettingsLayout` — the settings window and the only settings kit: `.Sidebar`, `.Content`, `.Pane`, `.Intro`, `.Empty`, `.Page`, `.Section`, `.Card`, `.Block`, `.Row` (labels and describes its control).
- `Slot`, `AsChild`, `Pressable` — slot plumbing and React Aria's press wrapper.

Actions
- `Button` — `variant` filled|filling|ghost|bordered|transparent|inline, `color`, `size` xs|sm|md|lg|unset, `iconOnly`, `rounded`, `tooltip`, `disabledReason` (shown while disabled), `isPending` + `spinnerPlacement`, `href`.
- `SplitButton` — main action plus a menu of related ones (`menu`, `menuLabel`, `wrap`, `fullWidth`).
- `ConfirmButton` — arms on press, then Confirm + cancel.
- `CopyButton` — copies `value`; `copyText`, `copyWithFeedback`, `useCopyFeedback`.
- `ToggleButtonGroup`, `ToggleButtonGroupItem` — segmented control.
- `List` row controls: `RowControls` (stops a row from taking its buttons' events), `RowActionButton` (`icon` + `label`).

Forms
- `Input` (`type` required; `prefix`/`suffix`, `hug`, `autoSelect`, `onSubmit`), `SearchInput`.
- `Textarea` — `autoResize`, `isResizable`, `endAction`.
- `Select` — `items` + `children(item)`, `showSearch`, `isVirtualized`.
- `Checkbox`, `Radio`/`RadioGroup`, `Switch`.
- `FormField` — `.Label`, `.Description`, `.Error` wired to the control.
- `Autocomplete` — search field and list inside a popover; `useAutocompleteEnterAction`.
- `RichInput` — TipTap message box and composer doc helpers.
- `MarkdownEditor` — TipTap markdown file editor.

Lists, menus, overlays
- `List` — `Menu`, `MenuItem`, `MenuTrigger`, `MenuSection`, `MenuSeparator`, `MenuHeader`, `SubmenuTrigger`; `ListBox` family; `GridList` family; `useCellEditMode`, `useListHoverHighlight`, `listBoxItemDataShow`.
- `Popover`, `PopoverTrigger`, `PopoverScroll`; `useContextMenu` (right click, `openAt`), `useRowContextMenu` (rows of a list, ContextMenu key and Shift+F10), `installLongPressContextMenu`.
- `Tooltip`, `TooltipTrigger`, `TooltipContent`.
- `Modal` — `Modal.create(options)`: a dialog named by its title (`useModalTitleId`, `ariaLabel`), Tab held inside while it has a backdrop, `setDismissable(false)` while work runs. `Dialog` is the declarative form; `useModalContext`.
- `modals` — `openFormDialog` (the app's form-dialog defaults), `DialogLayout` (title, description, body, actions), `openConfirmModal` and `ConfirmModalContent` (`isConfirmDisabled`, not dismissible while pending), `confirmDiscardChanges`, `Z_INDEX`.
- `Lightbox` — image preview. `Toast` — `toast.show/.success/.error/.info/.warning`, `toast.progress({title, total})` (persistent progress toast with `update(value)` and `close()`), `ToastRegion`.

Feedback and status
- `Chip` — the chip and pill: `tone` (none, neutral, primary, accent, success, warning, danger), `size` xs|sm, `shape` squircle|pill, `icon`, `tooltip`, `onPress` (a button).
- `Tag` — `TagGroup` and `Tag` for selectable or removable tags; `Badge` is a `Chip` with the tag colour names.
- `Alert` (+ `AlertIcon`, `AlertTitle`, `AlertDescription`, `AlertAction`) — in-page callout.
- `Marker` — inline status or labelled divider.
- `Spinner` (inline wait) and `Loader` (Lottie brand mark for a waiting page, with a line of text; uses `Lottie`).
- `ProgressBar`, `Meter` — 6px bar; `tone`, `--clowdy-progress-fill`.
- `Shimmer`, `ShimmerBlock` — sweeping text and blocks.
- `Hotkey` — key capsules; `hotkeysToSymbols`, `tooltipWithHotkey`, `tooltipWithSequence`.
- `Breadcrumb` — `.Link`, `.Page`.
- `Collapsible` — `CollapsibleTrigger`, `CollapsibleContent`, `CollapsibleMotionContent`, `useCollapsible`.
- `SortableList` — drag to reorder (pointer only).
- `Table` family — React Aria table.
- `DiffStat` — `+N −M`. `PathText` — a path cut at its start.
- `Attachment` — `Attachments`, `Attachment`, `PreviewableAttachment`. `FileIcon` (+ `FileIconColorScheme`, which no one provides yet: icons use their dark variants). `FileDropOverlay`. `Image`.
- `CodeHighlighter` — Shiki block. `codeLanguages` — `codeLanguage`, `codeHighlighter` for CodeMirror.

Hooks (`@clowdy/components/hooks`): `useStickToBottom`, `useFileDrag`, `useFilePaste`, `useClickout`, `useControlledState`.

## Left out of the Reforma copy

Reforma's `chat` and `openui` folders and its Storybook stories were never copied. Its design-tool controls (angle, color, gradient, layout grid, unit inputs, CodeTextarea, Terminal, Avatar, HoverCard and others) were copied and later deleted unused; copy one again from Reforma if a feature needs it.

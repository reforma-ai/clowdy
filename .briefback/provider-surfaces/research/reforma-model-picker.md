# Reforma's model and reasoning picker: what it is and what a port needs

Snapshot 2026-11-18. Research only: no plan, no design. Static reading of two checkouts: Reforma at `/Users/bionic/WORK/Reforma/reforma` (read-only) and Clowdy at `/Users/bionic/WORK/My/@kachurun/clowdy` (`main`, clean tree at the start). Nothing was run: no dev server, no tests, no screenshots, no Reforma git command.

Tags: **[observed]** read in a file (path and line given), **[inferred]** my reading of observed facts, **[unverified]** not checked. Line numbers are Reforma's unless a path says Clowdy. Paths under `apps/front/src/editor/chat/composer/` are shortened to `composer/`.

Words: Reforma calls this the "grade" picker (`ChatComposerGrade*`, `useGradeChat`), a leftover of the old lite/balanced/smart grades. Nothing in Reforma is named `ModelPicker`.

## 1. Where it lives (files and symbols)

### The picker proper

| File | Symbol | Role |
| --- | --- | --- |
| `composer/ChatComposerGrade.tsx` | `ChatComposerGrade` (127-179) | The entry: `PopoverTrigger` + `GradeTrigger` + `FrozenGradePopover` > `GradeWindow`. Also loads provider credentials on mount and hosts the Connect dialog (both to drop). |
| same | `GradeTrigger` (47-86) | The pill in the composer: model glyph, title, muted reasoning level, chevron. A `Button size="sm" variant="filling" rounded`. |
| same | `FrozenGradePopover` (89-125) | `Popover` placement `top`, `width={320}`, `spacing="none"`. Freezes the trigger rect for the whole open time (`getTargetRect`), and does not close on an outside press that lands in a `[role="listbox"]`. |
| same | `GradeWindow` (189-201) | Renders nothing while closed; lazy `ChatComposerGradePanel` in `Suspense` with `GradeWindowFallback` (a `Spinner size="xs"`, 96px box) while the chunk loads. |
| same | `REASONING_LABELS` (39-44) | `none/low/medium/high` to "None/Low/Medium/High". Duplicated in the panel (see section 3). |
| same | `ChatComposerContextUsage`, `UsageRing`, `ContextUsagePanel`, `BUCKET_LABELS` (203-352) | A different control (context-window ring and Compact) that shares the file. Not part of the picker. |
| `composer/ChatComposerGradePanel.tsx` | `ChatComposerGradePanel` (516-612) | The popover body: a two-pane "stage" (face and model list) with an animated height, then the footer card. |
| same | `ModelFace` (306-354) | Pane 1: a big model button (opens the list) over the "Reasoning effort" slider. For a model with no reasoning it shows the model's description instead of the slider (`Show fallback`, 340-343). |
| same | `ReasoningSlider` (198-304) | The effort control: `role="slider"`, a pointer-captured track with one stop per level, a thumb that follows the pointer partway. |
| same | `ModelList` (356-505) | Pane 2: a head row (Back button and "Select model"), a `Scrollable` (max 360px) with a `ListBox` of rows, grouped in `ListBoxSection`s when there is more than one group, plus the hover card. |
| same | `modelOption` (158-189) | One `ListBoxItem`: glyph, title, check on the selected one; pointer-enter reports the row to the hover card; pointer-up picks. |
| same | `progressFromTrackX` (191-196) | Pointer X to 0..1 along the track, accounting for the thumb width. |
| same | `PANE_*`, `HEIGHT_EASE`, `paneTransition` (507-514) | Motion constants for the pane swap. |
| `composer/ModelGlyph.tsx` | `ModelGlyph` (27-51) | The 16px brand mark of a row (returns `null` for `auto`). |
| `composer/ModelStatCard.tsx` + `.module.css` | `ModelStatCard` | Portal hover card beside a row: title, Intelligence Index, description, four 10-segment bars (Intelligence, Speed, Cost, Value). 300ms delay, 270px wide. Pointer-only. |
| `composer/ChatComposerGrade.module.css` | (525 lines) | All styles of the above; line map in section 2. |
| `composer/standaloneGrade.tsx` | `useGradeChat`, `StandaloneGradeChat`, `StandaloneGradeProvider` | The state the picker reads (`model`, `modelReasoning`, `setModel`, `setReasoning`, ...). Falls back to a standalone store when there is no project runtime. |
| `apps/front/src/runtime/chat/ChatRuntime.ts` | `storedModel`, `reasoning`, `selection`, `model`, `modelReasoning`, `setModel`, `setReasoning`, `reconcileStoredModel` (54-135) | The real store (MobX) behind the same interface. |
| `apps/front/src/runtime/chat/chatGrade.ts` | `readStoredChatModel/Reasoning`, `write...`, `selectionForChat`, `chatModelStoragePatch` | `localStorage` persistence (`chat:model`, `chat:reasoning`) and the rules that make a stored choice legal. |
| `packages/constants/src/chat-models.ts` | `CHAT_REASONING_LEVELS`, `ChatModelEntry`, `CHAT_MODELS`, `FAMILIES`, `effectiveChatModel`, `chatModelEffort` | The catalog and the level vocabulary (section 3). |

### Where the trigger is mounted

`composer/ChatComposerInput.tsx` 549-557: inside `<div className={styles.composerMode}>`, after `ChatComposerContextUsage` and before `ChatComposerSendButton` (558). Shown when `!ephemeral && (runtime || standaloneGrade)`. `EditorLayout.tsx:78` warms the lazy panel chunk (`import('@/editor/chat/composer/ChatComposerGradePanel')`). `admin/modals/createProject/CreateProjectPrompt.tsx:300` wraps its composer in `StandaloneGradeProvider`.

### What to leave out (the owner's three exclusions, located)

| Excluded | Where in Reforma (symbols, files, lines) |
| --- | --- |
| **Auto mode** | `CHAT_MODELS[0]` (`id: 'auto'`, `chat-models.ts:279-286`, no `reasoning`, no `stats`); `modelOption`'s `auto` branch (`ChatComposerGradePanel.tsx:164-173`: `autoOption` class, `description`, `stacked`); `ModelList`'s `auto` row and its `<Show when={auto}>` (382, 478-480); `.autoOption` and its `::after` divider (`ChatComposerGrade.module.css:309-325`); `ModelGlyph` returning `null` for `auto` (29); `normalizeStoredChatModel` turning blank/legacy ids into `auto` (`chat-models.ts:387-395`), `readStoredChatModel` defaulting to `auto` (`chatGrade.ts:17-26`), `effectiveChatModel` returning `{ id: 'auto' }` (477, 488); the `ModelFace` description fallback exists because Auto has no `reasoning`. |
| **The footer ("Use my subscription")** | `OwnModelsCard` (`ChatComposerGradePanel.tsx:64-156`), rendered as the last child of the panel (609); its title is `OWN_SUBSCRIPTION_TITLE = 'Use my subscription'` (`apps/front/src/admin/modals/profileSettings/models/providers.ts:54`); a grid of overlapping provider marks, title and connected-provider names, a "Configure" `Sliders` icon button with tooltip, and a `Switch`. CSS: `.ownModels`, `.ownModelsTitle`, `.ownModelsSwitch`, `.marks`, `.mark` (`.module.css:327-405`). Behind it: `ConnectModelsDialog` (lazy, opened from `ChatComposerGrade.tsx:155-176`), `ProviderCredentialsStore`, `PROVIDERS`, `PROVIDER_ORDER`, `chatSubscriptionOn`, `connectedChatProviders`. |
| Not asked, but tied to the two above | The "subscription on/off" branching of the list (`ModelList` 358-381: provider groups when on, vendor groups when off), `VENDOR_LABEL` (46-54), the `EXTERNAL_MODELS_LABEL`. The hover card and its stats are Reforma catalog data (Artificial Analysis); the owner did not list them, so keeping or dropping them is a decision (see section 7). |

## 2. Visual structure

All values below are read from CSS and tokens. Clowdy's tokens are the same as Reforma's (`diff` of `packages/styles/src`: only `base.css` and `zIndex.css` differ by the package name, `theme.css` by extra `[data-theme]` selectors, plus Reforma's two Figma manifests), so the values hold for both. px assume the 16px root.

### Tokens used (light / dark where they differ)

- Spacing: `xxs 2`, `xs 4`, `sm 6`, `md 8`, `lg 12`, `xl 16`; numeric `--spacing-1 1`, `-4 4`, `-6 6`, `-8 8`, `-24 24`, `-30 30`, `-96 96`. Radius: `sm 6`, `md 8`, `lg 10`, `full`. Squircle: radius is multiplied by `--squircle-radius-factor` (1.573 where `corner-shape` is supported) with `corner-shape: superellipse(var(--squircle-value))` (1.75); pills force `corner-shape: round`.
- Type (Onest): `typography-text-sm` 12/16 w400; `typography-text-xs` 11/14; `typography-heading-4` 16/20 w500; `typography-heading-6` 12/16 w500; `typography-label-sm` 12/16 w400; `typography-button-sm` 12/16 w400.
- Colors: `--color-surface-float` (white / secondary-950), `--color-surface-border` (secondary-200 / light-a10), `--color-text` (secondary-950 / light-50), `--color-secondary-muted-text` (black-a60 / light-a60), `--color-secondary-muted-light` (dark-a5 / light-a10), `--color-secondary-muted` (dark-a10 / light-a20), `--color-secondary-content` (secondary-900 / secondary-200), `--color-primary-muted` (primary-a20 / primary-a40), `--color-primary-muted-border` (primary-a20 / primary-a60), `--color-primary-content` (white), `--color-primary-border` (primary-300), `--color-primary-light` (primary-400), `--color-primary-a40`.
- Motion: `--ease` cubic-bezier(.4,0,.2,1); `--transition-duration-fast` .15s; `--transition-duration` .3s; `MOTION_EASE_UI` = [0.32, 0.72, 0, 1] (`@clowdy/constants` has the same constant).

### The trigger (in the composer)

[observed] `GradeTrigger` (`ChatComposerGrade.tsx:47-86`) + `.composerGradeTrigger` (`ChatComposer.module.css:291-297`).

- `Button size="sm" variant="filling" rounded` (color defaults to `secondary`): 30px tall, `padding 4px 10px`, full-radius pill, `gap: var(--spacing-sm)` (6px), text `typography-button-sm`. At rest transparent with `--color-text`; hover/pressed plate `--color-secondary-muted-light`; press scale .97; `:focus-visible` 4px `--color-primary-muted-border` ring.
- Content, left to right: `ModelGlyph` (16px brand mark, nothing for Auto) / `<span class=modelLabel>` (inline-flex, `align-items: baseline`, `gap: 0.3em`, `min-width: 0`) holding `<Text truncate>{title}</Text>` and, when the model has reasoning, `<span class=level>{label}</span>` (`color: --color-secondary-muted-text`, `flex-shrink: 0`) / `ChevronDown` (10px pack, `aria-hidden`). So the summary reads "GPT-6.1 Sol  High" in one line: the title in text color and the level muted, no separator character in the DOM (the `aria-label` uses " · ").
- `.triggerContent`: `justify-content: flex-start; min-width: 0`; its `svg` children `flex-shrink: 0`. `.composerGradeTrigger`: `flex-shrink: 1; min-width: 0; max-width: 100%; padding-left: var(--spacing-sm)`.
- Open state: the button gets `data-open` and `isPressed` (so `aria-pressed=true` and the pressed plate stays); `.trigger[data-open]` sets `--reforma-button-color` and `--reforma-button-color--hover` to `--color-secondary-muted-text` (the whole label goes muted while open).
- `aria-label="Model: <title> · <level>"`. No tooltip. No disabled state.
- Narrow composers: `@container (max-width: 340px) { .trigger .level { display: none } }` (`.module.css:135-139`); the container is `.surface` (`ChatComposer.module.css:90`, `container-type: inline-size`).
- Position: absolutely placed (`.composerMode`, `ChatComposer.module.css:273-279`) at `bottom: var(--spacing-xs)`, `right: calc(xs + 30px + xs)` (left of the send button), `max-width: calc(100% - 80px)`; in the compact one-liner it is centred on the row midline (223-227).

### The popover shell

[observed] `Popover` from the design system (identical in both repos, see section 4) with `placement="top"`, `width={320}`, `spacing="none"`, plus `className=gradePopover`.

- Base look (`Popover.module.css`): `--color-surface-float` plate, 1px `--color-surface-border` (dark: 12% white), radius `--radius-lg` x squircle, shadow `0 16px 32px --color-dark-a10` (dark `--color-black-a50`), `typography-text-sm`, `z-index: var(--z-popover) !important`, `min-width: 12rem`, `max-width: min(100vw - 16px, 20rem)`, `offset` 8 (gap to trigger), `containerPadding` 8.
- Enter: opacity .6 to 1, translate from `0 6px` (placement top), scale .97 to 1, shadow lighter to full, 0.28s `cubic-bezier(.22, 1.2, .28, 1)`. Exit: 0.12s `--ease`, opacity 0, same translate/scale. Reduced motion: opacity only.
- `.gradePopover`: `overflow: hidden`; a `::before` full-bleed plate (`inset: 0; border-radius: inherit; background: --color-surface-float; z-index: 1; pointer-events: none`) and the content blocks (`.face, .models, .stage, .ownModels`) get `position: relative; z-index: 2` (`.module.css:17-19, 34-42, 68-74`). [unverified] why: no comment in the source; likely an opaque base under the sliding panes.
- `shouldCloseOnInteractOutside={ target => !(target instanceof Element && target.closest('[role="listbox"]')) }` and `getTargetRect` returning the rect captured at first call and reset when the popover closes (`ChatComposerGrade.tsx:89-125`). [inferred] purpose: the trigger label changes width when a model is chosen, and a moving anchor would make the popover jump; the listbox exception protects the pick (the row is picked on `pointerup`).

### Pane 1: the face ("expanded" state before the list)

`ModelFace` (306-354), `.face` (`.module.css:102-108`).

- `.face`: column, `padding: var(--spacing-lg)` (12), `gap: var(--spacing-lg)` (12).
- Model button: `Button variant="filling" color="secondary" size="md"` (36px; `padding 6px 14px` from the size, overridden to `padding: var(--spacing-sm) var(--spacing-md)`, i.e. 6px 8px by `.modelButton`), `align-self: flex-start`, `aria-label="Select model"`. Inside: `ModelGlyph`, a baseline label with the title and the level both in `typography-heading-4` (16/20 w500; the level muted), then `ChevronDown`. Pressing it sets `picking` (opens the list pane). It is the first focusable element of the popover.
- `.reasoning`: column, `gap: 6px`, `padding-inline: 8px`, `padding-bottom: 8px`. Content: `<Text variant="label" color="secondary">Reasoning effort</Text>` then the slider. For a model without reasoning: `<Text class=faceDescription>` (`typography-text-sm`, muted) with the model's description instead.
- `chooseReasoning`: if the stored model differs from the shown one (a coerced Auto), it first writes the shown model (`chat.setModel(chat.model)`) then `chat.setReasoning(next)`.
- Estimated height 130px (12 + 36 + 12 + 16 label + 6 + 4 + 24 track + 8 + 12): computed from the values above, not measured.

### The slider

`ReasoningSlider` (198-304), `.track`/`.fill`/`.point`/`.thumb` (`.module.css:154-280`).

- Track: `height: var(--spacing-24)` (24), `margin-top: 4px`, `border-radius: --radius-full`, `background: --color-primary-muted`, `cursor: pointer`, `touch-action: none`, `user-select: none`, `outline: none`.
- Fill: from the left edge to the thumb centre (`width: calc(thumb-half + level-p * (100% - thumb-width))`, `min-width: 24px`), `linear-gradient(to right, --color-primary-border, --color-primary-light)`, glow `box-shadow: 0 0 8px --color-primary-a40`, with a `::after` shimmer (`linear-gradient(90deg, transparent, --color-primary-content, transparent)`, size 200% 100%, opacity .22, `range-shimmer` 2.4s ease-in-out infinite alternate).
- Stops (`.point`): one per level, a 4px dot, `--color-primary-content` at .45 opacity, positioned at `--point-p = index / last`; the dot under the dragged-to level scales 1.5 (`data-hot`).
- Thumb: 30px circle (`--spacing-30`), `1px` border `--color-primary-muted-border`, fill `--color-primary-content` (white), shadows `--shadow-xs, --shadow-sm`; `scale 1.08` while dragging; centred with `translate: -50% -50%`; focus ring on `.track:focus-visible .thumb`: extra `0 0 0 4px --color-primary-muted-border`.
- Position maths: `--level-p = --level-anchor-p + --level-pointer-p`, where `anchor = (index/last) * (1 - 0.4)` and `pointer = (dragProgress ?? index/last) * 0.4` (`REASONING_DRAG_PULL = 0.4`). At rest the sum is exactly `index/last`; while dragging the thumb sits 40% of the way toward the pointer, and the chosen level still changes at `Math.round(progress * last)`. Four `@property` `<number>` registrations make both custom properties transitionable: anchor 220ms `--ease`, pointer `--transition-duration-fast` `--ease` (and no pointer transition while dragging).
- Interaction: pointer down captures the pointer and sets the level at once (a click on the track jumps to the nearest level); move updates while captured; up releases. Keyboard (`tabIndex=0`): ArrowRight/ArrowUp +1, ArrowLeft/ArrowDown -1, Home, End; `preventDefault` on handled keys; no PageUp/PageDown.
- ARIA: `role="slider"`, `aria-label="Reasoning"`, `aria-valuemin=0`, `aria-valuemax=last`, `aria-valuenow=index`, `aria-valuetext=<label>`.
- Reduced motion: transitions and the shimmer are removed (`@media (prefers-reduced-motion: reduce)`, 270-280).

### Pane 2: the model list (the "expanding" part)

[observed] There is no inline accordion and no submenu. The list is a second pane in the same popover; pressing the model button swaps panes and the popover height animates. Choosing a row, or Back, swaps back.

- Stage (`ChatComposerGradePanel`, 516-612; `.stage`, `.stageMeasured`, `.layer`, `.pane`): a `div.stage` (`overflow: hidden`) whose `height` is set from a `ResizeObserver` on whichever pane is active (`picking ? listRef : faceRef`) and animated with `transition: height 0.28s cubic-bezier(0.32,0.72,0,1)`; the first measurement does not animate (`animateHeight` flips after it). Both layers are `position: absolute` over each other once measured.
- Face layer: `motion.div`, `opacity 1 to 0` and `y 0 to -8` while picking, `inert` and `pointer-events: none` while hidden. List layer: `AnimatePresence`, enters from `{ opacity: 0, y: 24 }` to `{ 1, 0 }`, exits back to `{ 0, 24 }` with `pointerEvents: none`; `transition { duration: 0.28, ease: MOTION_EASE_UI }`. With reduced motion or before the first measurement (`skipMotion`), the list is mounted without `AnimatePresence` and durations are 0.
- Head row (`.listHead`): `display flex; align-items: center; gap: 6px; min-height: 30px; padding: 6px`; an icon-only `Button size="sm" variant="filling" color="secondary" aria-label="Back"` with `ChevronLeft` (14px), then `Text` "Select model" in `typography-heading-6` (12/16 w500).
- Scroll: `Scrollable className=modelScroll onScroll` with `max-height: 360px`; the `ListBox` has `padding: var(--spacing-sm)` (6px).
- `ListBox`: `size="sm"`, `selectionMode="single"`, `disallowEmptySelection`, `aria-label="Model"`, `selectedKeys=[chat.model]`, `onSelectionChange` calls `pick(id)`. List-level CSS (design system, `ListBox.module.css`): column, `gap: 2px`, one sliding hover plate drawn by the list's `::before`.
- Groups: with a single group the rows are flat; otherwise each group is a `ListBoxSection` with a `ListBoxHeader` (caption `typography-text-xs` 11/14, w500, `--color-secondary-muted-text`, `padding: 6px 12px 4px`; `.section + .section { margin-top: 8px }`). Reforma groups by vendor (OpenAI, Anthropic, Google, Meta, Qwen, Tencent, Other) when the subscription is off, by connected provider when it is on.

### Row anatomy

`modelOption` (158-189) through the design system `ListBoxItem` (`ListBox.tsx:116-150`, `listRowItemContent.tsx`, `ListBox.module.css:86-380`).

- A row is `min-height: 30px` (`--spacing-30`), `padding: 6px 12px`, radius `--radius-sm` x squircle, `gap: 10px` between a start block and an end block.
- Start block (`itemStart`, `gap: 8px`, flex 1): `icon` slot = `ModelGlyph` 16px; then the label `Text slot="label"` (`typography-text-sm`, single line, ellipsis).
- End block (`itemEnd`, right aligned, `max-width: 60%`): `endAffix` = `Check` (14px pack) on the selected row only. No description, no badges, no stats on a normal row. (Only the Auto row had a stacked description.)
- Hover and keyboard focus: no per-row fill; one plate (`list::before`, `--color-secondary-muted-light`) glides between rows (`top/left/width/height` transitions `--transition-duration-fast` with `cubic-bezier(.16,1,.3,1)`, opacity .1s; the first appearance skips the travel). It follows the pointer and the keyboard focus (`useListHoverHighlight`). Text colour stays `--color-text`.
- Selected: `--color-secondary-muted` plate (the row's own `::before`) and text `--color-secondary-content`; consecutive selected rows merge their radii.
- Disabled (design system, unused here): opacity `--opacity-disabled` (.4). Row focus: no outline (`data-focus-visible` only moves the plate).
- Picking: `onPointerUp={ () => onPick(id) }` on each row (fires before the popover can treat the press as outside), and `onSelectionChange` for the keyboard path. `pick` writes `setModel` only when the id differs from the stored one, then `onPicked()` returns to pane 1.
- Hover card: `onPointerEnter` per row reports (model, row, pointer); the list's `onPointerLeave` clears; scrolling hides it until the scroll has been quiet for 150ms (then re-resolves the row under the pointer with `elementFromPoint`).

### The hover card

`ModelStatCard.tsx` + `.module.css`. A `createPortal` to `document.body`, `position: fixed`, `width: 270px`, `z-index: calc(var(--z-popover) + 1)`, `pointer-events: none`, vertically centred on the row, to the right when `innerWidth - row.right >= 270 + 8 + 12` else to the left, clamped to a 12px viewport margin; `top/left` transition 0.2s `cubic-bezier(.16,1,.3,1)`; card `padding 12`, gap 12, `1px --color-surface-border`, `--radius-lg` (no squircle), `--color-surface-float`, shadow `0 16px 32px --color-dark-a10` (dark: 12% white border, `black-a50`); fade-in .12s. Content: title (`heading-4`) and Intelligence Index (`AiStar` icon + one decimal, accent), description (`text-sm`, muted), then four rows of `CHAT_MODEL_STAT_LABELS` with a 10-segment bar (96px wide, 6px tall, tone danger/primary/success from the value; cost is inverted). Delay 300ms before the first card; once one is open the next row moves it without delay. [inferred] It is mouse-only: no focus or keyboard path exists in the code.

### States

- Loading: only the lazy chunk (`GradeWindowFallback`, spinner, 96px). There is no loading state for the catalog (it is a constant).
- Empty and error: none. The `ListBox` has no `renderEmptyState`; the list is never empty because the catalog is static. Credential load errors live in `ProviderCredentialsStore` (not read).
- Disabled: the trigger is never disabled; a model without `reasoning` simply shows its description instead of the slider.

### Keyboard and ARIA summary

- [observed] Trigger: `aria-label="Model: ..."`, `aria-pressed` from `isPressed`. The popover is a React Aria `Popover` in a `DialogTrigger`: [observed, Clowdy's installed `react-aria-components` 1.22.1, `dist/private/Popover.mjs:121-216`] it takes `role="dialog"` with a focus-contained scope and front/back `DismissButton`s (Reforma's tests skip them with `button:not([tabindex="-1"])`). Reforma passes no `aria-label` to this popover [observed], so the dialog is unnamed.
- [observed] Slider and list ARIA as above. Escape is the React Aria popover's (closes everything); no code maps Escape to "back to the face" (no `onKeyDown` in `ModelList`) [inferred].
- [unverified] Where focus lands after pressing the model button: the face layer becomes `inert`, no explicit focus call exists, so focus presumably falls back to the dialog; arrow keys in the list need focus on it.

## 3. Data model

### What feeds the picker

[observed] `useGradeChat()` returns this interface (`standaloneGrade.tsx:106-116`):

```ts
type GradeChat = {
    storedModel: string;                 // the persisted choice (may be illegal for the current switch)
    reasoning: ChatReasoningLevel;       // the persisted level
    model: string;                       // the effective id (computed from storedModel + credentials)
    modelReasoning?: ChatReasoningLevel; // the effective level; absent for Auto
    providerCredentials?: ProviderCredentialsView;
    setModel(id: string): void;
    setReasoning(level: ChatReasoningLevel): void;
    selectProvider(...); loadProviderCredentials();   // footer-only
};
```

The catalog row (`packages/constants/src/chat-models.ts:37-62`):

```ts
type ChatModelEntry = {
    id: string;                 // 'auto' or `${provider}:${slug}`
    provider: 'reforma' | InferenceProviderId;
    slug: string;
    vendor?: ChatModelVendor;
    title: string;
    description: string;
    default?: boolean;          // subscription fallback
    aliases?: readonly ['lite'];
    reasoning?: Partial<Record<ChatReasoningLevel, string>>;  // present = has effort control; map renames a level to a provider effort
    stats?: Record<'reasoning'|'speed'|'cost'|'value', number>;  // hover-card bars, 0-10
    intelligence?: number;      // Artificial Analysis index
};
```

- Where the list comes from [observed]: a hand-written constant. `FAMILIES` (titles, descriptions, vendor, stats) plus `row(provider, slug, options)` build `CHAT_MODELS` (`chat-models.ts:279-321`): Auto, 22 `reforma:` gateway rows, 3 `openai:`, 4 `anthropic:`, 4 `google:` rows. Nothing is fetched. The list order in the file is the display order ("strongest first").
- Where selection lives [observed]: `ChatRuntime` (`@observable storedModel`, `@observable reasoning`, computed `selection` / `model` / `modelReasoning`; `setModel`, `setReasoning`, `reconcileStoredModel`) or `StandaloneGradeChat` with the same shape; both persist through `chatGrade.ts` to `localStorage` keys `chat:model` and `chat:reasoning` (legacy `chat:grade`). Effective values come from `selectionForChat` then `effectiveChatModel`, which is where Auto and the subscription switch coerce the choice.
- Where it is sent [observed]: `chatRunConfig` (`runtime/chat/helpers/chatStreamData.ts:42-50`) puts `{ model, modelOptions: { reasoning } }` on every send. In the sandbox `applyCatalogReasoning` (`apps/sandbox/src/chat/agent/models/model-registry.ts:231-249`) maps the product level through `chatModelEffort(id, level)` (`model.reasoning[level] ?? level`) and keeps it only when it is in `PROVIDER_EFFORT`.
- Per-model "supported levels" do not exist in Reforma [observed]: every row has `reasoning: PASSTHROUGH` (`{}`) or a rename map (`{ none: 'low' }` on four Gemini rows); the slider always shows all of `CHAT_REASONING_LEVELS` for any model that has `reasoning`. The "levels a model really supports" idea has no field in Reforma.

### Exactly where the levels stop at "high"

1. **The source of truth**: `packages/constants/src/chat-models.ts:8`, `export const CHAT_REASONING_LEVELS = ['none', 'low', 'medium', 'high'] as const;` and `ChatReasoningLevel` (line 10) derives from it. The slider (`last = CHAT_REASONING_LEVELS.length - 1`, panel 206), `isChatReasoningLevel` (327-329), and the `reasoning` map's keys all derive from it.
2. **Label tables**, duplicated: `REASONING_LABELS` in `ChatComposerGrade.tsx:39-44` and in `ChatComposerGradePanel.tsx:56-61`, both `as const satisfies Record<ChatReasoningLevel, string>`, so adding a level is a compile error until both are filled. In Clowdy one table would do.
3. **The default is "high"**: `readStoredChatReasoning` (`chatGrade.ts:33-37`), `levelOrHigh` (`chat-models.ts:397-403`), and `withReasoning(fallback, 'high')` (474).
4. **The provider-side vocabulary is wider**: `CHAT_MODEL_REASONING = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh']` in `packages/types/src/sandbox/ai.ts:18-25`; `PROVIDER_EFFORT` is built from it. [inferred] So Reforma's product list is a subset of what the provider call accepts: a product level could reach `xhigh` only through a rename such as `reasoning: { high: 'xhigh' }`, and no row has one.
5. **Tests that pin the four levels**: `apps/front/src/specs/runtime/chat-grade.test.ts` ("reads missing or junk reasoning as high"), `chat-model.test.ts`, `editor/chat-grade-strip.test.tsx` (ArrowLeft from `high` gives `medium`, line 453-480).

### Facts about Clowdy's side that bear on this (for the Grill, not a design)

- [observed] `packages/protocol/src/agents.ts:124-149`: `AgentModel { id, name, description?, isDefault?, resolvedId?, efforts?: string[], defaultEffort?: string, supportsFast? }` and `AgentModels { state: 'ok' | 'unavailable' | 'error', models, fetchedAt?, detail? }`, served by `GET /v1/agents/:id/models` (`api.ts:33, 54`; `apps/daemon/src/http/routes.ts:204`; parsed in `apps/daemon/src/providers/models.ts` for Claude `supportedEffortLevels`, Codex `supportedReasoningEfforts` and `defaultReasoningEffort`, Cursor variant ids). The daemon caches for ten minutes. So per-model effort lists already exist, as open strings in the agent's own spelling.
- [observed] Nothing in `apps/desktop/src` references `AgentModels` or the endpoint (grep returned nothing); the transport has no call for it.
- [observed, `.briefback/agent-accounts/research/models.md`:65, 83, 92] real vocabularies are open and per model: Claude `low/medium/high/xhigh/max` (`low` only on Haiku in one recording; `ultracode` as an extra; Opus/Sonnet 4.6 lack `xhigh`), Codex `low` to `max` and `ultra` on some models, Cursor variants with `none` to `max`. A model may therefore have anything from 0 to about 6 levels.
- [observed] `chat.send` carries `chatId`, `text`, `attachmentIds` only (`packages/protocol/src/commands.ts:36`); a `model` field exists at project level (`project.update` settings, `domain.ts:32, 144`). Not read further.

## 4. Primitives used, and parity with `@clowdy/components`

Method: compared every file of each component directory in both repos after renaming `reforma` to `clowdy` (so the `@scope`, `--reforma-*` variables and names do not count) [observed].

| Primitive (Reforma use) | In Clowdy? | Difference |
| --- | --- | --- |
| `Popover`, `PopoverTrigger`, `OverlayTriggerStateContext` (`@clowdy/components/Popover`) | Yes | None in `Popover.tsx`, `Popover.module.css`, `PopoverScroll.tsx`. Props used: `placement`, `spacing`, `width`, `shouldCloseOnInteractOutside`, `getTargetRect` (the last two are React Aria props; `getTargetRect` is in the installed `react-aria` `PositionProps`, `useOverlayPosition.d.ts:101`). |
| `Button` (`size`, `variant="filling"`, `rounded`, `color`, `iconOnly`, `isPressed`, `contentClassName`, `aria-label`) | Yes | Same props. Only the pending-spinner API differs (`spinnerPlacement: 'center' \| 'start'` in Clowdy, `'center' \| 'end'` in Reforma); the picker does not use a pending button. |
| `ListBox`, `ListBoxItem`, `ListBoxSection`, `ListBoxHeader` (`@clowdy/components/List`) | Yes | None in `ListBox.tsx`/`.module.css`/`listRowItemContent.tsx`. `useListHoverHighlight.ts` is newer in Clowdy (a pointer that really moves takes the plate back after a scroll; a `focusin` handler keeps the plate on a key-chosen row): better, not a break. |
| `Scrollable` (`className`, `onScroll`) | Yes | None. Clowdy's AGENTS says not to wrap it in extra layout divs. |
| `Text` (`variant="label"`, `color="secondary"`, `truncate`) | Yes | None. `secondary` maps to `color-secondary-muted-text`. |
| `Spinner` (`size="xs"`) | Yes | None. |
| `For`, `Show` (render-prop `children`), `Box` | Yes | None. |
| `Tooltip`, `Switch`, `Dialog` (footer and Connect dialog) | Yes (`Tooltip`, `Switch`, `Modal`) | `Tooltip.module.css` has 6 extra lines for the hotkey capsule. Not needed (footer dropped). |
| `motion/react` (`AnimatePresence`, `motion`, `useReducedMotion`) | Dependency of `@clowdy/components` only (`^13.4.0`), already used there (`Collapsible`, `Breadcrumb`, `SettingsLayout`, `AngleControl`, `Modal`) | `apps/desktop/package.json` does not list `motion`, and the renderer imports no `motion` today [observed]. Using it from `apps/desktop` needs a dependency decision (the project rule: ask before adding one). |
| `MOTION_EASE_UI` (`@clowdy/constants`) | Yes (`packages/constants/src/animations.ts:2`, same value) | None. `apps/desktop` already depends on `@clowdy/constants`. |
| Icons `ChevronDown` (10), `Check` (14), `ChevronLeft` (14), `Sliders`, `AiStar` (14) | Yes (`dist/10`, `dist/14` have `ChevronDown`, `Check`, `ChevronLeft`, `Sliders`, `AiStar`) | `Sliders` is the footer's; `AiStar` is the hover card's. |
| Brand marks (`@clowdy/icons/logo`) | `Claude`, `Cursor`, `Openai` plus Gemini, Grok, Deepseek, Glm, Kimi, Muse, Qwen | Clowdy has the three agents' marks and an existing wrapper `features/settings/providers/ProviderIcon.tsx` (`claude`, `codex` to OpenAI, `cursor`). Reforma has no Cursor mark; Clowdy has no Tencent. |
| `cn` (`@clowdy/lib`) | Yes | None. |
| `ModelGlyph`, `ModelStatCard`, `standaloneGrade`, `chatGrade`, `chat-models.ts`, `providers.ts` | No (Reforma app code, not the design system) | Not in `packages/components`; the picker is app code in Reforma (`apps/front`), so it would be feature code in `apps/desktop` (or a new component in `packages/components`; a decision, not mine). |
| `Select` (Clowdy's existing Mode control) | Yes, in both | A different primitive (a React Aria `Select` with `placement`, `items`, `valueDisplay`, `maxHeight`); Reforma's picker does not use it. Noted because Clowdy's composer already uses it for "Mode". |

Other facts [observed]:

- Component CSS in `packages/components` sits in `@layer components`; app feature CSS must not (Clowdy `packages/components/AGENTS.md`). Reforma's picker CSS has no layer, so it ports as is.
- The renderer imports by subpath (`@clowdy/components/Popover`, `/List`, `/Button`, `/Scrollable`, `/Text`, `/Spinner`, `/Show`, `/For`), per `apps/desktop/AGENTS.md`; the package's `exports` map `./*` to `src/*/index.ts`.
- `babel-plugin-observing-components` wraps every renderer component, so Reforma's MobX-observer assumptions carry over without `observer()` (desktop AGENTS).

## 5. Clowdy's composer today (not a design)

Files (all `apps/desktop/src/renderer/features/chats/`): `Composer.tsx` (the card), `Composer.module.css`, `ComposerSend.tsx` + `.module.css` (send/stop), `composerDrafts.ts`, `composerFiles.ts`, `useComposerFiles.ts`, `useMentionTriggers.ts`, `MentionChip.tsx`. Mounted by `ChatView.tsx:81` (`<Composer ref chat run />`) and `features/agents/DraftChat.tsx` (`minLines={3}`, `start={ projectId, onStarted }`). Tests: `Composer.test.tsx`, `ComposerDraft.test.tsx`, `ComposerFiles.test.tsx` (happy-dom, a stub `RootStore` with `command` and `transport`).

Structure [observed, `Composer.tsx:165-260`]:

```text
div.surface                  (the card)
  div.main  onMouseDown=focusField
    Attachments (when files)
    RichInput (TipTap)       aria-label="Message", Enter sends
    div.row                  (flex, space-between, gap xs, margin-top sm)
      Button Attach (filling, secondary, sm, iconOnly, Clip)  + hidden <input type=file>
      div.end                (flex, gap xs)
        <Unavailable label="Mode">  Select (aria-label="Mode", size sm, variant transparent, placement top, class .mode = 9.5rem wide, items Autopilot / Semi-manual)
        <Unavailable label="Send">  <ComposerSend/>   (primary, sm, iconOnly, rounded; Send or Stop)
```

- `.surface` (`Composer.module.css:16-31`): flex column, `padding: 6px`, radius `--radius-xl` x squircle, `background: --color-chat-composer`, `typography-text-md`, animated conic ring in `::before`, glow on `:focus-within`. It has no `overflow: hidden` and no `container-type` (Reforma's has both).
- `.row` (84-91) and `.end` (93-98): a normal flex row. The new control would be a sibling inside `.end`, before or after the Mode `Select`, with the send button last. `.mode` is a fixed `9.5rem`.
- Disabled-with-a-reason pattern exists: `Unavailable` (263-275) wraps a control in a focusable `span role="button"` plus `Tooltip` when a `hint` is given (used for Mode while a run is active and for Send while files upload).
- Press handling: `focusField` (156-163) puts the caret in the text on a press of the card's own space; presses on `CONTROLS = 'button, [role="button"], [role="combobox"], [contenteditable="true"], a, input'` are left alone, and a press inside a portalled list is ignored through `event.currentTarget.contains(target)`. A picker popover that is portalled falls in the same case; the test "leaves a press inside the open mode list to the list" (`Composer.test.tsx:345`) covers the pattern.
- Where model/effort would meet this card [observed]: `chat.send` has no field for it, the `ChatMode` mode is per chat (`chat.setMode`), and the renderer has no model data (section 3).

## 6. Port checklist (what to copy or recreate, what to drop)

Copy or recreate (feature code in `apps/desktop`, subpath imports, English names; "grade" is Reforma's word and need not carry over):

1. **Trigger**: `GradeTrigger` (47-86) and its CSS (`.trigger[data-open]`, `.triggerContent`, `.modelLabel`, `.level`, the `@container (max-width: 340px)` rule that needs `container-type: inline-size` on the card, which Clowdy's `.surface` lacks) and `.composerGradeTrigger` from `ChatComposer.module.css:291-297`.
2. **Popover shell**: `FrozenGradePopover` (89-125) with `width={320}`, `spacing="none"`, `placement="top"`, the frozen `getTargetRect` and the listbox exception; `.gradePopover` (`overflow: hidden`, the `::before` plate); `GradeWindow` lazy mount and `GradeWindowFallback` (`.windowPending`); the `EditorLayout`-style warm-up is optional.
3. **Two-pane stage** (`ChatComposerGradePanel` 507-612): the `ResizeObserver` height, `AnimatePresence`, the `skipMotion` branch, `paneTransition`, `HEIGHT_EASE`, constants `PANE_DURATION_S = 0.28`, `PANE_RISE = 24`, `PANE_SINK = -8`; CSS `.stage`, `.stageMeasured`, `.layer`, `.pane`, `.face, .models, .stage` z-index group (`.module.css:68-100`).
4. **Face**: `ModelFace` (306-354) with the model button and the description fallback; CSS `.face`, `.modelButton`, `.modelLabel`, `.modelTitle`, `.level`, `.reasoning`, `.faceDescription` (102-152).
5. **Slider**: `ReasoningSlider`, `progressFromTrackX`, `REASONING_DRAG_PULL`; CSS `.track`, `.fill`, `.point`, `.thumb`, the four `@property` blocks, `@keyframes range-shimmer`, the reduced-motion block (44-66, 154-280).
6. **List**: `ModelList` (without the Auto row and the subscription branching), `modelOption` (without the `auto` branch), head row and `Scrollable`; CSS `.models`, `.listHead`, `.modelScroll`, `.modelList`, `.listTitle` (282-307).
7. **Glyph**: a per-agent mark (Clowdy already has `ProviderIcon` and the logo pack) instead of `MODEL_MARKS`.
8. **Hover card** (optional, undecided): `ModelStatCard.tsx` and `.module.css`, with the catalog data it needs (`stats`, `intelligence`) which Clowdy does not have; `AgentModel.description` is the only text source.
9. **Tests to recreate** (Vitest, happy-dom, as in Clowdy's `Composer.test.tsx`), from Reforma's `specs/editor/chat-grade-strip.test.tsx` (744 lines) and `specs/runtime/chat-model.test.ts`, `chat-grade.test.ts`: opens on press; shows the model and level on the trigger; opens the list and picks a row (writes once, returns to the face); picking the current model closes the list; the slider keyboard (arrows, Home, End) and its drag pull maths (`--level-anchor-p` + `--level-pointer-p`, test at 482-529, which mocks `getBoundingClientRect` and pointer capture); the helpers the test file defines (`press` = pointerdown + pointerup + click; `modelFaceButton` skipping `[tabindex="-1"]` dismiss buttons; the lazy-chunk timeout).
10. **Docs** to update when ported: `apps/desktop/AGENTS.md` (renderer layout, Agents section) and `packages/components/AGENTS.md` only if a design system component is added.

Drop (do not copy):

- Auto: `CHAT_MODELS[0]`, `modelOption`'s `auto` branch, `ModelList`'s `auto` row, `.autoOption` and its divider, `normalizeStoredChatModel`'s Auto fallbacks, `effectiveChatModel`'s `{ id: 'auto' }` returns, the Auto-coercion in `chooseReasoning` ("write the shown model first").
- Footer and subscription: `OwnModelsCard`, `ConnectModelsDialog`, `connectOpen` state and `Dialog`, `ProviderCredentialsStore`, `loadProviderCredentials`, `selectProvider`, `PROVIDERS`/`PROVIDER_ORDER`/`OWN_SUBSCRIPTION_TITLE`, `chatSubscriptionOn`, the subscription groups in `ModelList`, `VENDOR_LABEL`, and CSS `.connectDialog`, `.ownModels*`, `.marks`, `.mark` (`.module.css:30-32, 327-405`).
- Context usage control: `ChatComposerContextUsage` and everything below line 203 of `ChatComposerGrade.tsx`, CSS 407-525 except what `.title` is shared with.
- Reforma's runtime/store: `ChatRuntime`, `StandaloneGradeChat`, `localStorage` keys, `chat-models.ts` catalog, gateway/alias routing, sandbox mapping.

## 7. Findings that may need an owner decision (facts, not recommendations)

1. **Level count is variable in Clowdy, fixed at four in Reforma.** Reforma's slider assumes the same stops for every model; Clowdy's data is per model and open strings. In the slider code `index / last` with `last = length - 1` is `0/0 = NaN` for a one-level model (`anchorProgress`, `--point-p`), and a zero-level model has no slider at all (the face then shows the description, as for Auto). `REASONING_LABELS` is a closed table keyed by Reforma's four names; Clowdy's strings (`xhigh`, `max`, `ultracode`, `ultra`, `none`, `minimal`) have no labels yet.
2. **"Expands" is a pane swap, not an inline expansion.** If the owner pictured an accordion or a flyout, this is different from Reforma. Reforma's list replaces the face while open and returns to it after a pick.
3. **Shadows and shimmer vs `DESIGN.md`.** The slider uses a glow (`0 0 8px primary-a40`), a looping shimmer and thumb shadows (`--shadow-xs`, `--shadow-sm`); `DESIGN.md` has "The Float-Only Shadow Rule" (line 236: no shadow unless the thing overlays the page) and says AI glow is "not for every button" (233). The slider sits inside a floating popover, so it is arguable either way.
4. **The hover card depends on catalog data Clowdy does not have** (stats, an Intelligence Index) and has no keyboard path.
5. **Esc and focus**: Reforma never maps Escape to "back"; focus placement after the pane swap is not coded (section 2).
6. **`motion` is not a dependency of `apps/desktop`.** The pane swap and height animation use `motion/react`; a CSS-only version would differ from Reforma's feel; adding a dependency needs the owner's yes (AGENTS rule recorded in memory).
7. **Reforma's popover has no accessible name** and the trigger shows no tooltip.

## 8. Not read, not run, assumptions

- Not run: either app, any test, any build, any screenshot. The heights (130px face, 402px list at most) are arithmetic from CSS values, not measurements. Dark-mode appearance is read from tokens only.
- Not read: `ConnectModelsDialog*`, `ProviderCredentialsStore`, the rest of `providers.ts`, `ComposerProvider.tsx`, `ChatComposerPlus.tsx`, `ChatComposer.stories.tsx` and the Storybook stories, `Scrollable` internals and CSS, `useListHoverHighlight`/`useScrollActiveListItem` beyond the diff, `inference-providers.ts`, the sandbox `inference-harness.ts`, Reforma's `Chat.tsx`. Only the tests named in section 6 were read, `chat-grade-strip.test.tsx` lines 1-140 and 440-540 in full and the others by title.
- Not checked: React Aria's actual focus behaviour after the pane swap; the `OverlayTriggerStateContext` `aria-expanded/haspopup` wiring on the trigger; the `::before` plate's purpose; whether `onPointerEnter`/`onPointerUp` reach the DOM through the `ListBoxItem` in every React Aria version (it works in Reforma, whose range is `^1.17.0`; Clowdy has 1.22.1 installed, and the range there is also `^1.17.0`).
- Assumed: Clowdy's `packages/components` copy of each primitive is what the desktop renderer gets (the normalised diff shows it is identical, apart from the items in section 4).
- Clowdy's `.briefback/provider-surfaces/research/header-usage-and-readonly.md` sits beside this file; I did not read or touch it.

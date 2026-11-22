# Tasks in the side panel

> Keep this plan current during implementation.
> Check off tasks as their outcomes are completed.
> Check a stage only after done-when, verification, review, and commit.
> Record scope changes before leaving the stage.
> Record landed commits under the stage they implement.

**Goal:** the left part of the window is always the chat list and the chat: Tasks leaves the sections and becomes a tab of the right side panel, and the panel that covers the chat stays a mode the person lives in.

**Approach:** Stage 1 changes what the expanded panel does when a chat is chosen (it hides, and the flag stays) and keeps the flag between sessions, which the Tasks tab then relies on. Stage 2 makes Tasks a tab that always covers the chat (the corner button skips its expand step there), takes the Tasks section out of the shell, and takes the open task and the Tasks scope out of the back and forward history (Stage 4 of the first plan, done here: leaving them in the history while the section went would have meant rewriting the history tests twice). Stage 3 deletes what only sections needed (the left rail, `Section`, the `g a` chord) and the leftovers of the Tasks history. Tasks moves as it is: its screen, commands and hotkey scope are reused, and only what its new container breaks is fixed.

**Decisions** (owner, 2026-11-22)

- **Tasks is a tab of the right panel**, after Terminal and before Info (Files, Docs, Terminal, Tasks, then Info and Settings at the bottom), with the `Checkbox` icon of the 14 pack it has on the left rail. Its key is `Cmd+4` (`Ctrl+4` off a Mac), toggling like the other tabs: a second press shuts the panel.
- **The Tasks tab always covers the chat.** The corner button (the three-state step of shown, expanded and hidden that exists now) has two states on it, shown and hidden: it skips the expand step, because the tab is full already. Tasks does not change the expanded flag (the person's choice for the other tabs), hiding it leaves the flag as it is, and `Cmd+Shift+Enter` does nothing on it. The panel covers the chat while it is open and either the flag is on or the tab is Tasks.
- **A chat that is chosen while the panel covers it hides the panel and never touches the flag.** Choosing a chat, a run or the new-chat row (even the chat that is open already), or history showing another chat, closes the panel. In split mode the chat is beside the panel and the choice leaves it alone. This replaces the rule that shipped first (a chat choice cleared the expanded flag): expanded is a mode to live in, not a temporary view, so the flag stays as the person set it.
- **The expanded flag is kept per project**, with `sidePanelOpen` and `sidePanelTab`.
- **The `g a` and `g t` chords and the `nav.*` commands go**, with no replacement chord. The tab keys (`Cmd+0` to `Cmd+4`) are how the panel's tools are reached.
- **Opening a task opens the panel on the Tasks tab with the task selected**: the task chip (`shared/TaskChip.tsx`), the chat's `onOpenTask`, a mention, a related-chat link. Closing the task's detail (`openTask(null)`) leaves the panel as it is.
- **The left rail goes**, not kept with one item. The list of chats is the leftmost column and the window's plate reaches the window's left edge (no left rounding against a rail).
- **`Section`, `SECTIONS`, `ProjectUi.section`, `showSection`, the `?section=` URL parameter and `ProjectScreen` go.** The shell shows the Agents screen and nothing else; a `section` kept by an older version is ignored. The folder the window works in (`currentFolder`) is the open chat's or the new chat's folder in every case.
- **The open task and the Tasks scope are not places of the back and forward history**, as the panel's tabs are not. A history that carries the panel's state everywhere, for every tab, is a separate topic for later, to settle on its own.
- **Tasks moves as it is.** No redesign of its header, board, list, detail or archive; only what the new container breaks (borders, scroll, height, the plate's corners) is adjusted.

**Reuse:** `ProjectUi.openSidePanelTab`, `toggleSidePanelTab`, `SIDE_PANEL_TABS`, `SIDE_PANEL_TAB_KEYS`, `SIDE_PANEL_TAB_LABELS`, `sidePanelTabCommand` (`features/sidePanel/commands.ts`), `SidePanelRail` `TABS`, `RailItem` (`shared/RailItem.tsx`), `SidePanel` lazy tabs, `useSidePanel`, the Tasks `Screen` and `TASKS_SCOPE` (`features/tasks`), `NavHistory`, the screenshot harness (`apps/desktop/AGENTS.md`, "Checking the UI without a person").

## Out of scope

- Redesigning the Tasks screen (its header, detail panel placement, board and list), and any split mode for the Tasks tab.
- Per-tab expanded modes.
- A replacement chord for going to Agents, and anything to take the left rail's place.
- Back and forward for the panel's state, in any tab.
- Windows (the corner and the keys are checked on a Mac only), Linear, and the task model itself.

## Stage 1 — The covering panel hides on a chat choice, and expanded is kept

**Depends on:** None.

**This stage:** The expanded panel shipped with the rule that choosing a chat ends expanded. The owner turned that around: a covering panel just hides, and the flag is a mode kept as the person set it, also between sessions. This stage changes that rule and persists the flag, so Stage 2 can add a tab that covers the chat on top of it.

- [x] Complete
  - [x] Choosing a chat, a run or the new-chat row, and history showing another chat, closes an open expanded panel and leaves `sidePanelExpanded` as it was; a shut panel or a split one is not touched
  - [x] `sidePanelExpanded` is stored per project with the open state and the tab, and read back
  - [x] Tests and the guide say the new rule

**Files**

- `apps/desktop/src/renderer/stores/UiStore.ts` — `#showChat`: closes the panel while it is open and expanded, in place of clearing the flag; `StoredProjectUi`, the constructor's read and the keeping reaction: `sidePanelExpanded`
- `apps/desktop/src/renderer/stores/UiStore.test.ts` — the two tests of the old rule and the "not between sessions" line
- `apps/desktop/AGENTS.md` — the **Expanded** paragraph of the side panel bullet

**Done when:** with the panel expanded, choosing any chat shows that chat full width and a later `Cmd+Esc` brings the panel back expanded, also after a reload.
**Verify:** `bun run test src/renderer/stores src/renderer/features/sidePanel src/renderer/shell` and `bun run lint` in `apps/desktop`; in the screenshot harness expand the panel, call `openChat` through `--eval`, and see the chat.
**Commits:**

- `8e1eccd` feat(desktop): shut a panel that covers the chat when a chat is chosen, and keep the expanded choice per project

## Stage 2 — Tasks is a tab of the panel, and the Tasks section is gone

**Depends on:** Stage 1.

**This stage:** Tasks stops being a screen in place of the chat list's page and becomes the fifth tab of the panel, always covering the chat, with the key `Cmd+4`. Every way into a task opens that tab, and the shell, the rail and the commands stop knowing a Tasks section, with the `Section` type narrowed to Agents alone until Stage 3 deletes it. The Tasks screen and its hotkey scope are mounted in the tab as they are; it is mounted once, since its commands have fixed ids.

- [x] Complete
  - [x] `SIDE_PANEL_TABS` has `tasks`; the rail has its item after Terminal; `Cmd+4` toggles it; the terminal lets `Ctrl+3` and `Ctrl+4` through off a Mac (the Docs key was missing too)
  - [x] The panel covers the chat while the Tasks tab is shown, whatever the flag; the corner button steps shown and hidden there and leaves the flag, and `Cmd+Shift+Enter` does nothing
  - [x] The Tasks screen draws in the tab's plate (fills it, scrolls for itself), with the detail panel, the archive and the scope header working
  - [x] `openTask(id)` opens the panel on the Tasks tab with the task selected; `openTask(null)` leaves the panel alone
  - [x] `ProjectView` has no `taskId` or `tasksScope`; `NavHistory` records the project and the chat or run only
  - [x] The shell's outlet is the Agents screen; the Tasks item of the left rail, the `g t` chord and the `nav.tasks` command are gone; a stored `section: 'tasks'` falls back to Agents
  - [x] Tests and the guide follow

**Files**

- `apps/desktop/src/renderer/stores/UiStore.ts` — `SIDE_PANEL_TABS`, `SECTIONS` (Agents alone), `openTask` (opens the tab, no section switch), a getter for "the panel covers the chat" (open, and the flag or the Tasks tab) in place of `sidePanelOpen && sidePanelExpanded`
- `apps/desktop/src/renderer/stores/NavHistory.ts` — `#exists` and the `tasks` branch of the entry's repair: the section can no longer be `tasks`
- `apps/desktop/src/renderer/features/sidePanel/commands.ts` — `SIDE_PANEL_TAB_KEYS` (`$mod+4`), `SIDE_PANEL_TAB_LABELS`
- `apps/desktop/src/renderer/features/sidePanel/SidePanelRail.tsx` — `TABS`: the Tasks item (`Checkbox`, 14 pack, size 14), after Terminal
- `apps/desktop/src/renderer/features/sidePanel/SidePanel.tsx` — a lazy `TasksTab` from `../tasks`, shown while the tab is chosen
- `apps/desktop/src/renderer/features/sidePanel/SidePanel.module.css` — `.plate[data-tab='tasks']` like Files and Terminal (flex column, `overflow: hidden`), the expanded rule's comment
- `apps/desktop/src/renderer/features/sidePanel/useSidePanel.ts` — `expanded` is the covering getter, `expandedChoice` also holds for the Tasks tab (the panel comes back covering); `panelStep.ts` then draws the two states with no change
- `apps/desktop/src/renderer/stores/UiStore.ts` — also `stepSidePanel`: on the Tasks tab an open panel is hidden without clearing the flag
- `apps/desktop/src/renderer/features/agents/Screen.tsx` — `data-covered` follows the same value (no change if it reads `useSidePanel().expanded`)
- `apps/desktop/src/renderer/features/tasks/Screen.tsx`, `Screen.module.css` — only what the plate breaks (height, scroll, borders)
- `apps/desktop/src/renderer/shell/Shell.tsx` — `SCREENS`, `ProjectScreen`: the Agents screen alone
- `apps/desktop/src/renderer/shell/Rail.tsx` — the Tasks item and `SECTION_VIEWS` entry go (the rail itself goes in Stage 3)
- `apps/desktop/src/renderer/shell/shellCommands.ts` — `SECTION_CHORDS`: `g t` goes with its command (`g a` goes in Stage 3); `SIDE_PANEL_TABS.map` takes the new tab
- `apps/desktop/src/renderer/features/terminal/shellKeys.ts` — `isAppShortcut`: `Ctrl+3` and `Ctrl+4`, with its test in `TerminalsStore.test.ts`
- `apps/desktop/src/renderer/features/tasks/*.test.tsx`, `features/chats/*.test.tsx`, `stores/*.test.ts`, `shell/shellCommands.test.ts`, `hotkeys/keymap.test.ts` — tests that set or read `section` or `'tasks'`
- `apps/desktop/AGENTS.md` — the side panel and Tasks screen bullets

**Done when:** a task chip in a chat opens the Tasks tab full width over the chat with that task selected, `Cmd+4` and the corner button show and hide it, and the window has no way to show Tasks in place of the chat list's page.
**Verify:** `bun run test`, `bun run lint` and `bun run typecheck` in `apps/desktop`; in the harness `?fixtures=static&panel=open&panelTab=tasks` (full width, detail on a card, archive) and `?fixtures=static&panel=open&panelTab=files` (no change).
**Commits:**

- `cd74c1e` feat(desktop): make Tasks a tab of the side panel that always covers the chat, and take the Tasks section out of the shell (the history change of the first plan's Stage 4 is in it; an independent review found a press on the open chat's row not shutting a covering panel, a breadcrumb in the panel counted as the rail by the list keys, and the "Tasks is full" rule in four places, all fixed in it)

## Stage 3 — The left rail and the section state are deleted

**Depends on:** Stage 2.

**This stage:** With Agents the only section, the left rail is an item that chooses nothing, and `Section` is a type with one value. This stage deletes them and the `g a` chord, and lets the window's plate reach the window's left edge, which is what the owner meant by the left part always being the chat.

- [ ] Complete
  - [x] The left rail, its styles and its `Section` code are gone; the chat list is the leftmost column and the plate has no rounding or border at the window's left edge
  - [x] `Section`, `SECTIONS`, `ProjectUi.section`, `showSection`, the stored `section` and `?section=` are gone; `ProjectView` has no `section`
  - [x] `g a`, `nav.agents` and `navCommandId` are gone; `Cmd+N` (new chat) opens the draft without a section
  - [x] `currentFolder` is the chat's or the new chat's folder in every case
  - [ ] What only kept the Tasks history right goes: `NavHistory.replacing` and its callers in `features/tasks` (`settleScope`, `taskCommands`' `replacing`) once nothing needs them

**Files**

- `apps/desktop/src/renderer/shell/Rail.tsx`, `shell/Rail.module.css` — delete: nothing but sections lived in them
- `apps/desktop/src/renderer/shell/Shell.tsx`, `Shell.module.css` — the rail, `.railed`/`.bare`'s left side and the plate's left corner
- `apps/desktop/src/renderer/shell/shellCommands.ts` — `SECTION_CHORDS`, `sections`, `navCommandId`, the `showSection` call of `NEW_CHAT_COMMAND`
- `apps/desktop/src/renderer/stores/UiStore.ts` — `Section`, `SECTIONS`, `section`, `showSection`, `ProjectView`, `initialUiFromSearch`
- `apps/desktop/src/renderer/stores/index.ts` — the exports of `SECTIONS` and `Section`
- `apps/desktop/src/renderer/stores/NavHistory.ts` — `#exists`, the snapshot
- `apps/desktop/src/renderer/stores/RootStore.ts` — the `initialUi` comment
- `apps/desktop/src/renderer/features/sidePanel/currentFolder.ts` — the `section` parameter
- `apps/desktop/src/renderer/**/*.test.ts(x)` — what sets or reads `section`, `showSection` or `nav.*`
- `apps/desktop/AGENTS.md` — the shell, the rail and the harness URL parameters

**Done when:** the window has no left rail, `bun run typecheck` finds no `Section`, and chat, new chat and the panel work as before.
**Verify:** `bun run test`, `bun run lint` and `bun run typecheck` in `apps/desktop`; the harness at `?fixtures=static` and `?fixtures=static&panel=open&panelTab=tasks`, looking at the plate's left edge.
**Commits:**

- `b7b23cf` feat(desktop): remove the left rail and the section state, so the left part of the window is always the chats

Open: the last task, the leftovers of the Tasks history (`NavHistory.replacing` and `settleScope`, `settledUi`, `openScope` in `features/tasks/tasksScope.ts`, with their callers in `DetailPanel`, `ArchivedPanel`, `useTasksScope`, `Screen` and `taskCommands`, and their tests). They do nothing now that the history keeps no task or scope, and removing `settleScope` stops a gone scope from being reset to the roots when the person acts, so it is its own step. The stage stays unchecked until then.

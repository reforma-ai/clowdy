# UI wireframes (text description)

The owner's four wireframes, described so that anyone (including agents that cannot see images) can build the screens. They are **layout and content references only**: use Clowdy's components and design tokens (terracotta primary, paper surfaces, squircles, Onest), not the wireframes' violet. The spec (`spec.md` §5) wins over a wireframe where they differ; the differences are called out under "Spec overrides".

UI copy is English (the wireframes are Russian: Чаты, Задачи, Агенты, Документы, Настройки). Keep strings next to the components that use them.

## Shell (all screens)

- Window with a hidden title bar. Title band, 48px: on macOS the traffic lights sit at the left and the **project select** follows them; on Windows the caption buttons are at the right. Do not draw fake window buttons.
- Project select: a rounded, bordered control with a folder icon, the project name in semibold, and a chevron (example: "Car Rental"). Opens a list of projects plus "Create project" and "Open existing project…".
- Left **rail**, about 115px wide, a slightly tinted surface with a divider on its right. Four items, each an icon with its label under it, centered: **Chats** (speech bubble), **Tasks** (checkbox), **Agents** (two people), **Documents** (page). The active item sits on a soft tinted rounded plate with the accent color. **Settings** (gear icon + label) is pinned to the bottom of the rail.
- The area right of the rail belongs to the selected section. Sections add their own columns; there is no permanent right panel and no "daemon connected" indicator.

## Chats

- Second column, about 270px: heading "Chats"; a full-width outlined button "+ New chat"; the chat list, one row per chat: speech-bubble icon + title, selected row tinted (example titles: "First version", "Simplify booking", "Architecture questions").
- Main column. Header: chat title in bold (example "Simplify booking"), a status pill with a dot ("● Working") while its orchestrator runs, and an outlined **Stop** button (square icon + "Stop") on the right.
- Stream, top to bottom:
  - user message: a tinted bubble aligned right, time under it ("14:21");
  - orchestrator message: a rounded-square avatar (layers icon), bold "Orchestrator", time, and the bubble with text under it;
  - **progress card**: a bordered rounded card, title "Implementation · 3 of 8 tasks done", a progress bar (accent fill on a grey track), and chips with a link icon and a task key ("CAR-24", "CAR-25") that open the task;
  - event line: a small bolt icon, text "2 executors started", time.
  - tool calls appear as compact collapsible cards (same component as in Agents).
- Composer at the bottom: a bordered rounded container holding an attach (paperclip) icon button, a text input ("Write a message…"), a **mode select** ("Autopilot" with a chevron; options Autopilot / Semi-manual), and a round accent send button (paper plane). The mode is visible before sending and fixed for a started cycle.
- Semi-manual questions render as cards in the stream: wording, options with the recommended one preselected and a one-line consequence each, a field for a custom answer, a "Next" button.

## Tasks

- Header: "Tasks" in bold with a subtitle under it (source and project, e.g. "Internal · Car Rental"; "Linear · Car Rental" for a synced provider). Toolbar on the right: segmented **Board | List**, a search field ("Search tasks…"), an outlined **Filter** button, and a **+ Task** button.
- **Board**: columns from the project's workflow statuses (example: To do 3, In progress 2, Review 1, Done 2). A column header is a tinted pill with a status icon (empty circle, green dot, accent dot, check), the name, and a count badge. Cards are white rounded cards: a cube icon and the task key ("CAR-27"), the title, and when agents are working on it, small chips with a person icon and the agent name ("Agent 07"). The selected card has an accent outline.
- **List**: the same tasks as rows (key, title, status pill, agent chips).
- **Detail panel**, about 400px, opens on the right inside the section when a card is selected: key chip with cube icon and a close X; the title in large bold; a status pill; the description in a grey card; **Executors** (rows with a person icon, "Agent 07 · Interface", status pill "Working"); **Dependencies** (rows with a checkbox, checked when done: "CAR-22 Update API"); **Results** (rows such as "Code changes" with an external-link icon, "Checks" with a "Waiting" pill); **Latest activity** (avatar, "Agent 07 updated the form", "2 minutes ago"); a button "Open in Linear ↗" at the bottom, shown only for tasks that have an external URL. Related chats are listed too (spec §5.4).

## Agents

- Second column, about 375px: heading "Agents", a search field ("Find agent…"), then the **run tree**. Next to the tree heading one compact switch "Show finished", off by default.
- Tree rows: orchestrator row with a chevron, a status dot, bold name ("Orchestrator 01"), a status pill ("Working") and the current work as a subtitle ("Simplify booking"). Children are indented under connector lines: person icon, "Agent 07 · Interface", status pill, and a task chip with a cube icon and key ("CAR-24"). Statuses: Working (green), Waiting (amber), finished (grey). The selected row has an accent outline.
- Right: a header with an avatar, the agent name in bold ("Agent 07"), a status pill, the role line ("Executor · Interface"), and an outlined **Stop** button on the right; under it chips "Task CAR-24" and "Parent: Orchestrator 01", then a divider.
- The agent's stream, using the same message and tool components as chats:
  - the assignment from the parent ("Orchestrator 01 14:21 — Update the booking form …");
  - agent text with avatar, bold name, time;
  - collapsible tool cards: a row with an icon, a verb phrase and a code chip: "Reading file `src/booking/form.tsx`" (file icon), "Searching components ✓" (search icon), "Editing file `src/booking/form.tsx` +42 −18" (code icon, green/red diff stat), "`pnpm typecheck` ✓ Success" (terminal icon); a chevron on the right expands input and output;
  - a live line with a spinner at the end: "Checking confirmation handling…".
- Footer note "Viewing agent work". No input field for sub-agents (spec §5.5).

## Documents

- Second column, about 330px: heading "Documents", a search field ("Find document…"), then the recursive tree of the project's `.clowdy/docs/` folder: folders with chevron and folder icon, files with a page icon, selected file tinted. No folder chooser (spec §5.6).
- Right: breadcrumbs ("docs / decisions / booking-flow.md") with a dot when there are unsaved changes, and an outlined **Save** button at the top right; a tab bar **Editor | Markdown | Preview**; a formatting toolbar (block type select "Text", bold, italic, heading menu, link, bullet list, numbered list, checklist, undo, redo); the document; a thin footer "Markdown · UTF-8".
- Unsaved edits are never overwritten by an agent's change: show a conflict view with both versions and an explicit choice (spec §5.6).

## Spec overrides (what the wireframes show but we do not build)

- No permanent right panel in Chats (related tasks / active agents). The progress card and chips carry the links.
- No "Pause" button; only **Stop**.
- Agents: no "Active / All" chips, no separate "Finished" group, no Tree/List toggle; one "Show finished" switch.
- Documents: no folder selector with a gear.
- Wireframe color (violet) is illustrative; use the design system tokens.

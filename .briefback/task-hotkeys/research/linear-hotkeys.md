# Linear's hotkey system: what it is and why it feels good

Researched 2026-11-17. Scope: the Tasks-relevant subset (issue list, board, issue detail, create issue, command menu, navigation, text editing).

## Summary

- Linear publishes **no single shortcuts page** in its docs (`/docs/keyboard-shortcuts` returns 404 on 2026-11-17). The complete list lives in an in-app overlay (`?` or Cmd/Ctrl+/) that I could not open. Everything below is rebuilt from per-feature docs pages, the dated official changelog (26 pages, 2019 to 2026-11-12), and clearly labelled secondary sources.
- The system rests on **five ideas**: (1) one command menu (Cmd/Ctrl+K) that is context-aware and doubles as the property picker; (2) single-letter keys that act on a *target* (the hovered or highlighted row, the selected set, or the open issue); (3) two-key mnemonic chords (`G` go, `O` open, `M` mark relation, `W` work-on); (4) modifier keys reserved for heavier or destructive actions; (5) shortcuts are taught everywhere (menus, tooltips, a searchable overlay, a trainer) so the keyboard is discoverable, not memorised.
- "Feels good" comes less from the key map than from **polish at the seams**: hover counts as focus, bulk actions reuse the same keys, nearly every change is undoable (Cmd/Ctrl+Z) or shows a toast, shortcuts are suppressed in inputs and date pickers, IME composition and non-US layouts are actively patched (2025 to 2026 fixes).
- **Customisation:** no official evidence that key rebinding exists (see section 3.8). Treat "Linear has custom keybindings" as unverified and probably false.
- Several widely copied third-party lists are **wrong or stale** against first-party sources (rename, edit, due date, `G T`, cycle keys). Section 5 lists the conflicts.

## Evidence key

| Tag | Meaning |
| --- | --- |
| **Docs** | Current official docs page, fetched 2026-11-17 (pages carry no publish date; the fetch date is the date). |
| **Log** | Official changelog entry; date given. Can be superseded by a later entry or by a docs rewrite. |
| **2nd** | Third-party page. Used only to fill gaps and always labelled. |
| **Inf** | My inference from evidence; not stated by Linear. |

Confidence column in tables: **H** = stated on current docs; **M** = changelog only (dated), or docs and changelog disagree on a detail; **L** = secondary source only; **?** = conflicting or unverified, do not rely on it.

## 1. Principles

### 1.1 The command menu is the universal entry point and is contextual

- Cmd/Ctrl+K opens it. With one or more issues highlighted or selected, it offers the actions that apply to that view or selection. [Docs: creating-issues "Select issues", "Take actions on selected issues"; Log 2019-10-08 "Contextual command menu"]
- Groups are ordered by what you are looking at: in a cycle view, cycle commands come first. Commands are subdivided by type and carry icons. [Log 2019-12-19 "New command menu"]
- It is also the **property picker**. Clicking an assignee or priority control opens the same menu, "closer to the UI element that it was invoked from", "almost like a drop-down element but still retains its searchability and keyboard controllability". [Log 2019-10-08]
- Search is scoped by prefixes: `i ` issues, `p ` projects, `u ` users, `t ` teams, `l ` labels, `f ` favorites, `d ` documents; `v ` for custom views. Typing or pasting an issue ID (also a git branch name) and pressing Enter opens it. [Docs: search; Log 2024-01-17; Log 2021-04-23]
- Search became fuzzy on 2026-09-03; pasting internal Linear URLs or a GitHub PR link opens the target (2025-07-17, 2026-06-04). Accents are stripped (2024-01-17). [Log]
- Everything reachable by a shortcut is also in the menu, so the menu is the fallback when a key is forgotten. A 2020 post says the contextual (right-click) menu exists partly to teach shortcuts. [Linear blog "Invisible details", 2020-09-17]

### 1.2 Single-letter keys act on a target

- `A` assign, `I` assign to me, `S` status, `P` priority, `L` labels, `C` create, `F` filter, `H` snooze/remind, `X` select, `T` toggle group. They need no modifier and no menu first.
- The **target** is, in order: the selected issues; otherwise the highlighted issue (hover or J/K); otherwise the open issue. "Press `A` when viewing or hovering over an issue to open the assignment menu." [Docs: assigning-issues]
- A Descript guide (a customer's, hosted on Linear's blog, 2024-01-31) says the single keys work "for whatever the active item is you have selected". [Linear Now, community post; customer voice, not Linear docs]

### 1.3 Two-key chords are mnemonic and namespaced by the first key

| Prefix | Meaning | Examples (verified rows in section 4) |
| --- | --- | --- |
| `G` then X | **G**o to a place | `G I` inbox, `G M` my issues, `G A` active, `G B` backlog, `G X` archive, `G T` triage |
| `O` then X | **O**pen a named thing (opens a searchable picker) | `O I` issue, `O P` project, `O F` favorite, `O U` user, `O T` team, `O S` settings page, `O W` workspace |
| `M` then X | **M**ark a relation | `M B` blocked, `M X` blocking, `M R` related, `M M` duplicate |
| `W` then `O` | **W**ork on issue, open in coding tool | `W O` menu of tools |

The `O` family opens a menu you can type in, so a chord is "category key, then fuzzy search". [Log 2019-10-01 "New shortcut commands"; Log 2020-03-04; Docs: search, assigning-issues]

### 1.4 Modifiers are for heavier or destructive actions

Cmd/Ctrl+Delete deletes, Cmd/Ctrl+Z undoes, Cmd/Ctrl+Shift+M moves an issue to another team, Cmd/Ctrl+Shift+O creates a sub-issue, Cmd/Ctrl+Shift+P sets the parent, Cmd/Ctrl+Shift+S manages subscribers, Cmd/Ctrl+Enter submits. Rare actions are pushed behind modifiers and the menu. [Docs: delete-archive-issues, creating-issues, parent-and-sub-issues, my-issues]

### 1.5 Discoverability is built in

- A searchable shortcuts overlay opens with `?` (since 2021-03-25) and with Cmd/Ctrl+/ (added 2025-01-23). A command-menu action also opens it (2022-12-08).
- Menus and tooltips show the key. Missing tooltip shortcuts are treated as bugs (2023-08-16).
- A **shortcut trainer** shows hints after you click certain buttons; it can be switched off in Preferences (2023-05-11).
- Shortcut hints "highlight whichever key is pressed" (2026-01-22). [Inf: this is chord progress feedback.]
- A "keyboard-only" practice mode (pointer disabled) shipped 2024-04-03 and was removed 2025-03-19.
- Contextual (right-click) menus show the key beside each action (2020-08-26).

### 1.6 Focus and selection model (lists and boards)

- By default **no issue is selected** when a list or board opens. [Docs: creating-issues]
- **Highlight** with hover, or Up/Down or J/K. Home/End jump to the ends (2020-08-26). After navigating back from a detail view the previously active item is restored (2025-04-30) and scroll position is restored (2026-02-05).
- **Select** with `X` on the highlighted issue, Shift+click, Shift+X (board docs), Shift+Up/Down to extend, or Cmd/Ctrl+A for every issue in the filtered list. Esc clears. [Docs]
- Highlight and selection are the same target for shortcuts: "Highlighting or selecting an issue lets you act on it with keyboard shortcuts, the command menu, or the right-click contextual menu."
- Enter opens (secondary only); Esc goes back and, when text is selected on an issue page, first deselects the text (2022-12-08). Esc in the new-issue modal closes it, offering "Save draft" if there are unsaved changes (Docs), and closes immediately when there are none (2025-08-21).
- Space = **peek**: preview the hovered issue without opening it. Hold for temporary peek or tap to toggle (2019-09-24 originally Alt, moved to Space). Peek is not triggered while typing in inputs (2019-07-29) and is deactivated when the command menu opens (2019-10-08).
- Reorder: with grouping off and ordering Manual, Opt/Alt+Up/Down moves selected issues one step, Opt/Alt+Shift+Up/Down to top or bottom. [Docs: creating-issues]

### 1.7 Bulk selection reuses the same keys

With issues selected, the same single keys (`P`, `L`, `A`, `S`, `Shift+S`) and the command menu apply to all of them. "Common bulk actions appear in a toolbar at the bottom of the view." [Docs: creating-issues, assigning-issues, my-issues]. The command menu shows a **dash** for partial state when the selected issues differ (2024-04-24; labels 2024-05-23).

### 1.8 Undo, toasts, optimistic feel

- Cmd/Ctrl+Z restores a deleted issue [Docs: delete-archive-issues], undoes a team move [Docs: creating-issues], and (by changelog) undoes issue creation and title/description edits (2023-01-12), due dates (2022-03-15), reactions (2022-06-09), label-group changes (2023-01-12), snooze with `Z` in Inbox (2025-04-03). Relations keep their original creation date when undone (2024-05-23). Undoing creation shows an explicit warning when done on the client (2025-02-13).
- Toasts: assigning or unassigning yourself with the key shows a toast (2024-04-24); moving multiple issues shows a toast linking the issues and the target team (2022-03-15); **toasts do not close while the cursor hovers them** (2022-03-15); Cmd/Ctrl+Opt+O opens the latest toast (2022-12-08); bulk notification delete has an Undo button on the toast (2023-09-21).
- Optimistic UI follows from Linear's local-first sync engine (talk "Scaling the Linear Sync Engine", 2023-06-29, https://linear.app/now/scaling-the-linear-sync-engine). I did not watch the talk; the page only states its scope. [Inf: instant key feedback relies on it.]

### 1.9 Text entry versus shortcuts

- Single-key shortcuts are suppressed in text fields. Known edge cases were fixed one by one: the create-issue key firing while adding members (2026-04-16), global keys firing while editing a date field (2024-08-08), peek in inputs (2019-07-29).
- Where a modifier shortcut collides with the editor, the **focus context decides**: Cmd/Ctrl+Shift+C toggles inline code when the editor is focused, otherwise copies the current URL (2023-03-10; before 2022-12-08 it added the issue to the active cycle).
- Cmd/Ctrl+Enter submits a comment; a preference switches submit to plain Enter. Esc in the issue editor offers to save a draft. Cmd/Ctrl+Shift+Enter saves and creates another with the same values. [Docs: account-preferences, comment-on-issues, parent-and-sub-issues]
- Desktop app benefit stated by Linear: "Keyboard shortcuts have less risk of conflicting with browser-based presets". [Docs: get-the-app]

## 2. Why it feels great (evidence versus inference)

| Quality | Evidence | Inference |
| --- | --- | --- |
| No mode switch between mouse and keyboard | Hover = highlight = shortcut target [Docs]; clicking a control opens the same command menu as the key [Log 2019-10-08] | Users can mix mouse and keys per action without learning two systems. |
| Short keys for frequent actions, chords for navigation | Single letters for properties; `G`/`O` chords [Docs, Log] | Frequency-weighted key assignment keeps common actions at one keypress. |
| One vocabulary across single, bulk, menu, right-click | Same actions in all four places [Docs: creating-issues] | One action registry feeds every surface. |
| Forgiveness | Undo and toasts almost everywhere (section 1.8) | Fast keys are only safe because mistakes are cheap. |
| Teaching | Overlay, trainer, hints, tooltips, context menus | Discoverability is a first-class feature, with a trainer to build habit. |
| Sustained polish | 2026 fixes: numeric shortcuts on non-US layouts (03-12), `[` `]` on Nordic keyboards (04-30), `Alt+letter` treated as plain letter on Windows/Linux (05-14), IME composition triggering actions (2025-12-04) and unresponsive command menu with CJK IMEs (2026-02-05), `Ctrl+Shift+1-9` (08-13) | Key handling is a continuing maintenance cost; a hotkey layer needs layout, IME and AltGr tests from the start. |

## 3. Behaviour details

### 3.1 Property pickers

- Opening a picker uses a command-menu surface anchored to the control, searchable, keyboard driven (Enter picks). [Log 2019-10-08]
- Command menus with numbered options accept the digit to filter or pick (e.g. Open team) [Log 2021-03-18]; views use `1` to `9` for tabs [Log 2023-08-16, 2024-10-24]; triage uses `1`/`2`/`3` [Docs: triage; Log 2026-07-30].
- **Not found:** an official statement that digits 0 to 4 pick a priority inside the priority picker. One secondary page lists Shift+1 to Shift+4 as direct priority keys (fastshortcuts.com, "June 2026"); I treat that as unverified.
- Status by position: Cmd/Ctrl+Opt/Alt+1 to 9 sets the status of the selected issues by the team's workflow order [Log 2020-05-27]. A 2020-11-25 entry says status keys were "remapped" without naming the keys, so this is M at best.
- Picker rows show the current state; labels show partial selection with a dash for mixed selections [Log 2024-04-24, 2024-05-23].

### 3.2 Key hints in menus

Context menu and command menu rows show the key. A missing tooltip shortcut was fixed as a bug (2023-08-16). The shortcut overlay is searchable. [Log]

### 3.3 Chord timing

Not documented by Linear. The only hints are bug fixes: "shortcuts triggering even though some keys had been released" (2022-11-10) and "an incorrect keyboard action could fire when rapidly using system-wide keyboard shortcuts" (2024-06-20). The 1000 ms inter-key default seen in open-source libraries (section Part B) is a reference point, not Linear's value.

### 3.4 Conflict handling with text inputs

See 1.9. Rule of thumb that fits the evidence: single keys and Shift+letter are off in text fields; modifier chords stay on or are decided by focus context; Esc and Cmd/Ctrl+Enter stay on in inputs; date pickers and member pickers need explicit exceptions.

### 3.5 Shortcuts in dialogs and menus

Peek is disabled while the command menu is open (2019-10-08). Property keys work inside the create-issue modal and the sub-issue editor (2023-01-12, 2024-09-06). `Esc` closes the modal. A selection in a menu made with Enter must not also navigate to the issue (2023-08-16 fix). Inference: a focus-scope stack exists (modal over view over app).

### 3.6 Platform notes

Cmd becomes Ctrl and Option becomes Alt. Exceptions Linear made: Insights panel is Alt+Shift+I on Windows/Linux to avoid browser dev tools (2025-01-23); board move between columns on Windows moved from Alt+Left/Right to Ctrl+Left/Right (2022-09-22); copy ID and branch use punctuation keys (Cmd/Ctrl+`.`, Cmd/Ctrl+Shift+`.`) after the 2019-06-21 "international keyboard shortcut improvements"; back/forward added Cmd+Left/Right beside Cmd+`[`/`]` for layouts where brackets are awkward (2021-09-23).

### 3.7 Non-US layouts and IME

Evidence of continuing work only (list in section 2). No statement of the matching strategy (key versus code). Inference: Linear matches mostly by produced character with fixes for digits, brackets and Alt combinations, which is why those keys broke on some layouts.

### 3.8 Customisation and vim-like options

- The Preferences docs page (fetched 2026-11-17) lists General, Interface and theme, Desktop application, Automations and workflows. There is no keyboard or rebinding section.
- A scan of the full changelog (26 pages) found no entry about custom keybindings, rebinding, vim mode or layout presets.
- A search-engine summary attributed an unnamed third-party guide with "Preferences > Keyboard" rebinding; I could not locate that page and two other third-party pages (keycombiner.com, hotkys.com) do not mention it. **Treat as unverified.**
- Linear does ship `J`/`K` list navigation and `G`-chords, which are vim-flavoured, but there is no vim mode.

## 4. Grouped shortcut table (Tasks subset)

Win/Linux column: Cmd becomes Ctrl, Option becomes Alt. "same" = identical key.

### 4.1 Global, help, command menu, search

| Action | macOS | Win/Linux | Conf | Source |
| --- | --- | --- | --- | --- |
| Command menu | Cmd+K | Ctrl+K | H | Docs creating-issues; Log 2022-11-10 |
| Shortcut overlay | `?` | `?` | M | Log 2021-03-25 |
| Shortcut overlay (alt) | Cmd+/ | Ctrl+/ | M | Log 2025-01-23 |
| Search workspace | `/` | same | H | Docs search |
| Search within current view | Cmd+F | Ctrl+F | H | Docs search, inbox (Esc clears) |
| Quick open recent issue | `O` then `I` | same | H | Docs search |
| Open latest toast | Cmd+Opt+O | Ctrl+Alt+O | M | Log 2022-12-08 |
| Back / forward in history | Cmd+[ , Cmd+] (also Cmd+Left/Right) | Ctrl+[ , Ctrl+] | M | Log 2019-10-08, 2021-09-23 |
| Toggle sidebar / details pane | `[` / `]` | same | M | Log 2023-01-12, 2026-04-30 |
| Open linear agent chat | Cmd+J | Ctrl+J | H | Docs linear-agent |

### 4.2 Navigation (G, O chords)

| Action | Keys | Conf | Source |
| --- | --- | --- | --- |
| Inbox | `G` `I` | H | Docs inbox |
| My issues | `G` `M` | H | Docs my-issues |
| Team active issues | `G` `A` | H | Docs default-team-pages |
| Team backlog | `G` `B` | H | Docs default-team-pages |
| Team archive | `G` `X` | H | Docs default-team-pages, delete-archive-issues |
| Triage | `G` `T` | H | Docs triage |
| All issues / active cycle / cycles / projects / upcoming cycle / board | `G E` / `G V` / `G C` / `G P` / `G W` / `G D` | ? | Log 2019-10-01 lists `G E` all issues, `G V` active cycle and `G B` board (the last now differs); others from pie-menu.com (2nd, undated) |
| Open favorite | `O` `F` | H | Docs favorites |
| Open user profile | `O` `U` | H | Docs custom-views |
| Open team | `O` `T` | H | Docs triage |
| Open view | `O` `V` | H | Docs custom-views; Log 2026-04-02 |
| Open project | `O` `P` | M | Log 2019-10-01, 2022-10-13, 2024-05-23 |
| Open cycle | `O` `C` | M | Log 2019-10-01 |
| Open document | `O` `D` | M | Log 2022-02-03 |
| Open settings page | `O` `S` | M | Log 2025-07-24 |
| Open pull request / linked PRs | `O` `R` / `O` `G` | M | Log 2025-07-17, 2026-09-03 |
| Switch workspace | `O` `W` then digit | M | Log 2024-03-19 |
| Open my profile | `O` `M` | M | Log 2020-08-26 |
| Go to view tab N | `1` to `9` | M | Log 2024-10-24 |
| Go to team N | Ctrl+Shift+1..9 | M | Log 2020-09-02, 2026-08-13 (fix) |

### 4.3 Issue list and board: focus, selection, layout

| Action | macOS | Win/Linux | Conf | Source |
| --- | --- | --- | --- | --- |
| Move highlight | Up/Down or `J`/`K` | same | H | Docs creating-issues |
| Jump to first/last | Home / End | same | M | Log 2020-08-26 |
| Open highlighted issue | Enter | same | L | 2nd pie-menu.com, fastshortcuts.com |
| Select/deselect highlighted | `X` | same | H | Docs |
| Select a range | Shift+Up/Down after first selection; Shift+click | same | H | Docs creating-issues |
| Select multiple (board) | Shift+X or Shift+click | same | H | Docs board-layout |
| Select all (filtered) | Cmd+A | Ctrl+A | H | Docs creating-issues |
| Clear selection / back | Esc | same | H | Docs; Log 2022-12-08 |
| Peek highlighted issue | Space (hold or tap) | same | H | Docs board-layout; Log 2019-09-24 |
| Move selected one step | Opt+Up/Down | Alt+Up/Down | H | Docs creating-issues |
| Move selected to top/bottom | Opt+Shift+Up/Down | Alt+Shift+Up/Down | H | Docs |
| Move card between columns (board) | Opt+Left/Right | Ctrl+Left/Right (Windows) | M | Log 2022-03-15, 2022-09-22 |
| Toggle group / swimlane collapse | `T` | same | H | Docs custom-views, board-layout |
| List/board toggle | Cmd+B | Ctrl+B | H | Docs display-options, board-layout |
| Display options | Shift+V | same | H | Docs display-options |
| Open filter menu | `F` | same | H | Docs filters |
| Clear last / all filters | Shift+F / Opt+Shift+F | Shift+F / Alt+Shift+F | L | 2nd pie-menu.com, fastshortcuts.com |
| Save filtered list as view | Opt+V | Alt+V | H | Docs custom-views |
| View ordering / grouping / rows / columns | Shift+Opt+O / G / R / C | Shift+Alt+... | M | Log 2024-12-18 |

### 4.4 Issue actions and properties

| Action | macOS | Win/Linux | Conf | Source |
| --- | --- | --- | --- | --- |
| Assign | `A` | same | H | Docs assigning-issues |
| Assign to me | `I` | same | H | Docs assigning-issues |
| Status picker | `S` | same | H | Docs board-layout ("keyboard shortcut `S`"); 2nd agrees |
| Status by position | Cmd+Opt+1..9 | Ctrl+Alt+1..9 | M | Log 2020-05-27 (may be remapped 2020-11-25) |
| Priority | `P` | same | H | Docs issue-property |
| Priority 0 to 4 inside picker, or Shift+1..4 direct | n/a | n/a | ? | Not found in official sources |
| Labels | `L` | same | H | Docs issue-property |
| Estimate | Shift+E | same | H | Docs issue-property |
| Due date | Shift+D | same | H | Docs issue-property (pie-menu.com lists Cmd+D; wrong per docs) |
| Add to cycle | Shift+C | same | M | Log 2022-12-08 |
| Add to project | Shift+P | same | L | 2nd fastshortcuts.com, hotkys.com |
| Subscribe / unsubscribe | Shift+S | same | H | Docs my-issues, notifications |
| Manage subscribers | Cmd+Shift+S | Ctrl+Shift+S | H | Docs my-issues |
| Remind / snooze | `H` (Shift+H for remind where snooze exists) | same | M | Docs inbox; Log 2025-06-05 |
| Toggle favorite | Opt+F | Alt+F | H | Docs favorites |
| Delete | Cmd+Delete | Ctrl+Delete | H | Docs delete-archive-issues |
| Restore a deleted issue (archives view) | `#` | same | H | Docs delete-archive-issues |
| Undo | Cmd+Z | Ctrl+Z | H | Docs delete-archive-issues |
| Move to another team | Cmd+Shift+M | Ctrl+Shift+M | H | Docs creating-issues |
| Rename | Shift+R | same | M | Log 2023-12-06 (older `R` is stale; `R` now replies to a comment) |
| Edit issue | Opt+E | Alt+E | M | Log 2023-03-16 (older `E` repurposed for archiving in Inbox) |

### 4.5 Relations and hierarchy

| Action | Keys | Conf | Source |
| --- | --- | --- | --- |
| Mark blocked by | `M` `B` | H | Docs issue-property |
| Mark blocking | `M` `X` | H | Docs issue-property |
| Relate / reference | `M` `R` | H | Docs issue-property |
| Mark duplicate | `M` `M` | H | Docs triage |
| Remove relation | Shift+M | M | Log 2020-03-04 |
| Create sub-issue | Cmd/Ctrl+Shift+O | H | Docs parent-and-sub-issues |
| Set parent issue | Cmd/Ctrl+Shift+P | H | Docs parent-and-sub-issues |
| Open parent issue | Cmd/Ctrl+Shift+Up | M | Log 2025-04-03 |
| Open sibling / sub-issue | Cmd/Ctrl+Shift+Right / Down | M | Log 2024-05-23; 2nd pie-menu.com |

### 4.6 Copy family

| Action | macOS | Win/Linux | Conf | Source |
| --- | --- | --- | --- | --- |
| Copy issue ID | Cmd+. | Ctrl+. | M | Log 2019-06-21 |
| Copy git branch name | Cmd+Shift+. | Ctrl+Shift+. | M | Log 2019-06-21, 2020-04-14, 2025-09-18 |
| Copy issue URL | Cmd+Shift+, | Ctrl+Shift+, | M | Log 2020-02-04 |
| Copy issue title | Cmd+Shift+' | Ctrl+Shift+' | M | Log 2022-04-07 |
| Copy ID and title | Cmd+Shift+Opt+' | Ctrl+Shift+Alt+' | M | Log 2025-12-04 |
| Copy page URL (not in editor) | Cmd+Shift+C | Ctrl+Shift+C | M | Log 2022-12-08, 2023-03-10 |
| Copy issue as Markdown | Cmd+Opt+C | Ctrl+Alt+C | M | Log 2025-02-13 |
| Open in coding tool | W then O (menu); Cmd+Opt+. (last used) | Ctrl+Alt+. | H | Docs assigning-issues |

### 4.7 Create issue (modal)

| Action | macOS | Win/Linux | Conf | Source |
| --- | --- | --- | --- | --- |
| New issue | `C` | same | H | Docs creating-issues |
| New issue from template | Opt+C | Alt+C | H | Docs creating-issues, issue-templates |
| Full-screen issue editor | `V` | same | L | Log 2021-03-10 (old editor); 2nd fastshortcuts.com |
| Save issue | Cmd+Enter | Ctrl+Enter | M | Log 2021-03-10 |
| Save and create another with same values | Cmd+Shift+Enter | Ctrl+Shift+Enter | H | Docs assigning-issues, parent-and-sub-issues |
| Save then open | Cmd+Opt+Enter | Ctrl+Alt+Enter | M | Log 2021-03-10 |
| Close modal, offer draft | Esc | same | H | Docs creating-issues |
| "Create more" toggle | click | click | M | Log 2021-03-10, 2025-07-17 |
| Property keys inside modal | same single keys | same | M | Log 2023-01-12, 2024-09-06 |

### 4.8 Issue detail, comments, text editing

| Action | macOS | Win/Linux | Conf | Source |
| --- | --- | --- | --- | --- |
| Submit comment | Cmd+Enter (or Enter, per preference) | Ctrl+Enter | H | Docs comment-on-issues, account-preferences |
| Comment inline on selection | Cmd+Opt+M | Ctrl+Alt+M | H | Docs comment-on-issues |
| Add comment (focus box) | Cmd+M | Ctrl+M | L | 2nd |
| Open details sidebar | Cmd+I | Ctrl+I | L | 2nd (docs only use Cmd+I for cycle sidebar) |
| Attach file | Cmd+Shift+U | Ctrl+Shift+U | M | Log 2023-07-20, 2023-11-15 (docs comment page says Cmd+Shift+A, stale) |
| Bold / italic / link | Cmd+B / Cmd+I / Cmd+K | Ctrl+... | H | Docs editor |
| Strikethrough | Cmd+Shift+X | Ctrl+Shift+X | M | Log 2026-06-11 (docs editor page still says Cmd+Shift+S, stale) |
| Inline code | Cmd+Shift+C (editor focused) | same | M | Log 2023-03-10 |
| Numbered list | Cmd+Shift+9 | Ctrl+Shift+9 | H | Docs editor |
| Bullet / checklist | Cmd+Shift+8 / Cmd+Shift+7 | same | L | 2nd pie-menu.com |
| Heading / body | Cmd+Opt+0..4 | Ctrl+Alt+0..4 | M | Log 2026-03-12 |
| Toggle checklist item | Cmd+Enter (Shift for nested) | Ctrl+Enter | M | Log 2026-07-30 (flipped from Opt/Alt+Enter on 2026-04-02) |
| Move block up/down | Opt+Up/Down | Alt+Up/Down | M | Log 2023-09-28 |
| Create sub-issue from selection | Cmd/Ctrl+Shift+O | | H | Docs parent-and-sub-issues |
| Slash menu / mention | `/` / `@` | same | H | Docs editor |
| Editor undo | Cmd+Z | Ctrl+Z | H | Docs editor |

### 4.9 Inbox and triage

| Action | Keys | Conf | Source |
| --- | --- | --- | --- |
| Navigate list | `J`/`K` or Up/Down | H | Docs inbox |
| Delete notification / all read | Backspace / Shift+Backspace | H | Docs inbox |
| Mark read/unread | `U` | H | Docs inbox |
| Mark all read | Opt/Alt+U | H | Docs inbox |
| Snooze | `H` | H | Docs inbox |
| Archive notification | `E` | M | Log 2023-03-16; Linear customer guide |
| Undo snooze | `Z` | M | Log 2025-04-03 |
| Unsubscribe | Shift+S (after opening the issue) | H | Docs inbox |
| Triage accept / decline / duplicate / snooze | `1` / `2` / `3` / `H` | H | Docs triage; Log 2026-07-30 |

## 5. Conflicts between sources (do not copy third-party lists blindly)

| Item | First-party | Third-party claim | Verdict |
| --- | --- | --- | --- |
| Rename issue | Shift+R (Log 2023-12-06) | `R` (fastshortcuts.com, hotkys.com) | Third party stale. |
| Edit issue | Opt+E (Log 2023-03-16) | `E` | Third party stale. |
| Due date | Shift+D (Docs) | Cmd+D (pie-menu.com) | pie-menu wrong. |
| `G T` | Triage (Docs triage) | "Teams" (fastshortcuts.com) | fastshortcuts wrong. |
| Add to active cycle | Shift+C adds to any cycle; Cmd+Shift+C was repurposed (Log 2022-12-08) | `M`; Cmd+Shift+C | Both stale. |
| `G B` | Team backlog (Docs) | Board (Log 2019-10-01) | Docs win. |
| Delete | Cmd/Ctrl+Delete (Docs) | Cmd+Backspace (hotkys.com, same key on Mac) | Same physical key on macOS keyboards. |
| Strikethrough | Cmd/Ctrl+Shift+X (Log 2026-06-11) | Docs editor still lists Cmd/Ctrl+Shift+S | **Docs lag the changelog.** |
| Attach file | Cmd/Ctrl+Shift+U (Log 2023) | Docs comment page lists Cmd/Ctrl+Shift+A | Docs stale. |
| Checklist toggle | Alt/Opt+Enter (Log 2024-05-23) then Cmd/Ctrl+Enter (Log 2026-04-02 to 2026-07-30) | Docs editor says Cmd/Ctrl+Enter | Latest: Cmd/Ctrl+Enter. |

Take-away for process: the docs lag the changelog, and third-party lists lag both. Any parity target should be dated and, ideally, verified in the app overlay.

## Sources (all accessed 2026-11-17 unless noted)

Primary, Linear Docs (markdown at `https://linear.app/docs/<slug>.md`; no page carries a publish date):
- https://linear.app/docs/creating-issues (Issues; contains "Select issues")
- https://linear.app/docs/search
- https://linear.app/docs/assigning-issues
- https://linear.app/docs/issue-property (status, priority, labels, relations, estimates, due dates; fetched with `Accept: text/markdown`)
- https://linear.app/docs/parent-and-sub-issues
- https://linear.app/docs/delete-archive-issues
- https://linear.app/docs/comment-on-issues
- https://linear.app/docs/editor
- https://linear.app/docs/inbox
- https://linear.app/docs/triage
- https://linear.app/docs/my-issues
- https://linear.app/docs/board-layout
- https://linear.app/docs/display-options
- https://linear.app/docs/filters
- https://linear.app/docs/custom-views
- https://linear.app/docs/favorites
- https://linear.app/docs/account-preferences
- https://linear.app/docs/get-the-app
- https://linear.app/docs/default-team-pages (default views, G A / G B / G X)
- https://linear.app/docs/linear-agent
- https://linear.app/docs/notifications, https://linear.app/docs/issue-templates, https://linear.app/docs/use-cycles

Primary, Linear changelog (paged markdown, pages 1 to 26 scanned for keyboard, shortcut, command menu, undo, toast, IME, layout):
- https://linear.app/changelog (page 1 is 2026-11-12). Individual dated entries cited inline: 2019-06-20, 2019-09-24, 2019-10-01, 2019-10-07, 2019-12-18, 2020-03-04, 2020-05-26, 2020-08-26, 2021-03-10, 2021-03-25, 2022-03-15, 2022-12-08, 2023-01-12, 2023-03-10, 2023-05-11, 2024-04-03, 2024-12-18, 2025-01-23, 2025-03-19, 2025-06-05, 2025-12-04, 2026-01-22, 2026-02-05, 2026-03-12, 2026-04-02, 2026-04-30, 2026-05-14, 2026-06-11, 2026-07-30, 2026-09-03.
- https://linear.app/now/invisible-details (2020-09-17), https://linear.app/now/scaling-the-linear-sync-engine (2023-06-29), https://linear.app/now/descript-internal-guide-for-using-linear (customer guide, 2024-01-31).

Secondary (labelled 2nd above):
- https://fastshortcuts.com/shortcuts/linear/ (body says "June 2026", footer 2026; unverified aggregator)
- https://www.pie-menu.com/shortcuts/linear (undated; mac only)
- https://hotkys.com/apps/linear/default (undated; links to a 2021-03-25 changelog entry)
- https://keycombiner.com/linear/ (footer 2020-2023; no shortcut list)

## Open questions

1. Exact chord timeout and cancel rules in Linear (not published).
2. Whether number keys pick options inside the priority and status pickers.
3. Whether any shortcut remapping exists in Settings (official evidence says no).
4. Current mapping for `G C`, `G P`, `G V`, `G W`, `G E`, `G D`, "add to project", "open issue = Enter" in the live app overlay.
5. How Linear matches keys (character versus physical position) on non-US layouts.

## Assumptions and limits

- I could not open the Linear app or its `?` overlay, so no row is verified against the live UI. "H" rows are verified against current docs text, which itself lags the changelog.
- `https://linear.app/docs/select-issues` and `/docs/default-views` no longer resolve as `.md`; the content now lives under creating-issues and default-team-pages. `/docs/keyboard-shortcuts` is a 404.
- WebFetch summarisation was avoided for the key pages: docs and changelog were downloaded as markdown and read directly. The two Linear posts (sync engine talk, Invisible details) were read as text, not video.
- Changelog glyphs sometimes lose punctuation or modifier characters (for example the 2021-03-10 key list); where a key list looked corrupted I did not use it.
- Third-party pages were used only for rows marked L or ?.

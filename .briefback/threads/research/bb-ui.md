# bb threads: what the person sees

Source: `get-bb/bb` at `9f4c15646d3d7d9320191d4a2cd76199471a1ddc` (2026-11-19), read only, not run. Paths are relative to the bb repo root.

## Summary

- A child thread is a **normal thread** with a parent link. It has the same page, the same composer and the same actions. Nothing in the UI makes it read only.
- The sidebar is a plugin (`plugins/thread-list`). It draws the parent link as a **collapsible tree**, up to the depth cap, and rolls the status of collapsed children into the parent's row.
- The parent chat shows system cards and "Sent to" cards in its timeline, and a "Child threads" list with status glyphs in the info panel. There is no live counter in the chat itself.

## Sidebar tree

| What | Where |
| --- | --- |
| Plugin and its promises ("Nested child threads, worktree grouping, drag to reorder, pin, nest, and move between sections") | `plugins/thread-list/PLUGIN_OVERVIEW.md` |
| Tree is built from `parentThreadId` among the project's threads; a child whose parent is not in the list is a root | `plugins/thread-list/app/model/project-thread-groups.ts:405-490` |
| Row with depth indent and guide line | `plugins/thread-list/app/rows/ThreadRow.tsx:203-210,472-474` (`getSidebarThreadRowPaddingLeft(depth)`, `getSidebarThreadGroupLineLeft`) |
| Collapse: a chevron on any parent row, `Expand|Collapse <title> threads`; collapsed ids are stored and synced across windows | `ThreadRow.tsx:667-678`, `SidebarChildToggleChevron.tsx`, `plugins/thread-list/app/preferences/` |
| Collapsed parent rolls up the hidden descendants' indicators and draft state | `ThreadRow.tsx:417-441`, `packages/plugin-sdk/src/internal/thread-status.ts:121-178` |
| Drag a row onto another to nest it (calls `updateThread parentThreadId`, which sends the ownership notices) | `plugins/thread-list/app/dnd/` |
| Forks are **not** nested: they are ordinary rows; the info panel lists them under "Forks" and "Forked from" | `apps/app/src/components/secondary-panel/info/RelatedThreadsSection.tsx:83-91`, `apps/app/src/views/thread-detail/useParentThreadSection.ts` |

Status marks (`thread-status.ts:14-30,104-120`), in priority order: unread error, waiting for input (a pending interaction anywhere in the subtree), plan mode, **runtime** (the thread or a hidden child is active, starting or stopping), workflow running, queued message failed, unread success, background agent running, background command running, queued message waiting, draft. Unread marks only count for root threads (`isUnreadDoneThread` requires `parentThreadId === null`), so a finished child does not make the sidebar look unread by itself.

## Opening and writing to a thread

- A child opens like any thread (`getThreadRoutePath`), in a pane or split. The composer is the normal one; messages from the person are ordinary user messages, steered into a running turn or started as a turn (the same `tell` machinery).
- The prompt box shows a context banner "Parent: <title>" (or "Forked from") linking to the other thread (`useParentThreadSection.ts`, `apps/app/src/views/thread-detail/ThreadContextCardCore.tsx:30-45`).
- The info panel has a **Parent** row: a picker to assign a parent to a root thread, and an X to clear it (the "take over" action, `ThreadDetailView.tsx:1067-1085,1328`), and a **Notify parent** picker `auto|stuck|off` shown only when the thread has a parent (`ThreadMetadataContent.tsx:186-210`).

## The parent chat

- **System cards** in the timeline for each notification: `<thread> finished`, `failed`, `was interrupted`, `needs attention`, `N threads updated`, `assigned to you`, with icons and a collapsible body (`GeneratedConversationMessage.tsx:222-258,340-360`).
- **"Sent to <thread>"** cards for the agent's own `bb thread tell` (parsed from the shell command, `packages/thread-view/src/tool-call-parsing.ts:640-771`) and **"Message from <thread>"** cards in the target.
- `@thread:<id>` mentions render as links.
- The info panel "Child threads" section: count and a list (limit 4 in the context card) with the same status glyph as the sidebar, sorted as given, and a link to each (`ThreadContextCardCore.tsx:48-90`, `RelatedThreadsSection.tsx:66-80`). Forks are filtered out of it.
- No progress strip or counter above the composer for children (inferred from the absence in `apps/app/src/components/promptbox/`; not exhaustively searched).

## Stop, archive, delete

- Stop is per thread. A parent's stop does not touch its children.
- Archive asks first and lists the cascade (`listThreadCascades`, `apps/server/src/services/threads/thread-cascade.ts`), then archives children first, then the parent; running turns get an undo grace.
- Delete passes `childThreadsConfirmed: true` after the same kind of confirmation (`apps/app/src/components/thread/ThreadActionsProvider.tsx:256-325`).

## Not read

- Mobile layout of the tree, the drag and drop details, the composer's per-thread draft handling, and the search palette.

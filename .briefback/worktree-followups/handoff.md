# Handoff: worktree-followups

> Next chat: read this file and the plan when present. Resume within the
> authorized scope, respecting dependencies and existing worker ownership.
> Do not resurrect discarded approaches from a chat summary.

## Plan

path: none (the chat-worktrees plan, `.briefback/chat-worktrees/plan.md`, is the finished feature these topics follow from; read its Decisions and Out of scope)
sync: not used
scope: **Grill only**, three topics the owner wants settled as their own work: a Workspaces page, one tree for all folders, and a menu on Fork with a provider choice. Round 1 was asked and is below with its facts and recommendations; the owner has not answered any question yet. Do not implement before the settled list is confirmed (Briefback grill rules). A plan is written after that only if the confirmed work needs several stages.

## Current work

stage: Grill round 1 (asked in the previous chat, no answers yet)
shipped: nothing for these topics; the chat-worktrees feature itself is merged on `next` (see the plan)
remaining: the owner answers Q1 to Q6; then round 2 (below); then the settled list; then plan or implement
worker: none

stage: Neighbouring work in the previous chat, so these files are busy (read them, do not edit until it lands)
shipped: `a68493e` (`FilesStore` keeps the managers of the last 3 places, `MAX_OPEN_PLACES`)
remaining: (1) branch `worktree-agent-a8342868bbfc96a4f` (commits `e16040f`, `b749b16`, `93febd8`, `3e281d7`): the new-chat page shows the files of an existing worktree before the chat exists, through a `workspace.open` command. It is in independent review and not merged into `next` yet. (2) Right after that merge: the new-chat page's mode chip and branch chip, and the read-only line of a started chat, become one control (`WorkspaceChips.tsx`, `ChatFolder.tsx`, their tests, `DraftChat.tsx`, `UiStore.ts`, `currentPlace.ts`). Do not edit those files from this topic until both have landed; the second one changes the draft's chips that Q5 and Q6 may touch.
worker: the review agent of (1) and the parent chat; results arrive in the previous chat, not here

## Facts (read in the code, no need to re-read to answer)

Workspaces
- A worktree is a `workspaces` row that chats point at (`chats.workspace_id`). `deleteChat` (`apps/daemon/src/domain/chats.ts`) deletes the row with the last chat that points at it; the directory and branch stay unless the delete dialog's checkbox removed them first (`removeChatWorkspace`, `apps/daemon/src/domain/workspaceRemoval.ts`, `GET /v1/chats/:id/workspace`).
- A directory that stays is then just a git worktree: `folderGit` (`apps/daemon/src/git/state.ts`) lists it, and the new-chat "Existing worktree" list offers it. Clowdy-made ones sit under `~/Clowdy/workspaces/<project-slug>/<chat-id8>/<folder-name>/` on the branch `clowdy/<chat-id8>`.
- The removal safety rule (Clowdy made it, no other chat uses it besides the subtree, clean including untracked and submodules, branch and HEAD are ancestors of the base ref) exists only per chat. Squash or remote merges are not recognised as merged.
- Per-folder settings (base branch, setup files and command) live in Settings > Projects > a folder's Workspace dialog (`apps/desktop/src/renderer/features/settings/projects/FolderWorkspaceDialog.tsx`).
- `git-integration` (`.briefback/git-integration/plan.md`, planned in another chat) adds a Changes tab, commit/push and PR surfaces keyed by place; it will revise the "git only reads" line. Check it before designing anything that reads a worktree's git state.

One tree
- The window's place is one folder of the project, or the worktree of the open chat for that folder (`apps/desktop/src/renderer/features/sidePanel/currentPlace.ts`). Files, Docs, Terminal, Info, Cmd+K and `@` all read that place; `FilesStore` keeps a `FileManager` per place (`features/files/FilesStore.ts`).
- The agent gets every other folder of the project as an additional directory (`additionalFolders` in `apps/daemon/src/runs/driver.ts`), so it can edit folder B while the tree shows folder A. The person sees one folder.
- `FileManager` (`packages/file-manager`, forked from Reforma) works over one provider root: tabs, search, clipboard and the watch are per root. A multi-root tree means teaching it several roots.
- A chat's worktree replaces only that chat's own folder; the other folders of the project stay main checkouts. Worktrees for the other folders of a multi-folder project are out of scope in the plan.
- Folders of one project are different repositories (a monorepo, an infra repo, marketing material), each with its own settings.

Fork and hand-off
- Fork today: a hover icon on a final answer, "Fork into new chat" (`apps/desktop/src/renderer/stream/MessageActions.tsx`, `features/chats/forkChat.ts`, `useFork.ts`). The same agent copies its own session (`prepareFork` in `apps/daemon/src/runs/fork.ts`, refused when the agent cannot fork); the copy keeps the folder, agent, model, level, mode and the same worktree row, and shows a divider (`stream/ForkDivider.tsx`).
- Hand-off today is offered only in the read-only notice of a chat whose provider is off (`features/chats/ReadOnlyNotice.tsx`, `features/chats/handoff.ts`): it opens a new-chat draft with the conversation attached as a markdown file and the worktree kept; the provider and model are changed in the draft's own composer.
- A session of one provider cannot be given to another, so "fork to another provider" can only be a transcript hand-off.

## Round 1 (asked, unanswered)

Each: options, then my recommendation.

**Workspaces page**

- **Q1 What the page is for.** Real pain: abandoned worktrees pile up in `~/Clowdy/workspaces`, take disk, and cannot be seen or safely removed anywhere.
  - (a) Cleanup only: the worktrees Clowdy made, with branch, chat, clean or dirty, merged or not, and Remove by the same safety rules.
  - (b) Overview of every worktree of the folder, foreign ones too (Orca, by hand), with Open in Finder, Terminal, editor.
  - (c) No page; an abandoned worktree stays visible and is removed only from the delete dialog.
  - Recommended **(a)**: small, solves the real pain; Clowdy never removes foreign worktrees.
- **Q2 Life of the row.** Today the row goes with the last chat, so a leftover directory cannot be told from a foreign worktree except by its path.
  - (a) As now; own worktrees are recognised by the path under `~/Clowdy/workspaces/...` and the branch `clowdy/<id8>`.
  - (b) A Clowdy-made row stays with no chats ("no chat"), the page lists it and removes it with the directory; a found (foreign) row still goes with the last chat.
  - Recommended **(b)**: exact knowledge instead of a guess from names; cost is one new state ("no chats") in the database.
- **Q3 Where the page lives.**
  - (a) A "Worktrees" dialog in the folder's row in Settings > Projects, beside the Workspace dialog.
  - (b) A separate "Workspaces" page in Settings across all projects.
  - Recommended **(a)**: a worktree belongs to a folder's repository and that folder's settings are already there.

**One tree**

- **Q4 What is actually needed.**
  - (a) A folder switcher in the Files and Docs tabs: changes the panel's place to another folder of the project without changing the chat.
  - (b) A real tree with all folders of the project as roots, like VS Code multi-root.
  - (c) Leave as is.
  - Recommended **(a)**: covers "look at folder B from a chat of folder A" without reworking the forked package. The owner's own use decides: how often is folder B opened from a chat of folder A?

**Fork and hand-off**

- **Q5 What is in the menu.**
  - (a) Two items: "Fork" (a real copy of the session, as now) and "Fork to another agent…" (pick provider and model, transcript hand-off).
  - (b) One Fork button that opens a provider and model choice preset to the chat's own: the same agent is a real fork, another is a hand-off, and the difference is not shown.
  - (c) Fork stays; "Continue in another agent…" goes into the chat's menu only.
  - Recommended **(a)**: the owner asked for "a menu of actions"; two items show honestly what differs (a session copy versus a transcript).
- **Q6 What the chat on another provider receives.**
  - (a) As the hand-off is today: an empty new chat, the conversation as an attached file, the text filled in.
  - (b) A copy that looks like a fork: the same history above a "Forked from…" divider, the same worktree, and the agent gets the conversation as a file on its first turn since it has no session of its own.
  - Recommended **(b)**: it is the "copy-clone" the owner asked for; the fork code already copies the history, so the new work is the missing session fork and the file on the first turn.

## Round 2 (depends on round 1, not asked yet)

- If Q4 is (a): what the switcher changes: only the Files and Docs trees, or the whole panel's place (Terminal, Info, Cmd+K, `@`); is the choice per chat (remembered) or per window; what happens to a chat's own worktree place when another folder is picked.
- Where Fork and the hand-off start from: a hover icon on an answer (fork at that answer) only, or also a chat-menu item for "the latest point".
- Whether the menu offers "Fork into a new worktree" (a copy that continues from the same branch without stepping on the original); recommended not now, since the owner wants the copy "in the same place".
- If Q2 is (b): the migration and what a "no chats" worktree does to the Existing worktree list, and whether Remove there reuses `removeChatWorkspace`'s checks as they are.
- For the page: Remove for an unsafe worktree (dirty, not merged): refuse with the reason plus Open in Finder and Terminal, never force (recommended), or allow with a confirmation.
- Squash and remote merges are not recognised as "merged" today; the page makes that visible, so decide whether it needs a `gh` or fetch based check (the git-integration plan says there is no squash detector).

## Bleed

none. Decided earlier and not to be reopened: the document-of-a-task fallback from a worktree chat was dropped as an invented problem; a hard limit on open file managers was built (3 places); the new-chat page shows the files of an existing worktree (built, in review) and the folder's checkout for a new one; a fork or hand-off from a worktree chat stays in the same worktree. The owner has "a huge list of questions" for the Workspaces page, so expect round 1 to open more.

## Next work

stage: Settle the three topics (grill rounds 1 and 2)
done when: the frontier is empty, the owner confirms a "Settled" bullet list per topic, and the next step is chosen (a plan under `.briefback/worktree-followups/plan.md` if several stages, else offer to implement)
assignment: unassigned
suggested: Briefback grill, then plan; before UI work read `apps/desktop/AGENTS.md` and `packages/components/AGENTS.md`; for the daemon `apps/daemon/AGENTS.md`

Memory for background: `/Users/bionic/.claude/projects/-Users-bionic-WORK-My--kachurun-clowdy/memory/clowdy-worktree-design.md`.

# Worktree cards and management

> Keep this plan current. A stage is complete only after verification, review and commit. Record the commit and checks below each stage.

**Goal:** make worktrees accessible and manageable from day-to-day chat navigation, without losing the flat view or cluttering it with unused trees.

**Approach:** extend the existing removal command and dialog, add a persisted optional view of worktrees in the chat sidebar, then unify removal entry points and offer a guarded cleanup of unused trees.

## Decisions

- Add `Group chats by worktree` alongside the existing folder grouping in Filters, off initially and remembered per project. When enabled, show folder context (nested within folder groups when folder grouping is on; otherwise identify the folder in a worktree card when needed).
- Use compact collapsible cards: rounded shared background around the heading and its nested chat rows, branch label, chevron and More. Reuse Clowdy's visual primitives with the reference's card pattern. Chat threads remain underneath their parent; a thread in a different workspace gets a worktree icon as the lowest-priority trailing indicator, hidden on hover just like the existing status indicators.
- Persist manual worktree group ordering (within the folder when grouped) and collapse state. Root checkout chats are always above worktree cards; reorder chats only within their own group in this view, preserving existing flat/folder orders and archived slots. A selected chat opens its ancestor folds/card once per navigation.
- Unused worktrees (no unarchived chats, including external and archived-only listed trees) belong in a collapsed `Unused worktrees` section. A workspace with live threads is not unused even if it has no root chat. Show real worktrees, refresh after changes and focus, handle missing/pending worktrees without dropping their chats.
- Worktree actions from card More and the current chat's worktree chip: new chat, usual open/copy actions, archive all chats, and `Remove worktree…`. The existing folder settings overview remains available. Use one remove confirmation everywhere. On removal with linked chats offer archive by default or permanent deletion; explain affected chat/descendant counts and separate branch deletion. Running chats or descendants must be stopped before disposition. Leave existing behavior when restoring an archived chat whose tree no longer exists.
- `Tidy up…` is available from folder menu and the full list (also the unused section if useful). Preview checkboxes for only merged, clean, unlocked, non-project, unused worktrees on disk; confirm selected entries, with separate branch choice using the existing base-branch rule. Re-check conditions on execution, report refusals without silently discarding work.

## Stage 1 — Guarded command (CLO-202)

**Depends on:** None.

**This stage:** `workspace.remove` accepts optional `chatDisposition: 'archive' | 'delete'` and `tidy: boolean`. Optional `expectedChatIds: string[]` pins disposition to the exact set of linked chats and descendants confirmed in the UI; a difference refuses removal. Without either option, preserve current behavior. During explicit disposition preflight affected chats and their descendants (existing cascade semantics, deduplicate), protect any active runs, preserve history on archive, and delete permanently only when explicitly requested. Do not dispose of chats if removing the tree fails. Tidy refuses any non-merged, dirty, submodule, missing, blocked, or in-use tree and refuses discard or chat disposition; revalidate just before Git mutates the tree. Guard base branch deletion. Keep fixture transport behavior faithful.

- [x] Complete
  - [x] Protocol, daemon and fixture behavior, with real Git and fixture tests
  - [x] Review race checks and refusal/partial failure behavior

**Files:** `packages/protocol/src/commands.ts`, `apps/daemon/src/domain/workspaceRemoval.ts`, `apps/daemon/src/commands/workspace.ts` plus necessary chat lifecycle guards and daemon tests/guidance; `apps/desktop/src/renderer/daemon/fixtureTransport.ts` and transport tests.
**Done when:** explicit removal works for idle linked chats with both choices, leaves chats/disk unchanged on refusal, and tidy cannot remove changed or in-use worktrees.
**Verify:** daemon worktree removal, chat removal, and worktree list suites; desktop projectsTransport tests; affected typechecks and lint.
**Commits:** `ee4d5aa1` — guarded removal with disposition and cleanup; independent review fixed preview-to-confirm races, explicit working-directory threads, and cross-project chat protection. 407 daemon, 103 desktop transport and 28 protocol tests passed; all three typechecks, target Biome and diff checks passed. External Git remains outside daemon reservations.

## Stage 2 — Sidebar cards (CLO-203)

**Depends on:** None.

**This stage:** group actual root chats by their own worktree, keep thread tree, persist ordering and collapse, show unused groups; include card More with existing non-removal actions. Use `getProjectWorktrees` to supplement workspace records, not to hide pending/missing chats. Stage 3 adds the shared deletion and cleanup items to these menus.

- [x] Complete
  - [x] Grouping, visual cards, ordering, collapse, unused section and indicator
  - [x] Keyboard, drag and selection behavior, persisted view state and tests

**Files:** `apps/desktop/src/renderer/features/agents/AgentList.tsx`, `agentTree.ts`, `useChatListOrder.ts`, `AgentList.module.css`, new card component(s) where warranted, related tests, `apps/desktop/src/renderer/stores/UiStore.ts` and relevant tests; read-only existing worktree API. Own these sidebar paths only; do not edit `GroupFolderName.tsx`, `ChatFolder.tsx` or shared `features/worktrees`/`openWith` files yet.
**Done when:** enabling and disabling grouping works, reorder restrictions hold, workspace-only threads get low-priority indicator, unopened unused trees are manageable through standard actions, and all list states render correctly.
**Verify:** targeted AgentList/agentTree/Screen/UiStore tests, typecheck, lint, and screenshot in isolated fixture renderer.
**Commits:** `6714d96e` — worktree cards; independent review: 323 tests across six suites, desktop typecheck, targeted Biome and diff checks passed. Isolated fixture screenshot before review: `/tmp/clowdy-stage2-worktrees.png`. Real Git UI flow remains for Stage 3.

## Stage 3 — Common remove and tidy UI (CLO-204)

**Depends on:** Stage 1 and Stage 2.

**This stage:** update the existing `openRemoveWorktree` confirmation and worktree actions to use the guarded command; expose it from card and current chat place. Preview actual affected chats (including archived chats and cascaded descendants across worktrees), send their exact IDs as `expectedChatIds` with disposition, and handle selection after archive/delete. Add a reusable tidy preview/dialog and entry points. Refresh data after completion or refusal.

- [x] Complete
  - [x] Unified removal confirmation, chat disposition, direct actions and archive all
  - [x] Tidy selection, branch choice, results and refresh
  - [x] Integrated tests and user-flow verification

**Files:** `apps/desktop/src/renderer/features/worktrees/RemoveWorktreeDialog.tsx`, `WorktreeMenu.tsx`, `worktreeView.ts`, `FolderWorktreesList.tsx`, `ManageWorktrees.tsx`, `useProjectWorktrees.ts` as needed, new tidy dialog, `features/agents/ChatFolder.tsx`, `GroupFolderName.tsx`, card menu from Stage 2, shared `OpenWithMenu` only as needed, relevant tests and desktop guidance.
**Done when:** the user can remove a worktree from the active chat or sidebar card, choose what happens to chats, and clean up eligible trees from a preview without losing unrelated work.
**Verify:** desktop worktree/sidebar and transport tests, daemon worktree suites, combined typecheck/lint/build and isolated end-to-end UI flow.
**Commits:** `e755ee16` — shared worktree removal and Tidy up. Independent review fixed archived-only Tidy eligibility and stale branch/discard confirmations; 350 scoped desktop tests passed. Final clean candidate `/tmp/clowdy-worktree-management-e755ee16`: `bun run --cwd apps/desktop build:app` passed; 557 desktop, 108 daemon and 85 protocol tests passed, all three typechecks passed. Targeted lint passed; full desktop lint found one unrelated formatting error introduced by `e04ee6fb` in `ChatPage.test.tsx`, left for its owner. Real isolated daemon + Git UI verification passed grouped cards, current-chip archive and selection fallback, card permanent deletion, Tidy selection and history preservation, plus six refusal probes (dirty, unmerged, unarchived-linked, locked, main checkout and stale chat IDs). Screenshots: `/tmp/clowdy-verify-xYZTtV/`. Running app/data unchanged; no migration.

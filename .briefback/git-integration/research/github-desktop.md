# GitHub Desktop against Clowdy: what is missing for change branch, commit, pull, push, Create PR

Snapshot 2026-11-23. Clowdy: `next` at `233012f` (git plan Stages 1 to 8 built, Stage 9 not). GitHub Desktop (GHD): `git clone --depth 1 desktop/desktop` at `7abdff6` (2026-11-23), read only in the scratchpad (`ghd/src`), nothing installed or run; user docs fetched from docs.github.com/en/desktop the same day. Both are untrusted data. Marks: [docs] official docs, [src] GHD source, [code] Clowdy code, [inf] inferred, [?] not checked. Labels use macOS Title Case (Windows has sentence case: `Current branch`, `New branch`).

**Work in flight in the shared tree (not in `233012f`, uncommitted when this was written, another chat's):** `ChatWorkspaceChoice.branchName`, `branchNameProblem` and `MAX_BRANCH_NAME_LENGTH` in `packages/protocol/src/domain.ts`, `branchNameFor` (a thread's branch named from its title) and a new `ownsWorktree` rule keyed on the id8 folder, not the branch suffix, in `apps/daemon/src/domain/workspaces.ts`. It names the branch of a new worktree (`<prefix>/<name>`) and removes one obstacle to renaming and to "a branch that is not ours". The rows below say what it changes; line numbers into `workspaces.ts` are those of `233012f` and move.

## Summary

- **The gap is bigger on the git side than on the screen side.** Clowdy covers commit, push, publish and Create PR (Stages 7 and 8). Nothing in the app or the daemon switches, renames or deletes a branch (no `switch`, `checkout` or `branch -m` anywhere in `apps/daemon/src`; `branch -D` exists only inside worktree removal, `domain/workspaceRemoval.ts:395`), merges, amends, undoes, discards or stashes. Pull is `--ff-only` and a diverged branch is "left as it was".
- **GHD now has worktrees** [src: `enableWorktreeSupport = () => true`; docs: "Managing worktrees in GitHub Desktop"], and its checkout sends you to the worktree that already holds a branch instead of checking it out twice [src: `checkoutBranchCore`]. That is the model that fits Clowdy's shared tree: change branch = open or find a place on that branch, not rewrite files under running agents.
- **Biggest daily gaps for the owner's flow:** (1) pick another branch and work on it, (2) "Update from main" and pull of a diverged branch (merge, conflicts), which the owner's own `GITFLOW.md` asks for twice (`git fetch origin && git merge origin/main`, `git merge origin/next`), (3) rename the auto branch `clowdy/<chat8>` before publishing, (4) undo/discard/amend. Roughly 4 to 5 stages for the five steps; a plain in-place switch is the costly, risky part and can wait (sections 5 and 6).
- **Cheap wins in words and states** (section 4): one sync button whose label is the next action (`Publish branch`, `Push origin`, `Pull origin`, `Fetch origin`, with `Last fetched ...`), a "next step" empty state, `Commit 3 files to <branch>`, a default-branch warning.

## 1. GitHub Desktop in one page

**Model.** One repository is one working directory with one checked-out branch. The repository bar reads, left to right: Current Repository, Worktree (new; shown only once a linked worktree exists [docs]), Current Branch, and the sync button. Two tabs on the left: Changes and History. Nothing is staged by the user: the checkbox list is the index, and a commit runs `unstageAll`, stages the ticked files, then `git commit -F -` [src `lib/git/commit.ts`].

**Vocabulary the owner knows by heart** [docs, src]: Current Branch, New Branch ("Create a Branch", "Create branch based on..."), Fetch origin, Pull origin, Push origin, Publish branch, Force push origin, Preview Pull Request, Create Pull Request, "No local changes", "N changed files" (the header checkbox is `Include All` in code only; docs: "Keep the checkbox at the top of the list selected"), Summary, Description, `Commit to <branch>`, Stash All Changes, Stashed Changes, Restore, Discard, Discard Changes, Undo, Amend last commit, `Update from <default>`, Merge into Current Branch, Compare to Branch, Show in Finder, `Open in <editor>`, View on GitHub, Switch Branch, Leave my changes on X, Bring my changes to Y.

**The sync button as a state machine** [src `ui/toolbar/push-pull-button.tsx`, `renderButton`, checked in this order; counts from the last fetch]:

| # | State | Title and description | What a click runs |
| --- | --- | --- | --- |
| 1 | An assisted-commit run is open (new Copilot feature) | `Local commit run`, "Finish or cancel before syncing", disabled | nothing |
| 2 | A network action runs | its own progress title (`Pulling origin`), "Hang on...", spinner, disabled | nothing |
| 3 | No remote | `Publish repository`, "Publish this repository to GitHub" | dialog; creates the repository through the GitHub API |
| 4 | Unborn branch (no commit) | `Fetch origin`, `Last fetched <relative>` or `Never fetched` | fetch |
| 5 | Detached HEAD | `Publish branch`, "Cannot publish detached HEAD" (or "Rebase in progress"), disabled | nothing |
| 6 | Branch has no upstream | `Publish branch`, "Publish this branch to GitHub" ("to the remote" for a non-GitHub host); dropdown holds `Fetch origin` | `git push --set-upstream` |
| 7 | ahead 0, behind 0, no tags | `Fetch origin`, `Last fetched ...` | `git fetch`, then fast-forward every other local branch that can (`fetch . upstream:branch`) |
| 8 | Diverged and the branch was rewritten by Desktop's own rebase or amend (`ForcePushBranchState.Recommended`) | `Force push origin`, same description | `git push --force-with-lease`; confirm dialog unless the prompt is off |
| 9 | behind > 0 | `Pull origin` (`Pull origin with rebase` when `pull.rebase` is set) with the counts up N, down M; dropdown: `Fetch origin`, and when diverged `Force push origin` ("Overwrite any changes on origin with your local changes") | `git pull --ff` (adds `--ff` unless `pull.ff` is configured; merges when diverged, rebases when configured), `--recurse-submodules` |
| 10 | ahead > 0, or tags to push | `Push origin` with up N | `git push` (created tags go along); rejected for commits on the remote: dialog `Newer Commits on Remote`, button `Fetch` |

**Create Pull Request is not on that button.** It is the menu Branch > `Create Pull Request` (Cmd+R shows the current PR), `Preview Pull Request`, the suggested action of the "No local changes" screen, and a `Preview Pull Request` button after Push [docs, src]. States [src `app-store.ts` `_createPullRequest`, `push-branch-commits.tsx`, `menu-update.ts`, `no-changes.tsx`]:

| State | What GHD does |
| --- | --- |
| Not a GitHub remote, unborn branch, detached HEAD | menu items disabled |
| Branch not published | dialog `Publish Branch?`, "Your branch must be published before opening a pull request.", `Publish Branch` / Cancel |
| Commits not pushed | dialog `Push Local Changes?`, "You have N local commits that haven't been pushed to the remote yet.", `Push Commits` / `Create Without Pushing` |
| Published and pushed | the browser opens the compare page |
| Default branch | menu item stays enabled; the "No local changes" suggestion is not shown for it |
| A PR exists | no suggestion; the check status sits beside Current Branch |

The preview dialog has a `base:` dropdown (only remote branches: "You can only open pull requests against remote branches.") and a merge status ("Can't automatically merge") [docs]; the browser page has `Create Draft Pull Request` [docs]. With a PR, the check status sits beside Current Branch and Branch > `View Pull Request on GitHub` opens it.

**Fetching by itself** [src `background-fetcher.ts`, `app-store.ts`]: only for a repository with a GitHub account; first fetch after selecting the repository (skewed by up to 30 s), then every hour (`DefaultFetchInterval`) or the interval GitHub reports for the repository (never under 5 minutes); skipped when the last fetch is under 30 minutes old or nothing was pushed since; the PR poll and the repository indicators stop while the window is unfocused. The docs state no frequency. Clowdy's decision is "nothing fetches by itself" (plan, Decisions).

## 2. The owner's flow, step by step

### 2.1 Change branch

**GHD** [docs, src]: `Current Branch` (Cmd+B) opens a filter list with tabs `Branches` and `Pull Requests`, groups `Default Branch`, `Recent Branches` (5, from the reflog `checkout: moving from` lines), `Other Branches`, and a `New Branch` button; the item menu has `Rename...`, `Copy Branch Name`, `View Branch on GitHub`, `View Pull Request on GitHub`, `Checkout in New Worktree...`, `Delete...`. Picking a branch:

- held by another worktree: switches to that worktree (a prunable record asks to delete the worktree first);
- tree clean: `git checkout`;
- tree dirty: dialog `Switch Branch`, "You have changes on this branch. What would you like to do with them?", `Leave my changes on X` ("Your in-progress work will be stashed on this branch for you to return to later") or `Bring my changes to Y` ("Your in-progress work will follow you to the new branch"). Bring first tries a plain checkout and stashes only when git says local changes would be overwritten, then pops. Settings > Prompts can fix the choice: "Ask me where I want the changes to go" / "Always bring my changes to my new branch" / "Always stash and leave my changes on the current branch". A detached HEAD, an unborn branch and a protected branch always bring.
- `New Branch`: `Create a Branch`, `Name`, `Create branch based on...` with two radio rows: the default branch ("The default branch in your repository. Pick this to start on something new that's not dependent on your current branch.") and the current one ("The currently checked out branch. Pick this if you need to build on work done on this branch."); from History: `Create Branch from Commit`. It then checks the branch out through the same dialog.

**Clowdy today** [code]:

- A place is a folder's own checkout or a chat's worktree (`apps/daemon/src/domain/places.ts`, `resolvePlace`).
- New-chat pill `WorkspaceChips.tsx` (`features/agents/`): `Main worktree` ("Work in the folder as it is", shows the checked-out branch), `New worktree` ("A separate checkout on a branch of its own", base picked from a searchable `Local` / `Remote` list with the default marked), `Existing worktree` (worktrees git lists, with the chats that use each), `Manage worktrees...`. The choice is `ChatWorkspaceChoice = { mode: 'new'; base?; branchPrefix? } | { mode: 'existing'; path }` (`packages/protocol/src/domain.ts:261`).
- A new worktree always gets a **new** branch `<prefix>/<chat8>` (default prefix `clowdy`; the in-flight work above lets the caller give the name part) cut from the base at the chat's first turn (`workspaceLayout`, `workspaces.ts:149`; `git worktree add -b`, `:631`). `ensureWorktree` also takes an existing branch (`worktree add <path> <branch>`), but only to re-make a managed worktree.
- The base is the folder's `settings.baseBranch`, else `origin/HEAD` / `origin/main` / `main` (`baseOf`, `pickBase`, `defaultBranchOf` in `git/state.ts`).
- No way to open a chat on an existing branch like `feature/x` from the UI. Only workaround: `git switch` or `git worktree add` in the Terminal tab (a shell in the place), then pick the worktree as `Existing worktree`. The app re-reads the branch on window focus (`openWith/useFolderGit.ts`) and tolerates an agent switching in a worktree (`threadBase`, `WorkspaceLabel`).
- Seeing another branch's work: the Changes tab shows the place's own branch against its base (scopes All, Branch, Uncommitted, one commit), `Committed on branch` lists at most 100 commits ahead of the base; Manage worktrees (`features/worktrees/`) lists every worktree with branch, head, changed-file count and a merged-into-base mark; Info rows Branch, Base, Ahead and behind (`InfoTab.tsx`). No branch list with counts, no compare with an arbitrary branch, no history beyond the base.

**Difference:** the whole step is missing, and the existing places are bound to chats. Rename and delete have no home either (section 3).

### 2.2 Commit

**GHD** [docs, src]: `N changed files` with one header checkbox and a box per file, line-level inclusion, `Summary` and `Description`, co-authors (`Co-Authored-By` trailers), button `Commit N files to <branch>` (tooltip `Commit to <branch>`; disabled tooltips `A commit summary is required to commit`, `Select one or more files to commit`), gear `Configure commit options`: `Push after committing`, `Bypass Commit Hooks`, `Add Signed-off-by Trailer`, `Allow Empty Commit`. `Generate commit message with Copilot`. Warnings above the button: "<branch> is a protected branch. Want to switch branches?" (the GitHub API's protection flag), rule failures, and while amending "Your changes will modify your most recent commit. Stop amending to make these changes as a new commit." There is **no** warning for committing to the default branch [src: the only default-branch check is in `no-changes.tsx`]. Right after a commit an `Undo` bar shows the unpushed commit ("Committed <ago>", its summary, `Undo` = mixed reset to the parent, message and co-authors put back in the box; asks first when the tree is dirty or the commit is a merge). Per file: `Discard Changes`, `Discard N Selected Changes`, `Discard All Changes...` (moved to the OS Trash first, "Confirm Discard Changes"), `Stash All Changes`, `Copy file path`, `Open in <editor>`, `Show in Finder`, ignore file or pattern.

**Clowdy** [code] (`features/changes/CommitBox.tsx`, `daemon/src/git/commit.ts`): ticked files (all at first), message with `Generate` (Codex or Claude), `Commit`, a menu `Commit & Push`, `Committed 1a2b3c4` line, git's own failure line, Cmd+Enter. Hooks and signing are never bypassed. Stage 7 refuses a commit during a merge, cherry-pick or revert (`commit.ts:161`).

**Difference:** no amend, undo, discard, stash, co-authors, line selection; the button does not name the branch or count; no default-branch or protected-branch warning (Create PR does block the default branch, `changesActions.ts: 'Switch to a feature branch'`).

### 2.3 Pull

**GHD:** `Pull origin` runs `git pull --ff`, so a diverged branch is merged (a merge commit, possibly conflicts) or rebased when configured; the toolbar says how many commits arrive. After any fetch other local branches that can fast-forward are moved. Branch > `Update from main` (Shift+Cmd+U) merges the default branch into the current one (non-default branch only) [src `app.tsx: updateBranchWithContributionTargetBranch` -> `initializeMergeOperation`]. `Merge into Current Branch...`, `Rebase Current Branch...`, `Squash and Merge into Current Branch...` [docs]. Conflicts: banner "Resolve conflicts and commit to merge into <b>." with `View conflicts`, a dialog "N conflicted files", per file `Open in <editor>`, "All conflicts resolved", then commit; abort available; `Resolve with Copilot` [src, partly read].

**Clowdy** [code] (`git/remote.ts`): fetch, then `git merge --ff-only @{upstream}`; diverged answers `{ state: 'diverged' }` and the sidebar says `Diverged: 2 ahead, 3 behind, left as it was`; menu reasons `Nothing to pull`, `Not published yet`, `Upstream gone from origin`. The compare with the base shows `-> origin/main · N ahead · M behind` (`ChangesSidebar.tsx`) but nothing acts on "behind".

**Difference:** merge, rebase, update from the base, conflicts, fast-forwarding other branches: all absent.

### 2.4 Push

**GHD:** see the table (`Push origin`, `Publish branch`, `Force push origin`); `Push after committing` option; tags travel along; size limits (100 MiB file, 2 GiB push) and ruleset warnings [docs].

**Clowdy** [code]: sidebar row `origin/<b> · N ahead` opening Fetch, Pull, Push / Publish with a reason when off; `Commit & Push`; explicit refspec, never force, never tags (`remote.ts`); a rejected push shows git's cause line.

**Difference:** equal in function except force push and tags; different in shape: GHD has one button that always names the next action.

### 2.5 Create PR

**GHD:** above. **Clowdy** [code] (`CreatePullRequest.tsx`, `changesActions.ts: createPullRequest`): `Create PR` opens `/compare/<base>...<branch>?expand=1`; `Publish first` and `Push first` publish or push on a press, after which it reads `Create PR`; off with a reason on the default branch, with no commits ahead, diverged, or tracking another remote; replaced by the PR chip once a PR exists; the strip above the composer shows the same offer. **Difference:** no base choice, no preview or mergeability, no `Create Without Pushing` (deliberate), no PR list; the rest is equal or better (checks chip, viewed marks).

## 3. Gap table

Cost scale (a stage is Stage 7 or 8: a daemon write with real-repository tests, protocol and four transport places, one UI part, review): **S** under half a stage, no new daemon write; **M** about half to one stage; **L** one to two, because of shared-tree, running-agent or state-machine risk; **XL** more than two. Every new write reuses `exclusive` (`workspaces.ts:778`), `writeEnv.ts` (signing agent), `runProgram` and the four transport places, which is why single-command writes are cheaper than Stage 7 was.

| GHD term | What it does | Clowdy today | Cost | Recommendation |
| --- | --- | --- | --- | --- |
| `Current Branch` list, filter, groups, Pull Requests tab | Lists branches (Default 1, Recent 5 from reflog, Other), PRs with CI; pick = switch | Base picker only (`PickerPopover`, Local / Remote, default marked) inside the new-worktree row | M: new read route (`for-each-ref`, which worktree holds each branch, PR via `gh` later); reuse `state.ts` | Take now, as the entry of "work on this branch" |
| Switch branch (checkout) | `git checkout` in the single tree | none | L: the tree is shared with every chat of the folder, their threads and the owner's editor (section 5) | Take later, only for an idle place; never with agents running |
| Switch to the worktree that holds the branch; `Checkout in New Worktree...`; Worktree dropdown | Reuses or creates a worktree for an existing branch; remote name makes a local branch | New worktree always makes a new branch; Existing worktree lists what git has; Manage dialog | M to L: add `{ mode: 'branch'; name }` to `ChatWorkspaceChoice`; `ensureWorktree` already can (`:631`); fix ownership: `ownsWorktree` assumed `<prefix>/<chat8>` (`:159`; the in-flight change keys it on the folder instead) and removal must never delete a branch the chat did not create; refuse and point to the holder when another worktree has it; setup scripts run on a new one | Take now (the safe meaning of "change branch") |
| `New Branch` (from default, from current, from a commit) | `git branch name start`, then checkout | Only as the side effect of `New worktree` with a generated name | S: a name field on the new-chat row (prefix exists, `branchName` is being added by another chat); naming a branch in the shared checkout is the L case | Take with "work on this branch" (name at creation) |
| `Rename...` (Shift+Cmd+R) | `git branch -m`, local only; warns "This branch is tracking origin/x and renaming this branch will not change the branch name on the remote." Enabled when not default or not published | none | M: the daemon records the branch in `workspaces.branch`; `ensureWorktree`, `threadBase` and removal read the record (`ownsWorktree` stops reading the branch with the in-flight change), so a rename must update the row in the same step [inf from code] | Take now unless the in-flight name at creation is enough: `clowdy/ab12cd34` is what GitHub shows on the PR |
| `Delete...` (Shift+Cmd+D) | `git branch -D`; optional "Yes, delete this branch on the remote"; not the default branch, not with an open PR [docs] | Only with worktree removal (`workspace.remove` + `deleteBranch`, chat delete) | S to M local; remote delete is a new kind of write (`push --delete`) | Skip for now; worktree removal covers chat branches |
| Uncommitted changes on switch (`Leave` / `Bring`) | stash push marker `!!GitHub_Desktop<branch>` or stash, switch, pop; one stash per branch | n/a | M (inside the switch row) | Goes with in-place switch |
| `Discard Changes...` | per file, selection or line; copy to Trash first; confirm | none | M: `git checkout HEAD -- <paths>` plus removing untracked files, in a place an agent may be writing; needs a backup (stash-like object) and a confirm | Take later; ask how often the owner uses it |
| `Undo` (last unpushed commit) | mixed reset to the parent; message restored | none; the box shows `Committed 1a2b3c4` | M: `git reset --mixed HEAD~1` guarded by "not pushed" (`upstream.ahead`), restore the message into the draft | Take now (small, safe, frequent) |
| `Amend last commit`, `Amend Will Require Force Push` | `commit --amend` with chosen files and edited message | none | M, plus force push | Take later, with force push |
| `Force push origin` | `push --force-with-lease` after amend or rebase; confirm | plan: out of scope; daemon rule "never a force" | M: use `--force-with-lease=<ref>:<sha>` (stricter than GHD's bare lease), only when diverged after Clowdy's own rewrite; the rule in `apps/daemon/AGENTS.md` must be revised | Take later, tied to amend |
| `Stash All Changes`, `Stashed Changes`, `Restore`, `Discard` | one stash per branch, untracked included | none | M; the stash list is repository-wide, shared by worktrees [inf], so entries need the branch marker as GHD's | Take later, with in-place switch |
| `Update from <default>` (Shift+Cmd+U) | merges the default branch into the current branch | `base` ahead/behind is already computed (`GitBase`) but unused | M: `git merge --no-edit <base ref>` with signing, one place at a time, plus the conflict path below | Take now: the owner's `GITFLOW.md` asks for it after every `next` merge |
| `Pull origin` merging a diverged branch (or `with rebase`) | `pull --ff` | `--ff-only`, diverged left alone | M, shares the merge machinery of the row above | Take now with the row above; rebase skip |
| Merge conflicts (banner, dialog, `Open in <editor>`, abort, continue) | resolves in the user's editor, then commit | status reports `conflicted`; commit refuses during a merge (`commit.ts:161`) | L: read MERGE_HEAD state, banner, `merge --abort`, a "conclude merge" commit (today refused), per-file open in editor (exists in `openActions`) | Take the minimum: banner, `Abort merge`, `Ask the agent to resolve` (a quote into the chat, S); no conflict editor |
| History tab; Compare to Branch with `Behind (N)` / `Ahead (N)`; commit menu (Revert, Reset, Cherry-pick, Squash, Tags) | whole branch history, any branch pair | `Committed on branch`: at most 100 commits ahead of the base; click = commit scope | M: page the log of HEAD, compare with a picked branch (`GitScope` and `rev-list --left-right` exist); S for Copy SHA | Take paging and compare later; skip tags, cherry-pick, reorder, squash |
| Commit to default or protected branch warning | `<b> is a protected branch. Want to switch branches?` (GitHub protection, ruleset checks); none for the default branch | none; Create PR blocks the default branch | S: a line when the head is the base's name; M for protection (`gh api` exists since Stage 2) | Take the default-branch line now, protection later |
| Auto fetch | hourly, 30 minute floor, fast-forwards other branches | none by decision | S to build, but each SSH fetch may ask for Touch ID [inf: Secretive, `git-signing-needs-owner` note] | Skip; show `Last fetched` (from `FETCH_HEAD` mtime, S) |
| `Open in <editor>`, `Show in Finder`, `Open in <terminal>`, `View on GitHub`, `Compare on GitHub`, `View Pull Request on GitHub` | menu items with shortcuts Shift+Cmd+A, F, Ctrl+`, G, C | `OpenWithMenu` on the folder pill and the Files tab (acts on the worktree): Open in <editor>, Show/Open in <file manager>, Open in <terminal>, Open in GitHub, Copy path; PR chip link; Create PR | S: only shortcuts and a `View branch on GitHub` item (`githubLink` builds `/tree/<branch>`) | Skip; low value |
| Branch list with ahead/behind | counts only in Compare, not in the list | none for other branches | S to M: `for-each-ref` with `%(ahead-behind:<base>)` (git 2.41 or later [inf]) or `rev-list --left-right --count` per branch | Take with the branch list, capped |
| `Pull Requests` tab, `Checkout with GitHub Desktop` | list open PRs, check one out | PR chip for the current branch only | M: `gh pr list`, fetch `refs/pull/N/head`, worktree on it | Take later (review flow, not in the five steps) |
| Preview Pull Request: `base:` dropdown, merge status, draft | choose base among remote branches; mergeability | base fixed to the compared base | S for a base choice (`compareLink` takes a base); M for mergeability (`git merge-tree`) | Base choice later; skip the rest |
| Co-authors, `Add Signed-off-by Trailer`, `Allow Empty Commit`, `Bypass Commit Hooks` | commit options | none; hooks and signing never bypassed (decision) | S each except hooks | Skip; ask about co-authors |
| Line-level partial commit | click lines | file level | XL | Skip |
| `Push after committing` (sticky option) | commit then push | `Commit & Push` menu entry | S | Optional: make it sticky |
| Tags pushed with commits | default | `--no-follow-tags` | S | Skip |
| Rename or delete a worktree | menu on the Worktree dropdown | Manage worktrees: new chat, copy path, open in, remove | S | Skip (Clowdy is ahead: chats and merged marks) |

## 4. Ideas and words worth taking

1. **One primary sync button that names the next action** (table in section 1): `Publish branch` / `Push origin` / `Pull origin` / `Fetch origin` with `Last fetched 3 minutes ago` or `Never fetched`, ahead and behind as arrows, a dropdown for the rest. Clowdy's `RemoteMenu` is a row plus a menu of four verbs and does not say what to do next. The pure rules (`remoteActions`, `upstreamView`) already hold every state; this is a presentation change (S to M). Cost to watch: the owner's muscle memory is the words `origin`, `Publish branch`, `Force push`.
2. **"No local changes" with a suggested next step.** GHD title "No local changes", "There are no uncommitted changes in this repository. Here are some friendly suggestions for what to do next." One primary action in this order: `Publish your branch` ("The current branch (x) hasn't been published to the remote yet. By publishing it to GitHub you can share it, open a pull request, and collaborate with others."), `Pull N commits from the origin remote` ("The current branch (x) has a commit on GitHub that does not exist on your machine."), `Push N commits to the origin remote`, `Create a Pull Request from your current branch` (with a `Preview the Pull Request` sibling), none on the default branch; a stash replaces it with `View your stashed changes`. Then three quiet ones, each with its shortcut: `Open the repository in your external editor`, `View the files of your repository in Finder`, `Open the repository page on GitHub in your browser`. Clowdy's equivalent is `Nothing to commit` in `CommitBox.tsx`: put the same ladder there (S).
3. **`Commit 3 files to <branch>`** on the button: guards the wrong-branch commit, which matters more here because several chats share a place (S). Tooltips when off: `A commit summary is required to commit`, `Select one or more files to commit`.
4. **`Switch Branch` wording** if an in-place switch ever lands: "You have changes on this branch. What would you like to do with them?", `Leave my changes on X`, `Bring my changes to Y`, and "Your current stash will be overwritten by creating a new stash".
5. **Create-branch base choice** texts (section 2.1): worth copying for "start from the default branch or from this chat's branch" on `New worktree`.
6. **Amend and force push vocabulary**: dialog `Amend Will Require Force Push`, button `Begin Amend`, finish `Amend last commit`, banner "Your changes will modify your most recent commit.", `Force push origin`, setting "Force pushing" in Prompts. Branch rename warning text above.
7. **Undo bar** under the box: `Committed <ago>`, the summary, `Undo`; disabled with "Undo is disabled while the repository is being updated".
8. **Push rejected = a prompt, not a line**: `Newer Commits on Remote` with the one button `Fetch`; Clowdy prints git's `! [rejected]` line (Stage 8 review); offer a `Fetch` button next to it (S).
9. **Settings > Prompts**: one switch per destructive action (`Discarding changes`, `Force pushing`, `Undo commit`, `Removing worktrees`, ...) and the three-way switch behaviour. Clowdy has one confirm in the worktree removal; a "Prompts" section would hold the new ones.
10. **Recent Branches** (reflog `checkout: moving from`, 5) as the first group of the branch list; `Copy Branch Name`.
11. **Shortcuts the owner knows** [docs]: Cmd+B branches, Shift+Cmd+N new branch, Shift+Cmd+U update from default, Cmd+P push, Shift+Cmd+P pull, Cmd+Enter commit (Clowdy has it), Shift+Cmd+A / F / G, Ctrl+` terminal, Cmd+1 / Cmd+2 Changes / History (Clowdy: Cmd+5 is the Changes tab). Keep them only where they do not clash with `commands.ts`.
12. **"Local commit run: Finish or cancel before syncing"** (button disabled while an operation is open) maps to Clowdy's `An action is running`; keep that reason visible on the primary button.

## 5. The shared-tree problem: what "change branch" must mean

**Facts** [code, GITFLOW.md]: a chat without a worktree works in the folder's own checkout, and so do all the others; the owner's editor and terminal are there too. A chat's worktree is shared by its threads (`inheritWorkspace`) and by any chat that picked `Existing worktree` (`openExistingWorkspace`, one row for all). A run may carry a hidden own `cwd` (`thread_spawn cwd`, not in the protocol) and an agent may `cd` or `git switch` on its own. `GITFLOW.md`: do not switch branches in a tree others work in, because it changes the files under every agent. The same holds for users' projects. There is a per-chat busy check (`stoppedSubtree`, `domain/chats.ts:189`) but none per place.

| Option | What it is | Risks | Cost |
| --- | --- | --- | --- |
| A. Switch only in an idle place | Disabled with a reason ("2 chats are working here") while any run of any chat of that place or its threads is not terminal; hold `exclusive`; a turn that starts during the switch waits (as `isBeingRemoved` does); dirty tree asks Leave / Bring | "Idle" misses background commands (`waiting_background`), the owner's editor and terminal, and a chat that sends a minute later; a chat that resumes after the switch carries a conversation about the old branch (silent drift) unless the branch change is posted as a notice | L |
| B. Switch with agents running, only warn | Same write, a warning | Half-written files, edits and commits landing on the wrong branch | M, unsafe: do not |
| C. No switching; branch per chat | As today, plus "work on this existing branch" through a worktree (GHD's model) | Disk and setup time per worktree; git refuses a second checkout of a branch the folder holds (say so, point to that place); a pre-existing branch must never be deleted or renamed by the chat's removal | M |
| D. A branch picker that opens or finds a worktree on that branch | The picker of section 3 first row; picking a branch held by a place opens that place's chat, else creates a worktree on it. Same engine as C with a better entry | Same as C; plus the list must show which place holds each branch | M with C |
| E. Treat the folder's own checkout as the owner's place for pull, merge and switch, only when idle (A) and leave chat worktrees alone | A for one kind of place | Same idle risks, smaller surface (a chat worktree is one chat's branch) | L, later |

**Recommendation.** Build C and D first: "change branch" means "go to a place on that branch", never rewriting files under a run, and it fits the one-branch-per-chat model and the owner's `next` flow (nobody switches in the shared tree). Add rename (the auto name) next. Build A (for the folder's own checkout, with Leave / Bring and the notice) only if the owner confirms they switch branches in the main checkout of their other projects (question 1). Never B. Whatever lands, post a notice item or banner when the branch of a chat's place changes between turns (GitFacts already re-reads on focus and turn end; S to M).

## 6. Rough size of "replace GitHub Desktop for this flow"

| Item | Size |
| --- | --- |
| Branch list read (`GET .../git/branches`: local and remote, default, recent, holder place, ahead/behind capped) and picker UI | M |
| Work on an existing branch (`ChatWorkspaceChoice` + `ensureWorktree` + removal ownership + "held elsewhere" answer) | M to L |
| Rename branch with the workspace row | M (0.5) |
| `Update from <base>` and `Pull` merging a diverged branch, conflict banner, `Abort merge`, conclude merge, ask the agent | L (1 to 1.5) |
| Undo last commit | M (0.3) |
| Sync button with next-action label, "No local changes" next step, `Commit N files to <branch>`, default-branch line, `Last fetched` | S to M (0.5 together) |
| Base choice for Create PR | S |

**Total for the five steps without opening GHD: about 4 to 5 stages** (Stages 1 to 8 were about one each; the first row and the merge row are the heavy ones). **Can wait:** in-place switch with stash (1.5 to 2), amend and force push (1), discard (0.4), history paging and compare (0.5), PR list and checkout (1), branch protection warning (0.3), tags, cherry-pick, squash, line selection, auto fetch. Stage 9 (Last turn) is independent.

## 7. Open questions for the owner

1. When you change branch in GHD, what for: leave `next` to pull `main`, jump between feature branches of other projects, or start a branch for a new task? Do you do it in the main checkout (decides C and D against A)?
2. Is "a chat on its own worktree and branch, kept after the chat" an acceptable meaning of "change branch", or must the folder's own checkout move?
3. Pull of a diverged branch: merge (GHD's default and your `GITFLOW.md`), rebase, or keep "left alone"? Merge commits will be signed (Touch ID) and may conflict: who resolves, you in the editor or the agent?
4. Do you amend, force push, discard or undo in GHD, and how often? That decides whether "never a force" in the daemon rules is lifted and whether discard needs a backup.
5. Will a fetch from Secretive ask for Touch ID? If yes, auto fetch stays off and we show `Last fetched` only.
6. The branch name: with `branchName` another chat is adding a name at creation. Do you also want to rename after the fact (before the first publish), or a name suggested by the commit-message agent?
7. Do you want the PR list of GHD (open and check out a colleague's PR), and co-authors in the commit box?

## What was verified, inferred, not checked

- **Verified in docs:** branch, worktree, commit, sync, PR, stash, history, commit-management, amend, undo, shortcuts and settings pages. The docs index has no page for merge conflicts (a search found none), and the docs never state the auto fetch frequency, the `Publish branch` rules or the ahead/behind badges: those come from the source.
- **Verified in GHD source (read, not run):** the sync button state order and labels; background fetch intervals and fast-forwarding of other branches; pull and push arguments; checkout, Leave / Bring and stash marker; the empty-state text and ladder; branch dialogs and item menu; menu labels, accelerators and enabling rules; `Undo` as mixed reset; commit options; Create PR dialogs; worktree support flag and dialogs.
- **Verified in Clowdy code:** places, workspace choice, worktree creation, removal, Manage worktrees, Changes sidebar, commit box, remote rules, strip, Info rows, open-with actions, absence of switch, rename, amend, undo, discard, stash, merge (grep over `apps/daemon/src` and `features/changes`).
- **Inferred:** shared stash across worktrees; `%(ahead-behind)` availability; Secretive prompting for fetch; that a rename must update `workspaces.branch` and what breaks if not (read from `workspaces.ts`, `workspaceRemoval.ts`, `threadBase`, not tested); GHD docs saying discarded work goes to the Trash (docs only, source `discard` not read).
- **Not checked:** GHD at runtime (never started), its conflict dialog's exact button labels, Windows wording, GitHub Enterprise, rulesets and protection flows, GHD's Copilot assisted commit beyond the disabled-button label, how Clowdy behaves when git is older than 2.41.

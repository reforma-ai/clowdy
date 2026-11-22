# Git and GitHub in the official agent apps: what the docs say

Snapshot of 2026-11-22. Scope: the Codex app (OpenAI), the Claude Code desktop app, Claude Code on the web, and Claude Code's CLI and IDE features. Source type: product documentation, release notes, and the vendors' own pages. No source code was read. bb and Orca are out of scope.

## Summary

- Both vendors converge on the same baseline: a diff panel next to the chat, inline line comments that go back to the agent, an agent-assisted commit/push/PR flow, a per-thread git worktree, and `gh` (GitHub CLI) as the local GitHub login.
- The Codex app has the richest local git UI that the docs describe: five diff scopes, stage/unstage/revert per file and per hunk, Local-to-Worktree handoff, and a separate Code Review plugin for pull requests (inbox, pinned PRs, mark as viewed, submit review). It does the git work itself and lets the agent handle the thinking.
- Claude Code treats git as something the agent does. The desktop app documents a thin set of git controls (Changes card, diff with comments, `Create PR`, PR status with CI, `Auto-fix`, `Merge when ready`, `Worktree` toggle). Commit and push are not separate buttons in the docs. The agent runs `git` and `gh`.
- Claude Code on the web is the only surface with a documented draft-PR option (right-click `Create PR`, then `Create draft PR`), a `Compare against` branch picker, and a GitHub App based auto-fix.
- Claude Code's CLI has the clearest PR status model: a footer badge `PR #N` colored by review state, which disappears when the PR merges or closes.
- Auto-merge exists only in the Claude desktop app (`Merge when ready`). Stage/unstage/revert per hunk and mark-as-viewed exist only in Codex. Draft PR is documented only for Claude on the web.
- The current Codex docs say very little about the commit/push/create-PR buttons. The worktree page says "commit your changes, push your branch, and open a pull request on GitHub" and the review page says "decide what to stage, revert, commit, or push", but no button labels are given. Treat the Codex commit flow as partly undocumented (see Open questions).
- Both vendors also ship a GitHub-side review bot (`@codex review`, Claude Code Review with `@claude review`) and a GitHub-side coding bot. These are product services, not app surfaces, and are listed separately below.

## Codex app (OpenAI)

Context. The Codex app merged into the ChatGPT desktop app for macOS and Windows on July 9, 2026 (the "What's new" section of the Codex manual). The old URLs on developers.openai.com/codex/* now return a permanent redirect (308) to learn.chatgpt.com/docs/*. The pages carry no per-page dates; dates below come from the manual's "What's new" entries.

### 1. Diff and review surface
- The review pane needs a project that lives in a git repository. If it is not one, the app offers to create one.
- It shows the state of the repository, not only what Codex edited: Codex's changes, your own, and any other uncommitted changes.
- Five scopes: `Unstaged` (default), `Staged` (the git index), `Commit` (a selected commit), `Branch` (diff against your base branch), `Last turn` (the assistant's latest turn).
- Multi-folder projects with several repos: a repository selector in the header. `Last turn` shows "All repos"; other scopes apply to the selected repo (added in the July 2026 "multiple folders" work).
- Inline comments: hover a line, click `+`, write, submit. Then send a message in the chat. The docs say Codex treats comments as guidance and recommend a follow-up message that states intent ("Address the inline comments and keep the scope minimal"). So comments are not sent to the agent on their own.
- Stage, unstage, or revert at three levels: entire diff (`Stage all`, `Revert all`), per file, per hunk. A file can show up in both Staged and Unstaged, which the docs call normal git behavior.
- Navigation: click a file name to open it in your editor, click the row background to fold the diff, Command-click a line to open it at that line.
- `/review` in the composer: `Review against a base branch` or `Review uncommitted changes`. Prioritized findings, no changes to the working tree. Runs in the current chat, or in a separate chat if Settings > Git > Review delivery is `Detached`. App-only: findings appear as inline comments in the review pane.
- April 6-10, 2026 release: collapsible inline comments, inline and detached review modes, "clearer Git and source context"; PR activity, comments, and "push choices" moved into the app.

### 2. Commit, push, PR
- Documented: "stage, revert, commit, or push" are decisions made in the review pane. From a worktree, `Create branch here` in the chat header turns it into a branch, "from here you can commit your changes, push your branch to your remote repository, and open a pull request on GitHub".
- Settings > Git (developer settings page): branch naming standard, a switch for whether Codex uses force pushes, and prompts that Codex uses to generate commit messages and PR descriptions. So message and PR-text generation exist and are customizable. I found no text about a draft-PR switch for local work.
- Not documented in the current pages: the exact commit/push/PR button labels and the flow behind them. Non-doc evidence: an OpenAI Support reply on a community thread (Sep 27, 2026) says "Commit or push" stays available for local git projects and worktrees, in the Changes or review panel. An openai/codex GitHub issue (#47897, opened Sep 24, 2026) says Commit and Push were moved into an unlabeled ellipsis menu and are hard to find; a user suggests a keyboard shortcut for Git actions in Settings. Treat both as user reports, not specification.
- The app, not the agent, does these git actions (the Windows setup page says Git "powers the review panel", and `gh` "powers GitHub-specific functionality in the ChatGPT desktop app"). The docs do not say whether commit messages are produced by a model call or a template; the Settings > Git prompts imply a model call.

### 3. PR status and PR review surfaces
- A Code Review plugin ("pin it to the app sidebar") shows a PR's description, activity, comments, changed files, and checks. `Summary` and `Changes` tabs. You connect a source account when prompted.
- Personal inbox: `Assigned to me`, `Assigned to my team`, `Authored by me`, with review status. PRs can be pinned (`Pinned` group). `Mark as viewed` per file, tied to the displayed revision. A `Stack` section for dependent PRs. A `Threads` link back to your chats on the PR.
- `Review with Codex` starts a review in a new chat. A gear sets review instructions (also in Settings > Code Review). Chat reviews do not post anything. `Submit review` posts `Comment`, `Approve`, or `Request changes`. Posting from `Summary` or `Changes` goes out immediately, so drafts stay in chat until you post.
- `Checks` has a `Fix` action on an open PR: it attaches the failing checks to the chat and prepares a message without sending it. Diagnostics depend on what the CI provider reports to GitHub. This is manual, not auto-fix.
- If you are the PR author, you return to the PR and ask Codex to address specific feedback. No automatic loop is documented in the app.
- The desktop comparison table lists a "Pull requests pane" as "Available when enabled" in Codex and not available in ChatGPT Work.
- Not found in the app docs: auto-merge; a documented open/merged/closed indicator on the thread itself.
- GitHub-side (not the app): `@codex review` on a PR comment (Codex reacts with the eyes emoji and posts a standard GitHub review), automatic reviews, repo rules under `## Code Review Rules` in `AGENTS.md`. In GitHub it flags only P0 and P1 issues. GitHub code review is "generally available"; GitLab merge request review is beta, runs in the cloud, and has no `Create pull request` style controls.
- Scheduled tasks can use event triggers on GitHub PR activity (reviews, comments, commit updates, merges) on web and mobile, to act on PR feedback (August 24-28, 2026 entry).

### 4. Worktrees and branches
- `Worktree` under the composer in a new chat; a branch picker under the composer chooses the starting branch (main, a feature branch, or the current branch with unstaged changes, which are applied to the worktree). `Local` is the foreground, `Worktree` the background.
- Managed worktrees live in `$CODEX_HOME/worktrees` (changeable in Settings > Worktrees > Worktree root). They start from the selected branch's HEAD in a detached HEAD state, so many worktrees do not create many branches.
- `Hand off` in the chat header moves the chat and its code between Local and Worktree. Codex does the git operations. A chat keeps its worktree, and returns to the same one. Git allows a branch in one checkout only, so a branch made with `Create branch here` cannot also be checked out locally; the docs tell you to use Handoff instead.
- `.worktreeinclude` at the repo root copies ignored files (for example `.env`) into new managed worktrees. `AGENTS.override.md` is copied automatically.
- Optional local environment runs setup scripts for the new worktree.
- Cleanup: keeps the 15 most recent managed worktrees by default (configurable, or turn automatic deletion off). Never auto-deletes one tied to a pinned chat or a running chat. Deletes on archive or to stay under the cap. Saves a snapshot first and offers restore when you reopen the chat. Permanent worktrees from older versions stay; new ones cannot be created.
- Scheduled tasks in git repos can run on dedicated background worktrees; the page warns that frequent schedules can create many worktrees.
- Handoff also works between your computer and a connected remote host (June 15-19, 2026). Remote on iOS can pick a branch, create a worktree, run an environment setup script, and add inline review comments (June 8-12, 2026).

### 5. Auth model
- Local app: `gh` installed and logged in (`gh auth login`) enables the GitHub features. The Code Review plugin asks you to connect a source account.
- Cloud and GitHub-side: a "ChatGPT Codex connector" installed on the repo. To set automatic reviews you need push or admin permission on the repo. A search-tool snippet of the older review page said PR context needs `gh` and "if `gh` is missing or unauthenticated, pull request details may not appear in the sidebar or review pane"; I could not confirm that sentence in the current page text.
- Without GitHub: the review pane, staging, `/review`, worktrees, and handoff work in any git repository. PR features need a source account or `gh`.

### 6. Automatic vs on demand
- Automatic: the review pane reflects git state; worktree cleanup; automatic cloud PR reviews if enabled in settings.
- On demand: `/review`, `Review with Codex`, `Fix` on checks, `Hand off`, `Create branch here`, staging and reverting.

## Claude Code desktop app (Code tab)

Source is the desktop page of code.claude.com/docs (undated; version notes inside it; the changelog shows Claude Code 2.1.330 on Nov 20, 2026). The announcement "Bringing automated preview, review, and merge to Claude Code on desktop" is dated Feb 20, 2026.

### 1. Diff and review surface
- A session details panel beside the chat has cards; the `Changes` card shows `+N -M` line counts. Clicking the counts, or selecting `Changes`, opens the diff view. It can also be a pane. `Cmd+Shift+D` toggles the diff pane.
- Inline comments: hover a line, click `+`, type, Enter. `Cmd+Enter` (macOS) or `Ctrl+Enter` (Windows) submits all queued comments at once; Claude makes the changes and shows a new diff.
- The scopes for local sessions are not described in the page. For cloud sessions the diff is against the base branch and can omit unpushed changes.
- Not documented: stage/unstage, revert per file or hunk, mark as viewed, per-commit or per-turn scopes.
- `/code-review` in the prompt box (the Feb 2026 announcement called it a "Review code" button). In local, SSH, and WSL sessions the findings appear as a `Code review` card grouped by file with `Walk through in Changes` (step through, `Fix this one` or dismiss) and `Apply fixes`. It reports through a findings tool with file location, summary, and category.

### 2. Commit, push, PR
- No commit or push button is documented. The docs name one PR control, `Create PR`, and describe it only in an SSH note: Claude "pushes the branch and runs `gh pr create`". So the agent does the git work. If `gh` is missing, Desktop prompts you to install it the first time you try to create a PR.
- Not documented in the desktop page: draft PRs, generated title and body (the web page says the title and description are generated), commit message generation.

### 3. PR status
- After you open a PR it appears in the `Changes` card with its CI check status. Earlier layouts show a `CI` button in the status bar.
- The ellipsis menu beside the PR title has `Auto-fix` (Claude fixes failing checks; in local sessions it also addresses new review comments, but only from the repo owner, org members, collaborators, or GitHub Apps) and `Merge when ready` (turns on GitHub auto-merge; Desktop asks for a squash merge unless the base branch uses a merge queue; disabled in SSH and WSL sessions; the repo must allow auto-merge).
- Setting `Auto-archive after PR merge or close` archives the session when its PR merges or closes (not for cloud or running sessions).
- PR monitoring needs `gh` installed and logged in.
- Unverified: a web-search summary of the Claude desktop release notes claimed a May 8, 2026 change where auto-fix replies to each review thread and marks it resolved, and a fix to PR status icons for merged, merge-queued, and draft PRs. I could not open that changelog (the changelog URL returned the main desktop page), so this is search-snippet level only.

### 4. Worktrees and branches
- `Worktree` toggle in the row under the prompt box; off by default; per saved environment default available. Stored in `<project-root>/.claude/worktrees/` (settable under Worktree location). `Branch prefix` setting is prepended to every worktree branch name. `.worktreeinclude` copies gitignored files. Needs git installed.
- The worktree settings `worktree.baseRef`, `sparsePaths`, `symlinkDirectories` do not apply to the Code tab's worktrees; they are CLI-only.
- Archiving a worktree with uncommitted changes asks first (`Archive anyway` discards). Otherwise the worktree stays and is removed about 30 days after archive or last open. Unarchive restores it.
- `+ > Add folder` adds a folder to a running local or SSH session; Claude works there without a worktree.
- Session menu `Open in > Cloud` continues a local session in the cloud (summary carried over). No local-to-worktree handoff is documented.
- The branch: the earlier layout shows a branch name beside the worktree checkbox; the current layout documents no branch chip. Cloud sessions can create branches that do not exist locally; click the branch name and `Copy branch name`.
- Desktop scheduled tasks can run each run in an isolated worktree (`Worktree` checkbox in the task's Edit form).

### 5. Auth
- Local: `gh` for PR creation and monitoring. For SSH sessions the remote machine needs its own git credentials and `gh`; Desktop does not forward the SSH agent. Cloud: the Claude GitHub App or `/web-setup` (see the web section).
- Without GitHub: local sessions, diff, and worktrees work with git alone; PR features need `gh`.

### 6. Automatic vs on demand
- Automatic: diff tracking of Claude's edits, CI status once a PR exists, `gh` install prompt, worktree cleanup timing.
- Opt-in: worktree, auto-fix, merge when ready, auto-archive. Manual: PR creation, `/code-review`.

## Claude Code on the web (claude.ai/code, mobile, desktop with Cloud selected)

Source: "Use Claude Code in the cloud" and "Get started with cloud sessions" pages (undated). Plans: Pro, Max, Ultra, Team, Enterprise with the right seats.

### 1. Diff and review
- A session runs in a cloud VM, pushes a branch at a stopping point, and the `Changes` card shows `+N -M`. The diff view compares to the base branch by default; `Compare against` picks any other branch in the repo. Diffs come from raw git blobs, so diff drivers and `textconv` filters are ignored.
- Inline comments: hover, `+`, Enter. Comments queue until your next message, then are bundled with it ("at `src/auth.ts:47`, ...").
- A file can be missing from the list when changes were not pushed yet (including changes made by commands Claude ran); ask Claude to commit and push.
- Not documented: stage, revert, mark as viewed.

### 2. Commit, push, PR
- Claude pushes its branch itself. `Create PR` on the `Changes` card creates the PR with a generated title and description. Right-click `Create PR` and choose `Create draft PR` to switch the button to draft. This is the only documented draft-PR control in the app surfaces.
- The session stays live after the PR for follow-ups (paste CI output or comments).
- `claude --cloud` can start a session from the terminal; `--teleport` pulls a cloud session into a local checkout (needs a clean git state and the branch pushed).

### 3. PR status and auto-fix
- Auto-fix: Claude subscribes to GitHub events on the PR and responds to CI failures and review comments. It pushes clear fixes, asks you about ambiguous requests, and notes duplicates. It cannot react to base-branch merge conflicts (GitHub sends no webhook). Replies it posts on review threads use your GitHub account but are labeled as from Claude Code. Needs the Claude GitHub App on the repo.
- Turn on: the PR's ellipsis menu `Auto-fix` in the `Changes` card, `/autofix-pr` from the terminal (spawns a cloud session), the mobile app, or by pasting a PR URL and telling Claude.
- Warns about comment-triggered automation (Atlantis, Terraform Cloud, `issue_comment` workflows).
- No auto-merge control documented here.

### 4. Branches and cleanup
- Repo selector then a branch control to start from a feature branch; each task gets its own session and branch. Sessions persist after the tab closes; the VM expires after inactivity and reopening gives a fresh VM with history restored. Sessions can be archived (restorable) or deleted.

### 5. Auth
- Two methods. Claude GitHub App: authorize in onboarding, works for public repos and for private repos where the App is installed; required for auto-fix and for Projects. `/web-setup`: sends your local `gh` token to your Claude account; reaches any repo that token can; token can be removed by disconnecting GitHub at the connectors page. Credentials stay on Anthropic's servers; the VM goes through a GitHub proxy.
- Team and Enterprise: an Owner must enable the GitHub connector first; `/web-setup` is hidden unless an Owner turns on Quick setup.
- Without GitHub: cloning and PR creation require GitHub (GitHub Enterprise Server is supported on Team and Enterprise). A non-GitHub repo can be uploaded as a bundle (`CCR_FORCE_BUNDLE=1`, under 100 MB) but the session cannot push back.

### 6. Limits worth noting
- Bundled uploads: under 100 MB, falling back to current branch only, then a squashed snapshot. Shares rate limits with other Claude usage. Setup script cached only if it finishes in about five minutes. Not available with Zero Data Retention or HIPAA configurations.

## Claude Code CLI and IDE

### 1. Diff and review
- `/diff` opens a diff panel (fullscreen renderer, git repo, terminal at least 110 columns wide, v2.1.287 or later) or a dialog in the classic renderer. It lists changed files with line counts and refreshes whenever Claude edits or runs a shell command. A `source` picker shows one turn's edits (`T1`, `T2`, ...). `Ctrl+X B` cycles the comparison: this session's changes, all uncommitted changes, everything since the branch split from the default branch (remembered per repo). `ask` next to a file attaches that file's diff to the next prompt. The list skips test and generated files by default.
- `/code-review` (alias `/review`): reviews the branch against upstream plus uncommitted changes by default; accepts a PR number, branch range, commit range, or path; `--fix` applies findings; `--comment` posts inline comments to a GitHub PR or a note to a GitLab MR (needs `gh` or `glab`). Effort levels `low` to `max`, plus `ultra` for a cloud review (Ultrareview, needs a claude.ai account). It runs as a background subagent.
- VS Code extension: native side-by-side diff before applying an edit with accept/reject (per change in v2.1.275 or later, whole file otherwise; diffs with more than 100 changes open without per-change buttons); checkpoints and rewind with `Fork conversation from here` and `Rewind code to here`; plan review with inline comments (plans only, not diffs).
- Not documented as built-in: stage/unstage/revert UI.

### 2. Commit, push, PR
- Everything goes through the agent: "commit my changes with a descriptive message", "create a pr". Claude writes the message and PR description from the code changes. The session is linked to the PR when Claude creates it with `gh pr create` (or `glab mr create`); `claude --from-pr 1234` finds it later.
- Background agent sessions may commit, push, and open a draft PR when the task calls for it; the agent-view page says Claude does not push to `main`/`master`, force-push, or merge on its own.

### 3. PR status
- Footer badge `PR #446` with a colored underline: green approved, yellow pending review, red changes requested, gray draft. It disappears when the PR merges or closes. Click opens the PR. Refreshes right after `git push` or `gh pr` commands that change the PR. Needs a GitHub token (`GH_TOKEN`, `GITHUB_TOKEN`, or `gh auth login`); otherwise the footer reads `install gh for PR status` or `gh auth login for PR status`. GitLab shows `MR !N`. Disabled by `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`.
- Status line JSON exposes `pr.number`, `pr.url`, `pr.review_state`, plus `workspace.git_worktree` and `worktree.*`, so scripts can show PR and worktree state.
- Agent view (`claude agents`, background sessions): each row can show `#1234` colored by PR status (yellow waiting on checks or review or failed, green checks passed and nothing blocking, purple merged, grey draft or closed); a `Ready for review` group; filtering by PR number or URL.
- `/autofix-pr` runs auto-fix as described in the web section. `/install-github-app` sets up the GitHub Action and the Claude GitHub App (needs `gh` and repo admin).

### 4. Worktrees
- `claude --worktree <name>` creates `.claude/worktrees/<name>/` on branch `worktree-<name>`, from the repository's default branch by default (`worktree.baseRef` can be `"head"`). The default-branch fetch is capped at five seconds and falls back to the cached ref.
- `claude --worktree "#1234"` (or a PR URL) fetches that PR's head and makes `.claude/worktrees/pr-1234`.
- Cleanup on exit: a clean unnamed worktree is removed with its branch; one with work prompts keep or remove; subagent and background worktrees are swept after `cleanupPeriodDays` unless they hold work or unpushed commits.
- Isolation checks block edits, cwd, and git redirects into the main checkout while a session is isolated. `.worktreeinclude` copies gitignored files. Subagents can run in their own worktrees. Hook-based worktrees support non-git VCS.
- Moving between surfaces: `/desktop` and `claude --desktop` to Desktop, `--teleport` from cloud, `--cloud` to cloud.

### 5. Auth
- `gh` CLI for PR status, `--from-pr`, `/install-github-app`, `/autofix-pr`; `glab` for GitLab. The GitHub Action authenticates with the Claude GitHub App, plus an API key or OAuth token secret.

## GitHub-side services (product-level, not app surfaces)

| | OpenAI Codex | Anthropic Claude |
| --- | --- | --- |
| Review bot on PRs | `@codex review`, automatic reviews; GA for GitHub; only P0 and P1 shown; rules in `AGENTS.md` | Code Review (Team and Enterprise): automatic or on `@claude review`; inline comments, a summary, and a check run named `Claude Code Review`; never approves or blocks; levels Quick, Standard, Deep; rules in `REVIEW.md` and `CLAUDE.md`; not for ZDR or HIPAA orgs |
| Coding bot | Codex GitHub Action (CI patterns such as auto-fix on CI failure appear in the docs' examples); cloud chats open PRs | `claude-code-action`: `@claude` in an issue or PR comment, or a `prompt`; `/install-github-app` quick setup; app permissions are broad (Actions, Checks, Contents, Pull requests, Workflows, and more) |
| Install model | ChatGPT Codex connector on the repo; push or admin permission to configure | Claude GitHub App, one permission set shared by all Claude GitHub features |
| GitLab | Beta, cloud only | `claude-code-action` is GitHub only; GitLab CI/CD page exists; `/code-review --comment` supports GitLab MRs |

## Feature matrix

Key: Y = documented. P = partly documented or only indirectly. - = not found in the docs. "agent" = done by the model through `git` or `gh`, not by an app control. "n/a" = does not apply to that surface.

| Capability | Codex app | Claude desktop | Claude web | Claude CLI / IDE |
| --- | --- | --- | --- | --- |
| Diff of uncommitted changes | Y (Unstaged, Staged) | Y (Changes diff view; local scopes not described) | P (pushed changes only) | Y (`/diff`, VS Code diff) |
| Diff vs base branch | Y (Branch scope) | P (cloud sessions) | Y (+ `Compare against` any branch) | Y (`Ctrl+X B` third state) |
| Per-commit scope | Y | - | - | P (only via `/code-review` ranges) |
| Last-turn or per-turn scope | Y (Last turn) | - | - | Y (T1, T2 picker) |
| Inline comments to the agent | Y (needs a follow-up message) | Y (sent in one batch) | Y (bundled with next message) | P (VS Code plan comments; `ask` attaches a file diff) |
| Stage / unstage / revert per file or hunk | Y | - | - | P (VS Code accept/reject per change before applying) |
| Mark file as viewed | Y (PR review only) | - | - | - |
| Local review command | Y (`/review`) | Y (`/code-review`, findings card) | n/a | Y (`/code-review`, `--fix`, `--comment`) |
| Commit action | Y (app git; button labels undocumented) | P (agent) | P (agent pushes branch) | P (agent) |
| Commit message generation | Y (Settings > Git prompt) | P (agent) | P (agent) | P (agent) |
| Push action | Y (documented in flow text) | P (agent) | Y (automatic at a stopping point) | P (agent) |
| Create PR button | P (flow text only) | Y (`Create PR`) | Y (`Create PR` on Changes card) | - (prompt, agent) |
| Draft PR | - | - | Y (right-click `Create PR`) | P (background agent may open a draft) |
| Generated PR title and body | Y (Settings > Git prompt) | P (agent) | Y | P (agent) |
| Git work done by | app | agent | agent (VM) | agent |
| PR checks / CI shown | Y (Code Review plugin `Checks`) | Y (`Changes` card) | Y (`Changes` card) | Y (footer badge colors, agent view) |
| Open / merged / closed state | P (inbox, PR view) | P (auto-archive on merge or close) | P | Y (badge, vanishes on merge or close; agent view purple = merged) |
| Fix failing checks with the agent | P (manual `Fix` action) | Y (`Auto-fix`) | Y (`Auto-fix`, GitHub App) | Y (`/autofix-pr`) |
| Auto-merge | - | Y (`Merge when ready`, squash) | - | - |
| PR review comments pulled in | Y (author asks Codex; PR view) | Y (auto-fix, local sessions, trusted authors) | Y (auto-fix events) | P (`gh`, `/autofix-pr`) |
| Review a PR as a reviewer (inbox, submit) | Y (Code Review plugin) | - | - | P (`/code-review <number>`, `--comment`) |
| Per-thread worktree | Y (`Worktree` under composer) | Y (`Worktree` toggle, off by default) | n/a (cloud VM and own branch) | Y (`--worktree`) |
| Handoff Local to Worktree | Y (`Hand off`) | - (only `Open in > Cloud`) | P (teleport to terminal) | P (`--teleport`, `/desktop`) |
| Branch creation from a worktree | Y (`Create branch here`) | P (branch prefix setting) | Y (own branch per task) | Y (`worktree-<name>`) |
| Starting branch / base choice | Y (picker under composer) | P (cloud only documented) | Y (branch control) | Y (default branch or `head`; `--worktree "#123"`) |
| `.worktreeinclude` | Y | Y | n/a | Y |
| Worktree cleanup | Y (15 cap, snapshot, restore) | Y (about 30 days after archive) | n/a (VM expires) | Y (exit prompt, periodic sweep) |
| Archive tied to PR merge | - | Y (auto-archive setting) | - | - |
| Scheduled runs in a worktree | Y | Y | n/a | n/a |
| GitHub login | `gh` or source account; connector for cloud | `gh` | Claude GitHub App or `/web-setup` token | `gh` or token variables |
| Works without GitHub | Y (git only for review, worktrees) | Y (git only; `gh` for PR) | - (GitHub required; bundle cannot push back) | Y (footer hint to install `gh`) |

## Baseline versus extras

### Appears in at least two products (the likely baseline users know)

1. A diff panel with a file list and added/removed counts, opened from the chat. Codex, Claude desktop, web, CLI/IDE.
2. Inline line comments that are queued and sent to the agent as feedback. Codex, Claude desktop, Claude web. Codex wants an explicit follow-up message; Claude sends them with the next message or in one batch.
3. Base-branch comparison (not only the working tree). Codex Branch scope, Claude web default and `Compare against`, CLI `Ctrl+X B`.
4. A pre-commit review command run by the agent (`/review`, `/code-review`) that reports prioritized findings, and applies fixes on request. Codex, Claude desktop, CLI.
5. Agent-assisted commit and push, and PR creation with a generated title and description. Present everywhere; Codex adds user prompts for the text, Claude web adds the draft option.
6. A PR indicator with CI check status next to the work. Codex (PR view, `Checks`), Claude desktop (`Changes` card), CLI (footer badge).
7. A one-click way to hand failing checks to the agent. Codex `Fix` (manual), Claude `Auto-fix` and `/autofix-pr` (continuous).
8. PR review comments feeding back into the agent. Codex (author flow, event-triggered tasks), Claude (auto-fix).
9. A per-thread git worktree with `.worktreeinclude` to copy ignored files (same file name and idea in Codex, Claude desktop, Claude CLI), cleanup on archive, and the "one branch in one checkout" constraint.
10. `gh` as the local GitHub login, with a visible hint when it is missing or logged out.
11. Scheduled tasks that can run in their own worktree. Codex, Claude desktop.
12. A GitHub-side review bot that runs in the cloud and posts inline comments (`@codex review`, `@claude review`), never auto-approving.
13. An archive or cleanup rule that avoids silently deleting worktrees with work in them (Codex pinned and running chats; Claude prompts on dirty worktrees).

### Single-product extras

- Codex only: stage, unstage, revert per file and per hunk; `Staged`, `Commit`, and `Last turn` scopes; multi-repo review pane; `Hand off` between Local and Worktree and to a remote host; `Create branch here`; detached HEAD managed worktrees; the 15-worktree cap with restore snapshots; Settings > Git (branch naming, force push switch, commit and PR prompts); a PR reviewer workflow (inbox, pinned PRs, mark as viewed, `Stack`, `Submit review`).
- Claude only: `Merge when ready` auto-merge; `Auto-fix` that also answers review comments (replies labeled as Claude Code); draft PR via right-click `Create PR`; `Compare against`; footer PR badge colored by review state and the same data in status line JSON; `--worktree "#1234"`; `--from-pr`; Ultrareview (cloud); auto-archive after PR merge or close; `/web-setup` token route; `claude-code-action` and `/install-github-app`.

## Sources (all fetched 2026-11-22)

Pages carry no publish date unless stated.

Codex and ChatGPT desktop app (developers.openai.com/codex/* redirects to learn.chatgpt.com/docs/*):
- https://learn.chatgpt.com/docs/code-review (also `.md` and `?surface=app`) - review pane, scopes, comments, staging, Code Review plugin, `/review`
- https://learn.chatgpt.com/docs/environments/git-worktrees (`.md`) - worktrees, handoff, cleanup, `.worktreeinclude`
- https://learn.chatgpt.com/docs/codex-manual.md - consolidated manual (3.5 MB): What's new entries with 2026 dates, Settings > Git, Windows setup page with `gh` requirement
- https://learn.chatgpt.com/docs/third-party/github (`.md`) - `@codex review`, automatic reviews, P0 and P1 limit
- https://learn.chatgpt.com/docs/projects.md - multi-folder projects and git operations
- https://learn.chatgpt.com/docs/automations.md - scheduled tasks on worktrees, GitHub event triggers
- https://learn.chatgpt.com/docs/environments/cloud-environments.md - cloud chats (thin on git)
- https://learn.chatgpt.com/docs/changelog - recent CLI and iOS entries (Nov 2026): Codex CLI 0.169.0 (Nov 13, 2026) skips submodule worktree scans when checking repo changes, 0.171.0 (Nov 20, 2026) keeps partial git metadata when worktree status is slow, ChatGPT iOS 1.2026.314 (Nov 18, 2026) worktree creation keeps untracked files with unusual names
- Non-doc evidence: https://github.com/openai/codex/issues/47897 (opened Sep 24, 2026, last comment Oct 12, 2026) and https://community.openai.com/t/chatgpt-macos-app-where-did-the-commit-and-push-button-go/1387702 (posted Jul 21, 2026, support reply Sep 27, 2026)

Claude Code:
- https://code.claude.com/docs/en/desktop.md - desktop app (first 100k of 229k characters read in detail; rest searched by topic)
- https://code.claude.com/docs/en/claude-code-on-the-web.md - cloud sessions, auth, review, auto-fix
- https://code.claude.com/docs/en/web-quickstart.md - connect GitHub, review and iterate, `Create PR`, draft
- https://code.claude.com/docs/en/worktrees.md - `--worktree`, base ref, cleanup, `--worktree "#123"`
- https://code.claude.com/docs/en/common-workflows.md - create PRs, `--from-pr`
- https://code.claude.com/docs/en/interactive-mode.md - `/diff` panel, PR review status footer, GitLab MR badge
- https://code.claude.com/docs/en/statusline.md - `pr.*`, `worktree.*` fields
- https://code.claude.com/docs/en/agent-view.md - PR label colors, Ready for review, draft PRs from background sessions
- https://code.claude.com/docs/en/code-review-local.md - `/code-review`
- https://code.claude.com/docs/en/code-review.md - managed Code Review (GitHub)
- https://code.claude.com/docs/en/github-actions.md - `claude-code-action`, `/install-github-app`, app permissions
- https://code.claude.com/docs/en/vs-code.md - VS Code diff accept/reject, checkpoints, worktree banner (last 7k characters not read)
- https://code.claude.com/docs/en/desktop-scheduled-tasks.md - scheduled tasks with `Worktree`
- https://code.claude.com/docs/en/changelog.md - Claude Code 2.1.326 to 2.1.330 (Nov 16-20, 2026), only the newest 100k of 1.4M characters read
- https://claude.com/blog/preview-review-and-merge-with-claude-code - Feb 20, 2026 desktop announcement

## Open questions

- Codex: what are the exact commit, push, and `Create PR` controls, and do they offer a draft option? The current docs only say you can "commit, push, and open a pull request"; a draft switch was not found.
- Codex: does the thread itself show its PR state and checks in the chat or only in the Code Review plugin? The comparison table says "Pull requests pane: Available when enabled" with no explanation of how it is enabled.
- Codex: does `Last turn` survive the app restarting, and how big can a diff get before the pane degrades? No limits are documented. The Nov 2026 CLI entries (skip submodule worktree scans, partial git metadata when worktree status is slow) suggest git status cost is a live concern.
- Claude desktop: what are the diff scopes for local sessions, and is there per-hunk revert? Not documented. Is a draft PR option present? The desktop page is silent; the web page has it.
- Claude desktop: what the local `Create PR` does step by step (who writes the commit, whether it asks for a branch name). The only description is the SSH note.
- Claude desktop: the 2026 desktop release notes (auto-fix replies and resolves threads, PR status icons for merged, queued, draft) could not be read; only a search snippet mentioned them.
- Claude: whether PR state polling is interval-based or event-based locally (the CLI badge says it refreshes after `git push` and `gh pr` commands; background refresh was not described).
- I found no page in either vendor's docs about several agents or chats sharing one checkout; both steer parallel work to worktrees.

## Assumptions and limits

- The WebFetch tool summarizes pages with a small model, so exact UI labels were checked against the text it returned and, for Codex, against the 3.5 MB manual file saved locally. Where a summary and a page disagreed I used the page text. Labels such as `Commit or push` come from a support reply, not a docs page.
- The Claude desktop page is 229,736 characters long. I read the section list and the git and PR sections in the first 100,000 characters, and the 100,000 to 200,000 and 200,000+ ranges only by topic (worktrees on SSH, CLI comparison, troubleshooting). A "Create a pull request" section may exist that the summaries did not surface.
- Claude's changelog page is 1.4M characters; I read only the newest 100,000 characters (versions 2.1.326 to 2.1.330). Earlier release history for PR features, and the desktop release notes, were not read.
- `code.claude.com/docs/en/desktop-changelog` returns the desktop reference page, not a changelog.
- The Codex "What's new" dates are week ranges inside the manual (for example "April 6-10, 2026"); individual app release notes behind the changelog anchors could not be loaded (filtered changelog URLs returned only November 2026 CLI entries).
- Pages for Codex IDE extension and Codex CLI git behavior were not read beyond `/review`. JetBrains git features for Claude Code were not read. Claude Code Review, Ultrareview, and Projects were covered only at overview level.
- Slack, Linear, and other non-git integrations were out of scope.
- Both vendors change these pages often. Treat this file as a 2026-11-22 snapshot.

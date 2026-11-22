# Git and GitHub surfaces: research index

Snapshot 2026-11-22, Clowdy checkout at `32edc08` on `next`. Research only: no plan, no design.

## Question and scope

Which git and GitHub surfaces should Clowdy have, what do bb, Orca and the official agent apps already do, and what does Clowdy have to build on? Inputs: the owner's screenshots of bb (composer strip, Thread info, Diff panel, `GitHub PR` tab) and of Orca (Source Control tab, Checks and comments).

The owner's must-haves (chat of 2026-11-22):

1. Know the branch and tree (Clowdy already shows them) and see which PR is attached to the branch and its status.
2. See what the agent changed, run a review, and go through a list of diffs ticking them off as reviewed. The tick must be bound to the file's blob ids (a later edit un-ticks it, as in bb).
3. Create a commit from the UI, with an option to fill in the message automatically.
4. Create a PR for the branch with one button.

Nice to have: Orca-style Fetch, Pull, Push, Sync buttons so the owner does not open GitHub Desktop for basic actions.

Not wanted for now: the full `GitHub PR` page (bb's optional plugin).

## Summary

- **bb and Orca both run plain `git` and the user's `gh` CLI.** Neither stores a GitHub token or has OAuth. Without `gh`, the GitHub surfaces go empty and local git still works. Clowdy's daemon already inherits the login shell's `PATH`, and `gh` is on the owner's machine.
- **Neither reference fetches by itself.** Behind counts, merged-branch detection and PR containment go stale until a Fetch, Pull or Sync. Both read git with `GIT_OPTIONAL_LOCKS=0`, `-z` output and pinned English locale.
- **bb's data semantics** (see `bb-git.md`): Commits is `git log --left-right <base>...HEAD`, the whole branch, never the PR. The strip shows one section, Uncommitted when the tree is dirty, else Committed. Files changed and Uncommitted come from one status read, so swapping them is a front-end change. Viewed marks are server-side rows keyed by (environment, target, path) and tied to the blob-id revision of the file.
- **bb's writes are minimal:** one Commit action (`add -A` and an AI one-liner, off by default), `gh pr ready`, `gh pr merge`. No push, no pull, no create-PR. Orca is the precedent for those.
- **Orca's Create PR is a one-click pipeline** (see `orca-git.md`): stage all, generate the message, commit, publish or push, generate the PR title and body, `gh pr create`, each step able to stop with a notice. Eligibility has named blockers (dirty, detached HEAD, default branch, no upstream, needs push, no auth, existing PR). The primary button is a decision function over the state.
- **Text generation:** Orca spawns the user's agent CLI as a read-only subprocess (`claude -p`, `codex exec`, prompt on stdin); bb calls its own AI service with an 8 s timeout and a fixed fallback. Clowdy's memory note `clowdy-ai-services-registry` already says a `commit-message` task needs a pull service (ephemeral Codex thread or `claude -p --no-session-persistence`) and a seam for it.
- **The official apps** (see `app-docs.md`): the baseline is a diff panel with inline comments back to the agent, base-branch comparison, agent-assisted commit/push/PR with generated text, a PR chip with CI status, a Fix-checks action, worktrees. Codex does git in the app (stage per hunk, five diff scopes, Hand off); Claude Code mostly leaves git to the agent. Mark-as-viewed exists in Codex only, for PR review.
- **Size:** Orca is about 130k non-test lines. A plain port of the visible behavior (GitHub only, local only, `gh` required) is estimated at 8k to 12k lines, with the hardening skipped (Orca estimate, not measured). bb's git plugin is about 12k lines, mostly hardening.
- **Clowdy today** (see `clowdy-state.md`): git is read-only and thin. The daemon exposes branch, default branch, branch names, worktrees with a `dirty` boolean and the `origin` URL (`GET /v1/projects/:id/git`, wired in all four transport places, no consumer yet). No status per file, diff, commits, ahead/behind, merge base, PR, or `gh` use. No diff renderer and no line-diff library; the diff text agents send is dropped by the ACP mapper. The "Thread info" panel is the side panel's Info tab (folder-based, three rows). There is a strip frame above the composer (`ComposerBanner`) to reuse.
- **Collisions with the worktrees work:** same transport, protocol and `projectsInfo` files; the key of every git query should be the chat's *place* (`placeOf`, `currentPlace`), not a folder; the chips under the composer show the same branch; side panel tab arrays and keys (`Cmd+0` to `Cmd+4` are taken). The worktrees plan and the MVP plan both list PR, merge and ahead/behind as out of scope, and the daemon `AGENTS.md` says git never changes a folder. Those statements must be revised when this work lands.

## Topic pages

- [bb-git.md](bb-git.md): how bb builds the strip, Thread info, Diff panel, PR status and the PR tab; exact git/`gh` commands and what each number means; Viewed persistence; refresh policy; cost per surface.
- [orca-git.md](orca-git.md): Source Control tab and its state-machine button, per-action git commands, Create PR pipeline, Checks and comments, merge and auto-merge, text generation, polling and rate limits, worktree interplay.
- [app-docs.md](app-docs.md): Codex app, Claude Code desktop, web and CLI: feature matrix, baseline versus single-product extras, dated sources.
- [clowdy-state.md](clowdy-state.md): what Clowdy has now (daemon git, protocol, transport, side panel, composer area, refresh patterns), reuse list, collision points, 12 owner questions.

## Important sources

- bb: local clone at commit `796cdcc` (2026-11-21), `plugins/git`, `plugins/github-pr-status`, `plugins/github`, `packages/environment-provider-host/src/workspace-git.ts`. Clone path in the memory note `reference-bb-source-clone`.
- Orca: clone at commit `de67267a` (2026-11-20), `src/main/git`, `src/main/github`, `src/shared/source-control`, `src/renderer/src/components/right-sidebar`. Both MIT, read-only, nothing run.
- Clowdy: `apps/daemon/src/git/state.ts`, `apps/daemon/src/domain/git.ts`, `packages/protocol/src/api.ts`, `apps/desktop/src/renderer/features/sidePanel/`, `apps/desktop/src/renderer/features/chats/ComposerBanner.tsx`, `.briefback/chat-worktrees/plan.md`.
- Vendor docs: learn.chatgpt.com/docs (Codex, moved from developers.openai.com), code.claude.com/docs (desktop, web, CLI), fetched 2026-11-22.

## Open questions research could not answer

- Does an agent's own `commit` or `push` work from the daemon with the owner's SSH signing and Secretive agent? Not run; `SSH_AUTH_SOCK` may not reach a Finder-launched daemon (inference).
- Real cost of spawning `claude -p` or `codex exec` for a commit message (latency, failure rate): not measured by anyone.
- Where `gh` runs for Orca's plain SSH workspaces (code and docs disagree): only matters if Clowdy ever runs the daemon remotely.
- The Codex app's exact Commit, Push and Create PR controls: the docs do not name them.
- License of `@pierre/diffs` (bb's diff renderer): not checked.
- The 12 product questions in `clowdy-state.md` (scope reversal, `gh` versus token, whether Clowdy may write, base ref, per place versus per chat, diff dependency, tab shape, sequence with worktrees).

## Assumptions and coverage limits

- Everything about bb, Orca and the docs is static reading or page fetches; nothing was built or run. Behavior marked "inference" in the topic pages is not verified.
- Not read: bb's `plugins/github/app.tsx` in full, Orca's stacks, GitLab, Bitbucket, SSH relay and mobile code, the Claude desktop docs page beyond its first 100k characters, and the Claude changelog before its newest 100k.
- `spec.md` is named in `AGENTS.md` but does not exist in the repository.
- Clowdy's worktrees Stages 2 to 8 have no code yet; collision notes describe the plan, not source.

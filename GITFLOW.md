# Git Flow & Commit Convention

How we work with Git: branches, commits, packages.

**Goals:** clean history, predictable releases, automation-friendly.

## Tools

Use Git CLI for branches, commits, and pushes, and GitHub CLI (`gh`) for pull
requests and CI checks. GitHub Desktop is optional.

## Where work happens

All local work happens in the main checkout, on the branch `next`. Every chat and every agent works there together, at the same time. A new chat or a new task does not get its own branch or worktree: what changes in the tree shows in the owner's running app at once. Every commit is pushed to `origin/next` right away (Sharing the tree).

`next` starts from `main` and lands back on it through a pull request (Pull Requests). A separate branch and worktree are the exception, and the agent decides on them (Worktrees).

## When to commit

Commit a slice as soon as it can stand on its own: one feature, one fix, one refactor, one docs change. Do not leave finished work from several features sitting uncommitted. A working tree full of files from different slices is a missed commit, not a draft.

- Finished a slice — commit it. The branch does not have to be ready for a PR.
- Several slices in the tree — split them. Stage only the files that belong to the commit you are making.
- Leave uncommitted only work that is still in progress.

## Sharing the tree

Several agents edit the same tree at once, so each one keeps it clean for the others: small commits, made right away, of its own files only.

- Commit a slice the moment it stands on its own, before the next one starts. A file that stays dirty for an hour is the one two agents end up editing.
- Stage and commit by path, never the whole tree: `git add <paths> && git commit -m "<message>" -- <paths>`. The paths after `--` keep the commit to those files even when another agent has staged something else. Never `git add -A`, `git add .`, or `git commit -a`.
- Before you commit, look at `git status` and the diff of your paths. Changes you did not make are another agent's work in progress: leave them alone. Do not reset, restore, checkout, stash, clean, or reformat them, and do not run `lint:fix` or a formatter over files you did not touch.
- A file that holds your edits and another agent's, which you cannot tell apart: commit it whole and name both changes in the message body. A whole file in one commit is better than a file nobody dares to commit.
- Do not switch branches, rebase, `reset --hard`, or rewrite commits in the shared tree: each of those changes the files under every other agent.
- `.git/index.lock` means another agent is committing. Wait a few seconds and run the command again. Delete the lock only when no git process is running.
- Push after every commit: `git push origin next`. A commit that sits only on this machine does not exist for the owner's other checkouts, for a pull request, or for the next agent that clones. When the push is rejected because `origin/next` moved, run `git fetch origin && git merge origin/next` and push again; never force-push and never rebase. When it fails for another reason (the SSH key needs the owner's approval, for one), leave the commits in place, say so once in the report, and do not work around it.

## Commit messages

All commits follow Conventional Commits:

```
<type>(<scope>): <short description>
```

### Types

- `feat` – new functionality
- `fix` – bug fix
- `chore` – maintenance (no product impact)
- `refactor` – code changes without behavior change
- `docs` – documentation
- `test` – tests
- `ci` – CI/CD config
- `perf` – performance
- `revert` – revert a previous commit

### Scope

Required when change affects specific package:

```
feat(editor): add drag selection
fix(api): handle empty token
```

If unclear or repo-wide, skip it:

```
chore: update dependencies
```

### Rules

- Present tense, no period, short and specific
- Type is required, lowercase only
- Subject minimum 4 characters
- Body lines max 250 characters
- No PascalCase or UPPER-CASE in subject

  Examples:

- ❌ `fixed stuff` (no type)
- ❌ `fix: bug` (subject too short)
- ❌ `fix: Fixed Bug` (PascalCase)
- ✅ `fix(auth): prevent token double refresh`
- ✅ `fix: Prevent auth token double refresh`

## Branches

### Main branches

- **`main`** – always stable, protected, releases cut from here
- **`next`** – the working branch of the main checkout: all local work and every agent's commits land here, and it reaches `main` through a pull request

### Feature/Fix branches

Only for a worktree (Worktrees) or when the owner asks for a separate pull request. Day-to-day work is committed on `next`.

```
<nickname>/<short-description>
<nickname>/feat/<short-description>
<nickname>/fix/<short-description>
```

Examples: `max/feat/auth-token-refresh`, `max/fix`, `max/chore/update-dependencies`

## Worktrees

A worktree is for work that cannot share the tree. The agent decides to open one and does it without asking the owner. Open one when:

- the owner asked for a separate branch or an isolated checkout;
- the task is big (several stages, a broad refactor) and would leave the shared tree broken for long;
- the agent has to run code that must not touch the owner's running app or the other agents' files: a throwaway daemon with its own data folder, a migration try-out, a risky dependency change, an experiment that may be thrown away.

A small edit, a fix, or one more change on the day's work stays in the shared tree.

```
./clowdy worktree add <slug> [--from <ref>]
./clowdy worktree remove <slug>
```

`<slug>` is kebab-case. `add` creates a sibling directory `../clowdy-<slug>` on a new branch `<nickname>/<slug>`, then runs `bun install --frozen-lockfile` there. The branch starts from `origin/main`, fetched first, so it is clean and carries only what is released. `--from <ref>` starts it from another ref: `--from next` when the task builds on commits of `next` that are not on `main` yet. When the fetch fails (the SSH key needs the owner's approval, for one), the branch starts from the last fetched `origin/main` and the command says so. `<nickname>` is `git config user.name`, lowercased, with spaces turned into hyphens.

When the work is done it comes back to `next`, not through a pull request: from the main checkout run `git merge <branch>` (a merge commit keeps the branch's own commits and their signatures), push `next`, then `./clowdy worktree remove <slug>` and `git branch -d <branch>`. Work that stays in a worktree after the task is pushed on its branch, so it is not only on this machine. Run the checks of Pull Requests first for what the branch changed. When the merge would touch files that are dirty in the shared tree, wait until their owners have committed; do not stash them.

`remove` deletes that checkout. It refuses when the tree still has uncommitted work. Do not delete the directory by hand. A branch that was not merged stays until it is merged or the owner says to drop it.

A branch can be checked out in only one worktree. Do not switch another checkout onto it.

The owner does not need to hear about a worktree that was opened, merged and removed. Say something only when work is left in one: unmerged work, or a merge that failed, with the branch and the path.

## Pull Requests

- A PR into `main` carries what `next` holds, with a description that lists its slices. The owner decides when it goes. A separate branch and PR for one chunk only when the owner asks.
- CI (`.github/workflows/ci.yml`) runs on a PR into `main` that changes code, not on one that only changes documents, and not on a PR into another branch. It tests the result of merging the PR into `main`: build, lint, typecheck and test of every package, then lint of the root files (`scripts/`, `.github/`, the root configs) and typecheck of `scripts/` (`gate.yml`, Linux). Its `ci-ok` check is the one to look at: `gh pr checks <n>`. A PR with no `ci-ok` is a documents-only PR: there is nothing to wait for.
- Nothing runs again after the merge. A push to `main` does not run CI; the OTA bundle of a merge is published as before (Releases).
- GitHub cannot make a check required on a private repository of a free plan, so nothing stops a merge. Merge only when `ci-ok` is green.
- Merge with a merge commit: `gh pr merge <n> --merge`. The branch does not have to be rebased first: CI already ran on its merge with `main`, and a merge commit has fewer conflicts to settle. Do not rebase-merge or squash: both drop the signatures of the branch's commits.
- After the merge of `next`, the branch stays: in the main checkout run `git fetch origin && git merge origin/main`, which fast-forwards `next` onto the merge commit when it has nothing newer.
- After the merge of a separate branch, remove its worktree and delete the branch, on `origin` and locally: `./clowdy worktree remove <slug>`, `git push origin --delete <branch>`, `git branch -d <branch>` (use `-D` only once `gh pr view <n>` says MERGED, when the branch was merged some other way than by a merge commit).
- Every action in `.github/workflows` is pinned to a commit SHA, with its release in a comment: `uses: actions/checkout@<sha> # v5.1.0`. To move one, resolve the new release tag to its commit and change both.
- Direct pushes to `main` are not part of the flow.

Before you push, run the same checks for what you changed (the whole gate is what CI runs):

```
bunx turbo run build lint typecheck test --affected
```

`lint` is Biome: it reports lint findings, formatting and import order, and only reports. `bun run lint:fix` in a package applies the fixes.

## Releases

The desktop app is published to GitHub Releases in this repository. One-time setup (secrets, variables, signing): `apps/desktop/RELEASING.md`. Rules: `apps/desktop/AGENTS.md` → Releases.

- **Shell** (`.github/workflows/release-shell.yml`): raise `version` in `apps/desktop/package.json` and push it to `main`. The workflow builds the macOS and Windows installers and publishes a release `v<version>`, marked Latest; the app's updater follows that release. A push that keeps the version releases nothing, and a version is released once: a bad release is replaced by a higher version.
- **OTA bundle** (`.github/workflows/release-ota.yml`): every push to `main` that touches the desktop app, the daemon, or the shared packages builds a bundle (renderer, daemon, system skills) and publishes it to the `ota` prerelease; installed apps pick it up without a new shell. When the push also changed what the shell ships since the last shell release, the bundle waits: raise the shell version, and its release carries the bundle.

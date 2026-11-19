# Git Flow & Commit Convention

How we work with Git: branches, commits, packages.

**Goals:** clean history, predictable releases, automation-friendly.

## Tools

Use Git CLI for branches, commits, and pushes, and GitHub CLI (`gh`) for pull
requests and CI checks. GitHub Desktop is optional.

## When to commit

Commit a slice as soon as it can stand on its own: one feature, one fix, one refactor, one docs change. Do not leave finished work from several features sitting uncommitted. A working tree full of files from different slices is a missed commit, not a draft.

- Finished a slice — commit it. The branch does not have to be ready for a PR.
- Several slices in the tree — split them. Stage only the files that belong to the commit you are making.
- Leave uncommitted only work that is still in progress.

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

### Feature/Fix branches

```
<nickname>/<short-description>
<nickname>/feat/<short-description>
<nickname>/fix/<short-description>
```

Examples: `max/feat/auth-token-refresh`, `max/fix`, `max/chore/update-dependencies`

## Worktrees

A day of related work stays on one branch. Commit each slice there. At merge the branch lands on `main` as one merge commit, with its own commits, and their signatures, kept as they are.

Open a worktree when the work should not share that branch: a parallel unrelated task, or a separate chunk large enough to need its own checkout. The agent decides. A small edit on the current task stays in the current tree.

```
./clowdy worktree add <slug>
./clowdy worktree remove <slug>
```

`<slug>` is kebab-case. `add` fetches `origin`, creates a sibling directory `../clowdy-<slug>` on a new branch `<nickname>/<slug>` from `origin/main`, then runs `bun install --frozen-lockfile` there. `<nickname>` is `git config user.name`, lowercased, with spaces turned into hyphens.

`remove` deletes that checkout. It refuses when the tree still has uncommitted work. Do not delete the directory by hand. The branch stays until it is merged or deleted on purpose.

A branch can be checked out in only one worktree. Do not switch another checkout onto it.

## Pull Requests

- One PR is one logical change, with a description.
- CI (`.github/workflows/ci.yml`) runs on a PR into `main` that changes code, not on one that only changes documents, and not on a PR into another branch. It tests the result of merging the PR into `main`: build, lint, typecheck and test of every package, then lint and typecheck of the root `scripts/` (`gate.yml`, Linux). Its `ci-ok` check is the one to look at: `gh pr checks <n>`. A PR with no `ci-ok` is a documents-only PR: there is nothing to wait for.
- Nothing runs again after the merge. A push to `main` does not run CI; the OTA bundle of a merge is published as before (Releases).
- GitHub cannot make a check required on a private repository of a free plan, so nothing stops a merge. Merge only when `ci-ok` is green.
- Merge with a merge commit: `gh pr merge <n> --merge`. The branch does not have to be rebased first: CI already ran on its merge with `main`, and a merge commit has fewer conflicts to settle. Do not rebase-merge or squash: both drop the signatures of the branch's commits.
- After the merge, remove the worktree and delete the branch, on `origin` and locally: `./clowdy worktree remove <slug>`, `git push origin --delete <branch>`, `git branch -d <branch>` (use `-D` only once `gh pr view <n>` says MERGED, when the branch was merged some other way than by a merge commit).
- Every action in `.github/workflows` is pinned to a commit SHA, with its release in a comment: `uses: actions/checkout@<sha> # v5.1.0`. To move one, resolve the new release tag to its commit and change both.
- Direct pushes to `main` are not part of the flow.

Before you push, run the same checks for what you changed (the whole gate is what CI runs):

```
bunx turbo run build lint typecheck test --affected
```

`lint` only reports problems. `bun run lint:fix` in a package applies the fixes.

## Releases

The desktop app is published to GitHub Releases in this repository. One-time setup (secrets, variables, signing): `apps/desktop/RELEASING.md`. Rules: `apps/desktop/AGENTS.md` → Releases.

- **Shell** (`.github/workflows/release-shell.yml`): raise `version` in `apps/desktop/package.json` and push it to `main`. The workflow builds the macOS and Windows installers and publishes a release `v<version>`, marked Latest; the app's updater follows that release. A push that keeps the version releases nothing, and a version is released once: a bad release is replaced by a higher version.
- **OTA bundle** (`.github/workflows/release-ota.yml`): every push to `main` that touches the desktop app, the daemon, or the shared packages builds a bundle (renderer, daemon, system skills) and publishes it to the `ota` prerelease; installed apps pick it up without a new shell. When the push also changed what the shell ships since the last shell release, the bundle waits: raise the shell version, and its release carries the bundle.

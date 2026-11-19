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

A day of related work stays on one branch. Commit each slice there. At merge those commits are rebased onto `main`, so they read as one sequence.

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
- There is no CI on pull requests yet. Before you merge, run the checks for what you changed:

```
bunx turbo run build lint typecheck test --affected
```

`lint` only reports problems. `bun run lint:fix` in a package applies the fixes.

## Releases

The desktop app is published to GitHub Releases in this repository. Rules and secrets: `apps/desktop/AGENTS.md` → Releases.

- **Shell** (`.github/workflows/release-shell.yml`): raise `version` in `apps/desktop/package.json` and push it to `main`. The workflow builds the macOS and Windows installers and publishes a release `v<version>`, marked Latest; the app's updater follows that release. A push that keeps the version releases nothing, and a version is released once: a bad release is replaced by a higher version.

# Working in a shared checkout

Load this when other agents (or the manager) may be changing files in the same checkout as you. Assume so unless your `cwd` is your own worktree.

## Golden rules

1. Your files are the owned paths in the assignment. Everything else belongs to someone.
2. A change you do not recognize is someone else's work in progress. Leave it exactly as it is.
3. If you break someone else's build, you notice it through your own checks. Find out whether the cause is in your paths; fix only those.

## Commands

| Need | Use | Never use |
| --- | --- | --- |
| See what is changing | `git status --short`, `git diff -- <your paths>` | Assuming every modified file is yours |
| See your own changes only | `git diff -- <paths>`, `git diff --stat -- <paths>` | `git diff` without paths when reporting |
| Save your work (only if the assignment says to commit) | `git add <paths>` then `git commit -m "<what and why>" -- <paths>` | `git add -A`, `git add .`, `git commit -a` |
| Undo your own mistake in a file you own | Edit it back, or `git diff -- <path>` and reverse the hunk | `git checkout -- .`, `git restore .`, `git reset --hard`, `git clean`, `git stash` |
| Format or fix lint | The formatter or linter on your files only (for example `eslint --fix <paths>`) | A repository-wide fix or format |
| Install dependencies | Only if the assignment says you own the manifest | Reinstalling, deleting `node_modules`, regenerating a lockfile |
| Change branch | Stay where you are | `git switch`, `git checkout <branch>`, `git rebase`, `git merge` in a checkout others use |
| Run a server or watcher | A free port; stop it when done; kill only what you started | Killing processes by name; leaving watchers running |

If `git commit` fails with an `index.lock` error, another agent is committing. Wait a few seconds and retry. Delete the lock only when you have confirmed no git process is running (`ps`), and say so in the report.

## When a check fails and the cause is not yours

1. Read the failing output. Which file and which test? Is it in your paths or related to your change?
2. Run `git status --short` again. A moment ago the file may have been mid-edit by another agent. Wait a minute and rerun the check once.
3. Still failing, file not yours: find out whether it was already failing before you. Never stash or checkout to find out. Make a clean copy of the base state outside the repository and run the same command there:

   ```bash
   git worktree add "$TMPDIR/base-check" HEAD
   (cd "$TMPDIR/base-check" && <install if needed> && <the same command>)
   git worktree remove --force "$TMPDIR/base-check"
   ```

   Uncommitted work of others is not in that copy, so a failure there proves it existed at the last commit; a pass means the failure comes from uncommitted changes (yours or others').
4. Report it as it is: "Pre-existing failure: `<command>` fails in `<file>` at the base commit" or "Fails because of a concurrent change in `<file>`, not in my paths". Never mark your task `done` hiding it, and never fix the other file.

## Overlap discovered while working

If you find that you and another agent need the same file, stop editing it. Report `blocked` with: the file, what you need to change in it, and what you saw that makes you think someone else owns it. The orchestrator serializes the work.

## If your cwd is your own worktree or branch

The shared-checkout rules about committing and switching branches relax: commit freely in small steps on your branch, never touch the main checkout, and stay in your `cwd`. The rest (scope, evidence, reporting) is unchanged.

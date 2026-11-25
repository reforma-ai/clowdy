# CI: red runs and run time, settled decisions

- Status: accepted
- Date: 2026-11-25
- Decided by: user (semi-manual)
- Scope: The gate in `.github/workflows/ci.yml` and `gate.yml`, the tests that fail in it, and the Windows tests in `release-shell.yml`. Does not cover signing or notarizing the macOS shell, or the role of CI as a release gate (kept as it is, see decision 1).
- Related tasks: CLO-171, CLO-172, CLO-173, CLO-174, CLO-175
- Supersedes: none
- Superseded by: none

## Context
The user asked to fix the red 12-minute CI runs and worried about the cost of a run on every pull request. Facts from the repository and GitHub (2026-11-25):
- 49 CI runs in six days, 18 red, 446 minutes in all. At 0.006 USD a Linux minute that is about 3 USD; one run costs about 7-10 cents. Most of the organisation's Actions bill belongs to the `reforma` repository.
- Pull requests are opened and merged within 7-15 seconds, so the 12-16 minute run ends after the merge. The ruleset "Protect main" requires a pull request but no passing check.
- `release-ota.yml` runs no tests: an OTA release means the bundle was built, not that the tests passed.
- The red runs come from about ten tests that fail again and again: `MainBranchChoice`, `ManageWorktrees`, `ChatView` (a date format that depends on the machine's locale), `diff-view` (file-manager), and in the daemon the file watcher, `placeStatus`, terminal routes, `GitRemote` with two worktrees, file write order, `probing an agent`, `signing in` and `snapshotTree`.
- The gate runs the tests one package at a time: daemon 370 s, desktop 271-442 s, the rest 30 s. In `release-shell.yml` the Windows tests (6 min) run before the packaging (3.5 min) on the same job.

## Decisions
1. **CI stays a report, not a gate, for now.** Options were: hold OTA until CI is green / require green CI to merge / report only. Chosen by the user, in their words: an OTA release that went out already passed what mattered, and the red tests may be about optional things. Reason: while the red cannot be trusted, a gate would delay releases for nothing. Reopen when CI has been green for a stretch.

## Decided by the agent
- Every test that failed in the red runs is sorted into a real regression (fix the code or the stale test) and a timing or environment flake (fix the wait, the race or the locale dependence in the test). No blanket retries: they would hide real races.
- Linux-only failures are reproduced in a Linux container with two CPUs, so the loop is not a 12-minute CI run.
- Run time: the gate splits into parallel jobs for the daemon, the desktop app and the rest (about 12 to 7 minutes), and the Windows tests in `release-shell.yml` run beside the packaging, not before it (about 11.5 to 6 minutes). CI is not cancelled when a pull request merges: a fast merge would otherwise leave no signal at all.
- Left for later: filtered installs (no native builds to skip here), parallel notarization (no signed release yet), a turbo cache (not proven safe), and Vitest `isolate: false` for the desktop tests (its own hint says about two minutes).

## Consequences
A green gate is trusted again, and a run takes about half the time for a small rise in billed minutes. Code can still reach OTA before CI ends; reopen decision 1 once the gate is steady.

## Assumptions
- The Linux container reproduces the daemon failures (to check first).
- Each parallel job still passes alone on a 2-CPU runner (to check on the first CI run).

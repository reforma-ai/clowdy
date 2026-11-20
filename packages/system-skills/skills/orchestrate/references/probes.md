# Probes: ways to break a change

Pick at least three that fit the change. A probe is a real run with a real observation; write the input and the result in the check report (rows in "What was run"), including the probes that passed.

## By kind of change

| Kind | Probes |
| --- | --- |
| User interface | Empty state, one item, a thousand items. Very long text, text with accents, quotes, angle brackets, emoji. Double click on every action. Reload mid-action. Resize narrow. Keyboard only (tab order, Enter, Escape). Error from the backend: does the UI say so? Slow backend: does it show progress? |
| API or service | Missing and extra fields, wrong types, empty body, huge body. Same request twice (is it idempotent?). Two at once. Unauthorized, wrong role, another user's id. Unknown id. Pagination edges (first, last, beyond). |
| Command line | No arguments, wrong arguments, `--help`, a path with spaces, a missing file, no permission, stdin closed, interrupt with Ctrl-C midway, run twice. |
| Data and migrations | Empty database, existing data with nulls and old formats, the largest realistic table. Run the migration twice. Roll back or restore: can it be undone? Does old data still display? |
| Files, parsing, formats | Empty file, one line, no trailing newline, CRLF, BOM, encodings, a quote or a separator inside a value, very large file. |
| Background work and processes | Cancel midway, kill and restart, two at once, a crash between two steps (is the state consistent?), a leftover lock or process. |
| Configuration | Missing variable, wrong value, default path, no network. |
| Docs or skills | Follow the instructions literally, as a newcomer, in order. Do the commands exist? Do the links work? Is anything contradictory between two documents? |
| A fix | The original bug no longer reproduces (same repro). The neighbors of the fixed code: same function with other inputs, other callers. |

## Beyond the change

- **Callers.** `grep` for each changed function, type, route, setting. Every caller still fits the new behavior?
- **Neighbors.** Run the tests of the modules next to the change, not only the new tests.
- **Weak tests.** Would the new tests fail if the feature were deleted? Delete or break the feature locally in a scratch copy and see. Tests that mock the thing they test prove nothing.
- **Leftovers.** Debug output, commented code, `console.log`, stray files in `git status`, a dev server still running.
- **Docs.** Does the behavior documented in `.clowdy/docs/` still match what you saw?

## Failing before the change

A gate fails. Is it the change, or was it already failing? Do not stash or reset in the shared checkout. Check the base state in a scratch copy:

```bash
git worktree add "$TMPDIR/base-check" <base commit or HEAD>
cd "$TMPDIR/base-check" && <install if needed> && <the same command>
cd - && git worktree remove --force "$TMPDIR/base-check"
```

Uncommitted work is not in that copy. A failure there existed before the uncommitted changes. Record it under "Known limits" of the check report. A pre-existing failure is not a defect of the change, but it can make a criterion unverifiable: then it is `blocked` for that criterion, with the exact command and output.

## Flaky results

Run the failing test or step three times. Fails every time: a defect. Fails sometimes in code the change touched: a defect ("intermittent", with the counts). Fails sometimes elsewhere: record as pre-existing flakiness with the counts; do not hide it and do not blame the change.

## Evidence that is not enough

- "It compiles" for a behavior change.
- A unit test that passes while the real flow was never run.
- A sub-agent's summary, a green badge, or a result you did not see yourself.
- Output from an earlier state: rerun after any change.

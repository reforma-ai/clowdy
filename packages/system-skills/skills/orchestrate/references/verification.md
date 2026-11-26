# Verification

Load this when you verify: the integrated result of a cycle, a foundation task that others wait on, or a small change (compact steps at the end). A thread you started to check the work follows the same steps.

You wrote or integrated the work, so your claim that it works is a hypothesis. It earns a pass only with commands you ran in this turn. Take an adversarial stance toward your own result: your job is to find what is wrong with it.

Rules that always apply:

- Never report pass on something you did not run. "Not run" is a valid, written outcome.
- Verify the integrated result: all pieces together, in the state the manager would get. Not one part.
- Evidence is a command, its exit code, the relevant output, and what you observed. A statement without evidence does not count, and neither does a sub-agent's "done".
- A failure goes back into the task with a concrete reason. An external blocker is `blocked`, never pass.
- Never put secrets or raw logs in a document.
- A read-only sub-agent may review the diff cold or probe a flow. Its findings are leads; the verdict rests on what you ran.
- For a user flow or a risky change, a fresh thread may run these steps for you ([threads](threads.md), "Check what a thread built"): give it the claim, the acceptance criteria and where the result is, never the author's reasoning. Its check report, with the commands and their output, is evidence; its "passed" without them is not.

## Steps

1. **Pin the state.** Record the date (`date +%F`) and, if the project uses git, `git rev-parse --short HEAD` and `git status --short` (what is uncommitted). Confirm the result is complete: every file and behavior the tasks promise is present. Missing pieces are a failure.
2. **Derive acceptance criteria before you re-read your diff.** Sources: the task descriptions (Outcome, Check), the documents (`product.md` for behavior), the request. Write a numbered list of checkable statements: "Export of 3 invoices gives a file with a header and 3 rows". Add the standing criteria: it builds; typecheck and lint pass; the relevant existing tests still pass; no debug output, secrets or stub TODOs in the changed files; documented behavior is still true.
3. **Run the gates.** Use the project's real commands (AGENTS.md, `package.json` scripts): build, typecheck, lint, tests. Record command, exit code, last 20 lines. Start from a clean state when dependencies or generated files changed; if a result looks stale or cached, rerun without the cache. Rerun after every change. A failing gate: check whether it also fails at the base state ([probes](probes.md), "Failing before the change").
4. **Run the real flow.** Do what a user does: start the app, CLI or service as a user would and perform the steps the criteria describe; read the actual output. UI: drive a real browser (the project's end-to-end tooling, or any browser automation that is installed), take a screenshot and look at it. API: real requests. Data: real before and after. If the flow cannot run (no display, no browser automation, missing credentials, a device you do not have), say exactly why. That criterion is unverified: `blocked` when it is essential. Reading code is not a substitute. Stop everything you started.
5. **Try to break it.** At least three probes aimed at this change: empty and odd input, repeat, wrong order, cancel midway, restart, concurrent use, old data. Catalog by kind of change: [probes](probes.md). Then read the diff for what you skipped: unhandled branches, `.skip` or `todo` tests, tests that assert nothing or mock the thing under test, added `ts-ignore` or `eslint-disable`, swallowed errors, callers of a changed signature that were not updated (`grep` them).
6. **Decide.**
   - **Passed**: every criterion verified by something you ran, and no probe found a defect.
   - **Failed**: any criterion or probe failed, or the result is incomplete. Defects only: a style preference is a note, not a failure.
   - **Blocked**: an essential criterion cannot be run for an external reason (credentials, a service down, a missing tool). Say what is needed.
7. **Record.** Leave the commands, results, probes and limits on each verified task as a comment. Avoid secrets and raw logs.
8. **Act on the verdict.** Passed: set the tasks Done. Failed: reopen them (In progress) with the reason, fix, and verify again. Blocked: keep them out of Done and report what is needed.

A failure entry always has: the criterion, expected, actual (exact command and output), a repro in three steps or fewer, and where to look if you know (marked as a hypothesis). Most serious first.

## Re-verification

After a fix, verify again from step 1: all gates, not only the failed criterion, plus a regression look at what the fix touched. Record the new result on the task.

## Compact steps

For work done on the spot, check the actual change proportionately: inspect the diff and run the nearest meaningful check or flow. Report what you checked and any limit; do not create a task or report just to record it. If the chat is bound to an existing task, record relevant evidence there and follow its status flow.

For a foundation task that others wait on, put 2-4 criteria in the task, run the nearest gates (build, typecheck, affected tests), exercise the user-visible flow, try one probe and read the diff. Leave the command and result as a task comment. Record significant checks on the task. If anything fails, fix it and repeat the relevant checks. The final result of a larger cycle gets the full steps.

## Example

Verifying CLW-21 and CLW-22 ("invoices CSV export") in the main checkout, after you built both.

1. `date +%F` -> 2026-11-17; HEAD `a1b2c3d`; the two tasks' files are uncommitted. The endpoint and the button both exist.
2. Criteria (from the tasks): 1 button visible on the invoices page; 2 click downloads `invoices.csv`; 3 file has a header and one row per invoice, with commas and accents correct; 4 status filter applies; 5 build, typecheck, lint and tests pass.
3. `bun run build`, `typecheck`, `lint`, `test`: all exit 0.
4. Start the app, create 3 invoices, click Export: a file downloads, 4 lines. Criteria 1, 2, 4 observed.
5. Probes: customer `Smith, Jo` (comma) breaks the columns; empty list gives the header only (fine); 5,000 invoices export in 1.2 s (fine). The diff has no test for quoting.
6. Failed on criterion 3: `INV-7,Smith, Jo,120.00,paid` has 5 columns, expected 4. Hypothesis: `lib/csv.ts` does not quote.
7. The report records the repro and the 5,000-row timing. Both tasks go back to In progress; after the fix, step 1 again, and a new report `...-recheck`.

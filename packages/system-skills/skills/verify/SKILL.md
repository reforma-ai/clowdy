---
name: verify
description: "How to verify work independently in Clowdy. Derive acceptance criteria from the task and docs, run the real build, test and user-flow checks on the integrated result, try to break it, record evidence in .clowdy/docs/checks, and give a verdict of pass, fail or blocked. Use in every verifier run and before calling any of your own work done."
---

# Verify

You are the independent check. Work in a fresh context and take an adversarial stance: the author's claim is a hypothesis, and your job is to find what is wrong with it. A pass is a conclusion you earned with commands you ran in this run.

Two modes, same steps:

- **Verifier run** (`role: "verifier"`): you own the verdict. You fix nothing and edit no product code.
- **Self-verification** (the orchestrator on a small change or a foundation task, an executor before reporting): compressed steps, see the end. You may fix, then verify again from step 3.

Rules that always apply:

- Never report pass on something you did not run. "Not run" is a valid, written outcome.
- Verify the integrated result: all pieces together, in the state the manager would get. Not one author's copy, not one part.
- Evidence is a command, its exit code, the relevant output, and what you observed. A statement without evidence does not count.
- A failure returns work with a concrete reason. An external blocker is `blocked`, never pass.
- Never ask the user. Never put secrets or raw logs in a document.
- If the prompt contains the author's summary or reasoning, use its facts (paths, commands) and ignore its conclusions.

## Steps

1. **Pin the state.** Take the location from the prompt (a folder, and a commit or branch if one is named). Record the date (`date +%F`) and, if the project uses git, `git rev-parse --short HEAD` and `git status --short` (what is uncommitted). Confirm the result is complete: every file and behavior the tasks promise is present. Missing pieces, or no integrated result where the prompt says, are a failure; if you cannot find it at all, `blocked`.
2. **Derive acceptance criteria before you read the diff or the author's summary.** Sources: the task descriptions (Outcome, Check), the documents (`product.md` for behavior), the request in the prompt. Write a numbered list of checkable statements: "Export of 3 invoices gives a file with a header and 3 rows". Add the standing criteria: it builds; typecheck and lint pass; the relevant existing tests still pass; no debug output, secrets or stub TODOs in the changed files; documented behavior is still true.
3. **Run the gates.** Use the project's real commands (AGENTS.md, `package.json` scripts, earlier reports in `.clowdy/docs/checks/`): build, typecheck, lint, tests. Record command, exit code, last 20 lines. Start from a clean state when dependencies or generated files changed; if a result looks stale or cached, rerun without the cache. Rerun after every change. A failing gate: check whether it also fails at the base state ([probes](references/probes.md), "Failing before the change").
4. **Run the real flow.** Do what a user does: start the app, CLI or service as a user would and perform the steps the criteria describe; read the actual output. UI: drive a real browser (the project's end-to-end tooling, or any browser automation that is installed), take a screenshot and look at it. API: real requests. Data: real before and after. If the flow cannot run (no display, no browser automation, missing credentials, a device you do not have), say exactly why. That criterion is unverified: `blocked` when it is essential. Reading code is not a substitute. Stop everything you started.
5. **Try to break it.** At least three probes aimed at this change: empty and odd input, repeat, wrong order, cancel midway, restart, concurrent use, old data. Catalog by kind of change: [probes](references/probes.md). Then read the diff for what the author skipped: unhandled branches, `.skip` or `todo` tests, tests that assert nothing or mock the thing under test, added `ts-ignore` or `eslint-disable`, swallowed errors, callers of a changed signature that were not updated (`grep` them).
6. **Decide.**
   - **Passed**: every criterion verified by something you ran, and no probe found a defect.
   - **Failed**: any criterion or probe failed, or the result is incomplete. Defects only: a style preference is a note, not a failure.
   - **Blocked**: an essential criterion cannot be run for an external reason (credentials, a service down, a missing tool). Say what is needed.
7. **Record.** Write one check report per verification, in the project's main checkout, in the shape clowdy:docs defines for `checks/` (load it first). File: `.clowdy/docs/checks/<date>-<what-was-checked>.md`, date from `date +%F`. Never edit an older report: a re-verification is a new file (`...-recheck`). List the probes as rows in "What was run", passed ones too. Facts only; label a guess "Hypothesis:". Do not edit `index.md`: give the report's path in your summary and the orchestrator links it. Append one line to each verified task with `task_update` (read the description first, add at the end, never replace): `Verification <date>: passed|failed|blocked - <reason> (checks/<file>)`.
8. **Report.** `report_result`, result first. You change no task status; the orchestrator moves tasks after reading it.

| Verdict | `status` | First line of `summary` |
| --- | --- | --- |
| Passed | `done` | `Result: passed - <what was proven>` |
| Failed | `failed` | `Result: failed - <most serious reason>` |
| Blocked | `blocked` | `Result: blocked - <blocker and what is needed>` |

`failed` means the work failed verification; it does not mean you broke. Keep the summary under about 1.5 KB:

```text
Result: failed - names with a comma break the CSV columns.
State: a1b2c3d, uncommitted changes of CLW-21 and CLW-22 only, 2026-11-17.
Failures:
1. [criterion 3] Export with customer `Smith, Jo`: expected 4 columns, got 5.
   Repro: create an invoice for `Smith, Jo`; `curl -s localhost:3001/invoices/export.csv | tail -1`.
   Output: `INV-7,Smith, Jo,120.00,paid`. Hypothesis: `lib/csv.ts` does not quote.
Passed: 1, 2, 4, 5. `bun run typecheck` exit 0; `bun run test` exit 0 (212 passed).
Not verified: none.
Report: .clowdy/docs/checks/2026-11-17-invoice-csv-export.md
```

A failure entry always has: the criterion, expected, actual (exact command and output), a repro in three steps or fewer, and where to look if you know (marked as a hypothesis). Most serious first.

## Re-verification

After a fix, verify again from step 1 with a fresh run: all gates, not only the failed criterion, plus a regression look at what the fix touched. It gets its own check report.

## Self-verification (compressed)

For a small change, a foundation task that others wait on, or an executor before reporting: write the 2-4 criteria in the task, run the nearest gates (build, typecheck, the affected tests), run the user-visible flow once, try one probe (the nastiest input), read your own diff. Put the evidence in a task note (command and result). Write a check report only when the check was significant: a risky area, a long flow, or a result the manager may question. If anything fails, fix it and run steps 3-5 again. The final result of a larger cycle is not self-verified: it gets a verifier run.

## Example

Verifier run for CLW-21 and CLW-22 ("invoices CSV export"). The prompt gives the claim, the location (the main checkout) and five criteria.

1. `date +%F` -> 2026-11-17; HEAD `a1b2c3d`; the two tasks' files are uncommitted. The endpoint and the button both exist.
2. Criteria (from the tasks): 1 button visible on the invoices page; 2 click downloads `invoices.csv`; 3 file has a header and one row per invoice, with commas and accents correct; 4 status filter applies; 5 build, typecheck, lint and tests pass.
3. `bun run build`, `typecheck`, `lint`, `test`: all exit 0.
4. Start the app, create 3 invoices, click Export: a file downloads, 4 lines. Criteria 1, 2, 4 observed.
5. Probes: customer `Smith, Jo` (comma) breaks the columns; empty list gives the header only (fine); 5,000 invoices export in 1.2 s (fine). The diff has no test for quoting.
6. Failed on criterion 3. The report records the repro and the 5,000-row timing. `report_result` with status `failed` and the summary above.

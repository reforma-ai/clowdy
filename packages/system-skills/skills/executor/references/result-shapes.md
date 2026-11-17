# Final message shapes

Templates for the `summary` of the executor's closing tool call: `report_result({ status, summary, taskUpdates })`. Put the verdict first; the orchestrator keeps about 2 KB of the summary. Plain words about behavior; paths and commands in backticks. No secrets, no raw logs: at most the last 5-10 relevant lines of an output.

`taskUpdates`: move the tasks you completed to Review. For `failed` and `blocked`, change no status; the reason goes in the summary and in the task notes.

## Done

```text
Result: done - the invoices endpoint exports the filtered list as CSV.
Changed:
- `GET /invoices/export.csv?status=` returns the list with a header row, UTF-8 with BOM
- Reuses `lib/csv.ts`; registered in `routes.ts`
Checked:
- `bun test apps/api/src/invoices/export.test.ts` -> exit 0, 6 passed
- `bun run typecheck` -> exit 0; `bun run lint` -> exit 0
- `curl -s localhost:3001/invoices/export.csv?status=paid | head -3` -> header and 2 rows, status filter applied
Not run: browser flow (belongs to CLW-22).
Notes: BOM chosen so Excel reads accents (recorded in the task).
For the orchestrator: follow-up, the invoices query has no index on `status`; not touched.
```

## Blocked (needs an answer)

```text
Result: blocked - cannot choose the export size limit without a product call.
Done so far: endpoint and tests for the unlimited case, passing (`bun test ...` -> exit 0).
Untouched: pagination for exports above 50,000 rows.
Question: what should happen above 50,000 rows?
Options: A) refuse with a clear message (simple, safe); B) stream in the background and email a link (needs the mail service, a new task). Recommend A for the first version.
```

## Blocked (external)

```text
Result: blocked - the payment sandbox rejects every call with 401.
Evidence: `curl -s -o /dev/null -w "%{http_code}" https://sandbox.example/v1/ping` -> 401; the key in the environment is empty.
Needed: a sandbox key available to the tests, from the manager.
Finished: everything that does not call the sandbox; those tests pass. Sandbox tests are skipped by flag, not deleted.
```

## Failed

```text
Result: failed - the migration cannot be applied to existing data.
Tried: (1) add the column with a default; (2) backfill in the migration; (3) backfill in a separate step. All fail on rows with null `created_at`.
Evidence: `bun run migrate` -> exit 1, "NOT NULL constraint failed: invoices.created_at" (rows 412, 977).
Learned: 31 legacy rows have no creation date; the task assumed none did.
Suggest: decide a rule for legacy rows (use the import date) and re-run; no other part of the task is affected.
```

## Writing the task note

Append to the task description, never replace it:

```text
## Notes
2026-11-17 (executor): UTF-8 with BOM for CSV so Excel reads accents. Reused `lib/csv.ts`. Legacy rows have no `created_at`, see the blocked message.
```

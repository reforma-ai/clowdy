# Check report template

One report per verification, in `checks/<YYYY-MM-DD>-<what-was-checked>.md`. It is evidence, not a status message: someone who did not see the run must be able to tell what was done and trust the result. Reports are not edited afterwards. A new run gets a new file, and the older one stays as history.

```markdown
# Check: <what was verified, in user terms>

- Result: passed
- Date: 2026-11-20
- Tasks: <CLW-2, CLW-3, CLW-4>
- State checked: <the combined result of which tasks, where it was run>

## What was run
| Step | Command or user action | Result |
| --- | --- | --- |
| 1 | `bun run check` | exit 0 |
| 2 | Open the site, pick a cake and the 10:30 slot, submit | order confirmation shown |
| 3 | Open `/admin` with the password from `.env.example` | the new order is listed |

## Evidence
<The few lines that prove the result: the output that matters (at most 20 lines), a screenshot link, a count. Not the whole log.>

## Failures
<Only when the result is failed. For each: what broke, where, the exact steps to reproduce, and the task it went back to. A concrete reason, not "did not work".>

## Blocked
<Only when the result is blocked. What outside thing is missing, who can provide it, and what was verified without it. Never report this as passed.>

## Known limits
- <What was not checked, flaky parts, assumptions, environment differences.>

## Verdict
<One sentence a manager can act on.>
```

## Rules

- `Result` is `passed`, `failed` or `blocked`. A claim from the author that the work is done is not a result: record only what a command or a walked flow showed.
- Check the integrated result, not each piece. Say which tasks the state includes.
- Run real commands and real user flows. If a step could not run, the report says so under Known limits and the result is not `passed` for that step.
- No secrets, no raw logs, no personal data in the report, in screenshots either.
- The same summary goes on the task (`task_update`) and in the final report, with the path of this file. Add the report to `index.md`.
- How to verify is in clowdy:orchestrate (Verify); this file only fixes the shape of the record.

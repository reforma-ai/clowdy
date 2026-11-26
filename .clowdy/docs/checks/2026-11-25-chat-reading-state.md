# Chat reading state

- Date: 2026-11-25
- Tasks: CLO-193
- Result: passed
- State checked: `clowdy/dev` before commit

| Check | Evidence |
| --- | --- |
| Fold isolation | In Electron fixtures, Agents was initially folded in Simplify booking; opening it left Ship the checkout folded. Returning to Simplify booking preserved the open disclosure. Store tests cover saved choices across sessions and ignoring the legacy global value. |
| Older reading position | In a fixture chat populated with messages, leaving at scrollTop 1815px and adding more messages while away still returned to 1815px. The maximum increased from 5186px to 5662px. |
| Latest | Leaving the chat at its end and adding messages while away returned to scrollTop 6098px, the new maximum. Leaving within 20px of the end followed the newly arrived messages too. |
| Message anchor | Increasing an earlier message's height by 600px while away changed scrollTop from 2178px to 2778px. The visible message's offset remained -128px exactly. Tests cover an absent anchor and a composer covering the viewport. |
| Tests | Full desktop suite: 5024 tests in 273 files passed. Independent review added additional probes and reran 326 affected tests; all passed. Desktop typecheck, lint and `git diff --check` passed. |

Not checked: installed packaged app and Windows. Scroll memory is session-only by design.

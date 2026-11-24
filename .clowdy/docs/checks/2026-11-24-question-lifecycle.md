# Question lifecycle checks

Status: partial
Date: 2026-11-24
Related task: CLO-54

## Results

- An isolated daemon using the real Codex adapter displayed a question, waited 65 seconds, accepted the answer and received the agent's response. Claude completed the same flow with a three-second wait.
- An isolated daemon using Cursor accepted an answer after three seconds. In a second run, Cursor timed out before an answer at 65 seconds; the question closed and the agent continued.
- The targeted daemon tests cover a cancelled call, an agent ending its turn with a question open, an occupied execution slot, MCP disconnection and the provider capability. The renderer tests cover the waiting color and a withdrawn question.
- An isolated Electron fixture showed the question and blue waiting indicator. It did not test the live provider flow in the desktop application.
- The desktop build passed. The full desktop test run had 4 failures in `SourceControlPage.test.tsx` because its fixture lacks `RootStoreProvider`; 4,782 tests passed. The baseline typecheck failed in existing daemon files before these changes.

## Limits

No hour-long wait was run. The Cursor timeout remains unresolved. The Codex run used a direct tool call, not the nested asynchronous call observed in CLO-54. Arbitrary third-party ACP forms and a live desktop session were not checked.

# Question lifecycle checks

Status: passed with limits
Date: 2026-11-24
Related task: CLO-54

## Results

- An isolated daemon using the real Codex adapter displayed a question, waited 65 seconds, accepted the answer and received the agent's response. Claude completed the same flow with a three-second wait.
- Before the durable fallback, an isolated daemon using Cursor timed out before an answer at 65 seconds. After the fallback, two real Cursor runs waited 65 seconds, accepted an answer and continued with that answer. A third waited 75 seconds from question creation and also continued with the stored answer.
- Targeted daemon tests cover cancellation, an agent ending a turn with a question open, a slot held by another run, MCP disconnection, provider capabilities, daemon restart, answer replay after a failure, Stop, and stopped background work. Renderer tests cover the waiting color and preparing or withdrawn questions.
- A scripted agent that produces text or a tool-start event while its question call is pending is stopped, and its existing question remains answerable. An empty message-closing event does not trigger this transfer.
- Recovery opens a question interrupted during preparation only after the recorded agent process is confirmed gone; a process whose identity cannot be confirmed leaves the card expired. Recovery also closes a partially streamed assistant message.
- The final targeted daemon run passed 267 tests across eight files; the targeted renderer run passed 128 tests. The ACP session suite passed 238 tests with 8 skipped.
- An isolated Electron fixture showed the question and blue waiting indicator. It did not test the live provider flow in the desktop application.
- The desktop build passed. The full desktop test run had 4 failures in `SourceControlPage.test.tsx` because its fixture lacks `RootStoreProvider`; 4,782 tests passed. Daemon typecheck still reports the same eight failures seen before these changes.
- Verified session closure waits for an in-flight process start and, when a verified stop is required, for a title-waiting process to exit. Focused tests cover failed closes, refused-session retries and process ID reuse.

## Limits

No hour-long wait was run. Cursor's own timeout remains, but the durable path stops its session before that timeout. Cursor can show the intentionally stopped MCP call in its tool history. The Codex run used a direct tool call, not the nested asynchronous call observed in CLO-54. Arbitrary third-party ACP forms and a live desktop session were not checked. A downgrade while a durable question is open is not supported.

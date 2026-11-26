# Keep the computer awake during agent work

- Status: accepted
- Date: 2026-11-25
- Decided by: user (semi-manual)
- Related task: CLO-194

## Decision

Settings > Power offers three machine-wide sleep modes: Allow sleep, Keep awake while agents work, and Always keep awake. The second is the default, including on existing installations without a saved setting. Display sleep follows the system's own settings in all three modes.

The daemon owns the setting and the sleep assertion, since agents can continue after the desktop window closes. Its active-run count includes queued and waiting runs as well as foreground and background work across projects. The assertion ends when the count reaches zero, unless Always keep awake was selected. That mode lasts for the daemon's lifetime, including when no window is open.

## Implementation

`apps/daemon/src/power.ts` persists the choice in `power.json` in the daemon data folder. macOS uses an idle-sleep assertion through `caffeinate`; Windows uses [SetThreadExecutionState](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-setthreadexecutionstate) without the display flag. Neither changes the system's sleep settings or overrides explicit sleep or lid closure.

# Terminal

## Summary

The side panel's Terminal tab shows shells the daemon runs. Output lives in two in-memory xterms (a headless mirror in the daemon, the one on screen in the renderer), each with 5,000 rows of scrollback. The daemon serializes that screen to ANSI only to restore a client. There is no transcript file, no line model outside the cell buffer, and no selection action. A selection is plain text from the renderer's xterm, used today only to copy.

## How it works

**Where it lives.** `TerminalTab` is the Terminal tab of the side panel. It lists the shells of the place the window is working in (a project folder, or the worktree of the open chat) and mounts the chosen one. `TerminalsStore` holds every shell the window has loaded. `TerminalView` owns one `@xterm/xterm` 6.0.0 instance for the life of that session and moves its DOM node between hosts, so scrollback survives a tab or panel switch. The first time the tab is shown, the view opens the stream.

The shell itself is not in Electron's main process. The renderer talks to the daemon over `GET /v1/terminals/:id/stream` (`TerminalSocket` in `terminalStream.ts`). Main starts or finds the daemon and is not on the byte path.

**Sessions.** A terminal belongs to a project folder, or to one worktree of that folder (`TerminalCreate.workspaceId`). Chats that share a worktree share its shells. A folder's own shells are a different set. Up to `MAX_TERMINALS` (16) run at once on the daemon. Tabs are labeled by the shell program (`zsh`, then `zsh 2`). The id is the stable name; the label is not. `TerminalInfo.cwd` is the directory the shell started in. Nothing in `TerminalSession.update` records a later `cd`.

Opening the tab starts a shell when the place has none. Closing the last shell closes the panel. A worktree that is not on disk yet shows a waiting note and starts nothing. `openInTerminal` starts another shell in a subfolder of the same place and switches to the tab. An exited shell stays listed for 30 minutes (`EXITED_TTL_MS` in `TerminalService`) so a returning window can still read the last screen. A daemon restart ends every shell. The guide states that nothing is persisted.

**What is stored.** Each side has a cell buffer, not a log file.

- The daemon's `TerminalSession` spawns a PTY (`pty.ts`, Bun) and writes every chunk into `@xterm/headless` with `scrollback: TERMINAL_SCROLLBACK` (5,000). `@xterm/addon-serialize` turns that mirror into the `screen` text frame: escape sequences for the normal buffer, the alternate buffer when it is active, the cursor, and modes. The client writes `RIS` plus that string, which replaces whatever it was showing. Later output is raw PTY bytes. A client whose socket holds more than 1 MiB is not sent the skipped bytes; it is attached again and gets a fresh screen (`HIGH_WATER_BYTES` in `http/terminals.ts`). The daemon guide also says a program that outruns the mirror fills memory until xterm discards (50 MB).
- The renderer xterm is created with the same scrollback. It does not load `SerializeAddon`. It writes an exit line of its own (`[Process exited with code N]`) that the daemon mirror does not have.

The buffer is a ring. Rows above the cap are dropped. xterm's selection model shifts a selection up when that happens and clears it if it slides off the top (`SelectionModel.handleTrim`). A resize changes columns and reflows wrapped rows, so the same output is a different number of rows afterward. `TerminalView.fit` resizes the local xterm immediately and tells the shell after 100 ms. The shell has one size: the last `resize` from any client wins.

A full-screen program switches to the alternate buffer. That buffer is the screen. The shell's scrollback stays on the normal buffer, which is not what a selection on the alternate screen reads. Serialize includes the alternate screen as a mode switch, not as extra scrollback lines.

**Selection.** `TerminalView` does not subscribe to `onSelectionChange`. The xterm instance is private. The only use of the selection API is copy, and only off macOS: Ctrl+C with a selection, or Ctrl+Shift+C, calls `getSelection()`, writes the clipboard, and clears the selection. On a Mac the custom key handler returns true for Cmd chords other than the few shell sequences, so xterm handles them. That path was not run.

From xterm 6.0.0 itself, which this app depends on:

- `getSelection()` is plain cell text. Wrapped rows are joined onto the previous line when `isWrapped` is set. The string is `\n`-separated, `\r\n` on Windows. Non-breaking spaces become ordinary spaces. Trailing spaces on a row are trimmed. There are no ANSI sequences in that string.
- `getSelectionPosition()` returns the start and end cell. The type comment says the coordinates are 1-based. The implementation returns the selection model's raw pair, and select-all uses `y = ybase + rows - 1`, which is a 0-based buffer row including scrollback. Treat the documented 1-based range as unreliable until someone checks a live selection.
- Those `y` values are buffer rows, one per screen row. They are not the line numbers of `getSelection()` after wrapped rows have been joined.

There is no context menu, no toolbar button, and no `Mod-i` handler on the terminal. Right-click is not bound (`rightClickSelectsWord` is left at xterm's default). `packages/components/src/Terminal/` is a header/status frame with no xterm and no caller in the desktop app.

## What A and B meet here

**B is close to the data the terminal already has.** `getSelection()` is the selected text, already stripped to what the cells show (a progress bar's earlier frames are gone; the current cells remain). Wiring it out means a method on `TerminalView`, because the xterm is private, and a button or key of the app's own. `onSelectionChange` exists and is unused. The chat's floating Reply listens to `document` `selectionchange` inside `[data-message]`. An xterm selection is not that, especially once the WebGL renderer is loaded (`WebglAddon`, with a DOM fallback if the context is lost). The file button is a CodeMirror tooltip and does not attach to xterm.

`Mod-i` is not reserved. The key handler sends ordinary keys to the shell. A shortcut that runs only while `hasSelection()` is the same shape as the editor's command, but it has to be added in `#handleKey`.

A selection can be the whole ring: 5,000 rows, up to `MAX_TERMINAL_COLS` (500) cells wide. The file quote refuses to put that much into the composer. `getSelection()` has no cap.

**A is not a small step from this buffer.** Nothing appends output to a file. The bytes the daemon could persist are the raw PTY stream (ANSI, cursor motion, alternate-screen programs) or a dump of the cell buffer at one moment. The dump's row numbers change when the ring drops lines or the width changes. A range captured in the renderer can be applied to the daemon's mirror only if both buffers still match: same size, same content, and the client-only exit line accounted for. After a reconnect the client replaces its buffer with a new screen, so a range taken earlier no longer names the same rows. Two windows share one shell and therefore one size, but each has its own xterm and its own selection.

An append-only log with stable line numbers, which is what a growing `terminals/9.txt` implies, is a new store. The ring is the opposite: it forgets the head and reflows.

## Relevant files and modules

- `apps/desktop/src/renderer/features/terminal/TerminalTab.tsx` — tabs, mount, empty-state rules.
- `apps/desktop/src/renderer/features/terminal/TerminalView.ts` — xterm, stream, fit, copy, exit line.
- `apps/desktop/src/renderer/features/terminal/TerminalsStore.ts` — `TerminalSession`, grouping, create and close.
- `apps/desktop/src/renderer/features/terminal/useTerminalsStore.ts` — one store per transport, kept for the life of the window.
- `apps/desktop/src/renderer/features/terminal/shellKeys.ts` — keys that must not be eaten by xterm.
- `apps/desktop/src/renderer/features/terminal/openInTerminal.ts` — start a shell in a subfolder and show the tab.
- `apps/desktop/src/renderer/daemon/terminalStream.ts` — WebSocket client; screen replaces the view.
- `packages/protocol/src/terminals.ts` — routes, scrollback, size limits, `TerminalScreen`.
- `apps/daemon/src/terminals/session.ts` — mirror, serialize, batching.
- `apps/daemon/src/terminals/service.ts` — registry, 16-shell cap, 30-minute exit retention.
- `apps/daemon/src/terminals/pty.ts`, `shell.ts` — spawn and environment (`TERM_PROGRAM=Clowdy`).
- `apps/daemon/src/http/terminals.ts` — socket, 1 MiB high water.
- `packages/components/src/Terminal/Terminal.tsx` — unused chrome, not this terminal.

## Constraints

- Scrollback is 5,000 rows on both sides, in memory only. Older output is gone.
- Line numbers of a buffer dump are not stable: trim, resize reflow, and a fresh `screen` all renumber.
- Buffer rows and `getSelection()` lines differ wherever a row is wrapped.
- Alternate-buffer selections are the screen, not the shell history behind it.
- `TerminalInfo.cwd` goes stale after `cd`. The place (folder or worktree) is the reliable directory.
- Output is unsanitized. A persisted ring includes whatever the user did not select: tokens, env dumps, passwords.
- ANSI stays in the serialized screen and in the raw PTY bytes. It is already gone from `getSelection()`.
- The renderer and the daemon can disagree by the local exit line, and by output not yet parsed on one side.
- Electron main is not a place to read the selection or the scrollback.

## Open questions

- Is a quotable "line" a buffer row or a wrapped logical line?
- Should the exit line the client paints be part of a quote or a saved log?
- For a shell that has `cd`'d, which directory is the attachment's path relative to?

## Assumptions and limits

- xterm coordinate and wrap behavior is read from `node_modules/@xterm/xterm` 6.0.0 (`SelectionService.selectionText`, `SelectionModel`), not from a running window.
- The 50 MB discard figure is the daemon guide, not a constant in `session.ts`. The code that was read batches output and writes it to the mirror; it does not set a custom discard threshold.
- No check of whether the DOM renderer (WebGL context lost) exposes the selection through `window.getSelection()`.

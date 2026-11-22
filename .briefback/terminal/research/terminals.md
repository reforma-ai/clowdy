# Terminals: what bb and Reforma do, and what Clowdy took

Read on 2026-11-22 for the Terminal tab of the side panel. bb is get-bb/bb at `796cdcc` (shallow clone, read only); Reforma is `/Users/bionic/WORK/Reforma/reforma` at `ad8a0a886`. Anything not confirmed in source is marked.

## bb (get-bb/bb)

- **Three hops.** The browser talks to bb's server (`/ws/terminals/:id`, Hono); the server talks to a host daemon (Node) that dials out to it over `/internal/ws`. The server keeps a database row per terminal and relays between the two sockets. Clowdy's daemon is the network endpoint itself, so Clowdy has two hops.
- **PTY: node-pty `1.2.0-beta.15`**, in a Node daemon (in the desktop app run with `ELECTRON_RUN_AS_NODE`). Native binaries are the cost: `asarUnpack`, an after-pack script that patches `unixTerminal.js` for the asar path and `chmod 755`s `spawn-helper` (macOS), and a runtime re-chmod when the exec bit is lost. Windows goes through the same node-pty (ConPTY); shell `pwsh`, then Windows PowerShell, then `%ComSpec%` (`terminal-shell.ts`).
- **Wire: JSON text frames, base64 bytes, zod on both ends.** Client to server: `input`, `resize`, `ping`, `ack {nextSeq}`, `visibility`. Server to client: `attached`, `output {seq, dataBase64}`, `session-updated`, `exited`, `error`, `pong`. Limits: 500 columns, 200 rows, 64 KiB per input frame. Output is coalesced for about 4 ms or 64 KiB and numbered.
- **Backpressure in three layers:** acks sent after xterm parsed a chunk, with the daemon pausing the PTY above 1 MiB unacked and resuming under 512 KiB; a 1 MiB high-water mark on the server's socket queue with a 32 MiB cap (close 1013); a 1 MiB cap on the client's input queue.
- **Replay is raw bytes, not a screen.** A ring of 4 MiB or 10,000 chunks; an attach replays from `sinceSeq`, at most the last 512 KiB; a gap makes the client reset and print a notice. No serialize addon, no headless xterm. A program mid alt-screen can come back wrong. The daemon strips `ESC [ c` (device attributes) and answers it itself, and the client suppresses xterm's own replies while replaying, so replayed queries do not get answered twice.
- **Lifetime.** The daemon owns the PTY; a reload re-attaches; a daemon-to-server drop under 30 s resumes. Kill is SIGHUP to the process group, SIGKILL after 2 s. Exited sessions keep their scrollback 30 minutes (32 sessions or 16 MiB at most). No limit on live terminals and no idle timeout found. The most recent attacher owns resizing. A macOS descriptor leak was fixed by destroying the pty after exit.
- **UI.** A terminal tab in the right panel; xterm `6.1.0-beta.292` with fit, webgl (optional, silent fallback), unicode11, web-links and search; scrollback 10,000; theme from the app's CSS variables; Cmd+C/V and Ctrl+Shift+C/V, plain Ctrl+C left for SIGINT; a file-path link provider; OSC 7 and OSC 8; title from `onTitleChange`.
- **Shell and cwd.** `$SHELL`, else `/bin/zsh`, `/bin/bash`, `/bin/sh`, started as a non-login interactive shell, with a login environment captured once (`$SHELL -ilc env`). cwd is the thread's worktree, a host path, or home, absolute and existing. It sets `TERM=xterm-256color`, `COLORTERM=truecolor`, `FORCE_HYPERLINK=1`, `DISABLE_AUTO_TITLE=true`, `PROMPT_EOL_MARK=""`.
- **Not confirmed:** what `assertBrowserWebSocketAllowed` checks, and how a browser reaches a remote server.

## Reforma

- **Sandbox terminal runner** (`apps/sandbox/src/core/process/terminal-runner.ts`, `terminal-registry.ts`, `pty-host.cjs`): node-pty in a Node sidecar spoken to over stdin frames; the shell is mirrored into `@xterm/headless` and serialized with `@xterm/addon-serialize` for a snapshot, with the mouse encoding and the hidden cursor appended by hand; a client that falls behind gets one snapshot instead of output; exited terminals stay listed 10 minutes; a terminal nobody is attached to for 12 hours is killed. Its comments say the sidecar shrinks to `Bun.spawn(cmd, { terminal })` once oven-sh/bun#33237 is fixed and Windows is verified.
- **Front end** (`apps/front/src/runtime/editor/TerminalSession.ts`, `TerminalTab.tsx`): one xterm per session kept for the session's life, moved between hosts by React; output batched per animation frame; theme from the host's computed style; Option+arrows on a Mac; Ctrl+C copies a selection elsewhere; links open with Cmd/Ctrl-click.

## What Clowdy took, and why

| Choice | Source | Why |
| --- | --- | --- |
| PTY from `Bun.spawn(cmd, { terminal })`, inline | Reforma's note, tried here on Bun 1.4.4 | `openpty` and ConPTY with no native module, no Node and no sidecar to ship and sign, and it works on a remote machine that only has Bun. Ctrl+C, resize and the exit code were checked on macOS. |
| Headless xterm mirror and a serialized screen on attach | Reforma | Exact screen for a reloaded or second window, alt-screen programs included; bb's raw replay can come back wrong. |
| Numbered batches, and a queue while a screen is taken | New | Output is neither lost nor doubled between the screen and the live bytes. |
| Binary frames for bytes, JSON for control | New | bb's base64 JSON is 4/3 the size and decodes every frame; a split character reaches xterm whole. |
| Re-attach with a new screen for a slow client | Reforma | No flow control toward the PTY (as in Reforma); a slow client never sees a torn screen. |
| Token as a WebSocket subprotocol | New | A page cannot set headers on a WebSocket. Host and Origin run first, which is what keeps another web page out. |
| Kill = hang-up, then SIGKILL after 2 s | bb | An interactive shell ignores SIGTERM. |
| Login shell on macOS, plain interactive on Linux | Terminal apps | `.zprofile` is where Homebrew sets its `PATH`. bb instead captures a login environment once. |
| Ctrl+` toggles the tab | VS Code | One key to get the tool and get rid of it. |
| xterm 6.0.0 with fit, web-links, unicode11, webgl; headless 6.0.0 with serialize 0.14.0 | Reforma | The same versions, which are stable and over three days old. |

## Not done, on purpose

Shells do not survive a daemon restart. A terminal belongs to a project folder, not to a chat or a worktree. There is no search addon, no file-path links, no OSC 7 cwd tracking, no title from the program, no copy-on-select setting. The Windows path was never run. The CSP allows only `ws://127.0.0.1:*`, so a remote daemon needs more.

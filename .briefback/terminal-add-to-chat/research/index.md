# Terminal selection as Add to chat

## Question and scope

How can a text selection in the in-app terminal become an Add to chat attachment, the way a selection in a file or a chat message already does?

Scope is the current desktop terminal, the two existing quote flows (file or diff lines, and chat text), and how a sent message becomes model context. The open product choice is not decided here:

- **A.** Persist the terminal transcript to a file and attach a path plus a line range, in the spirit of Cursor's `@/path/to/terminals/9.txt:9-18`, so the agent can read more than the user selected.
- **B.** Paste only the selected text.

This pass records what the current code makes easy or hard for each. It does not choose A or B, and it does not plan the feature.

## Summary

The terminal is a live PTY in the daemon, mirrored by an in-memory xterm (5,000 rows of scrollback) and drawn by another xterm in the renderer. Nothing writes a transcript file. The only selection API in app code is copy: `Terminal.getSelection()` returns plain text of the cells, with no path and no line range.

File and diff Add to chat is not a file attachment. `codeQuote` writes `` `path:from-to` `` plus the selected text into the composer as a Markdown quote. Chat Reply does the same with text only: a whole message is source Markdown held as a card until send; a selection is the rendered words, inserted immediately. `chat.send` stores that string as the user message. The daemon does not open the path or fetch extra lines. The agent can read more only when the path is a real file its own tools can open. A terminal has no such file, so a path in the quote would be a hint nothing resolves.

**A** needs a log that does not exist. The buffer that does exist is a reflowing ring, so line numbers move as output grows, the window resizes, or old rows are dropped. **B** can reuse `quoteIntoComposer` and `getSelection()`, but the terminal has no selection button, and a long selection hits the same composer cost the file quote already caps.

## Topic pages

- [terminal.md](terminal.md) — where the terminal lives, how output is stored, selection, and the missing UI hook.
- [add-to-chat.md](add-to-chat.md) — file, diff, and chat quote gestures, labels, and the payload that lands in the composer.
- [agent-context.md](agent-context.md) — what the model actually receives, and what A and B can and cannot add.

## Important files

- `packages/protocol/src/terminals.ts` — terminal contract, `TERMINAL_SCROLLBACK` (5,000), `MAX_TERMINALS` (16).
- `apps/daemon/src/terminals/session.ts` — PTY plus headless xterm; `SerializeAddon` builds the reconnect screen.
- `apps/daemon/src/terminals/service.ts` — lifetime; exited shells stay listed 30 minutes; nothing is written to disk.
- `apps/daemon/src/http/terminals.ts` — WebSocket; binary output; a slow client is resent a screen instead of a torn stream.
- `apps/desktop/src/renderer/features/terminal/TerminalView.ts` — renderer xterm, fit, copy, no selection action.
- `apps/desktop/src/renderer/features/terminal/TerminalTab.tsx` — side-panel tabs; one xterm per session, moved between hosts.
- `apps/desktop/src/renderer/features/terminal/TerminalsStore.ts` — sessions grouped by project folder or worktree.
- `packages/file-manager/src/react/editor/selectionAction.ts` — CodeMirror "Add to chat" button and `Mod-i`.
- `apps/desktop/src/renderer/features/chats/useAddToChat.ts` — wires that button to the composer.
- `apps/desktop/src/renderer/features/chats/codeQuote.ts` — path, line range, and fenced text.
- `apps/desktop/src/renderer/features/chats/composerBridge.ts` — `quoteIntoComposer`.
- `apps/desktop/src/renderer/features/chats/composerDrafts.ts` — `withQuoteLast`, `quotedMessage`.
- `apps/desktop/src/renderer/stream/SelectionReply.tsx` — floating Reply over a selection in one message.
- `apps/desktop/src/renderer/stream/MessageActions.tsx` — Reply on a whole message.
- `apps/desktop/src/renderer/features/chats/Composer.tsx` — `quote`, `reply`, and `chat.send`.
- `apps/daemon/src/runs/messages.ts` — `sendMessage`; the prompt string.
- `apps/daemon/src/attachments/message.ts` — `messageWithFiles`, a different attachment path (uploaded files).

## Open questions

- Should a terminal quote use the file label ("Add to chat") or the chat label ("Reply")? The code uses both, for different gestures.
- For A, where would the file live: inside the place the agent works in, or under the daemon data directory like uploaded attachments? Those two places are not equal for a sandboxed agent. See [agent-context.md](agent-context.md).
- For A, is the line index a buffer row (what xterm selects) or a logical line after wrapped rows are joined (what `getSelection()` returns)? They disagree. See [terminal.md](terminal.md).
- Is the extra context the agent should be able to read the 5,000 rows still in the ring, or an append-only log of everything the shell printed, including output already discarded?
- Should a selection inside a full-screen program (alternate buffer) be quotable? That buffer is the screen, not the shell's scrollback.
- Does a quote from a terminal that is not the chat's place (another folder or worktree) need an absolute path? The current file quote uses the path relative to the place.

## Assumptions and coverage limits

- Clowdy's `AGENTS.md` does not require CodeGraph. This pass used the source, the protocol, and the daemon guide.
- The app was not run. Selection behavior is from xterm 6.0.0's own source (`getSelection`, `getSelectionPosition`, `selectionText`) and from Clowdy's call sites. Copy on a Mac was not exercised; the app's handler leaves non-Ctrl keys to xterm.
- No agent session was inspected to see whether a model follows `` `path:10-12` `` and opens the file. The daemon does not do that itself.
- Provider sandbox rules were not re-read. The constraint cited for files outside the project is the daemon guide's attachment note.
- `packages/components/src/Terminal/` is chrome with no xterm and no caller in the app. The in-app terminal does not use it.

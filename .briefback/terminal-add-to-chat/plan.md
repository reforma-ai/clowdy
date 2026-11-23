# Terminal Add to chat

> Keep this plan current during implementation.
> Check off tasks as their outcomes are completed.
> Check a stage only after done-when, verification, review, and commit
> (or staging per project rules).
> Record scope changes before leaving the stage.
> Record landed commits under the stage they implement.

**Goal:** selecting text in the app's terminal offers Add to chat, and the quote points at a plain-text log of that terminal's buffer so the agent can read more than the selection.

**Approach:** The daemon keeps 500 rows of scrollback and rewrites one plain-text file per shell from that buffer (Stage 1). A turn is handed the project's log folder and told its path (Stage 2). The terminal selection quotes that file the way a file selection already quotes code (Stage 3). Research: `research/index.md`.

**Decisions**

- Scrollback is 500 rows on the daemon mirror and the renderer. The log is the plain text of that same buffer, one line per drawn row of the active buffer, trailing blanks cut, rewritten as the screen changes. ANSI is not in the file. After the screen moves, a line range can name different text; the selected text stored in the message stays as it was.
- The file is `<dataDir>/terminals/<projectId>/<terminalId>.log`. Nothing is written into the person's repository.
- A turn receives that project's terminals directory through `additionalDirectories` when the directory exists. The system prompt names its absolute path and says the app's terminal logs are there, one file per shell, so the agent can look when the person talks about the terminal without selecting anything.
- A terminal selection offers Add to chat and Mod-i. The draft gets a file-style quote: the absolute path, the buffer-row range, and those rows' text, capped at 100,000 characters. Several quotes accumulate. It is not a Reply card.
- The file exists only while the session does: the running shell and the 30 minutes an exited shell stays listed. Removing the session or stopping the daemon deletes the file.

**Reuse:** `TerminalSession` mirror (`apps/daemon/src/terminals/session.ts`), the line dump in `Viewer.lines` (`apps/daemon/test/terminals.test.ts`), `codeQuote` and `quoteIntoComposer` (`apps/desktop/src/renderer/features/chats/`), `useAddToChat`'s `showChat` path, `additionalFolders` (`apps/daemon/src/runs/driver.ts`), `systemPrompt` (`apps/daemon/src/runs/prompts.ts`).

## Out of scope

- An append-only transcript of everything the shell ever printed.
- A log inside the project tree, under `.clowdy/`, or in `/tmp`.
- Granting the agent the whole data directory.
- Making a line range stay valid after the screen moves.
- A Reply card, or the daemon expanding the quote itself.
- A second grant for agents that do not advertise `additionalDirectories`. They still get the path in the prompt and the selected text in the quote.

## Stage 1 — The buffer is a file

**Depends on:** None.

**This stage:** The scrollback both sides keep drops to 500 rows, and each listed terminal has a plain-text file of its active buffer. The file is what is drawn: one line per buffer row, trailing spaces cut, trailing empty rows dropped, no header, so line 1 is the first row. It is rewritten after the mirror has parsed a burst of output, and again when the screen is resized, not on every byte and not from the ANSI serializer. The path is on `TerminalInfo` so the client does not invent the data directory. Closing the terminal, the sweep after the 30 minutes, a failed start, and stopping the daemon delete the file. A write that is still waiting when the session goes does not recreate it. A start deletes logs still in the directory: a daemon that was killed never reached `stop()`, and no shell is alive to own them.

- [ ] Complete
  - [x] Scrollback is 500 on the daemon mirror and the renderer's terminal
  - [x] A listed terminal rewrites `<dataDir>/terminals/<projectId>/<terminalId>.log` as the plain rows of the active buffer
  - [x] `TerminalInfo` names that absolute path
  - [x] The file is gone when the session is gone, including logs a killed daemon left behind
  - [x] The daemon guide no longer says nothing about a terminal is persisted

**Files**

- `packages/protocol/src/terminals.ts` — `TERMINAL_SCROLLBACK`, `TerminalInfo`: 500 rows, and `logPath`
- `apps/daemon/src/terminals/session.ts` — `TerminalSession`: write and delete the log
- `apps/daemon/src/terminals/service.ts` — `TerminalService`, `TerminalServiceOptions`: pass the log path, delete with the session
- `apps/daemon/src/daemon.ts` — `TerminalService`: logs under `config.dataDir`
- `apps/daemon/test/terminals.test.ts` — `Viewer`, the log tests: scrollback follows the constant; the file matches the buffer and disappears
- `apps/daemon/AGENTS.md` — the terminal lifetime: the log, and that the shell itself still dies on restart

**Done when:** a running or recently exited terminal has a plain-text file of its current buffer at the path its info names, and that file is gone once the session is.
**Verify:** `bun test --cwd apps/daemon test/terminals.test.ts`
**Commits:** None yet.

## Stage 2 — The agent can open the logs

**Depends on:** Stage 1.

**This stage:** A turn that can take extra directories is given this project's terminals folder, and only when that folder is already there, the same way a missing project folder is left out. The system prompt names the absolute path whether or not the folder exists yet, so the agent knows where to look when the person says the terminal is wrong and selected nothing. Agents that do not advertise the capability are unchanged apart from that sentence. Exact `additionalDirectories` assertions that never create the folder stay as they are.

- [ ] Complete
  - [ ] `additionalDirectories` includes `<dataDir>/terminals/<projectId>` when that directory exists, and omits it when it does not
  - [ ] The system prompt names that absolute path and says one file there is one shell

**Files**

- `apps/daemon/src/runs/driver.ts` — `additionalFolders`: the project's terminals directory, when it is there
- `apps/daemon/src/runs/prompts.ts` — `systemPrompt`: the path sentence
- `apps/daemon/test/chat-folders.test.ts` — the directory grant, including a case where the folder exists
- `apps/daemon/test/orchestration.test.ts` — `systemPrompt`: the path sentence

**Done when:** a turn for a project that has had a terminal is handed that project's log directory and told its path, and a project that has not is told the path without being handed a missing directory.
**Verify:** `bun test --cwd apps/daemon test/chat-folders.test.ts test/orchestration.test.ts`
**Commits:** None yet.

## Stage 3 — Add to chat from the terminal

**Depends on:** Stage 1.

**This stage:** While a message box is mounted, a non-empty terminal selection shows Add to chat and Mod-i does the same thing. Mod-i is not sent to the shell when it quotes. The quote is `codeQuote` of the session's `logPath`: the range is the 1-based index of the buffer rows the selection covers (line 1 is the first row of the active buffer, the same numbering as the file), and the body is those rows, not the joined string `getSelection()` returns where a row wraps. A selection past 100,000 characters is cut the way a file quote is. The composer takes the text and the chat is shown. The exit line the renderer paints is not in the daemon file; a selection of it can name a range the file does not have, and the text in the message is still what was selected. The button is the terminal's own, because the file editor's selection action never sees an xterm selection.

- [ ] Complete
  - [ ] Add to chat and Mod-i quote the selected buffer rows through the composer, and only while a composer is mounted
  - [ ] The quote is the absolute log path, the row range, and those rows
  - [ ] The desktop guide says the terminal offers Add to chat

**Files**

- `apps/desktop/src/renderer/features/terminal/TerminalView.ts` — selection rows, the button, Mod-i
- `apps/desktop/src/renderer/features/terminal/TerminalTab.tsx` — `quoteIntoComposer`, `showChat`
- `apps/desktop/src/renderer/features/terminal/TerminalTab.test.tsx` — the quote that a selection produces
- `apps/desktop/src/renderer/features/chats/codeQuote.ts` — `codeQuote`: called as it stands
- `apps/desktop/AGENTS.md` — the Terminal section: Add to chat

**Done when:** selecting text in a terminal and pressing Add to chat or Mod-i puts a file quote of that log into the composer and shows the chat.
**Verify:** `bun run --cwd apps/desktop test -- features/terminal`
**Commits:** None yet.

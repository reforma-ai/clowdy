# Agent context

## Summary

A quote becomes model context only as text inside the user message. The daemon does not parse `` `path:10-12` ``, does not open that path, and does not fetch lines the user did not select. Uploaded files are the one attachment the daemon rewrites into the prompt, as absolute paths. The agent can read more than it was given only with its own file tools, and only when the path is a file it is allowed to open. A terminal transcript is not such a file today. Pasting the selection (B) is therefore a one-shot blob. A path plus a range (A) gives the agent more context only after something writes a real file and the agent chooses to read it.

## How it works

`Composer.send` calls `chat.send` with the draft text (reply card already expanded into `> ` lines) and, when the user attached files, `attachmentIds`.

`sendMessage` (`apps/daemon/src/runs/messages.ts`) trims that text and stores it on the `user` stream item. That is what the chat shows. The string the engine is given is `content`:

- By default, `messageWithFiles` (`apps/daemon/src/attachments/message.ts`): the person's text, then a blank line, then `Attached files:` and one line per file, `- @/absolute/path (media type, size)`.
- With no files, `content` is the text alone.
- Callers can pass a different `content`. The composer does not. The first message of a run is wrapped by `firstMessage` (mode line plus the text). Later turns send `content` as the prompt.

The comment on `messageWithFiles` says the agent sees plain text only. Engines, the driver, and `next_prompt` know nothing of files beyond that string. There is no quote type, no line-range type, and no post-processing that pulls in surrounding source lines.

So a file Add to chat and a chat Reply arrive as ordinary Markdown in `text` / `content`. A file quote the user then asks about is sent as one blockquote with hard breaks (two trailing spaces), then a blank line, then the typed words. `codeQuote.test.ts` pins the string:

```text
> `src/a.ts:4`  
> ```ts  
> a();  
> ```

Why is this called twice?
```

The path is a hint written by the client. Whether a given agent opens `src/a.ts` and reads past lines 4 is that agent's behavior. Clowdy does not do it. The path works as a hint because it is the file's path in the place the run already works in (the chat's worktree, else the chat's folder, else the main folder). The agent's own read tools see that tree. `additionalDirectories` can include the project's other folders. That is the existing way "read more than the selection" happens, and it depends on the file already being on disk, stable, and inside a directory the session was given.

Uploaded attachments are different. They are bytes under `<dataDir>/attachments/<id>/<name>`, mode 0600. The prompt names the absolute path. The daemon guide says an agent whose sandbox forbids paths outside the project cannot open them. They have no line range. Deleting the chat deletes them. They are not how Add to chat works.

`@` mentions in the typed text are also just text (`@src/a.ts`) by the time they reach `sendMessage`. The composer serializes the chip; the daemon does not resolve it to file contents.

A queued message keeps the same `content` until it is delivered. Editing a message can resend text and attachment ids; it does not know about quotes as a structure. A fork copies attachment bytes to new ids. Quoted source paths inside the copied conversation text are the original paths. None of that adds a terminal log.

## What this means for A and B

**B (selected text only).** The agent receives exactly the cells the user selected, wrapped as a blockquote, plus whatever they type. It cannot see the next lines unless it runs commands itself. That matches chat selection, which is already a one-shot blob. It does not match the file flow's extra ability, and that extra ability is not a property of the quote. It is a property of the file.

This path does not put unselected scrollback, including secrets the user did not highlight, into the prompt. It also does not create a file that later turns, other chats, or git could read.

The practical limits are the composer's, not the daemon's. `quote` will insert a very long selection. `codeQuote` exists partly so a lockfile-sized selection never becomes the message. A 5,000-row terminal selection can approach that. The command body is refused past 8 MB, which is far above the 100,000-character quote cap.

**A (path plus range, agent can read further).** Nothing in the prompt pipeline will open the path. The range is useful only if:

1. Some writer creates a file the agent's tools can read, and
2. The lines in that file stay put for as long as the agent might read them, and
3. The quote tells the agent a path it can actually open.

The current terminal fails (1) and (2). There is no file. The in-memory ring drops the oldest rows and reflows on resize, so a range taken at selection time does not name the same text later. See [terminal.md](terminal.md).

Where a new file could live, from the rules that already exist:

- **Inside the place** (the worktree or the folder). The agent can read it the way it reads `src/a.ts`. The file is also a real file in that tree: git status sees it unless it is ignored, and another agent in the same place sees it. Secrets in the scrollback become files in the working tree. The terminal's start `cwd` may not be the shell's current directory, and a terminal is shared by every chat in the place, not owned by the chat that quoted it.
- **Under the daemon data directory**, like attachments. The prompt can name the absolute path, which is what `messageWithFiles` does. The same guide says a sandboxed agent may be unable to open that path. Codex's shell is sandboxed with network off; the guide's `clowdy` note is about the CLI, not about reading an attachment, but the attachment sentence is explicit: outside the project, a sandbox can refuse. This pass did not re-check each provider's sandbox.
- **A Cursor-style `@/path/to/terminals/9.txt:9-18` mention.** The composer has no line-range mention. The daemon would not expand it. The agent would have to understand the syntax and open the file. That is the same "hint plus a real file" arrangement as today's file quote, with the body omitted.

Writing the file once at selection time freezes a snapshot. The agent can then read lines around the selection only within that snapshot, and only until the file is deleted. It cannot see output that arrives afterward unless the file is appended. Appending the raw PTY stream does not produce stable plain lines (ANSI, carriage returns, alternate screen). Appending plain rows from the reflowed buffer renumbers when the width changes. An append-only capture of logical lines, taken before reflow and never trimmed, would be a new log beside the ring. The ring cannot be that log.

Multi-session makes the path part of the identity. There can be 16 shells, several in one place, labeled only `zsh` and `zsh 2`. The terminal id is unique; the label is not. A file named from the label collides. The shell is not per chat.

Renderer versus daemon matters for who can write the file. The selection range exists only in the renderer's xterm. The renderer cannot write the project through Node; it would go through the daemon's file API, which refuses paths outside the place, or through the attachment upload API, which stores bytes under the data directory. The daemon's mirror can dump its own buffer, but the private `#mirror` has no plain-text method and no route, and it does not know which cells the user selected. Electron main never sees the bytes.

## Relevant files and modules

- `apps/desktop/src/renderer/features/chats/Composer.tsx` — `chat.send` text and `attachmentIds`.
- `apps/daemon/src/runs/messages.ts` — `sendMessage`; `content` is the prompt.
- `apps/daemon/src/attachments/message.ts` — `messageWithFiles`.
- `apps/daemon/src/attachments/` — upload path, data-directory layout, sandbox note in the daemon guide.
- `apps/desktop/src/renderer/features/chats/composerMentions.ts` — `@path` with no line range.
- `apps/daemon/AGENTS.md` — "Attachments", "Prompts", "Folders", and the terminal section "Nothing is persisted".

## Constraints

- The model context for a quote is one string, sent once. Later turns do not re-read the composer.
- Extra lines are available only if they are in a file the agent's own tools can open. Clowdy does not fetch them.
- A path outside the project is named in the prompt for uploaded files and may still be unreadable under a sandbox.
- A path inside the project is readable and is also part of the tree.
- Terminal line numbers in the live buffer are unstable. A snapshot file is stable only for that snapshot. See [terminal.md](terminal.md).
- The quote cap and the composer cost sit on the client. The daemon will accept a multi-megabyte `text` until the 8 MB body limit.

## Open questions

- If A is a snapshot file, is "more context" the rest of the 5,000-row ring at that moment, or output that arrives later?
- If the file is in the worktree, should it be gitignored, and who deletes it?
- If the file is in the data directory, which agents can read it? That needs a check against the sandboxes, which this pass did not run.
- Should the prompt include the selected text as well as the path, as `codeQuote` does, so the model still sees the selection when it cannot open the file?

## Assumptions and limits

- No live agent was asked to follow a `path:line` quote. "The agent can open the file" is inferred from the session's working directory and additional folders, plus the absence of any daemon expander.
- The sandbox limitation for data-directory paths is the daemon guide's sentence on attachments. Provider settings were not re-read.
- `firstMessage` was not opened. The guide says the first turn prefixes the mode and the content, and later turns send the content alone. The quote would be inside that content either way.

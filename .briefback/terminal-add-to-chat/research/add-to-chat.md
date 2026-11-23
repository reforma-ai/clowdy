# Add to chat

## Summary

"Add to chat" from a file or a diff, and "Reply" from a chat message, both end as Markdown in the composer. Neither creates the uploaded-file attachment that `chat.send`'s `attachmentIds` carries. A file quote includes a relative path, an inclusive line range, and the selected text. A chat quote includes text only. The composer wraps every line in `> `. The side panel can do this only while a real message box is mounted.

## How it works

### Files and diffs

`useAddToChat(pathOf)` returns a CodeMirror extension, or `undefined` when no composer is registered. `FilesTab` passes it as `editorExtensions` and reads the path from the active tab at the moment of the action. `DiffCard` passes it to `DiffView` and uses `file.path`. Both paths are relative to the place (the folder or the worktree), not absolute.

The extension is `selectionAction` in the file manager. While the main selection contains something other than blank space, it shows a filled small button under the last selected character: the Message icon, the label **Add to chat**, and a `Mod-i` hint (⌘I on a Mac, Ctrl+I elsewhere). The button waits until the mouse is released. The press does not move focus or clear the selection first; `run` then calls `onAction` and collapses the selection. `Mod-i` is bound with `Prec.high` so it beats CodeMirror's "select parent syntax", and it does nothing when the selection is empty, so that binding still works with a caret. Only the main range counts.

`selectedLines` reports 1-based inclusive lines of the document the view holds, plus the text as written. A selection that ends at the start of a line counts as the previous line. In a diff card the document is the new text. Removed lines are widgets, not document text, so they cannot be selected or quoted, and the line numbers are the new file's.

`onAction` builds `codeQuote(path, selected)` and passes it to `quoteIntoComposer`. If that returns true, `ProjectUi.showChat()` runs. `showChat` closes the side panel only when the panel is covering the chat (`sidePanelCoversChat`: open and full width). A panel beside the chat stays open.

`codeQuote` shape, before the composer wraps it:

```text
`src/a.ts:10-12`
```ts
selected text
```
```

One line is `` `src/a.ts:10` ``. The fence is at least three backticks, longer than any run inside the text, so the text cannot close it. The info string is the file's extension. Leading blank lines and trailing space are stripped. Over 100,000 characters the quote is cut at the last whole line that fits, the header names the lines actually included, and a following line says the selection goes on to the original end line (`MAX_QUOTED_CHARS`). The comment in `codeQuote.ts` gives the reason: the composer makes a node per line break, and a huge selection is a flood for the agent.

There is no second payload. Path, range, and text are one string.

The rich Markdown editor (`MarkdownPane`, TipTap) does not get this extension. A selection there is rendered text with no source lines. Docs in the source view use the same editor extension as other files.

### Chat messages

The labels differ from the file button. Both gestures say **Reply**.

- A whole message: `MessageActions` shows an icon button when the message has text and `onReply` is set. `StreamView` calls it with `{ role: 'user' | 'assistant', text }` where `text` is the message as written, Markdown included. `ChatView` turns that into `ComposerHandle.reply`. Swipe-to-reply does the same when the setting is on. The role is shown on the card (`You` or the agent's name) and is not part of the quoted text.
- A selection inside one message: `SelectionReply` listens on `document` and reads `window.getSelection()` only when the range lies inside a single `[data-message]` in that stream. The button says **Reply**, with no shortcut. It quotes `Selection.toString()` trimmed: the words as drawn, not the Markdown source. A fragment cannot be mapped back to source lines. The button hides while the pointer is down, and on Escape, scroll, or resize.

`reply` stores one `ReplyMessage` per composer key (`composerQuotes`). The card replaces any previous card. The draft is unchanged until send. `quote` (the selection path, and the side panel's path) appends immediately via `withQuoteLast` and focuses the field. An edit-frame composer does not register with the bridge and does not show a reply card.

### What the composer does with the string

`quoteIntoComposer` calls the last registered `ComposerHandle.quote`. Registration is `useRegisterComposer` from `Composer`. The open chat and the new-chat page register. A read-only chat has no box, so it registers nothing, `useHasComposer()` is false, and the file button is not offered. If several boxes were mounted, the last one wins. Observed: the registry is a stack, and `quoteIntoComposer` uses `composers.at(-1)`.

`withQuoteLast` / `quoteOf` prefix `> ` on every line (a blank line becomes `>`), keep blank lines that sit inside a fence, drop other blank lines that sit between lines that are already quotes, and append that as one paragraph of hard breaks plus an empty paragraph for the caret. Empty input is ignored. The `>` characters are plain text. There is no quote node.

So a file quote arrives in the draft already inside a blockquote, fence included. A second Add to chat appends another quote. Drafts live in a module-level `Map` (`composerDrafts`), keyed by chat id or the new-chat key. They survive switching chats in the same window. They are not written to disk; a reload drops them. Reply cards are the same kind of in-memory map.

On send, `Composer.send` takes the card if there is one and sets `text` to `quotedMessage(replied.text, message)`: the same `> ` wrapping, a blank line, then what was typed. Selection quotes and file quotes are already in `message` because they were written into the draft. The command is `chat.send` with that string, plus `attachmentIds` only for files picked with the attach button, a paste, or a drop. Those files are a separate mechanism (`useComposerFiles`): bytes uploaded to the project, shown as chips, not quotes.

`@` mentions are also separate. `serializeMention` writes `@src/a.ts` (quoted if the path has whitespace). There is no line-range field on a mention.

## Relevant files and modules

- `packages/file-manager/src/react/editor/selectionAction.ts` — button, `Mod-i`, `SelectedLines`.
- `apps/desktop/src/renderer/features/chats/useAddToChat.ts` — host callback, `showChat`.
- `apps/desktop/src/renderer/features/chats/codeQuote.ts` — path, range, fence, 100,000-character cut.
- `apps/desktop/src/renderer/features/files/FilesTab.tsx` — path from the active editor tab.
- `apps/desktop/src/renderer/features/changes/DiffCard.tsx` — path from the changed file; new text only.
- `apps/desktop/src/renderer/features/chats/composerBridge.ts` — `registerComposer`, `quoteIntoComposer`, `useHasComposer`.
- `apps/desktop/src/renderer/features/chats/composerDrafts.ts` — `withQuoteLast`, `quotedMessage`, `quoteOf`.
- `apps/desktop/src/renderer/features/chats/composerQuotes.ts` — the one reply card per box.
- `apps/desktop/src/renderer/features/chats/Composer.tsx` — `quote`, `reply`, send.
- `apps/desktop/src/renderer/stream/SelectionReply.tsx`, `selectedMessage.ts` — selection Reply.
- `apps/desktop/src/renderer/stream/MessageActions.tsx`, `StreamView.tsx`, `ChatView.tsx` — whole-message Reply.
- `apps/desktop/src/renderer/stores/UiStore.ts` — `showChat`.

## Constraints

- The file payload is one quoted string. There is no structured `{ path, from, to, text }` after `codeQuote`.
- The chat payload has no path and no line range. A partial selection is rendered text.
- The composer must be mounted. The edit frame and a read-only chat are not targets.
- `showChat` does not close a side-by-side panel. It closes a panel that covers the chat, so the box can be typed in.
- File `Mod-i` is a CodeMirror binding. It does not exist on the terminal, and the terminal's key handler would otherwise give the key to the shell.
- The 100,000-character cap is inside `codeQuote` only. `ComposerHandle.quote` will accept a longer string.
- `chat.send`'s `text` is an unbounded string in the command schema. The HTTP body limit is 8 MB (`http/body.ts`). That is not a reason to put a 5,000-row log in the box: `codeQuote.ts` already treats a large quoted body as too heavy to edit and too large for the agent.

## What A and B meet here

**B fits the insertion that already exists.** `quoteIntoComposer(selectedText)` is the chat-selection path. The terminal would still need its own button; `SelectionReply` and `selectionAction` will not see an xterm selection. Reusing `codeQuote` without a real path would invent a header. Reusing `quote` alone pastes text and loses any chance to name a range.

**A does not fit this payload.** Nothing in the composer stores a path plus a range without also inlining the text. A mention cannot carry `:9-18`. Uploaded attachments are bytes plus an absolute path the daemon prints later; they are not a line range, and the attach flow reads `File` objects, not a terminal buffer. Putting only `` `some/terminal.txt:9-18` `` into the quote would look like a file quote's header with the body missing. The current file quote always includes the body, and the agent is not given a tool that expands the header. See [agent-context.md](agent-context.md).

## Open questions

- Which label a terminal button should use. Files say "Add to chat". Chat says "Reply".
- Whether a terminal quote should be a draft insertion (`quote`) or a card (`reply`). The card holds one message and replaces the previous card. Draft quotes accumulate.
- Whether a terminal selection should pass through `codeQuote`'s cap and fence, or through the plain `quote` path.

## Assumptions and limits

- Tests were not re-run. The payload shape is from `codeQuote`, `composerDrafts`, and `Composer.send`.
- How the user bubble renders a `>` quote was not checked in the window. The stored text is the Markdown source.
- The file-manager guide's description of `selectionAction` matches the source that was read. The rich Markdown exception is that guide plus the absence of the extension on `MarkdownPane`.

# Chat mentions

- Status: accepted
- Date: 2026-11-25
- Decided by: user (mentions and on-demand reading), orchestrator (pagination and archive behavior)
- Scope: Mentioning another chat and reading its conversation
- Related tasks: CLO-192
- Supersedes: none
- Superseded by: none

## Context

The composer already lists tasks, documents and files under `@`. A chat's agent can read its own thread tree with the thread commands, but cannot use those commands to read an independent chat.

## Decision

- Add a Chats section to the same picker. It searches the current project's chat titles, including archived chats, and excludes the current chat.
- Store a reference by chat ID, not title. A sent reference shows the current title and opens the chat when pressed.
- Let the agent read the referenced conversation on demand with `clowdy chat read`. The command is read-only, restricted to the current project, and returns messages, decisions from question cards and thread notices in pages. It does not wake the chat, change its archive state, or acknowledge thread notices.
- Do not inject another chat's history into the prompt automatically. Reading history does not grant permission to modify the other chat.

## Reason

People can refer to decisions and results from another conversation without copying its messages. The agent can choose how much history it needs.

## Consequences

Renaming a chat does not break references. Deleted chat references retain the ID but no longer open a chat. Opening an archived chat follows the app's existing behavior and restores it to the list. Reading it through the agent does not restore it.

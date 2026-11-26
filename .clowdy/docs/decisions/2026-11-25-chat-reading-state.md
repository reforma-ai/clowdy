# Remember each chat's reading state

- Status: accepted
- Date: 2026-11-25
- Decided by: user (independent chat state), orchestrator (session-only scroll and message anchor)
- Scope: Chat stream and running-agents disclosure
- Related tasks: CLO-193, CLO-17

## Context

CLO-17 made the running-agents disclosure folded by default, but remembered a manual toggle across the whole project. Opening it in one chat therefore opened it in another. Navigating to another chat also unmounted the stream, so the previous chat scrolled to the end when opened again.

## Decision

- Each chat starts with its running-agents disclosure folded. Manual changes belong to that chat and survive an app restart. Ignore the old project-wide value. Rows waiting for the user remain visible.
- Keep the reading position of each chat for the current window session. If the reader was away from the end, restore the visible message and its offset where possible, with a pixel-position fallback. Within the existing 50px latest-message threshold, continue following the latest messages when the chat is reopened.

## Reason

Switching chats should not interrupt reading a conversation. An explicit expansion in one chat should not change another chat's default.

## Consequences

The scroll position is not retained after an app restart. An edited or deleted anchor may fall back to the nearest available scroll position. Other composer disclosures keep their existing behavior.

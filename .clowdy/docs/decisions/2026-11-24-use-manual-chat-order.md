# Use one manual order for chats

- Status: accepted
- Date: 2026-11-24
- Decided by: user (semi-manual)
- Scope: The active chat list, its Filters menu, and Chat settings
- Related tasks: CLO-55
- Supersedes: none
- Superseded by: none

## Context

The chat list offered Created and Last activity in both Filters and Chat settings. Created was already the default. The user wanted to arrange chats by hand and keep new ones at the top.

## Options considered

1. Use a single manual order. Start with the newest chats and preserve a person's moves.
2. Keep Last activity as a separate mode. This retains automatic movement after a message and requires a switch between the two orders.

## Decision

Use a single order and remove the sorting controls. Save the order per project on this computer. New chats appear first. Moves stay within a folder when the list is grouped. Threads move with their parent.

## Reason

A steady list makes it possible to place frequently used chats where the person expects them. The project already saves other sidebar choices locally.

## Consequences

Receiving a message leaves a chat in place. Changing the folder grouping keeps the saved order. The same project can have a different order on another computer.

# Stage 2 data-layer API (for the chats stage)

Landed on `clowdy/full-app-refactor` from `clowdy/refactor-renderer-data` (range `3e89a8f7..a5a336b6`).

## RunStream

- `stream.ids`: item ids in `seq` order. A new array only when an item is added or removed, not when one changes.
- `stream.item(id)`: one item. A component that reads it re-renders only when that item changes.
- `stream.items`: unchanged, a new array on every change; kept for current callers.
- So `StreamView` should render `ids` and let each message read `item(id)`: then only the streaming message re-renders.
- `streamBlocks` folds only the latest turn on each chunk; earlier turns keep their block objects (cache by turn).

## Holding streams

- `useRunStream` holds the stream it shows. Unshown streams go to a pool of 20 released streams and older ones are dropped.
- Code that calls `streams.of()` directly gets a stream that may be dropped later and is reloaded on its next `load()`: views use `useRunStream`.
- A resync refetches only streams that are shown.

## Other changes

- Task lookup by key goes through an index (`ProjectState`), so a chip re-renders only when its own task changes.
- One SSE reader (`readSse`) for the feed and the file watch; both reconnect after 30 s of silence.
- The fixture daemon is in `daemon/fixtures.ts`, loaded on demand in development only; `createTransport` is async.

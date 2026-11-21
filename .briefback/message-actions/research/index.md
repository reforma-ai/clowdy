# Message actions: research map

**Question:** what does it take to add per-message actions to the Clowdy chat (copy, reply, edit a sent message, fork into a new chat, text selection with reply), using BB (`get-bb/bb`) as the reference? Orca was dropped by the user.

Snapshot 2026-11-20. Research only; nothing was implemented. The Clowdy notes were written at `0d37a49`; `main` has since taken two small merges (a keep-open Claude session for Monitor/wakeups in `apps/daemon/src/engine/acp/v2.ts` and `mapper-v2.ts`, and the running-agents plate in `features/chats/ComposerBanner.tsx`), so re-check those files before relying on line-level claims.

## Pages

- [ui-clowdy.md](ui-clowdy.md): the renderer side. `ChatView` → `StreamView` → `UserBubble` / `AssistantMessage`, the fold into "Worked for Ns", the composer, drafts and files per chat key, settings, design-system parts, icons, tests.
- [engine-and-providers.md](engine-and-providers.md): the daemon and the providers. Storage, session lifecycle, what ACP and the two pinned adapters can do for fork and truncate, options, side effects.
- [reference-apps.md](reference-apps.md): BB's message action row, selection toolbar, quote format, edit flow, fork flow, with the tests that document them.

## Summary

- The renderer has no per-message UI beyond an always-visible time on user bubbles. The final answer of a turn is decided inside `stream/turns.ts` but not exported. The composer has no edit mode and no quote model. No fork, edit-history or reply concept exists in the protocol, the daemon or the fixture daemon.
- ACP has no rewind or truncate method. `session/fork` is unstable. The two pinned adapters (`claude-agent-acp@0.107.0`, `codex-acp@2.8.0`) implement it and read a private fork-at-a-message `_meta.jetbrains.air.fork`. Claude cuts at an exact assistant message; Codex rounds to the end of the turn. No provider reverts file changes. Other ACP agents have no fork at a point.
- Clowdy stores only `runs.session_id`; it drops the ACP `messageId`. Deleting stream items is plain SQL, but no event tells the renderer about it.
- BB: actions appear on hover on desktop (the "last message always visible" rule is the user's own, BB has it only on touch). Edit forks the provider session at the previous turn's checkpoint, deletes the stored suffix and re-runs; only Claude, Codex and Pi can edit. Fork copies history through the end of the turn and the "Forked from" card never goes away. A quote is `> ` per line appended to the draft.

## Not answered by research

- Real behaviour of the private fork `_meta` at the pinned adapters (nothing was run). Codex 2.8.0 cannot be launched here until 2026-11-22 (`minimumReleaseAge`).
- Whether `resumeSessionAt` could truncate in place for Claude (unverified lead, not needed by the plan).
- Whether Gemini, Copilot, OpenCode, omp or Hermes advertise `sessionCapabilities.fork` in a real `initialize`.

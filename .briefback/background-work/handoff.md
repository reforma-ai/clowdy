# Handoff: background-work

> Next chat: read this file and the plan when present. Resume within the
> authorized scope, respecting dependencies and existing worker ownership.
> Do not resurrect discarded approaches from a chat summary.

## Plan

path: `.briefback/background-work/plan.md`
sync: updated (rewritten after the probes and the grill of 2026-11-19; nothing implemented yet)
scope: Research and the grill are done and the plan is written; **no source file has been changed**. Authorized so far: reading, probing, and the files under `.briefback/background-work/`. Implementation is not yet authorized: ask the owner which stages to start.

Attach: this file, `plan.md`, `research/index.md`, and `research/acp-background-probe.md` for any ACP work, `research/turn-lifecycle.md` for the driver.

## Current work

stage: none started (research, grill and plan only)
shipped: `.briefback/background-work/{plan.md,handoff.md,research/index.md,research/turn-lifecycle.md,research/acp-background-probe.md,research/probe-harness.ts.txt}`, uncommitted. No source file was touched.
remaining: everything in the plan.
worker: none

## Bleed

none. Corrections to carry forward from earlier chats:

- The first plan assumed a quiet window of 5 s, a `backgroundTaskId` heuristic and a v1 opt-in route (`_meta.jetbrains.air`). The owner rejected the timer; the probes found explicit v2 events instead. Those approaches are discarded; the AIR route is only a named fallback.
- The first research said a background sub-agent is killed at the end of the turn. It is not: without `backgroundSubagents` the adapter holds `session/prompt` until the sub-agent finishes (probe s3). `research/turn-lifecycle.md` has the corrected table.
- The first plan did not know about the existing title linger in `AcpSession` (`awaitsTitle`, `linger`, `lingering`). Stage 5 builds on it.

## Warnings for whoever implements

- **Do not work in the checkout the owner's dev app runs from.** The owner's development build of Clowdy runs this repository's daemon. Editing `apps/daemon` there can restart or kill live runs, including the chat that orchestrates the work. Use a worktree (`./clowdy worktree add background-work`, see `GITFLOW.md`) or have the owner close the app. For real checks start a throwaway daemon on its own `CLOWDY_DATA_DIR` and `CLOWDY_PORT` (and its own `CLOWDY_PERSONAL_DIR`), never the owner's.
- **The working tree has the owner's uncommitted edits**, among them `apps/desktop/AGENTS.md`, `apps/desktop/src/renderer/features/agents/{AgentList.tsx,AgentList.module.css,ArchiveButton.tsx,Screen.test.tsx}` and `apps/desktop/src/renderer/shared/SidebarHeading.tsx`. Do not stage, stash, reset or reformat them; commit only your own paths (`GITFLOW.md`, conventional commits, English only).
- The probe client is `research/probe-harness.ts.txt` (the header says how to run it); each scenario makes a few small model calls (haiku for Claude, the user's default model for Codex). It needs the user's own `claude` and `codex` logins and the pinned adapters from `bun x`.
- Tests: the daemon's tests run with `bun test` from `apps/daemon` (not Vitest). No test starts a real agent; keep it so, and use `ScriptEngine` and the fake ACP agents.
- Stage 4 switches Claude Code and Codex to `protocol: 'v2'` only after the real-adapter checks pass; until then the catalog keeps them on v1.
- Only Claude Code, Codex and Cursor are in use. The v1 layer is kept working, not extended: a feature that is hard on v1 is not built there, and an agent on v1 simply lacks it (the runtime already degrades: no `steer` or `send` means the message waits in the chat's queue). Pick the protocol of any other agent when it is added.

## Next work

stage: Stage 1 — Contract, statuses and storage
done when: a daemon test moves a run `running → waiting_background → queued → running` and `→ succeeded`, refuses the transitions not listed, and reads `Run.background` back from the database and the event log.
assignment: unassigned
suggested: Briefback tdd for the status table and `setBackground`; Briefback review before commit

stage: Stage 3 — ACP protocol layers: the seam and the `protocol` setting
done when: `bun test test/acp-*.test.ts test/agents-api.test.ts` passes unchanged, and a test shows an agent set to `v2` that answers 1 being restarted on v1.
assignment: unassigned; independent of Stage 1 (it touches `engine/acp/` only), so it can run in parallel with it
suggested: Briefback review (a behaviour-preserving refactor of a 750-line file)

stage: Stage 2 — Driver: a session that outlives its turn (blocked by Stage 1); Stage 4 — ACP v2 layer: the conversation (blocked by Stage 3); Stage 6 — Desktop surface (blocked by Stage 1)
done when: see the plan
assignment: unassigned
suggested: Briefback tdd, plus the daemon's `AGENTS.md` invariants (status changes only through `RunService.setStatus`; events and transactions rules) for Stage 2; `apps/desktop/AGENTS.md` and `packages/components/AGENTS.md` before any UI change in Stage 6

stage: Stages 5, 7, 8, 9 — blocked by earlier stages (see **Depends on**). Stage 9 (stop and send for agents that cannot steer, e.g. Cursor) is a fallback added last at the owner's request
done when: see the plan
assignment: unassigned
suggested: Briefback review

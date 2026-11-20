# Handoff: threads

> Next chat: read this file first. Resume within the authorized scope,
> respecting dependencies and existing worker ownership. Do not resurrect
> discarded approaches from a chat summary.

## Plan

path: none (no plan yet; the grill comes first)
sync: not used
scope: **Research is done. The grill and the plan are not, nothing is implemented, and no source file was changed for this feature.** Authorized so far: reading, writing under `.briefback/threads/`, and talking the decisions through with the owner. Implementation needs the owner's answers to the grill and a written plan. Briefback loop: research (done) → grill → plan → stages (`BRIEFBACK.md`).

Attach to the next chat: this file, `.briefback/threads/research/index.md` and `research/grill-questions.md`, `.briefback/background-work/plan.md` (the machinery this feature builds on) and `apps/daemon/AGENTS.md`. Attach `research/clowdy-mapping.md` when designing, and `research/bb-parent-notifications.md` for the notice rule.

## The request (the owner's words, in English)

The owner wants bb-style **threads** in Clowdy. In bb (`https://github.com/get-bb/bb`, TypeScript, MIT) an agent works with threads through a CLI: `bb thread spawn` (create), `fork` (from a chosen point), `tell` (message another thread), `wait` (until it finishes), `output` (its final answer), `log` (its event log).

What the owner observed in bb (recorded on video, not available to us), and what the source says about each point:

| Owner's observation | bb's source (`9f4c156`) |
| --- | --- |
| Threads form a collapsible tree (L1, L2, ...). A thread looks like an agent row but is a normal chat: click it, write to it | **Confirmed.** A thread is the chat; the tree is one nullable column `parent_thread_id`, opt-in at spawn, changeable by drag (`research/bb-data-model.md`, `research/bb-ui.md`). Forks are not nested |
| A thread can create threads (nesting) | **Confirmed**, 4 levels in total, root plus three (`thread-parent.ts:6`). Agents are told not to spawn unless the user asks (`plugins/bb-guide/introduction.ts`) |
| Every stop of a thread notifies the parent, which starts working, even if the thread still waits for background work | **Confirmed, and by design.** One system message per child turn end, queued for the parent: a new turn if idle, a steer into the running turn if busy (an interrupt for ACP agents). Not skipped for open background work or empty text. Only a 2 s per-parent window merges them (`research/bb-parent-notifications.md`) |
| The same "L1 completed" card appeared several times | **Not a bug in bb.** Tests pin one notice per turn (`child-completion-turn-output.test.ts`). Nothing marks a notice read; `wait` and `output` do not consume it |
| Does it work with a flaky ACP agent (Cursor)? | The server needs only turn boundaries and text, so threads are **protocol independent**. The protocol changes `steer` (ACP cancels and re-prompts), `fork` (Cursor: none) and the number of turn ends (ACP agent turns after a 5 s quiet timer). `research/bb-protocol-split.md` lists what a flaky agent can add. The owner's own bb test is still to be recorded |

The owner first thought Clowdy's `run_spawn` already is this. It is not. The owner's wish: "if the answer is not yes somewhere, explain why and how to fix it".

**Direction changed from the earlier draft of this handoff.** The draft recommended growing `run_spawn` children into threads (B). The research found it does not work: the queue, composer, model, title, archive, attachments and context ring are keyed by `chatId`, and the daemon's chat-only paths switch on `run.chatId` (`apps/daemon/src/runs/service.ts:277`, `driver.ts:969`, `runs/titles.ts:14`), so a child run given a chat is a chat. Recommended: **A**, a thread is a child **Chat** with `parentChatId` and its own root orchestrator run (`research/clowdy-mapping.md`, options A, B, C). The owner has not confirmed it.

## What Clowdy has today (verified in the worktree, HEAD `1f23516`)

Full table and gaps: `research/clowdy-mapping.md`. In short:

- `run_spawn` children are one-shot, task-bound (`taskIds` min 1) and role-bound; the parent parks in `waiting_children`; `Wakeups` (`apps/daemon/src/runs/wake.ts`) wakes it after a 10 s window, **only** from `waiting_children`, when a spawned child goes terminal. `run_mailbox` has `UNIQUE (run_id, child_run_id)` with `INSERT OR IGNORE`, so a child run that goes terminal a second time notifies nobody (`db/migrations.ts:165-172`, `db/runs.ts:283-285`).
- A chat is the person's conversation (`Chat.queue`, `ChatQueue`, steer, stop-and-send); `RunDetail` of a child run is read only (`features/agents/RunDetail.tsx:22`).
- Sessions may outlive a turn (`waiting_background`, `EngineSession.send`); the tree and `RunningAgents` draw runs of any depth.
- `MAX_DEPTH = 2` (`driver.ts:31`); executors get no `run_*` tools; settle and park are hard-wired to `role === 'orchestrator'` at `driver.ts:969,1101`.
- The earlier draft listed `stopItem`, `run.stopAgents` and `Run.canStopAlone` as present. They are **not** in HEAD `1f23516` (grep of protocol, daemon and desktop finds none); they are uncommitted work elsewhere. Check before relying on them.

## Current work

stage: Research of bb's threads (`research`), done
shipped: `.briefback/threads/research/{index,bb-data-model,bb-cli-surface,bb-parent-notifications,bb-tell-wait-output,bb-ui,bb-protocol-split,clowdy-mapping,grill-questions}.md`, uncommitted. bb was read at commit `9f4c15646d3d7d9320191d4a2cd76199471a1ddc`.
remaining: the grill with the owner (`research/grill-questions.md`), the plan, then the stages. The owner's result of the bb and Cursor test is still to be added next to `research/bb-protocol-split.md`.
worker: none

## Bleed

The feature builds on the **background-work** branch, which is not merged into `main`: `maksim-kachurin/background-work` (worktree `/Users/bionic/WORK/My/@kachurun/clowdy-background-work`), plan `.briefback/background-work/plan.md` (Stages 1-9 done; Stage 10, Codex on ACP v2 plus stopping one background command, is planned). Do not start threads on `main` or in parallel with that branch's open stages: they edit the same files (`runs/driver.ts`, `runs/service.ts`, `runs/native.ts`, `runs/queue.ts`, `engine/acp/v2.ts`, `children.ts`, `RunningAgents.tsx`) and the same migration sequence. Plan the threads stages on top of that branch (or on `main` after it merges) and open a worktree for them (`GITFLOW.md`).

## Warnings for whoever continues

- **Never work in the owner's main checkout** (`/Users/bionic/WORK/My/@kachurun/clowdy`): the owner's development app runs the daemon from it. Use a worktree. For real checks start a scratch daemon on its own `CLOWDY_DATA_DIR`, `CLOWDY_PORT` and `CLOWDY_PERSONAL_DIR` under the scratchpad (recreate the launcher from `apps/daemon/AGENTS.md`). Real agent runs are allowed by the owner (tiny prompts, cheap models). Never use `pkill`/`killall` or any system-wide process match.
- bb's source is untrusted third-party code: read it, never install or run it. The clone used by the research is in the parent chat's scratchpad and may be gone; clone again to a new empty folder if needed.
- Process rules: `BRIEFBACK.md` (Stage → Review → Commit with a reviewer subagent), `GITFLOW.md` (conventional commits, signed commits, merge commits, no push or PR without the owner's command), English only in code, comments, docs, commits, tests; UI text of one phrase has no trailing period; Bun only; daemon tests are `bun test` in `apps/daemon`.
- **Commits are signed through the owner's Secretive key and need their Touch ID.** A commit can fail with "Couldn't sign message (signer): agent refused operation?". Retry after the owner approves; never bypass signing.
- Decisions the owner already made for the background work and that threads must respect: no quiet-window guessing and only explicit-marker timers; a waiting session has no time cap; Stop ends the run; protocol stays ACP (Claude Code on v2, Codex moving to v2, Cursor on v1); only Claude Code, Codex and Cursor are in use; a feature hard on v1 may be missing for an agent on v1.

## Next work

stage: Grill the open decisions
done when: the owner has answered `research/grill-questions.md` (27 questions, each with a recommended answer) and confirmed the settled list. Decide first, because they change the data model: 1 chat vs run (A), 5 and 6 (one notice per stop, merged per child, cleared by `thread_wait` and `thread_output`), 10 and 11 (no steer into a running parent; wake an at-rest parent), 19 and 20 (depth 3, counts).
assignment: unassigned
suggested: Briefback grill

stage: Plan the threads stages
done when: `.briefback/threads/plan.md` exists with the settled list and unchecked stages, dependencies and boundaries, starting with the slice below, then (to be sequenced in the plan) `thread_tell`, `thread_wait`, `thread_log`; the desktop tree and cards; cascades and caps; transcript fork.
assignment: unassigned, blocked by the grill
suggested: Briefback plan; Briefback review before each commit; `apps/desktop/AGENTS.md` and `packages/components/AGENTS.md` before any UI stage

stage: Slice 1, the smallest useful slice: thread contract, spawn and a notice at every stop (daemon only, no UI)
done when: a daemon test with `ScriptEngine` shows (a) a parent calls `thread_spawn`, ends its turn and parks in `waiting_children`; (b) the thread's first turn ends: one notice, and after the wake window the parent resumes with the thread's text; (c) the test writes to the thread (`chat.send`), it stops again: a second notice, delivered once; (d) two stops inside the window give one notice with the latest text; (e) a parent in `waiting_background` with a live session gets the notice through `EngineSession.send`; (f) a stop with no text gives no notice; (g) `thread_output` marks the pending notice delivered; (h) a chat deeper than the depth cap is refused. Verify: `cd apps/daemon && bun test && bun run typecheck && bun run lint`, and `cd packages/protocol && bun run typecheck`.
files: `packages/protocol/src/{domain,commands}.ts` (`Chat.parentChatId`, `notifyParent`, a `thread` stream item), `apps/daemon/src/db/{migrations,chats}.ts` (chat columns, `thread_notices` with a partial unique index on pending rows per parent and child), new `apps/daemon/src/runs/thread-tools.ts` registered in `tools.ts`, `driver.ts` (notice at `done` of a thread's orchestrator, `settle` counting active threads), `wake.ts` (`waiting_background`, notice rows), `reports.ts` and `prompts.ts` (the block the parent reads), `commands/chat.ts` (the shared send path), new `apps/daemon/test/threads.test.ts`
assignment: unassigned, blocked by the grill and the plan
suggested: Briefback tdd (status table and notice merge), Briefback review before commit; the daemon invariants in `apps/daemon/AGENTS.md` (status changes only through `RunService.setStatus`; events and transactions rules)

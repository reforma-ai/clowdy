# bb threads: how an agent uses them (CLI, guide, transport, limits)

Source: `get-bb/bb` at `9f4c15646d3d7d9320191d4a2cd76199471a1ddc` (2026-11-19), read only. Paths are relative to the bb repo root. Guide templates live in `packages/templates/src/templates/` (printed by `bb guide <chapter>`).

## Summary

- Threads are driven by a **shell command**, `bb`. It is not an MCP server and not a built-in tool. The agent runs `bb thread ...` through whatever shell tool its provider gives it.
- The agent learns the CLI from two things: a short **introduction text** injected into new sessions and a **skill** (`bb-cli`) that routes to `bb guide <chapter>`. Both come from the `bb-guide` plugin.
- The CLI talks plain HTTP to the bb server. It identifies the calling thread with an environment variable, not a token.
- `spawn`, `fork` and `tell` return at once. Only `wait` blocks (by polling). Nothing counts or rate-limits children; the only structural cap is depth 4.

## How the agent is told

| Piece | What | Source |
| --- | --- | --- |
| Introduction text | Contributed to every new agent session: "Use `bb thread ...` to inspect or wait for other BB threads. **Do not spawn new threads or message other threads unless the user has explicitly asked you to do so**, except to answer a thread that messaged you." It also says: answer the parent in your **final response** (bb reports it), not with `tell`; send one message per command; "Never send acknowledgements or thanks"; do not wait for a reply to a message that asks for nothing | `plugins/bb-guide/introduction.ts`, wired by `plugins/bb-guide/server.ts:32-60` (`bb.agents.contributeInstructions`) |
| Skill `bb-cli` | Habits: give a spawned thread a clear prompt; do not poll, use `bb thread wait`; `tell` steers by default, `--mode queue` for non-urgent; a send reported as `queued` is not a failure | `plugins/bb-guide/skills/bb-cli/SKILL.md:69-90` |
| Guide chapters | `bb guide threads`, `thread-inspection`, `thread-messaging`, `thread-lifecycle`, `json` | `packages/templates/src/templates/bb-guide-*.md` |
| Tools | The plugin registers `tools: []`. Threads need no tool | `plugins/bb-guide/server.ts:49-60` |

So the agent only spawns threads when the **user asks or when a skill says so**. There is no automatic delegation. For ACP agents the text is wrapped in `<system_instructions>` and prepended to the first prompt (earlier note, `.briefback/acp/research/bb-source.md`).

The UI also parses the agent's shell call to draw a "Sent to <thread>" card for `bb thread tell` (`packages/thread-view/src/tool-call-parsing.ts:640-771`, `apps/app/src/components/thread/timeline/ThreadTimelineRows.tsx:1668-1697`). This is a reason the CLI stays a shell command.

## Transport

- The host daemon puts `BB_CLI`, `BB_SERVER_URL` and the `bb` directory on `PATH` in the agent's shell, and `BB_THREAD_ID`, `BB_PROJECT_ID`, `BB_ENVIRONMENT_ID`, `BB_THREAD_STORAGE` per thread (`apps/host-daemon/src/runtime-shell-env.ts:395-401`, `packages/agent-runtime/src/thread-shell-environment.ts:20-30`).
- Outside a thread the CLI talks to `http://127.0.0.1:38886` (`bb-guide-overview.md:28`). Inside one it uses `BB_SERVER_URL`.
- `createCliBbSdk` adds two headers, a "this is the CLI" marker and `CALLER_THREAD_HEADER_NAME` = `BB_THREAD_ID` (`apps/cli/src/client.ts:20-33`). The server tags the request `{ kind: "cli", callerThreadId }` (`apps/server/src/request-context.ts:107-114`). No bearer token is sent on loopback. How remote hosts authenticate was not read.
- Every command takes `--json`. A failure prints `{"ok": false, "error": {code, message, hint}}` on stdout and the message on stderr (`bb-guide-overview.md:38-40`). Long text goes through `--prompt-file` or `--message-file` (`-` is stdin).

## Subcommands

| Command | Required | Useful options | Output (human; `--json` prints the object) | Blocks? |
| --- | --- | --- | --- | --- |
| `bb thread spawn` (aliases `create`, `new`) | `--project <id>` and `--prompt` or `--prompt-file` | `--parent-self` or `--parent-thread <id>` (parenting is opt-in), `--provider`, `--model`, `--reasoning-level`, `--permission-mode`, `--environment <id\|path>`, `--new-environment personal\|worktree`, `--title`, `--visibility`, `--lifecycle-owner-thread`, `--parent-notifications auto\|stuck\|off`, `--send-at`, `--plan` | `Thread spawned: thr_x`, then (if the parent is the caller) "You will be notified when this thread is done." and an ID / Project / Status / Created block | No. Returns when the thread row exists and the first send is attempted |
| `bb thread fork <source-id>` | source id | `--source-seq-end <seq>`, `--prompt`, `--title`, `--environment`, `--new-environment`, `--permission-mode`, `--agent-context-seed`, `--visibility`, `--lifecycle-owner-thread` | `Thread forked: thr_x`, `Source:`, `Status:`, `Environment:`. No parent flag: a fork is never a child | No |
| `bb thread tell <id> [message]` (aliases `message`, `send`) | id and text or `--message-file` | `--mode steer\|queue\|auto` (default `steer`), `--send-at`, `--compact-first`, `--model`, `--plan`, `--file`, `--image` | `Thread X steered`, `Thread X updated` (new turn), or `Thread X message queued (<reason>); it dispatches when that clears`. JSON: `delivery: sent\|queued`, `messageSequence` or `queuedMessage` | No |
| `bb thread wait <id>` | id | `--status <status>` (default `idle`), `--event <type>`, `--timeout` (default 1200 s), `--poll-interval` (250 ms) | `Thread X reached status idle.` Exit 2 timeout, 3 bad arguments, 4 unreachable | Yes, polls |
| `bb thread output [id]` | id or `--self` | none | The final text, or `(no output)` | No |
| `bb thread log [id]` | id or `--self` | `--format json\|minimal\|verbose`, `--limit`, `--after-seq`, `--all`, `--message <seq>`, `--context <n>` | Events (json, oldest first, 100) or user-message turns (newest first, 20) | No |
| `bb thread show`, `list`, `count`, `search` | | `list --parent-thread <id>`, `count --parent <id\|none>` | Status, parent, `Parent notifications:` line | No |
| `bb thread stop`, `archive`, `delete`, `retry`, `update` | id | `update --parent-thread`, `--clear-parent-thread`, `--parent-notifications` | | stop waits for the interrupt |
| `bb thread interactions list\|approve\|deny\|answer\|respond` | id | | Lets a parent answer a child's approval or question | No |
| `bb thread queue list\|create\|send\|delete ...` | id | | Inspect and edit a thread's queued messages | No |

Observed in `apps/cli/src/commands/thread/{spawn,fork,actions,wait,show}.ts` and `packages/templates/src/templates/bb-guide-thread-*.md`. The exact spawn output lines are `spawn.ts:657-665` and `printThread` at the end of that file.

Execution flags default from the parent (see `bb-data-model.md`), so a bare `bb thread spawn --project $BB_PROJECT_ID --parent-self --prompt "..."` makes a child on the same provider and model in a new worktree.

## Errors worth knowing

- Missing `--project`: `missing_required` with a hint that prints the current project id (`spawn.ts`, `context-hints.ts`).
- Bad parent: `parent_thread_invalid` with reason `not_found`, `archived`, `deleted`, `self`, `cycle`, `too_deep` (`thread-parent.ts`, `lifecycle-api-errors.ts`).
- Fork on a provider without fork: "Provider acp-cursor does not support thread forks" (`thread-fork.ts:31-42`).
- `tell` to a thread whose workspace was removed: hint to `bb thread restore-environment` (`actions.ts:777-791`).
- A thread that cannot start a turn within 5 minutes is stopped and reported to its parent as failed (`thread-lifecycle.ts:751`, guide text in `bb-guide-threads.md:100-104`).

## Limits and runaway protection

| Limit | Value | Source |
| --- | --- | --- |
| Hierarchy depth | 4 levels in total | `thread-parent.ts:6` |
| Children per thread, active children, total threads | **None found** | grep for caps in `apps/server/src` found only the timeline cache and storage-delete limits |
| Running threads per machine | One per processor by default, plus an optional global limit. A **new turn on an idle thread** waits when the count is reached; a **steer into a running turn is never held** | `plugins/concurrency-limit/server.ts:524-560` |
| Wait | 20 min default, polling | `packages/sdk/src/areas/threads.ts:92-93` |
| Tell | No rate limit, no relation check (any live thread id works, across projects) | `thread-send.ts:303-320` only checks that the sender exists and is not deleted |
| Prompt-level rules | The introduction text above | `plugins/bb-guide/introduction.ts` |

Inferred, not verified: a parent that sits in `bb thread wait` is an `active` thread and counts toward the concurrency limit, so with a small limit and several waiting parents a child's first turn could wait behind them until the 20-minute timeout.

## Sources

- `plugins/bb-guide/{introduction.ts,server.ts,PLUGIN_OVERVIEW.md,skills/bb-cli/SKILL.md}`
- `apps/cli/src/commands/thread/*.ts`, `apps/cli/src/client.ts`, `apps/cli/src/context-env.ts`
- `packages/templates/src/templates/bb-guide-{overview,threads,thread-inspection,thread-messaging,thread-lifecycle}.md`
- `packages/sdk/src/areas/threads.ts`

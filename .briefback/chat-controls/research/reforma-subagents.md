# Reforma reference: sub-agents in the chat

Reference repo: `/Users/bionic/WORK/Reforma/reforma` (read-only). All paths below are relative to it.

## Summary

A sub-agent in Reforma is an `Agent` tool call on the parent assistant message plus a separate,
persisted child thread. The parent renders the call as a small, non-collapsible card: a loader and a
shimmer verb while the child runs, one grey line of live activity ("Reading chat.ts", "Running bun
test"), then a quiet "Ran Explore agent" / "Finished". The card never shows the child's tool calls or
its report inline. Clicking it opens the whole child thread in place of the chat, with a `Back to chat`
header button and a Stop button instead of a composer. While a child runs, the composer also shows one
strip per running sub-agent with its activity, tool-call count, and a Stop action.

Live activity is not a nested transcript. The sandbox watches the child's stream, reduces each
"tool input ready" / "text started" / "reasoning started" chunk to a tiny patch, and sends it on the
parent stream as `data-subagent-status`. The front shallow-merges that patch into a per-`toolCallId`
metadata map, and the card reads the latest patch. That reduction is the part most worth porting.

## What the user sees

### The card (`AgentTool`)

File: `packages/components/src/chat/Tool/agent/AgentTool.tsx`, registered as `Agent` in
`packages/components/src/chat/Tool/Tool.tsx` (`TOOL_RENDERERS`).

| State | Icon | Title | Second line |
| --- | --- | --- | --- |
| Running | `ProgressLoader` (14) | Shimmer verb: `Exploring` (research), `Running` (shell), `Verifying`, `Planning`, else `Running <Label>` | Activity from the patch, else `Starting…` |
| Waiting on the user | loader while the parent stream is open, else `Message` | live verb, else `Ran <Label> agent` | `Waiting for you` |
| Finished | `Message` (14) | `Ran <Label> agent` | `Finished` |
| Started in background | `Message` | `Started <Label> agent in background` | none |
| Failed | `Message` | `Ran <Label> agent` | error text in `danger`, xs |
| Stalled (stream ended, call never finished) | `Message` | `Tool call was not completed` (secondary) | none |

- Labels (`subagentLabel`): `research` → `Explore`, `shell` → `Shell`, `verify` → `Verify`, `plan` →
  `Plan`, otherwise the capitalized id.
- The whole card is a `Pressable` (role button, aria-label `<title>. <activity>`) when the child thread
  id is known and the call did not fail; it calls `onOpenSubagent(childThreadId, label)` from
  `useChat()`.
- Chrome: `ToolShellCard collapsible={false} data-slot="agent-tool"` with `shellStyles.tool`, inner
  `Box direction="row" gap="md" padding="md"`; `aria-busy` while running. No expand/collapse, no
  report text, no nested rows.
- Status line logic is a pure function, `agentStatusLine({ live, failed, stalled, needsUser,
  background, activity })`; liveness comes from `useToolProgress(part.state, needsUser)`
  (`chat/Tool/shell/toolProgress.tsx`).

### Activity copy (`subagentActivityLabel(patch)`)

- `patch.type === 'text'` → `Finishing reply`; `'reasoning'` → `Thinking…` (never the raw text).
- Tool patches map by tool name (`TOOL_ACTIVITY`): `Reading <file>`, `Writing <file>`, `Editing
  <file>`, `Listing <dir|files>`, `Grepping <pattern>`, `Finding <glob>`, `Running <command>`,
  `Fetching <url>`, `Loading <skill>`, `Reading <mcp resource>`, `Checking lints`, plan tools, and so
  on. File names go through `basename`; several paths become `N files`. A `Preamble` tool shows its
  content as the line.
- Unknown tools: `Using <title or humanized tool name>`.
- `TOOL_ICON` maps the same tool names to icons; `toolActivityIcon(name)` is used by the floating
  compact activity card (`apps/front/src/editor/chat/ChatCompactActivity*.tsx`,
  `compactActivityStatus.ts`), which reuses `subagentActivityLabel` for both normal tools and Agent
  rows.

### Composer strips (`ChatComposerSubagents`)

Files: `apps/front/src/editor/chat/composer/ChatComposerSubagents.tsx`, `runningSubagents.ts`.

- One `ComposerBannerStatus` per running sub-agent inside a `ComposerBanner dense`, above the composer
  surface (above the queue). Icon `Robot` (14), text in a `Shimmer` unless waiting.
- Copy (`subagentComposerCopy`): `<Label> Agent · <activity> · N calls`, `<Label> Agent working` before
  any activity, `<Label> · Waiting for you` when the child needs the user (no count then).
- `onPress` opens the child thread; action `Stop` ends the whole run for a foreground sub-agent, or only
  that job for a background one (`thread.stopBackgroundJobs([jobId])`).
- Sources: open (non-terminal, non-background) `Agent` calls on the live assistant message while the run
  streams, then background sub-agents from the thread snapshot (`backgroundJobs[].agent`). Finished
  rows stay only in the transcript.

### The child view

- `ChatRuntime.openSubagent(childThreadId, label)` creates a persisted `ChatThread` for the child, loads
  it, and sets `viewedSubagent`; `closeSubagent()` disposes it.
- `apps/front/src/editor/chat/Chat.tsx` renders `ChatSubagentView`
  (`apps/front/src/editor/chat/subagent/ChatSubagentView.tsx`) as an absolute overlay over the chat
  panel, wrapping the same `ChatThread` view in its own `ThreadProvider`.
- In that view (`apps/front/src/editor/chat/thread/ChatThread.tsx`, `viewingSubagent`): no composer, no
  file drop, no empty state; a full-width `Stop` button (`color="danger" variant="bordered"`) while the
  child is busy.
- Header (`apps/front/src/editor/chat/header/ChatHeader.tsx`): the history title is replaced by
  `PanelHeaderBack` → `Back to chat`.
- When a child needs the user, `ChatThread` calls `ChatRuntime.openSubagentIfWaiting`, which opens the
  waiting child automatically if its parent is the selected thread. Its pending question then renders
  inline in the child transcript. `threadRequiresUserAction` also counts `patch.needsUser`, so the
  editor rail flags the chat.
- Stories: `apps/front/src/editor/chat/Chat.stories.tsx` → `SubagentView`, `SubagentDone`;
  `ChatComposer.stories.tsx` → `RunningSubagents`; `AgentTool.stories.tsx` → `Running`,
  `RunningCommand`, `OutputAvailable`, `Failed`.

## Data flow

1. The parent model calls the `Agent` tool (`apps/sandbox/src/chat/agent/tools/agent/Agent.ts`):

   ```ts
   type AgentToolInput = { name: string; message: string; resume?: 'new' | 'resume'; background?: boolean };
   type AgentToolOutput = { name: string; childThreadId: string; content: string; data?: unknown; error?: string; jobId?: string };
   ```

   `packages/types/src/sandbox/tools/agent.ts` holds the client copy.
2. `runSubagent` (`apps/sandbox/src/chat/agent/subagents/run.ts`) opens or resumes a child thread
   (persisted, `parentThreadId` set, no queue of its own), appends the brief as a user message, starts
   the child run, and tees its UI chunk stream: one branch is persisted as the child transcript, the
   other is watched for activity (`consumeChildStream`).
3. `subagentActivityFromChunk` (`apps/sandbox/src/chat/agent/subagents/subagent-activity.ts`) maps:
   - `text-start` → `{ type: 'text' }`, `reasoning-start` → `{ type: 'reasoning' }`;
   - `tool-input-available` → `{ type: 'tool', toolName, title?, input? }`, where `input` keeps only
     `path, paths, glob, pattern, command, url, query, name, content`, strings cut to 80 characters and
     arrays to 3 items; `SetPhase`, `TodoWrite`, `ReadTodo` are skipped.

   `runSubagent` adds a running `toolCalls` count and emits status updates: `starting`, `running` (with
   each patch), `needs-user` / `running` while the child is parked on the user, then `completed`,
   `failed` (with `{ error }`), or `cancelled`.
4. The Agent tool forwards each update on the parent stream as a transient part
   (`AgentEventBuilder.subagentStatus`):

   ```ts
   type SubagentStatus = 'starting' | 'running' | 'needs-user' | 'completed' | 'failed' | 'cancelled';
   type SubagentStatusUpdateData = {
       childThreadId: string;
       toolCallId: string;               // the parent's Agent call
       status: SubagentStatus;
       patch?: Record<string, unknown>;  // shallow-merged by toolCallId on the client
   };
   ```

5. The front (`ChatThread` `onData`, `apps/front/src/runtime/chat/ChatThread.ts`) merges it into
   `toolMetadata: Map<toolCallId, { toolName: 'Agent'; patch }>` with `childThreadId` and
   `needsUser: status === 'needs-user'` added. `MessageTurnStore.getToolMeta(toolCallId)` exposes it to
   tool renderers, and `AgentTool` reads `patch`.
6. When the tool resolves, its output carries `childThreadId`, the report in `content`, and `error` on
   failure. The card uses `output.childThreadId` first, `patch.childThreadId` before that. The report
   goes to the parent model only; the card does not display it.
7. Background sub-agents return a receipt with `jobId` at once. Their progress lives on the thread
   snapshot as `ThreadBackgroundJob.agent = { name, childThreadId, waitingForUser?, toolCalls? }`
   (`packages/types/src/sandbox/tools/get-background-result.ts`), and their report arrives later as a
   background-result notice.

## Components, styles, dependencies

| Piece | Source | Notes |
| --- | --- | --- |
| `AgentTool`, `AgentCard`, `subagentLabel`, `subagentActivityLabel`, `subagentComposerCopy`, `agentStatusLine`, `toolActivityIcon` | `packages/components/src/chat/Tool/agent/AgentTool.tsx` | `observer` (mobx-react-lite); context via `useMessageTurn()` and `useChat()`. |
| Card styles | `AgentTool.module.css` (`.title` weight 500, `.hit` reset for the pressable row) inside `@layer components`; shell from `chat/Tool/shell/ToolShellCard.module.css` | CSS modules with `@reference '@reforma/styles/rulesets'`. |
| Composer strips | `ChatComposerSubagents.tsx`, `runningSubagents.ts`; `ComposerBanner` / `ComposerBannerStatus` from `packages/components/src/chat/ComposerBanner/` | `ComposerBannerStatus` props: `icon`, `action`, `onAction`, `onPress`, `role`. |
| Child view | `ChatSubagentView.tsx` (+ `.module.css`: absolute inset overlay), `ChatHeader.tsx` (`PanelHeaderBack`), `ChatRuntime.openSubagent` / `openSubagentIfWaiting` / `closeSubagent` | MobX store state `viewedSubagent`. |
| UI kit and icons | `Box`, `Pressable`, `Shimmer`, `Show`, `Text`, `ToolShellCard`; `ProgressLoader` (`@reforma/icons/assets`), `Message`, `Robot` and the tool icons (`@reforma/icons/14`) | Helpers `basename`, `humanizeString`, `plural` from `@reforma/lib`. |
| Tests | `packages/components/src/chat/Tool/agent/AgentTool.test.ts`, `apps/front/src/editor/chat/composer/runningSubagents.test.ts`, `ChatComposerSubagents.test.tsx`, `apps/sandbox/src/specs/chat/subagents/subagent-activity.test.ts`, `run-subagent.test.ts` | Copy and reduction behaviour. |

Clowdy has `Shimmer`, `Pressable`, `Show`, `Text`, `Box`, and icons `14/robot.svg`, `14/message.svg`,
`assets/progress-loader.svg`. It has no `chat/` folder in `packages/components`: `ToolShellCard`,
`ComposerBanner`, and the message-turn context are not there.

## Agent-specific vs portable to an ACP client

Portable:

- The card layout, its six states, the label/verb tables, `agentStatusLine`, and
  `subagentActivityLabel`. They are pure functions over a tool-call state plus an optional patch
  `{ type: 'tool' | 'text' | 'reasoning', toolName?, title?, input?, toolCalls?, needsUser?,
  childThreadId? }`. The `TOOL_ACTIVITY` table must be re-keyed to the agents' tool names (Claude Code
  `Read`, `Edit`, `Bash`, `Grep`, `Glob`, `WebFetch`…; Codex's own) or to ACP tool `kind`s.
- The reduction idea: keep only the latest child activity and a call count, sliced to path- and
  query-like fields. It works on any stream of child tool-call starts, wherever they come from.
- Composer strips for running sub-agents with Stop.
- Clowdy's own delegation (`run_spawn`, child runs with `origin: 'spawned'`) matches Reforma's model
  closely: a real child transcript Clowdy owns, so "click the card to open the child run" and the
  auto-open on needs-user port directly.

Depends on what the agent and its ACP adapter expose:

- Claude Code's sub-agent tool (`Task`; confirm the name and input fields the adapter reports) arrives
  as an ordinary ACP tool call with input, status, and final output. That is enough for the running /
  finished / failed card, with the title taken from the input (for `Task`: `subagent_type`,
  `description`).
- Live activity needs the child's tool calls with a link to the parent call. Clowdy's ACP plan lists
  native sub-agent events over ACP as out of scope, and native sub-agents are shown as cards on the tool
  call. Without child events, the card stays on `Starting…` until it finishes; with them, feed the same
  reducer.
- There is no child thread to open for a native sub-agent unless the adapter streams its transcript.
  The card should then not be pressable (Reforma already drops the press when `childThreadId` is
  missing).
- `needs-user` from inside a child, background sub-agents with job ids, `resume` of a named child, and
  usage folding into the parent ledger are Reforma agent features.

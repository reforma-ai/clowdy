# Permission modes over ACP: what the agents offer, what Clowdy does, what Reforma has

Snapshot 2026-11-22. Facts only; the decisions are in `../plan.md`.

## What the agents offer [observed: `bun apps/daemon/src/probe.ts <agent>` from a scratch folder, no prompt, no model call]

The probe takes agent ids only and uses its working directory as the session's `cwd`.

| Agent (pin) | `mode` option (category `mode`) | Not a permission |
| --- | --- | --- |
| Claude Code (`claude-agent-acp@0.107.0`) | `default` Manual, `acceptEdits` Accept edits, `plan` Plan, `auto` Auto, `bypassPermissions` Bypass permissions | `plan` is a way of working (its `ExitPlanMode` is withheld by Clowdy, `catalog.ts` `sessionMeta`) |
| Codex (`codex-acp@2.8.0`) | `read-only`, `workspace-write` Workspace access, `agent` Auto review, `agent-full-access` Full access, and `permission-profile:<id>` for each allowed profile of the person's Codex config | `collaboration_mode` is a separate option |
| Cursor | `agent`, `plan`, `ask` | all three: no permission control over ACP (not checked how Cursor decides, it reads its own config) |

- Claude (`dist/session-mode.js`, `dist/permissions/modes.js`): `auto` is offered unless `disableAutoMode` is set or the model does not support it (a chosen `auto` then becomes `acceptEdits`); `bypassPermissions` unless the process is root. With no mode asked for, a new session starts in the person's `permissions.defaultMode` from `~/.claude`, else `auto`, else `default`. A resumed session starts in the mode of its transcript.
- Codex (`dist/index.js`, `AgentMode`): the adapter's default is `agent` (workspace-write sandbox, network off, `on-request` approvals reviewed automatically); `INITIAL_AGENT_MODE` moves it. Only `agent-full-access` opens the sandbox and the network.
- Both adapters offer the option through `session/new` as `configOptions` (and the older `modes`); `session/set_config_option` changes it. The classification `_meta.jetbrains.air.kind` (`standard`, `plan`, `auto_review`, `full_access`) is sent only to a client that declares `_meta.jetbrains.air`; Clowdy does not.
- A permission request carries `options[]` of kinds `allow_once`, `allow_always`, `reject_once`, `reject_always` (an adapter may offer a subset). The agent owns what `allow_always` remembers.

## What Clowdy does today [read in code]

- Modes: never set. `session.ts` `pickPermission` answers every `session/request_permission` with the first allow option (`CLOWDY_AGENT_PERMISSIONS=allow`, the default) or reject option.
- So the effective state is: Claude in `auto` (or the person's `defaultMode`), Codex in `agent`, and every request, including the ones Claude's classifier flags as risky, allowed by the daemon.
- Model and effort are applied at the start of every turn (each turn is a new agent process) by `applyChoices`, which logs a value the agent does not offer and leaves the agent's own.
- Agent settings are booleans with an environment effect (`AgentSettingSpec`), stored in `AgentOverride.settings`; the Providers page draws them as switches.
- A question to the person is a `question` stream item plus run status `waiting_user` (`RunService.ask`, answered by `run.answer`); the thread tools report such a thread as `asking`, and no thread tool can answer for the person.

## What Reforma has [read in `/Users/bionic/WORK/Reforma/reforma`]

- `packages/components/src/chat/Approval/Approval.tsx`: a compound (`Approval`, `ApprovalRequest`, `ApprovalButtons`) that renders two buttons, Reject and Approve, as the footer of a tool card (`Tool/bash/BashTool.tsx`, `Tool/edit/EditTool.tsx`, `Tool/default/Default.tsx`). It is driven by the AI SDK's tool-part state (`approval-requested`, payload `{ id, approved, reason? }`) through a `useChatHandlers` context.
- It has no "allow always", no keyboard handling, and no look for an answered request (the footer disappears and a denial strikes the header through). Nothing in the backend asks approval for Bash or Edit; only two tools use `needsApproval`. The composer shows no pending approval.
- Not usable as is: Clowdy's `packages/components` has no `chat/` folder (the chat's cards live in `apps/desktop/src/renderer/stream/`), and ACP's options (up to four kinds, named by the agent) do not fit a boolean. What carries over is the placement: the decision sits with the tool call it is about.

## What bb has [read in a shallow clone of https://github.com/get-bb/bb at `796cdcc`, 2026-11-21; its path is in the memory note `reference-bb-source-clone`]

- **One list is bb's own preset set, mapped per provider underneath.** Claude Code and Codex are not ACP in bb: its three modes become the vendors' native settings (`plugins/provider-claude-code`: `acceptEdits`, `auto`, `bypassPermissions`; `plugins/provider-codex`: approval policy, sandbox, reviewer). For ACP agents (`packages/provider-bridge-acp/src/bridge/bridge.ts`, `handlePermissionRequest`) the mode is a two-value policy of the client: `full` answers `allow_once` to every request; `accept-edits` asks the person and refuses file writes outside the workspace (through the client's `fs/write_text_file`), with optional launch flags per agent (`permissionCli`, for example Grok's `--always-approve`).
- **A request is classified before it is shown** (`packages/provider-bridge-acp/src/interactions.ts`, `buildAcpPermissionInteractionPayload`): `command` (text of the command), `file_change` (paths, from `locations` and the diff), or `tool_use` (tool and title), from the tool call's `kind`, `rawInput`, `locations` and `content`. The options collapse to three decisions: `allow_once`, `allow_for_session` (any `allow_always` option), `deny` (any `reject_*`).
- **"Allow for session" is bb's own memory**, not the agent's: the decision is answered to the agent, and the subject (without the call id) goes into a per-session set; the next request with the same subject is answered `allow_once` at once, with no prompt (`sessionGrants`, `acpSessionGrantKey`).
- **The approval UI** (`apps/app/src/components/thread/pending-interactions/`): a docked banner above the composer, "Approval needed", collapsible, with an attention dot; a command shows as `$ command` clipped at four lines with "Show N more lines", a file change as a list of paths, a tool as its name and detail; buttons Deny (left), Allow for session, Allow once (primary); a decision in flight spins on its button; several pending requests stack with the first open and the rest folded. bb's Tailwind code is not portable; the layout and the logic are.
- The owner's screenshots of the Codex app's menu (Ask for approval, Accept edits, Approve for me, Full access) are the same four presets this plan uses.

# Header usage status, and chats of a disabled provider (facts)

Read from the code on 2026-11-18, `main` at `3dfed87`. Nothing was run besides screenshots of the Providers page. Feeds the grill of `provider-surfaces`; the owner's direction is in the chat, not here.

## 1. The window header (where the usage status goes)

- `apps/desktop/src/renderer/shell/TitleBand.tsx` is the 48px band over the window's top edge: Back/Forward (`Button variant="filling" size="sm" iconOnly`), `ProjectSelect`, and one control at the right edge, the keyboard-shortcuts button (`styles.shortcuts`, `margin-left: auto` in `TitleBand.module.css`). It renders its controls only when `root.phase === 'ready'`.
- The band's right padding is `calc(var(--titlebar-inset-end) + var(--spacing-lg))`, which keeps the right edge clear of the Windows caption buttons; anything added at the right sits to the left of the shortcuts button and inherits that clearance.
- The band is a window drag region (`base.css`); a control in it must opt out the way the existing buttons do (`Button` already does). Not verified for a custom trigger.
- Primitives that exist for a popover from a button: `@clowdy/components/Popover` (used by the filter menu of `features/agents/AgentList.tsx`), `Tooltip`, `Button`, `Text`, `Spinner`; the bars of the Providers page are in `features/settings/providers/UsageBlock.tsx` + `UsageBlock.module.css` (`role="progressbar"`, `data-level` `warn` at 75 and `high` at 90) and `formatRemaining` in `shared/time.ts`.

## 2. The data a header status needs (already there)

- `useAgents()` (`stores/`) gives `AgentInfo[]`; per agent: `enabled`, `status` (`ready`, `missing`, `needs-runtime`, `disabled`), `signIn` (`status`, `account` email/name/plan, `checkedAt`), `usage` (`state` ok / unavailable / error, `windows[] { id, label, usedPercent, resetsAt? }`, `fetchedAt`, `detail`), `canSignIn`. `providerAgents(agents)` in `features/settings/providers/providerView.ts` filters to Claude, Codex, Cursor.
- Window labels the daemon produces: `5h`, `7d`, `7d · <model>` (Claude), `5h`, `7d` (Codex), `Plan usage` (Cursor).
- The store refetches `GET /v1/agents` on `agents.changed`, at start and when the page opens; the daemon refreshes a provider's reading at most every 90 s (Cursor 5 min), on demand. A header status that is always visible would need its own refetch rhythm (the Providers page now fetches every minute while open).
- `UsageBlock` thresholds (warn 75, high 90) differ from bb's (warning at used >= 80, urgent at >= 90; `.briefback/agent-accounts/research/limits.md`, "Status bar and popover data model").

## 3. What bb does (from research/limits.md and the owner's screenshots, both earlier in this work)

- One chip per provider in the status bar; the chip shows the provider's tightest "primary" window (highest used percent among session, weekly, plan; scoped windows like `7d · Fable` are left out of the headline), with a health tone.
- The popover lists providers sorted by their highest used percent, descending; a row is the provider's icon, the account email and a plan badge, then one bar per window with its label, percent used and time to reset; Cursor shows `Plan usage`. A refresh action; a Detailed/Compact segmented control (`verbose`/`compact`).
- Row states: usage, loading, sign-in (only for a proven sign-out), unavailable, error, empty.

## 4. Chats and the provider today

- A chat has no provider of its own. `Chat` (`packages/protocol/src/domain.ts`) holds `mode` and `orchestratorRunId`; the provider is `Run.engine` of each run. A new run takes the engine "an explicit choice, then the project's setting, then the daemon's default" (`apps/daemon/src/runs/service.ts`, `resolveEngine`: `preferred ?? project.settings.engine ?? config.engine`). `ProjectSettings` (`project.update` in `packages/protocol/src/commands.ts`) already carries `engine` and `model`; the desktop has no UI for either.
- `chat.create` takes `projectId`, `title`, `mode`; `chat.send` takes `chatId`, `text`, `attachmentIds`. Neither carries an engine, model or effort. `task.start` carries `engine`.
- A chat is an orchestrator conversation that starts tasks, and each task has its own run with its own `engine`; so "the chat's provider" is the orchestrator's engine, and the executors may differ.
- A switched-off agent does not stop a chat before a run starts: `resolveEngine` only checks `engines.has(id)` (known, installed or not); the run then fails when the registry resolves the agent with "`<Agent> is switched off in Clowdy`" (`registry.ts`, `build`). The desktop shows nothing in advance.

## 5. The composer

- `features/chats/Composer.tsx`: the card is a rich input on top and a bottom row with attach, the mode `Select` (Autopilot / Semi-manual, `MODES`) and `ComposerSend`. The same component is the new-chat page's (`start` prop: the first message creates the chat with `chat.create { projectId, mode }`, then `chat.send`) and the chat view's (`ChatView.tsx`, inside `styles.composer`).
- The mode on the new-chat page is local state (`draftMode`) until the first message; an existing chat uses `chat.setMode`.
- Where a read-only notice would replace the composer: the `<div className={ styles.composer }>` in `ChatView.tsx`, and `DraftChat.tsx` for the new-chat page.

## Not read or run

The desktop's drag-region behaviour for a custom control in the band; `DraftChat.tsx`; the main-process window code; Windows.

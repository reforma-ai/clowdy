# Delegation settings

**Goal:** Configure the agent, model and effort of new threads globally by role, while preserving existing launches and preferences.

**Approach:** Store choices in daemon-owned global settings and expose them through the existing snapshot and commands. Resolve the role at spawn time; use the existing provider effects for native subagents and suggestions. Reuse the composer's model picker in Settings.

**Decisions**

- Explicit launch fields take precedence over the role, then Default; no saved Default retains current inheritance behavior. An explicit inherit choice uses the orchestrator.
- Unset global switches retain each provider's saved value, including mixed values; show that state until the person explicitly sets a global value. Preserve the old values for rollback and never change the separate Claude workflow preference.
- Suggestions belong in Chat; apply only where supported. Do not investigate prediction reliability.
- Keep provider definitions owned by CLO-229 unchanged; apply global overrides through the registry. Integrate against CLO-229 after its changes are available, preserving its asynchronous thread start and the separate uncommitted Claude changes in the parent checkout.

**Reuse:** `apps/daemon/src/db/appSettings.ts` for persisted app settings, `apps/daemon/src/domain/snapshots.ts` and `apps/daemon/src/commands/index.ts` for transport, `apps/daemon/src/runs/threads.ts` for launch resolution, `apps/daemon/src/engine/acp/registry.ts` for provider effects, and `apps/desktop/src/renderer/features/chats/ModelPicker.tsx` for choices.

## Stage 1 — Settings and thread selection

**Depends on:** None.

Persist and validate Default and role choices; expose them to clients. Add role to the thread tool and resolve explicit arguments against the role and Default without silently replacing unavailable selections. Update agent instructions to name roles and reserve model overrides for a user request or strong reason.

- [x] Complete
  - [x] Settings survive restart and old launches still inherit
  - [x] Role, Default, explicit override and unavailable selections are covered by daemon tests

**Files:** `packages/protocol/src/domain.ts`, `packages/protocol/src/api.ts`, `apps/daemon/src/db/appSettings.ts`, `apps/daemon/src/domain/snapshots.ts`, `apps/daemon/src/commands/index.ts`, `apps/daemon/src/runs/threads.ts`, `apps/daemon/src/runs/thread-tools.ts`, `apps/daemon/test/threads.test.ts`, `packages/system-skills/skills/orchestrate/SKILL.md`.

**Done when:** a new thread receives the selected role settings and existing launches remain unchanged without saved settings.
**Verify:** `bun test test/threads.test.ts` in `apps/daemon`; `bun run typecheck`.
**Commits:** `8e517734` — settings, role resolution and UI (combined because the protocol and fixture changes are shared with Stage 2); checked: daemon thread, ACP and registry suites, root typecheck and lint; reviewed independently. Actual provider accounts were not tested.

## Stage 2 — Global controls and settings UI

**Depends on:** Stage 1.

Expose the roles table and reusable picker under Agents > Delegation. Add the global native switch and Chat suggestions switch, preserving mixed legacy preferences until explicitly changed and retaining provider-specific effects and workflow behavior. Display errors and unavailable configured choices.

- [x] Complete
  - [x] Settings controls persist and affect supported providers without losing mixed legacy values
  - [x] Candidate app flow, disabled provider and unavailable model are verified

**Files:** `apps/daemon/src/engine/acp/registry.ts`, `apps/desktop/src/renderer/features/settings/SettingsWindow.tsx`, `apps/desktop/src/renderer/features/settings/ChatPage.tsx`, `apps/desktop/src/renderer/features/settings/providers/ProviderCard.tsx`, `apps/desktop/src/renderer/features/settings/DelegationPage.tsx` (create), associated protocol, store and tests.

**Done when:** choices can be changed in the candidate app and new sessions use them while legacy mixed settings remain effective until changed.
**Verify:** relevant daemon and desktop tests, `bun run typecheck`, `bun run lint`, candidate build and isolated UI flow.
**Commits:** `8e517734` — shared controls and settings UI; checked: isolated candidate UI, `./clowdy build mac`, root typecheck and lint; reviewed independently. Desktop tests: 148 passed, one baseline permission-preset test timed out.

## Baseline and integration

- `bun run typecheck`: passed.
- `bun test test/threads.test.ts` in `apps/daemon`: 66 passed.
- Desktop `bun run test -- src/renderer/features/settings/providers/ProvidersPage.test.tsx src/renderer/features/chats/ModelPicker.test.tsx`: 135 passed, one existing permission-preset test timed out at 5 seconds.
- CLO-229 changes `threads.ts` and `thread-tools.ts` from synchronous to asynchronous spawn. Preserve that contract during integration. Its provider files and the parent's uncommitted Claude provider edit are outside this worktree and must not be overwritten.

## Verification and integration notes

- `bun test test/threads.test.ts test/acp-permission-mode.test.ts test/acp-registry.test.ts` in `apps/daemon`: 146 passed.
- Root `bun run typecheck` and `bun run lint`: passed.
- Desktop `bun run test -- src/renderer/features/settings/DelegationPage.test.tsx src/renderer/features/settings/ChatPage.test.tsx src/renderer/features/settings/providers/ProvidersPage.test.tsx src/renderer/features/chats/ModelPicker.test.tsx`: 148 passed; the existing permission-preset test timed out, as it did at baseline.
- `./clowdy build mac`: passed after `8e517734`. Built renderer and daemon were exercised in an isolated Electron and scratch data directory: Research inheritance and both shared switches changed; fixture UI also saved a Research model and effort. Packaged shell refuses isolation switches, so it was not launched.
- Migration 33 adds `runs.strict_model`: back up the live database before upgrade and verify compatibility when reverting. CLO-229 changes `runs/threads.ts`, `thread-tools.ts`, `driver.ts`, `db/runs.ts` and migrations; preserve its asynchronous launch and both changes when integrating. The parent checkout's uncommitted Claude provider file was not touched.
- The legacy mixed values remain in `agents.json` under their provider overrides when a shared switch is set. The shared choice supersedes them; the UI offers an explicit off action for mixed values. Claude Workflow remains independent.

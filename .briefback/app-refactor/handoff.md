# App refactor: handoff

Plan: `plan.md` (Checkpoint paragraph). Research: `research/index.md`. Parent task `CLO-225`.

## Branches

| Branch | Worktree | Holds | Merge order |
| --- | --- | --- | --- |
| `clowdy/refactor-frontend` | `/Users/bionic/Clowdy/workspaces/clowdy/0DCP3E70/clowdy-frontend` | design system, renderer data layer, chats, tasks, settings UI; from `origin/next` `54d3a6b4` | first |
| `clowdy/full-app-refactor` | `/Users/bionic/Clowdy/workspaces/clowdy/0DCP3E70/clowdy` | the frontend branch plus daemon core and edges | second |

Stage branches (`clowdy/refactor-ds`, `-renderer-data`, `-daemon-core`, `-daemon-edges`, `-ui-chats`, `-ui-tasks`, `-ui-settings`) are fully merged or cherry-picked; their worktrees can be removed. The UI stage branches were cut from the full branch, so the frontend branch carries their commits as cherry-picks.

## Conflict resolutions against `next`

- `settings/skills/SkillsSection.tsx`, `RecommendedSkill.tsx`: next's Briefback recommendation moved onto `SettingsLayout`; its status is a `Chip` (Badge drops `data-testid`).
- `stream/StreamCard.tsx`, `ThreadCards.tsx`: `StreamCard` got a `trailing` header slot so next's "Still running" stays in the header.
- `agents/AgentList.tsx`, `WorktreeCardHeader.tsx`: `BranchPullRequestBadge` lives in its own file; next's order (badge before status) and its worktree-header badge (`cardBranchKey`) kept.
- `runs/driver.ts`: next's usage-limit pass (reads the run for `usageLimitUntil`). `skills/service.ts`: `USER_PLUGIN_NAME` kept beside `briefbackStatus`.

## Checks (frontend branch, after the review fixes)

- `bunx turbo run build lint typecheck test --force --continue`: build, lint, typecheck green. Desktop 85 failures in 3 files (`ChangesTab`, `DiscardChanges`, `RemoveWorktreeDialog`) under load from the parallel daemon suite; the three files pass alone (125/125). `daemonProbe.test.ts` fails as at baseline. Daemon 4 timing failures under load; pass alone.
- Separate reviewer (read-only): two defects fixed (usage refresh icon lost its keyframes; branch prefix box refilled while being emptied), one unused import.
- Browser smoke run of the renderer on the fixture daemon (`?fixtures=static`): agents, chat streaming, side panel tabs, tasks board and list, worktree Changes, every Settings page, light and dark; no console errors. Screenshots in `/tmp/clowdy-refactor/smoke/` (temporary).
- Not done: the Electron app was not started; Windows not run; real agent runs not exercised.

## Left

`CLO-239` tasks UI, `CLO-244` chats UI, `CLO-245` settings and Changes UI, `CLO-242` design system, `CLO-240` disabled user skills still load (safety), `CLO-241` sync git in `chat.create`, `CLO-243` daemon follow-ups, `CLO-230` shared packages, `CLO-231` Electron shell (separate branch). Stage 10 (one daemon-renderer contract) and Stage 11 (unused-code lint, compact guides) not started. Owner decisions: GITFLOW integration branch, `--no-verify` on the first empty commit, event log retention.

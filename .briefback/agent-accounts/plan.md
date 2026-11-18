# Providers: accounts, usage, login, settings (plan)

Research: `research/index.md` (accounts, login), `research/limits.md` (usage), `research/models.md` (models, written last). Owner's direction and decisions: `grill.md`. Built on the branch `kachurun/providers` in the worktree `../clowdy-providers`, rebased on `main` and fast-forwarded into it (the owner's attachments work touched the same protocol files).

## Settled list

- **One Providers section in Settings** (replaces the Engine page), one large card per provider: Claude, Codex, Cursor. Other agents are not shown yet.
- **Card top:** who is signed in (email, plan), or a Sign in button when nobody is; a Sign in again button when someone is. One account per provider: the machine's own login, detected, never an app-owned account. A switch turns the provider off in Clowdy (`enabled` override that already exists).
- **Card middle: usage** for every installed and enabled provider, in the manner of bb's popover: per row a label (`5h`, `7d`, `7d · <model>`, `Plan usage`), a bar, the percent used and the time to reset.
- **Card bottom: the provider's settings**, only what Clowdy can really control (an environment variable or a session option), plus the program path and extra environment of every provider.
- **Sign in is a button** that runs the vendor's own login in the daemon (`claude auth login --claudeai`, `codex login`, `cursor-agent login`), shows the link the vendor prints, and re-reads the account when the login ends. Clowdy never holds a token of Claude or Codex.
- **Usage sources:** Claude from the user's own `claude` (headless `/usage`), Codex from `codex app-server` (`account/read`, `account/rateLimits/read`), Cursor as bb does it (the access token from the Keychain or `auth.json`, Cursor's dashboard API); the owner approved reading the Cursor token.
- **A disabled provider** keeps its chats read-only, with a hand-off to a new chat; that and the composer's provider/model pickers come later, not in this plan.
- **Model list:** only a foundation in the daemon (where the list comes from per agent), no UI.
- **Not now:** several accounts per provider, a default or ordering of providers, the usage popover in the status bar or header, the settings of other agents.

## Contract (stage 0, fixed before the work splits)

`packages/protocol/src/agents.ts`: `AgentInfo` gains `signIn` (status, account: email, name, organization, plan, method; checkedAt; detail), `usage` (windows `{ id, label, usedPercent, resetsAt? }`, fetchedAt, state, detail), `loginSession` (the sign-in in progress: status, url, code, message), `canSignIn`, `settings` (`{ id, label, description, value, default }`). Commands: `agent.signIn { id }`, `agent.cancelSignIn { id }`; `agent.update` takes `settings: Record<string, boolean>`; `agents.refresh` also re-reads accounts and usage. The event stays `agents.changed`; the client refetches `GET /v1/agents`. `GET /v1/agents` answers at once with what is cached and refreshes stale data in the background, then announces it.

## Stages

Each stage ends with its checks and one commit on the branch.

### Stage 0: protocol contract
- Commit: `a502cb4` feat(protocol): describe who is signed in to an agent, its usage, sign-in and settings.
- [x] Types and commands above, documented in `api.ts`/`agents.ts`; protocol tests for the command schemas.
- Checks: protocol typecheck and tests.

### Stage 1: account identity (daemon)
- Commit (stages 1 and 2 together, they share one reader per provider): `07652f4` feat(daemon): read who is signed in to Claude, Codex and Cursor and how much of the plan is used. Verified live on the owner's machine for Claude (Max) and Codex (Plus).
- [x] `src/providers/exec.ts` (run a program with a deadline, capped output, own process group), probers `claude.ts` (`claude auth status --json`), `codex.ts` (app-server client, `account/read`), `cursor.ts` (`~/.cursor/cli-config.json` identity, token present), `ProvidersService` (cache, TTL, background refresh, announce).
- [x] The registry hands out the environment a run would use (`probeTarget(id)`), so an identity read sees the same `CLAUDE_CONFIG_DIR`/`CODEX_HOME` as a run.
- [x] `GET /v1/agents` carries `signIn`; fakes for the three CLIs in tests.
- Checks: daemon tests, typecheck, lint.

### Stage 2: usage (daemon)
- Commit: with stage 1. The Cursor token read was never run live (a Keychain prompt may appear); Cursor is read every 5 minutes.
- [x] Claude: `claude -p "/usage" --output-format stream-json` and the `usage_report` rows (with a text fallback); Codex: `account/rateLimits/read` in the same app-server session; Cursor: Keychain/`auth.json` token, `GetCurrentPeriodUsage` and `GetPlanInfo`.
- [x] Windows mapping to `{ id, label, usedPercent, resetsAt }`; every window optional; API-key logins say there are no plan limits.
- [x] TTL and back-off per provider; a failed read keeps the last good one with an error note.
- Checks: tests on the response shapes from `research/limits.md`; owner probes 2-6, 8, 10 (limits.md) settle the unverified ones.

### Stage 3: sign in (daemon)
- Commit: `57d75fa` feat(daemon): sign in to an agent by running its own login program. Tested with fake login programs only; a real `claude auth login` would replace the owner's login, so it was not run.
- [x] `LoginSessions`: start, cancel, timeout, link and code parsed from the output (bb's parser: last OSC-8 link or first https URL, user code `XXXX-XXXX`), exit 0 then re-read the account, one session per provider, process group killed with the daemon.
- [x] `agent.signIn`, `agent.cancelSignIn`.
- Checks: tests with fake login programs (link printed, denied, timeout, cancel).

### Stage 4: provider settings (daemon)
- Commit: `5c9e021` feat(daemon): give an agent switches Clowdy can turn and show what the person changed (also `AgentInfo.overrides`).
- [x] `AgentSpec.settings` in the catalog (Claude: memory, claude.ai connectors, native sub-agents, 1M context); stored as `overrides[id].settings`; the registry applies them to env and `disallowedTools`; `AgentInfo.settings` lists them with values.
- Checks: registry tests; the Claude defaults stay what they are today.

### Stage 5: model list foundation (daemon)
- Commit: `1ab5dd0` feat(daemon): list the models an agent offers without starting a chat (`GET /v1/agents/:id/models`; Claude `list_models` control request, Codex `model/list`, Cursor `--list-models`; all three confirmed live).
- [x] After `research/models.md`: `AgentModel` in the protocol, a `ModelCatalog` that gets the list the cheapest reliable way per agent and caches it; nothing in the UI.

### Stage 6: Providers page (desktop)
- Commits: `010361c` (state and fixtures), `e752d0d` (the page), `6e8b909` (advanced prefill), `b19d06f` (review fixes).
- [x] Transport: `getAgents`, the commands; fixtures; a store that refetches on `agents.changed`.
- [x] Settings > Providers: cards, usage rows (bb's look), sign in / again, switch, settings, path and environment; the Engine page goes away.
- Checks: desktop typecheck, lint, tests, screenshots of the page on fixtures.

### Stage 7: review and landing
- Reviews: daemon (`250593f`: announce inside a transaction, readers stop with the daemon, login and token hardening) and desktop (`b19d06f`). Rebased on main and fast-forwarded into it.
- [x] Review of the daemon and of the page; rebase on main and fast-forward it (the owner's uncommitted attachments files may overlap `commands.ts`; if so, stop and say so).

## Follow-ups (not in this plan)

- The usage popover in the header or status bar, in bb's look; usage polling while a page is open; the refresh button spinner until `fetchedAt` changes.
- A disabled provider: read-only chats with a hand-off to a new chat; provider and model pickers in the composer (the model list is ready); statistics.
- Brand marks: done after the first landing. Claude and Codex use `Claude` and `Openai` of `@clowdy/icons/logo` (Reforma's set); Cursor's is its own 2D cube from cursor.com/brand, added to the same pack (`packages/icons/src/logo/SOURCES.md`).
- Several accounts per provider (Orca's per-account config folders) if it is ever wanted; `agent.signIn` is the same login mechanism with another config folder.
- `agents.changed` rows are persisted per project on every change; a non-persisted notification would keep the event log smaller.

## Risks and unknowns (from the research)

- The shape of `claude -p "/usage" --output-format stream-json` (`usage_report`) and the unit of the status fields are read from docs and source only; code is defensive and keeps the text fallback. Owner probes in `research/limits.md`.
- `codex app-server` next to a running `codex-acp` on the same `CODEX_HOME`: unknown; probes are short-lived.
- Cursor: the dashboard API is undocumented; the token read is the one place Clowdy touches a credential, by the owner's decision.
- A login can only run where the browser is: the daemon runs on the user's machine, as it does today.
- Windows: Claude's link cannot be captured through a `BROWSER` script there; v1 lets the CLI open the browser by itself on every platform and shows the link only when the vendor prints one.

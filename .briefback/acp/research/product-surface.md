# Product surface: how bb presents agents, its FAQ writing, and what in Clowdy's app would change

Snapshot 2026-11-17. bb at `f1c5304` (`apps/app/src/components/settings/ProvidersSettingsSection.tsx`, `plugins/provider-acp/app.tsx`, `apps/web/src/compare/compare-content.tsx`, `docs/configuration.md`, `README.md`). Orca at `cbc8119e` (README). Clowdy at the working tree of branch `kachurun/feat/task-hotkeys`: `apps/desktop/src/renderer/features/settings/{Screen,EnginePage}.tsx`, `features/settings/skills/*`, `packages/protocol/src/{commands,domain,skills}.ts`. Observed = read; inferred = my reading. No UI was run.

## Summary

- bb's agent picker is a **list of providers** (Settings → Providers) where each row can be turned off, plus a per-provider **plugin settings page**. For ACP, that page is a searchable list of the official registry with Add / Update / Remove, and a JSON "custom agents" setting for anything else. The same operations exist as CLI commands (`bb acp registry|add|remove`, `bb provider enable|disable|list|models`).
- The thread (not the project) owns the agent choice: a new thread picks provider, model and options; `bb thread spawn --provider acp-opencode --model ...` does it from a script or from another agent.
- bb's FAQ (the writing the owner admired) is a set of **plain question-and-answer entries**, reused across landing pages. Its properties are listed below.
- Clowdy's Settings → Engine page "only reports". Opening the agent set touches the protocol (`EngineId`, `chat.create`, `project.update`, `task.start`), the daemon's config and a new Settings surface.

## How bb presents agents

- **Settings → Providers** (`ProvidersSettingsSection.tsx`): rows from `useSystemProviders`, an Enable/Disable action per provider (core list `disabledProviderIds`; a disabled provider is hidden from pickers and new turns on it are rejected), a "Disabled" badge, drag-to-sort order, an idle-session timeout choice ("ASAP" or N minutes), a completed-turn display choice, and when nothing is installed the line "No providers available. Install a provider plugin in Settings → Plugins". Documentation: `docs/configuration.md` "Provider availability".
- **ACP plugin page** (`plugins/provider-acp/app.tsx`): registry list with search, status badges (available, added, update available, built in, manual install), Add/Update/Remove buttons, a refresh button; a note per agent for the not-installable case ("distributed only as a downloadable binary. Install it yourself, then add it as a custom agent with its command", `registry.ts`).
- **Shipped agents** appear automatically when their CLI is found (`visibility: "installed"`): opencode, omp, grok, hermes-agent; Cursor is always listed; each carries sign-in and install hints (`signInCommand`, `installUrl`), see `bb-source.md`.
- **Per-thread choice**: provider and model pickers on a new thread; reasoning level and per-agent options such as OpenCode's `mode` (agents are session modes, not models); a permission mode per thread (Accept Edits, Approve for me, Full Access in the copy; ACP agents get Accept Edits and Full Access only). Changing the permission mode restarts the OpenCode session and restores the conversation (`acp-provider` skill).
- **Usage and health**: Provider usage panel, Settings → Updates for CLI versions and updates, installation status with install/update buttons run by the host daemon.
- **Messages from agents to each other** are shown as thread items with the sender; the user can message any thread (FAQ copy).
- Documentation surfaces: the README (install, telemetry disclosure, dev loop), `docs/configuration.md` (a long reference with a heading per feature), the `bb guide <chapter>` CLI manual and skills for agents (`plugins/bb-guide/skills/bb-cli`), an `apps/web` site with landing pages, guides and a blog.

## bb's FAQ: what the writing does

Source: `apps/web/src/compare/compare-content.tsx` (about 18 questions as typed constants `FAQ_*`, rendered under "Common questions" on landing and comparison pages, `landing-template.tsx`). Quotes are verbatim from that file.

- **The heading is a question in the user's own words.** "Can I use my existing AI subscriptions with bb?", "What happens when I hit a usage limit?", "Which coding agents does bb support?", "Can my coding agents talk to each other?", "Will my agents keep running when I close my laptop?", "Is my code private with bb?".
- **The first word answers it.** "Yes." for capabilities, and an honest "Not on that laptop." for the laptop question. Few answers hedge.
- **One short paragraph, then a link if there is a guide** ("See how", "Set it up"). Roughly 40 to 90 words.
- **It names the real default, the setting, or the limit.** "By default, bb runs one thread per processor core and starts the rest as others finish." "Accept Edits applies changes inside the project and asks before anything else. Approve for me reviews requests automatically and sends high-risk ones to you. Full Access skips approvals and can run anything on your machine."
- **It states costs and non-features plainly.** "bb doesn't offer team plans, SSO, or a support SLA." The privacy answer says the relay "doesn't store traffic, but isn't end-to-end encrypted".
- **It uses the product's own UI names** (Keep Awake, Account Pooler, Automations, Settings), not internal terms; it explains an unfamiliar term once in a clause ("the Agent Client Protocol (ACP), an open standard for connecting coding agents to apps").
- **Answers that matter for this work, verbatim:** subscriptions ("bb runs the agents you already use, signed in the way you already pay for them: a Claude Pro or Max plan, a ChatGPT plan for Codex, a Cursor plan, API keys, or any other provider's plan. Your existing setup comes along too (CLAUDE.md, skills, MCP servers, and agent settings)."), agents ("Claude Code, Codex, Cursor, and OpenCode, plus Pi, Grok Build, omp, and Hermes Agent. In Settings, add any other agent that supports the Agent Client Protocol (ACP) ... like Gemini CLI or Devin. You can also add one with a plugin. Each thread can use a different agent."), usage limits ("When an agent stops on a usage limit that reports when it resets, bb sends the message again a little after the reset"), agents talking ("there's no coordinator to set up ... any agent can message another thread, whatever the provider ... an agent hears back automatically when a thread it started finishes or fails").
- **Reuse:** each answer is a typed constant (`CompareFaq { question, answer }`), and some are functions taking a `contrast` slot so a competitor page can add one clause. **[inferred]** This keeps one source of truth per claim.
- Reference docs are kept apart from the FAQ: `docs/configuration.md` carries field-level detail (every custom-agent field, the PATH discovery rules), written in the same direct style, while the FAQ stays answers-first.
- Orca's README is a feature grid ("Chat or Terminal", "Orchestrate Agents", "Run Anywhere") with one sentence each and a docs link; its docs live on a separate site (`docs/site/content/docs/**`, MDX). I did not find an FAQ file in the repo.

## What in Clowdy would change (surface only; no design)

Observed current state:

- `apps/desktop/.../settings/EnginePage.tsx` only reports: `ENGINE_NAMES = { claude, codex, fake }`; text says engines and accounts are the daemon's configuration, "so there is nothing to connect here yet."
- `settings/Screen.tsx` has groups General (Appearance) and Agents (Engine, Skills).
- `settings/skills/skillView.ts` `engineLabel` only knows Claude and Codex ("Claude and Codex", "Claude only", "Codex only").
- `packages/protocol`: `EngineId = 'claude' | 'codex' | 'fake'` (`domain.ts:37`), zod enum in `commands.ts:10`; engine appears in `project.update.settings.engine`, `task.start.engine`, `run_spawn.engine` (daemon tool), `Run.engine`, `ProjectSettings.engine`; **`chat.create` has no engine field** (a chat's engine comes from the project setting or the daemon default via `RunService.resolveEngine`).
- The daemon picks the engine for a new run by "an explicit choice, then the project's setting, then the daemon's default" (`runs/service.ts` `resolveEngine`).

Surfaces an agent-per-thread, add-an-agent model would touch **[inferred from the above]**:

| Area | Today | Touched by |
| --- | --- | --- |
| Settings → Engine page | read-only sentence | an agents list: detected/registered agents with state (installed, version, signed in, missing), add/remove, a custom-agent form (command, args, env), registry browsing, sign-in hint text per agent |
| Protocol commands and routes | closed enum in three commands; no agent listing route | agent registry listing/probe/state routes and events; open agent identifier in `chat.create`, `task.start`, `project.update`, `Run` |
| Chat creation and composer | engine not selectable per chat | a picker for agent, model, and permission mode on a new chat; `useStartChat.ts` and `Composer.tsx` (not read) |
| Run list / run detail | shows `Run.engine` | agent name and icon per run; labels from `engineName` in daemon `limits.ts` |
| Skills page | two-engine label | per-agent visibility (which agents see a skill) |
| Notices and errors | `not_logged_in` etc. mention `claude auth login` text | per-agent sign-in text (bb stores `signInCommand`, `installUrl` per agent) |
| Daemon config | `CLOWDY_ENGINE`, `CLOWDY_MAX_RUNS_<ENGINE>` env | persisted agent configuration (a file or the DB) instead of env |

## Sources

- bb `f1c5304`: `apps/app/src/components/settings/ProvidersSettingsSection.tsx`, `plugins/provider-acp/{app.tsx,src/registry.ts,skills/acp-provider/SKILL.md}`, `apps/web/src/compare/compare-content.tsx`, `apps/web/src/landing/landing-template.tsx`, `docs/configuration.md` ("Provider availability", "Custom ACP Agents", "Skills"), `README.md`
- Orca `cbc8119e`: `README.md`
- Clowdy: files named in the header (read 2026-11-17)

## Open questions

- Where bb's agent picker for a new thread lives in code and what it shows when a provider is installed but signed out (not read).
- Whether the owner means the website FAQ or the in-product docs when saying "FAQ-style documentation"; I read the website FAQ constants and `docs/configuration.md`.
- `spec.md` (named in `AGENTS.md` as the product spec) is not present at the repository root in this working tree, so I could not read what it says about agents and Settings.

## Assumptions and limits

- No UI was run. I did not read `useStartChat.ts`, `Composer.tsx`, `RunList.tsx` or the Clowdy stores.

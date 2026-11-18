# Providers settings: the owner's direction (grill notes)

Status: collecting. Research is running in `research/` (accounts and login: `index.md`; usage limits: `limits.md`). Nothing here is confirmed as a final scope until the owner says so; "Settled" is what the owner stated in their own words on 2026-11-18.

## Settled (owner's words, paraphrased)

- **One place.** Settings gets a section called Providers, in the manner of Orca's settings. It joins three things that the references keep apart: the providers themselves, their authorization (login), and their settings.
- **One large card per provider.** Start with Codex, Cursor and Claude. Other agents are out of scope for now.
- **Card top: status.** Which account is signed in. Several accounts only if that turns out to be possible; the owner would rather not complicate it and just show the signed-in accounts that were detected.
- **A provider can be switched off.** It may be installed on the computer and still not wanted in Clowdy.
- **No default provider and no ordering for now.** BB has both (drag to reorder, "Default"); the owner does not see where Clowdy would use them yet.
- **Card bottom: the provider's own settings,** when there are any. BB's per-provider pages have many (memory, subagents, 1M context, sandbox, approvals, ...).
- **Usage (limits)** is shown for every agent that is installed and enabled.
- **Taste.** The owner likes bb much more than Orca overall and wants Orca's login approach taken only in part.

## Facts about the starting point (not research, read from the code)

- The daemon already detects agents (`apps/daemon/src/engine/acp/registry.ts`, `GET /v1/agents` → `AgentInfo`: status, version, path, login command, `enabled`) and keeps per-agent overrides in `agents.json` (`enabled`, `path`, `env`). The desktop has no screen for it: `features/settings/EnginePage.tsx` only prints a sentence.
- The catalog already carries Clowdy's own env defaults per agent (Claude: no claude.ai connectors, no auto-memory, sub-agent depth and count caps) and the Claude `sessionMeta` (`disallowedTools`); these are the natural source of provider settings.
- Not present yet: the account identity of a provider, usage windows, a login flow in the app, a catalog of per-provider settings.

## Settled in the second round (owner, 2026-11-18)

1. **Provider settings:** the ones Clowdy can really control (a variable or a session option). The owner will ask to delete the rest later; no need to hold back.
2. **Login: a button in the app, as in Orca** ("done ideally there"). The bb way (install the CLI, go to a terminal and run commands) is not obvious enough for a person. One account per provider is still the starting point.
3. **Usage:** in the provider cards first. Second step: surface it in the app itself, in the status bar (bb and Orca both do) or better in the header. The owner finds bb's usage popover ideal for this (rows per account: icon, email, plan badge, then bars "5h", "7d", "7d · <model>" with percent and time to reset; Cursor shows "Plan usage").
4. **A disabled provider:** its existing chats stay, but read-only: where the composer is, a message says the provider is off. It also changes the provider and model pickers in the composer (that UI does not exist yet) and the statistics.

## Proposed, not confirmed: switching provider inside a chat

Question from the owner: can a chat change provider on the fly (OpenAI to Claude)? bb cannot; is that technical or a choice? Read from the code: `Run.engine` and `Run.sessionId` (`packages/protocol/src/domain.ts`), resumed with `resumeSessionId` (`apps/daemon/src/runs/driver.ts`). A session id belongs to one agent and means nothing to another, so a switch needs a NEW session seeded from Clowdy's own copy of the conversation (the daemon stores every stream item). That is possible, but what the new agent gets is a transcript, not its own state (no prompt cache, no native tool results, no thinking). So it is mostly a product choice for fidelity, not a hard limit. Proposal: a chat is bound to one provider; the model can change inside it through ACP config options; a different provider means "Hand off to a new chat" (a new chat whose first message carries a summary or the transcript); a disabled provider gets the same read-only message with the same button. Providers can still mix inside one chat's run tree: every run has its own `engine`, so an orchestrator on Claude can spawn an executor on Codex.

## Research outcome and proposal (2026-11-18, not confirmed by the owner)

Research: `research/index.md` (accounts and login), `research/limits.md` (usage limits). Nothing was run; the owner's probes are listed there.

- **Accounts.** Orca makes accounts first-class: one private vendor config dir per account (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`), the vendor CLI keeps the tokens, Orca picks which dir an agent starts with (about 12,600 non-test lines, mostly guards against starting under the wrong account and provisioning each dir with the user's settings, plugins and history). bb keeps one identity per vendor, the machine's, and **does run the vendor login for the user** during onboarding (embedded terminal, link and code parsed from the output); its experimental Account Pooler is a separate opt-in plugin that holds its own tokens and proxies API traffic.
- **Proposal: option (b)** of `research/clowdy-fit.md`: show who is signed in, and a Login button that runs the vendor's own login in the daemon and hands the link to the app; one account per provider. Managed accounts (c) later at most: they need per-account env injection in the registry, history and settings provisioning, and per-account limits (today limits and pauses are per engine id). The login driver of (b) is the same mechanism (c) would reuse with another config dir.
- **Identity without tokens.** Claude: `claude auth status --json`. Codex: `account/read` of `codex app-server` (`codex login status` prints no email). Cursor: `cursor-agent status` (output unverified).
- **Usage without tokens.** Claude: `/usage` (ACP prompt, Markdown text; or the headless `usage_report`, experimental). Codex: `account/rateLimits/read` of the same `codex app-server`, so one probe process gives identity, plan and limits. Cursor: no token-free source; bb and Orca read the Cursor token from the Keychain or `auth.json` and call Cursor's undocumented dashboard API. Owner's decision needed.
- **Avoid:** calling Anthropic's `api/oauth/usage` or OpenAI's `wham/usage` with the user's token (Orca, bb), and any app-owned token store or traffic proxy (bb's Pooler): Anthropic's page says developers may not "collect, store, or intermediate" plan credentials.
- **Gap found in the code:** version and identity probes must run with the same environment as a run (today the version probe ignores agent overrides, and only `PATH` is taken from the login shell, so a `CLAUDE_CONFIG_DIR` exported in `.zshrc` is invisible to the daemon).

## Open

1. Which provider settings, concretely, per provider (after the research on what each vendor exposes).
2. How the login button works per provider (depends on the accounts research).
3. What "Hand off to a new chat" carries: a summary the agent writes, the transcript, or the last N turns. Not needed for the Providers page; needed before the composer's provider picker.

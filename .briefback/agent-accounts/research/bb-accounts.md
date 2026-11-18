# bb: how it handles accounts and login

Snapshot 2026-11-18. Source: shallow clone of https://github.com/get-bb/bb at `48c3a78` (commit 2026-11-18 00:20 -08:00, MIT, app version 0.49.0 per `CHANGELOG.md`), read only; nothing installed or run. Paths are relative to the repo root, cited `path@48c3a78`. `[observed]` = read in source or docs; `[inferred]` = my reading. Earlier note: `.briefback/acp/research/bb-source.md`, which marked the Account Pooler "not read in detail".

## Summary

- **The brief's premise needs two corrections.** bb has no login *of its own* for the providers, but (1) its onboarding **does run the vendor's login command for the user**, in an embedded terminal, and shows the link or code it finds in the output; (2) its opt-in **Account Pooler plugin does hold OAuth tokens of its own** and proxies model traffic with them. Neither is "uses whatever the CLI is signed in as". **[observed]**
- **Default path: one identity per vendor, the machine's.** bb asks the vendor's own tooling who is signed in and shows it. Claude through the Agent SDK's `initializationResult().account`; Codex by reading `$CODEX_HOME/auth.json` and decoding JWT claims; Cursor by reading the Cursor Keychain item or `auth.json` plus the IDE's `state.vscdb`. A signed-out agent is a health status with the vendor's login command attached. **[observed]**
- **Account Pooler** (`plugins/account-pool`, "Account Pooler [Experimental]", disabled by default, added in bb 0.42.0): a local reverse proxy ("hub") on the bb server. bb signs in to extra Claude/Codex accounts through its **own** OAuth flows (not the vendor CLI), stores their tokens in its data directory, refreshes them, and points Claude Code and Codex at the hub with environment variables. It picks an account per request, fails over on limits, and sets the bearer token itself. It never reuses the machine's own Claude Code or Codex login. **[observed]**
- **"bb account" is unrelated.** `plugins/bb-account` links the bb server to a getbb.app account (GitHub sign-in) for remote access and hosted services. It holds no provider credentials. **[observed]**

## 1. The default path: health probes per provider

| Provider | Installed check | Signed-in check and identity | Login command shown | Where |
| --- | --- | --- | --- | --- |
| Claude Code | `claude` resolved via `BB_CLAUDE_CODE_EXECUTABLE` or login-shell PATH; `--version` | Agent SDK `query()` with `env: process.env` (so `CLAUDE_CONFIG_DIR` is inherited), no session persisted; `initializationResult().account` (`AccountInfo`: email, `subscriptionType`, `tokenSource`, `apiKeySource`, `apiProvider`). Signed in = non-firstParty provider **or** tokenSource not `none` **or** an API key source. Account UUID from `<CLAUDE_CONFIG_DIR or home>/.claude.json` `oauthAccount.accountUuid` | `claude auth login` | `plugins/provider-claude-code/src/bridge/{provider-maintenance,initialization-probe}.ts` |
| Codex | `codex` on PATH; version gate `CODEX_MINIMUM_SUPPORTED_VERSION` | Reads `$CODEX_HOME/auth.json` (default `~/.codex`), decodes the ChatGPT JWT for email, plan, expiry; API-key mode reported as having no subscription limits | `codex login --device-auth`, plus `codex login` when the viewer's browser is on the same machine | `plugins/provider-codex/src/bridge/provider-maintenance.ts`, `src/ai/codex-auth.ts` |
| Cursor (ACP bridge) | `cursor-agent` on PATH | Signed in = an access token can be read: macOS Keychain (service `cursor-access-token`, account `cursor-user`) or the CLI `auth.json` (`~/.cursor/auth.json` on macOS, `$XDG_CONFIG_HOME/cursor/auth.json` on Linux, `%APPDATA%\Cursor\auth.json` on Windows). The email comes from the **Cursor IDE's** `state.vscdb` (`cursorAuth/cachedEmail`), which may not be the CLI's account | `cursor-agent login` | `packages/provider-bridge-acp/src/bridge/provider-maintenance.ts`, `plugins/provider-acp/src/known-agents.ts` |
| OpenCode, omp, Grok, Hermes (ACP) | PATH | per-dialect | `opencode auth login`, `omp login`, `grok login`, `hermes login` | `plugins/provider-acp/src/known-agents.ts` |

Health statuses are `ready | not_installed | unauthenticated | expired | unsupported_version | unknown`. All values **[observed]**.

What this means for credentials: bb reads another program's credential file or store for Codex (usage and identity) and Cursor (usage and identity). For Claude it asks the Claude binary, and takes usage windows from the SDK's experimental control request `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET` (`initialization-probe.ts`). The earlier note's wording "bb: no (CLI output)" holds for Claude only. **[observed]**

Codex gets one more use of the file: `plugins/provider-codex/src/ai/chatgpt-client.ts` sends requests to `https://chatgpt.com/backend-api/codex/responses` and `.../transcribe` with the access token read from `auth.json`, with `originator: bb`. I did not trace which bb feature calls it. **[observed; callers not traced]**

## 2. Guided sign-in: bb runs the vendor's login for the user

- Where: the onboarding screen, not (as far as `grep` shows) Settings. `loginCommand` and `useAgentSignIns` are used only under `apps/app/src/components/onboarding/` **[observed]**. I did not confirm that no other screen offers a sign-in for an already onboarded user.
- How (`apps/app/src/components/onboarding/useAgentSignIns.ts`): the "Sign in" button creates a terminal session on the agent's host titled "Sign in to NAME" whose command is the provider's login command (`resolveSignInCommand`: the local variant, for example `codex login`, when the viewer's browser is on the agent's machine; the remote one, `codex login --device-auth`, otherwise). It polls the provider health every 3 s and closes the terminal when the status becomes `ready`; cancel closes it; non-zero exit codes are classified (127 not found, 126 permission, signal). **[observed]**
- Guidance (`onboarding-model.ts`, `OnboardingViews.tsx`): the terminal output is stripped of control sequences and parsed (`parseSignInOutput`) for the last OSC-8 hyperlink or first `https://` URL, a user code matching `[A-Z0-9]{4,5}-[A-Z0-9]{4,5}`, and the phrase "paste (the|your)? (authorization)? code". The UI then shows "Sign in on SITE.", "Enter this code on SITE." or "Sign in on SITE, then paste the code it shows you.", with a code input that is written into the terminal, and a toggle to show the raw terminal. Providers opt in with `internal_DO_NOT_USE_guidedSignIn` (Claude Code, Codex and Cursor declare it). **[observed]**
- Credentials: none are touched by bb. The vendor CLI writes its own store; bb only polls health. **[observed]**

So "bb never runs a login" is wrong in the narrow sense that matters for Clowdy's option (b): bb runs the vendor login for a single account, with link and code capture from terminal output, in a terminal it owns.

## 3. Account Pooler (`plugins/account-pool`)

Overview text (`PLUGIN_OVERVIEW.md@48c3a78`): "Keep a Claude Code or Codex thread running when one account hits its limit. The Account Pooler puts every account you own behind a local hub and picks the account for each request." "Requirements: Accounts you own and are permitted to use this way." "Experimental: routing, storage, and CLI may change." The skill file says "The builtin Account Pooler plugin is disabled by default." Changelog: added in 0.42.0 ("Sign into multiple Claude and Codex accounts in one place. A proxy automatically rotates through your accounts as they hit usage limits. Experimental."). **[observed]**

### Does it touch the machine's own credentials?

No, by design, and the docs say why: "Anthropic and OpenAI refresh tokens are single use and rotate, so two programs holding one login sign each other out at the next refresh; the pool therefore never copies this machine's Claude Code or Codex login, and signing in to the same account the machine uses gives the pool a separate login." (`skills/account-pool/references/accounts-and-routing.md`; this is bb's statement, not verified against vendor docs). An earlier `--import` option that shared the machine's login was removed. **[observed]**

### How accounts are added and stored

- **Claude (OAuth, PKCE, manual code):** `src/oauth-login.ts` builds an authorize URL `https://claude.ai/oauth/authorize?code=true&client_id=9d1c250a-...&response_type=code&redirect_uri=https://console.anthropic.com/oauth/code/callback&scope=org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload&code_challenge=...&state=...`; the user pastes the code (or the redirected URL) back; bb exchanges it at `https://platform.claude.com/v1/oauth/token` and reads `https://api.anthropic.com/api/oauth/profile` (email, UUID, `has_claude_max`/`has_claude_pro`, rate-limit tier). The login session lives 10 minutes. The CLI form is `bb pool account add --provider claude --login` then `login-complete --session <id> --code-stdin`. Whether the hard-coded client id is Claude Code's own was not verified against an Anthropic source. **[observed; client id provenance unverified]**
- **Claude (API key):** `--api-key-stdin`, stored as an account of kind `apiKey`. **[observed]**
- **Codex (device code):** `src/codex-device-login.ts` against `https://auth.openai.com` with client id `app_EMoamEEZ73f0CkXaXp7hrann`, which is the same constant as `CLIENT_ID` in the Codex CLI source (`codex-rs/login/src/auth/manager.rs:1897@ad5dd4a`). Prints a verification URL and a one-time code; `login-poll` waits. **[observed]**
- **Storage:** account metadata in the plugin KV store; each account's secret as `account-<id>.json` mode 0600 in a `secrets` directory (mode 0700) under the bb server data dir; hub tokens as `hub-token-<host>.json` (`src/store.ts`). Tokens are plaintext JSON on disk, protected by file mode. **[observed]**
- **Refresh:** bb refreshes OAuth tokens itself (`grant_type: refresh_token` with the same client id) and writes the new secret; a refresh token rejected by the token endpoint is fingerprinted (SHA-256) and never sent again until "Sign in again" (`src/claude-adapter.ts`, `src/codex-adapter.ts`, `src/store.ts`). **[observed]**

### How requests are routed (the part that differs from every other approach)

- The hub lives on the bb server at `/api/v1/plugins/account-pool/http` and serves Anthropic Messages (`/claude/...`) and OpenAI Responses (`/v1/...`) endpoints. bb contributes environment variables to provider sessions (`src/server.ts`, `experimental_contributeEnv`):
  - Claude Code: `ANTHROPIC_BASE_URL=<hub>`, `ANTHROPIC_AUTH_TOKEN=<machine-scoped hub token>`, `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1`, `ENABLE_TOOL_SEARCH=true`, `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL=1`, `BB_CLAUDE_MODELS_URL`, and `ENABLE_PROMPT_CACHING_1H=1` for subscription accounts. The reasons are written beside each variable, for example "Claude Code otherwise refreshes this machine's own Claude login while routed, which can spend its single-use refresh token and sign it out".
  - Codex: `CODEX_OPENAI_BASE_URL=<hub>/v1` and `CODEX_POOL_AUTH_TOKEN`, applied as in-memory app-server config.
- The hub picks an account, **sets `authorization: Bearer <that account's access token>`** (or `x-api-key` for key accounts) on a header-filtered copy of the agent's request, and forwards it upstream (`src/claude-adapter.ts` `requestHeaders`, `src/provider-adapter.ts`). It reads quota from response headers and from the usage endpoints, and answers 429 itself only when no account can serve. **[observed]**
- Policy of the pool: accounts in priority order; new conversations stay on the current fallback; existing conversations stay pinned to an account (prompt cache locality) until the provider refuses it; switch threshold 98 % by default is "a preference, not a cutoff"; a provider error retries twice on the pinned account before failing over; "The pool does not enable extra usage, purchase credits, or change spending limits." Routed Claude Code loses features that need the machine's own login (Claude in Chrome, claude.ai connectors, Remote Control); `bb pool bypass <thread-id>` sends one thread to its own credentials. **[observed]**
- Scale: about 9,700 non-test lines in the plugin (hub, store, adapters, usage, UI). **[observed, `wc -l`]**

## 4. "bb account" (`plugins/bb-account`)

`PLUGIN_OVERVIEW.md`: "Sign this bb in to your getbb.app account once. Remote access and hosted services, such as generated thread titles and commit messages, then use that account." It stores a server credential (`bbcred_...`) in plugin KV, uses GitHub sign-in on getbb.app and exposes `bb account login|status|logout`. Other plugins call it through RPC and "never see the credential". No Anthropic, OpenAI or Cursor credentials appear in it. **[observed]** It is unrelated to provider accounts.

## 5. Relevant quotes from bb's own product copy

- FAQ (`apps/web/src/compare/compare-content.tsx@48c3a78`, `FAQ_SUBSCRIPTIONS`, quoted in `policy.md`): "bb runs the agents you already use, signed in the way you already pay for them."
- `PLUGIN_OVERVIEW.md` of the pool: "Accounts you own and are permitted to use this way."

## Files and modules

| Area | Path |
| --- | --- |
| Claude health and usage | `plugins/provider-claude-code/src/bridge/{provider-maintenance,initialization-probe}.ts` |
| Codex health, usage, AI client | `plugins/provider-codex/src/bridge/provider-maintenance.ts`, `src/ai/{codex-auth,chatgpt-client}.ts` |
| Cursor and other ACP | `packages/provider-bridge-acp/src/bridge/provider-maintenance.ts`, `plugins/provider-acp/src/known-agents.ts` |
| Guided sign-in | `apps/app/src/components/onboarding/{useAgentSignIns.ts,onboarding-model.ts,OnboardingViews.tsx}` |
| Account Pooler | `plugins/account-pool/{PLUGIN_OVERVIEW.md,skills/account-pool/*,src/{server,hub,store,oauth-login,codex-device-login,claude-adapter,codex-adapter,provider-adapter,quota,usage}.ts,app.tsx}` |
| bb account | `plugins/bb-account/{PLUGIN_OVERVIEW.md,README.md,src/*}` |

## Open questions

- Whether any settings screen, not only onboarding, offers the guided sign-in later.
- Which bb feature uses `provider-codex/src/ai/chatgpt-client.ts`, and whether it ships enabled.
- The provenance of the hard-coded Claude OAuth client id.
- How the hub authenticates a machine token and whether it is reachable beyond the bb server's own listener (only the contribution of `ANTHROPIC_BASE_URL` was read).

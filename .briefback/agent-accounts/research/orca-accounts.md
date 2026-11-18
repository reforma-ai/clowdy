# Orca: how managed accounts work

Snapshot 2026-11-18. Source: shallow clone of https://github.com/stablyai/orca at `3941b73d` (commit 2026-11-18 06:35 -08:00, MIT), read only; nothing installed or run. Paths are relative to the repo root and cited `path@3941b73d`. `[observed]` = read in source or docs; `[inferred]` = my reading. The earlier note `.briefback/acp/research/orca-source.md` was written at `cbc8119e`; this page goes deeper into `src/main/claude-accounts/**`, `codex-accounts/**`, `cursor-accounts/**`, `grok-accounts/**` and the settings UI, which that note listed as not read.

## Summary

- **Orca multiplies the vendor's own credential store.** For Claude and Codex, one managed account is one private config directory (`CLAUDE_CONFIG_DIR` / `CODEX_HOME`) under Orca's data folder. Orca runs the vendor's own login command with that variable set, so the vendor CLI writes and refreshes the tokens itself. Orca keeps only metadata (id, email, organization, folder path) in its settings. **[observed]**
- **"System default" is the vendor CLI's own home, left alone.** It means: inject nothing, the agent starts exactly as it would from a terminal (`~/.claude` or the user's own `CLAUDE_CONFIG_DIR`; `~/.codex`). Orca's docs say accounts it adds "do not rewrite that login; they run in isolated homes" (`docs/site/content/docs/agents/codex-hot-swap.mdx@3941b73d`). **[observed]**
- **No credential copying in the current Claude and Codex design.** Earlier Orca versions did copy logins into the System default (code still detects and warns about those, and a legacy Codex mirror can still write `~/.codex/auth.json` for retained terminal panes). The only place the current code writes a vendor credential store is Antigravity (`agy`), whose docs call it "switching one shared login". **[observed]**
- **Binding is by environment at spawn.** A terminal gets a pointer file and a shell function that re-reads it on every `claude` launch; a chat/structured session gets `CLAUDE_CONFIG_DIR` / `CODEX_HOME` in the child environment. A running process keeps the account it started with; Orca asks (or is set to restart or keep) when the selection changes. **[observed]**
- **Cursor and Grok have no managed accounts.** Orca only reads what is already signed in (status plus usage) and, for ACP chats, records the config-dir variable the session ran with. **[observed]**
- **The cost is large.** About 4,700 lines in 42 files for Claude and about 7,900 lines in 55 files for Codex (non-test, includes a WSL migration module). Most of it is provisioning (what to share with the default home), concurrency, rollback, Windows and WSL. **[observed, `wc -l`]**

## At a glance

| Agent | Managed accounts | Storage per account | Env var | Login Orca drives | Identity read from |
| --- | --- | --- | --- | --- | --- |
| Claude Code | yes, several | `<userData>/claude-profiles/<accountId>/home` (+ `profile.json` marker beside it); credentials live where Claude puts them for that dir (Keychain item `Claude Code-credentials-<8 hex>` on macOS, `.credentials.json` in the dir elsewhere) | `CLAUDE_CONFIG_DIR` | `claude auth login --claudeai`, link captured via `BROWSER`, or pasted-code flow | `oauthAccount` in the dir's `.claude.json` (email, organization); plan from the credential record |
| Codex | yes, several | `<userData>/codex-accounts/<accountId>/home` with marker `.orca-managed-home` | `CODEX_HOME` | `codex login` (link parsed from stderr) or `codex login --device-auth` | JWT claims in the home's `auth.json` |
| Cursor | no | none | `CURSOR_CONFIG_DIR` pinned per ACP session, not per account | none ("Orca only reads it") | `cli-config.json`, macOS Keychain item, IDE state DB |
| Grok | no | none | `GROK_HOME` pinned per ACP session | none | Grok's own auth session file |
| Antigravity (`agy`) | saved logins, one active | Orca's store; switching **writes `agy`'s credential store** | none (one login per machine) | user runs `agy` themselves | `agy` status |
| Pi, Copilot, Hermes, Kimi (ACP) | no | none | `PI_CODING_AGENT_DIR`, `COPILOT_HOME`, `HERMES_HOME`, `KIMI_CODE_HOME` pinned per session | none | n/a |

Sources: `src/main/claude-accounts/profiles/claude-profile-paths.ts`, `codex-accounts/managed-homes/codex-managed-home-path.ts`, `main/cursor-accounts/status.ts`, `main/grok-accounts/status.ts`, `main/acp/launch/acp-account-binding.ts`, `docs/site/content/docs/agents/antigravity-accounts.mdx` (all `@3941b73d`).

## Claude Code

### Storage and where credentials really live

- Account folder: `<userData>/claude-profiles/<accountId>/home`, `accountId` is a UUID; created mode 0700; an ownership marker `profile.json` (mode 0600) sits next to `home`. Orca refuses a profile that overlaps `~/.claude`, `~/.config/claude` or the user's own `CLAUDE_CONFIG_DIR` (`claude-profile-paths.ts`). **[observed]**
- Orca's own settings hold a record per account: id, email, organizationUuid/Name, `managedAuthPath`, `authMethod: 'subscription-oauth'`, timestamps (`sign-in/claude-account-registration.ts`). No token is stored by Orca. **[observed]**
- Credentials are Claude's: on macOS a Keychain generic password whose service is `Claude Code-credentials-` plus the first 8 hex chars of `sha256(configDir NFC)` (the unsuffixed `Claude Code-credentials` is the default home), account name = the OS user; elsewhere `<dir>/.credentials.json`. The code comment says "Match Claude 2.1+ config-scoped Keychain naming" (`claude-accounts/runtime-auth/keychain.ts`). Anthropic's docs confirm the behavior in words: Claude Code "keys the macOS Keychain entry to that directory too, so a session with a different `CLAUDE_CONFIG_DIR` reads a different entry" (see `vendor-multi-account.md`). **[observed]**
- Orca never writes a Claude keychain item. It reads (usage polling, "does this folder hold a login") and, on account removal, deletes the items of its own profile folder (`security delete-generic-password -s <service>`, up to four times per spelling of the path) (`sign-in/claude-account-folder.ts`). **[observed]**
- Orca has a guard for `CLAUDE_SECURESTORAGE_CONFIG_DIR`: if the login shell exports it, an empty account folder "proves nothing" because Claude then keeps logins elsewhere (`selection/claude-account-selection.ts`). That variable is not on the Anthropic pages I read. **[observed in Orca; not found in docs]**

### How login is driven

Entry points: `ClaudeAccountService.addAccount`, `reauthenticateAccount` ("Sign in again"), `signInWithPastedCode` (`claude-accounts/service.ts`).

1. Orca creates (or reuses, for re-auth) the account folder and runs `claude auth login --claudeai` with `CLAUDE_CONFIG_DIR=<home>` merged into the inherited environment. No PTY on macOS/Linux: stdout and stderr are pipes, stdin is kept open, the child is detached; a 600 s timeout; cancel kills the process group (`sign-in/claude-login-session.ts`, `claude-command-process.ts`). On native Windows the login runs in a visible console wrapper. **[observed]**
2. **"Copy link" (link capture).** Orca writes a tiny helper script `.orca-sign-in-browser` (mode 0700) into the account folder: `printf '%s' "$1" > "$0.tmp" && mv "$0.tmp" "$0.link"`, and sets `BROWSER=<that script>`. Claude calls `$BROWSER <authorize-url>`; Orca polls the `.link` file every 250 ms (up to 60 s) and accepts it only if the host is `claude.com`/`claude.ai` and `redirect_uri` is `http://localhost|127.0.0.1` (the local-callback flow). The user then pastes the link into any browser **on the same machine** (the callback is local). The code comment: "Claude discards BROWSER stdout; its printed link uses a different pasted-code flow." Not available on a native Windows host: "Claude spawns BROWSER without a shell, and Windows has no sh script to point it at" (`sign-in/claude-sign-in-browser.ts`, `shared/agent-accounts/claude/claude-sign-in-link.ts`). **[observed]**
3. **Pasted-code flow** (for a person on another device, remote Orca server): Orca still sets `BROWSER` to the capture helper but also scans stdout for a printed `https://claude.com|claude.ai/...?code=true&redirect_uri=<non-local>` link, shows it, then writes the pasted code plus newline into the CLI's stdin (`sign-in/claude-pasted-code-login.ts`). **[observed]**
4. After exit code 0 Orca reads `<home>/.claude.json` → `oauthAccount.emailAddress`, `organizationUuid`, `organizationName`. No email → error "Claude login completed, but Orca could not resolve the account email." Same email+organization already saved → "This Claude account is already added." (`claude-account-registration.ts`, `claude-account-folder.ts`). **[observed]**
5. A denial in output (`access_denied`, "authorization denied") kills the child and fails the sign-in; an abandoned folder is deleted ("Publish accounts only after login, so abandoned sign-ins never appear in the list"). **[observed]**

### Email and plan

- Email, organization: from the account folder's `.claude.json` (`oauthAccount`), never from the network (`claude-account-folder.ts`). **[observed]**
- Plan: the credential record Claude wrote beside the token (`claudeAiOauth.subscriptionType`, `rateLimitTier`, e.g. "pro", "max_20x"); the code comment says "not live billing" (`rate-limits/providers/claude/claude-oauth-credentials.ts`). **[observed]**

### What "System default" means

- Accounts list shows a row "System default" (or "System default: <email>") above the managed accounts (`renderer/src/components/settings/accounts/claude/accounts-pane-claude-section.tsx`). Selected when `activeClaudeManagedAccountId` is null: Orca injects nothing. If the user's own shell exported `CLAUDE_CONFIG_DIR`, Orca remembers it in `ORCA_CLAUDE_USER_CONFIG_DIR` and the shell function restores it. **[observed]**
- `coveredBySystemDefault`: a saved account whose own folder has no login yet but whose saved identity equals the System default login runs on the System default ("legacy accounts"); the UI warns "System default is signed in as X, which is also a saved account. An earlier Orca version may have copied that login there. If it is not your own login, select System default and run claude /login." A legacy snapshot file `claude-runtime-auth/system-default-auth.json` marks copy-based switching of older versions (`profiles/routing/claude-profile-router.ts`). **[observed]**
- Orca never overwrites or swaps the vendor CLI's credentials in the current Claude design **[observed: the only `add-generic-password` in `src/main` is in `antigravity/native-macos-credentials.ts`]**. Older versions did copy ([observed: legacy markers above]).

### Binding an account to a terminal, chat, run

- **Terminals.** The selection is mirrored to a pointer file `<userData>/claude-profiles/selected-host` (content: the account home path or empty). The pane gets `ORCA_CLAUDE_PROFILE_POINTER` and a shell function `claude` (bash/zsh, fish, PowerShell variants in `shared/shell/launch/agents/claude-shell-function.ts`) that, on every launch of `claude`, reads the pointer and runs the real binary with `CLAUDE_CONFIG_DIR=<home>` (and `ORCA_CLAUDE_INJECTED_CONFIG_DIR` so it can tell its own value from the user's). A `CLAUDE_CONFIG_DIR` the user set inside that pane wins; an empty pointer restores the user's own value. So a selection change applies to the **next** `claude` started in an existing pane. **[observed]**
- **Structured chats (Claude Agent SDK).** The child environment is built from the launch environment with account variables scrubbed and only `launch.env` allowed to pin `CLAUDE_CONFIG_DIR` (`main/claude/claude-stream-json-connection.ts`: "Always supply scrubbed env to prevent ambient auth leaks; only launch.env may pin CLAUDE_CONFIG_DIR"). The account home is resolved when a session is created (`runtime/agent-session/environment/structured-agent-account-home.ts`: "create pins"), and `select()` carries the comment "chats follow the selection on their next start". `applyClaudeEnvPatch(..., { stripAuthEnv })` deletes `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `AWS_BEARER_TOKEN_BEDROCK` so a stray key cannot override the account (`runtime-auth/environment.ts`). **[observed; who passes `stripAuthEnv` in each path not traced]**
- Account folders are created lazily and set up in the background: `ClaudeProfileRouter.setUp` runs a provisioning worker; a launch waits for the first setup (`prepareLaunch`) but later refreshes may time out without blocking. **[observed]**

### Switching while Claude runs

- Setting `claudeAccountSwitchRunningSessions: 'ask' | 'restart' | 'keep'`, UI label "When you switch accounts while Claude is running in terminals" with options Ask / Always restart / Never restart and the help text "Restarting continues each terminal conversation on the new account. Busy sessions stop their current work." (`renderer/src/components/settings/accounts/claude/claude-running-session-switch-setting.tsx`). **[observed]**
- Mechanism: the renderer finds running Claude panes on the outgoing account (the account is read from the transcript path of hook events, `shared/agent-accounts/claude/claude-pane-account-folder.ts`), shows a dialog listing sessions on the account, elsewhere, and "can't move", and on "restart" queues an in-place pane restart that resumes the conversation under the new account (`renderer/src/lib/provider-accounts/claude-account-switch-sessions.ts`). A host without a window (headless Orca server) moves its own panes and skips panes whose session is shared by two panes, held by agent teams, or unproven (`main/runtime/session-lifecycle/projection/claude-running-pane-account-move.ts`). **[observed]**
- This works because transcripts are shared between account folders (see provisioning) so a resumed session id exists under the new account. **[inferred from the history-linking code]**

### Token refresh

- Orca does not refresh Claude tokens. Claude Code refreshes inside the account's own store when it runs. Orca's usage polling classifies a stale token: "Idle login's access token lapsed, not the login; Claude refreshes it when it next runs" and shows "Claude usage updates the next time Claude runs." It mirrors Claude's refreshability check (refresh token present, not expired, not "revoked") to decide between that message and "Sign in again to use this account." (`rate-limits/providers/claude/claude-active-usage-fetch.ts`). **[observed]**

### Provisioning of an account folder (what is shared with the default home)

`claude-accounts/profiles/setup/claude-profile-provisioning.ts` and neighbors:

- Non-hidden entries of the default home that are not runtime state (skills, plugins, commands, agents, ...) are **symlinked** (directories; junctions on Windows) or **copied** (files, because rename-replace saves break links).
- `CLAUDE.md` is replaced by an import line `@~/.claude/CLAUDE.md`.
- `settings.json` is synced key by key using stored digests so keys the account changed itself survive.
- `.claude.json` is merged from a whitelist of configuration keys (`theme`, `env`, `mcpServers`, `apiKeyHelper`, ...); identity, onboarding and anything unknown stay private to the account (`profiles/setup/claude-profile-state.ts`).
- Transcripts and history (`projects`, `session-env`, `file-history`, `shell-snapshots`, `todos`, `paste-cache`, `tasks`, `plans`, `transcripts`) are linked into the default home so every account sees the same history; `sessions` (live process registry) is not shared (`profiles/setup/claude-profile-history.ts`).
- Never shared: `.claude.json` identity, `.credentials.json`, `.session_ingress_token`, caches, logs (a denylist of about 70 names).

### WSL and Windows

A second router exists for WSL distros on Windows (`profiles/wsl/*`, about 650 lines); the account folder lives inside the distro (`~/.local/share/orca/...`). Link capture is unavailable on a native Windows host (see above). **[observed]**

## Codex

### Storage, login, identity

- Account home: `<userData>/codex-accounts/<accountId>/home`, marker file `.orca-managed-home` containing the account id; ownership is asserted before every use and a missing home is recreated only at the exact expected path (`codex-accounts/managed-homes/codex-managed-home-path.ts`). In WSL: `~/.local/share/orca/codex-accounts/<id>/home` inside the distro. **[observed]**
- Login: `codex login` (or `codex login --device-auth` when someone signs in from another device), spawned with `CODEX_HOME=<home>`; stdin ignored, stdout and stderr piped; a 180 s timeout (15 min for device auth) (`codex-accounts/login/codex-login-session.ts`). The browser link is parsed from output after the marker "navigate to this url to authenticate:" and accepted only on host `auth.openai.com`; the device prompt needs the URL, the phrase "one-time code" and a code matching `XXXX-XXXX` (`login/codex-login-auth-url.ts`, `codex-device-auth-prompt.ts`). Settings shows the link with "Copy link" / "Open" (`renderer/.../codex/CodexLoginLinkNotice.tsx`). **[observed]**
- Completion is exit code 0 plus changed bytes of `<home>/auth.json` (`login/codex-login-auth-snapshot.ts`); on Windows Orca watches `auth.json` and kills a lingering login tree after a 5 s grace. **[observed]**
- Identity: `auth.json` → `tokens.id_token` JWT claims: `email`, `chatgpt_account_id`, `chatgpt_plan_type`, workspace id (`credentials/codex-auth-identity.ts`). Duplicate detection on provider account id and workspace. **[observed]**
- Orca has no code for `cli_auth_credentials_store` (`grep` finds none in `src/main`), so a managed home depends on Codex writing `auth.json`. A comment in `codex/history/shared-store/codex-account-history-links.ts` notes that encrypted secrets "whose keyring passphrase is named from CODEX_HOME" stay private per home. **[observed absence; the consequence for keyring mode is inferred]**

### System default, config, history

- System default = the real `~/.codex` with no `CODEX_HOME` injected (`runtime-home-service-launch.ts`: `isHostSystemDefaultRealHomeSelected` → return `null`). **[observed]**
- For a managed account Orca mirrors `~/.codex/config.toml` into the managed home and links skills, hooks, plugins, prompts, themes, `AGENTS.md` and rules from `~/.codex` (`codex/configuration/homes/codex-home-paths.ts`, `codex-accounts/managed-homes/codex-config-mirror.ts`). A warning appears when the source config is unreadable: "Codex keeps the last successfully synced settings". Session history is linked across accounts unless the setting `codexShareHistoryAcrossAccounts` is false (default on). **[observed]**
- Legacy: `<userData>/codex-runtime-home/home` was a shared mirror whose `auth.json` was copied from `~/.codex`; code remains that can write `~/.codex/auth.json` back (`runtime-home/credentials/runtime-home-service-auth-sync.ts`, `writeSystemDefaultAuth`) for panes retained from older versions, guarded by identity checks. The comment in `runtime-home-service-managed-home.ts` gives the reason for the current design: "Host accounts refresh auth in separate homes so concurrent accounts cannot race one auth.json." **[observed]**

### Binding and switching

- Env at spawn: `CODEX_HOME=<managed home>`. Docs: "Any new Codex session launched after that uses it, and open Codex chats move to it before their next message (a reply already running finishes first). Terminal sessions already running keep their original account until restarted." "Each terminal session keeps the account it launched with; chats always follow the selected account." (`docs/site/content/docs/agents/codex-hot-swap.mdx`). **[observed]**
- Token refresh: Codex refreshes `auth.json` in the managed home itself; Orca only reads it for usage (`rate-limits/providers/codex/codex-backend-auth.ts` sends the access token and `chatgpt-account-id` to `https://chatgpt.com/backend-api/wham/usage`). **[observed]**

## Cursor, Grok, others

- Cursor settings text: "Shows your Cursor plan usage from the sign-in already on this computer. Orca only reads it — it never changes your Cursor login." (`renderer/.../providers/CursorAccountsSection.tsx`). It reads, in order, the macOS Keychain item (service `cursor-access-token`, account `cursor-user`, "cursor-agent 2026.06+ stores tokens in Keychain instead of auth.json"), the legacy CLI `auth.json`, then the Cursor IDE's `state.vscdb`; identity comes from `cli-config.json` `authInfo.{email,displayName}` (`rate-limits/providers/cursor/cursor-auth.ts`, `cursor-auth-paths.ts`). **[observed]**
- Why no Cursor accounts: Orca gives no reason. What the code shows: the CLI config folder "holds Cursor's allowlist and sessions; its login lives elsewhere per platform" (`cursor/cursor-acp-launch-spec.ts` comment), i.e. on macOS a global Keychain item rather than a file in the config dir. If that item is not keyed to `CURSOR_CONFIG_DIR`, a per-directory scheme cannot isolate logins there. **[inferred; Probe 6 in `index.md`]**
- Grok status only (`grok-accounts/status.ts`); Orca's ACP launch specs pin a per-session home variable for Grok, Cursor, Pi, Copilot, Hermes, Kimi (`directoryAccountBinding(...)`) to record which home the session used, resolving the **inherited** env or default path, not a managed account (`acp/launch/acp-account-binding.ts`, `runtime/agent-session/environment/structured-agent-account-home.ts`). **[observed]**
- Antigravity: "Orca writes that login into `agy`'s own credential store on this machine and checks that `agy` now reports it"; docs state running sessions may keep the previous account and "you cannot pin two new sessions to two different accounts at once" (`docs/site/content/docs/agents/antigravity-accounts.mdx`). This is the swap-credentials design the Claude and Codex paths moved away from. **[observed]**

## Files and modules

| Area | Path (`src/main/...` unless noted) |
| --- | --- |
| Claude service, selection, sign-in | `claude-accounts/service.ts`, `selection/claude-account-selection.ts`, `sign-in/{claude-login-session,claude-command-process,claude-sign-in-browser,claude-pasted-code-login,claude-account-registration,claude-account-folder}.ts` |
| Claude routing and provisioning | `claude-accounts/runtime-auth-service.ts`, `profiles/routing/claude-profile-router.ts`, `profiles/claude-profile-paths.ts`, `profiles/setup/*`, `runtime-auth/{keychain,environment}.ts` |
| Terminal shell function | `src/shared/shell/launch/agents/claude-shell-function.ts`, `src/shared/agent-accounts/claude/claude-profile-routing.ts` |
| Codex | `codex-accounts/service.ts`, `login/*`, `managed-homes/*`, `account-management/*`, `runtime-home/**`, `credentials/*`, `codex/configuration/homes/codex-home-paths.ts` |
| Cursor, Grok | `cursor-accounts/status.ts`, `grok-accounts/status.ts`, `rate-limits/providers/{cursor,grok}/*` |
| ACP account pin | `acp/launch/acp-account-binding.ts`, `runtime/agent-session/environment/structured-agent-account-home.ts` |
| Settings UI | `src/renderer/src/components/settings/accounts/{claude,codex,providers,sign-in}/*` |
| Docs | `docs/site/content/docs/agents/{codex-hot-swap,antigravity-accounts}.mdx`, `docs/site/content/docs/settings.mdx` |

## Quotable product statements (for `policy-facts.md`)

- "Running multiple Codex accounts to maximize tokens is common. Orca lets you add each account once and switch the active one in a click, with no config editing." (`codex-hot-swap.mdx`)
- "Usage still counts against each account's own plan; Orca does not pool quota across accounts." (same)
- Settings: "Optional saved accounts per provider. Without any, Orca uses your existing logins." (`settings.mdx`)
- Orca sends `User-Agent: claude-code/2.1.0` with `anthropic-beta: oauth-2025-04-20` and the stored access token to `https://api.anthropic.com/api/oauth/usage` (`rate-limits/providers/claude/claude-oauth-usage-request.ts`). **[observed]**

## Open questions

- Which code path passes `stripAuthEnv` for Claude chats and terminals (the helper exists; call sites not traced).
- Whether Orca's Claude account flow works when the owner's Claude keeps logins in a keychain item not keyed to the config dir (`CLAUDE_SECURESTORAGE_CONFIG_DIR` case).
- How Orca behaves for a Codex user whose default `cli_auth_credentials_store` is `keyring` or `auto` (managed homes need `auth.json`).
- Mobile, cloud and remote-runtime variants of the account services (`orcad`, WSL router internals) were skimmed only.

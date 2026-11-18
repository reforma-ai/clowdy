# Research: agent accounts and login (Orca, bb, vendors, Clowdy fit)

Snapshot 2026-11-18. Research only: no plan, no design, no recommendation. Slug `agent-accounts`; notes in this folder. Context and the owner's direction so far: `../grill.md` (Providers settings).

## Question and scope

Clowdy wants a Providers screen that detects which agents exist, shows them with their usage limits, and has to decide how accounts and login work. Two references behave differently: **Orca** (sign in from the app, several accounts per agent for Claude and Codex, none for Cursor) and **bb** (no login of its own; an experimental Account Pooler; a separate "bb account"). Five questions:

1. How Orca's accounts work (storage, login, identity, "System default", binding, switching, refresh, modules).
2. How bb does without login (signed-out guidance, what `account-pool` is, whether "bb account" is unrelated).
3. What the vendors and ACP adapters officially support for several accounts or profiles, and what ACP offers for login.
4. Terms and risk facts per approach (quotes with URLs and dates, no judgment).
5. How three options would fit Clowdy's architecture: (a) system default only, (b) plus run the vendor login for the user, one account, (c) managed accounts with per-account config dirs.

Usage limits are covered in parallel in [limits.md](limits.md) (not read by me).

## Summary by question

1. **Orca** multiplies the vendor's own credential store. One managed Claude or Codex account is one private config directory (`CLAUDE_CONFIG_DIR` / `CODEX_HOME`) under Orca's data folder; Orca drives the vendor CLI login with that variable set (`claude auth login --claudeai` with the link captured through a `BROWSER` helper script or a pasted code; `codex login` with the link parsed from stderr, or `--device-auth`), reads email and plan from files the CLI wrote (`.claude.json` `oauthAccount`, the `auth.json` JWT), and starts agents with the selected account's variable. "System default" means "inject nothing". The current code never writes the vendor's credential store for Claude and Codex (older versions copied logins and the code still detects that); it does for Antigravity. Terminals re-read a pointer file on every `claude` launch; running sessions keep their account, and a setting (Ask / Always restart / Never restart) decides what happens on a switch. Cursor and Grok get status and usage only. The Claude and Codex account code is about 12,600 non-test lines. See [orca-accounts.md](orca-accounts.md).
2. **bb**: the default path keeps one identity per vendor, the machine's, and reads who is signed in from the vendor's tooling (Claude through the Agent SDK's account info; Codex from `auth.json`; Cursor from its token store and the IDE's email). Signed-out is a health status with the vendor's login command, and **bb does run that command for the user** in an embedded terminal during onboarding, parsing the link, code and "paste code" prompt out of the output (so "bb never runs a login" is not accurate). The **Account Pooler** is an opt-in, experimental, disabled-by-default plugin that signs in to extra Claude and Codex accounts with **its own OAuth flows**, stores their tokens (plaintext JSON, mode 0600) and runs a local hub that forwards the agents' API traffic with those tokens, selected through `ANTHROPIC_BASE_URL` and `CODEX_OPENAI_BASE_URL`. It never copies the machine's own login. **"bb account" is unrelated** (a getbb.app account for remote access and hosted services). See [bb-accounts.md](bb-accounts.md).
3. **Vendors**: Claude Code officially documents several accounts through one `CLAUDE_CONFIG_DIR` per account (own settings, history and login; Keychain entry keyed to the directory; a keyless Console sign-in is the exception). `claude auth status` prints JSON and exits 1 when logged out; `claude auth login` accepts `--claudeai`/`--console`/`--sso`/`--email`; `claude setup-token` prints a one-year, inference-only token. Codex uses `CODEX_HOME` as the unit of identity (file mode `auth.json`, or a keyring entry keyed by a hash of the path); `codex login status` prints one line to stderr with no email. Cursor documents `agent login|logout|status`, `CURSOR_API_KEY`, `NO_OPEN_BROWSER`, and nothing on several accounts or on where the login lives. The ACP adapters can report identity (`_auth/status_update`; `auth/status` from the Claude adapter) and offer login (`authenticate`, terminal-auth methods), but only to clients that advertise the matching capabilities, which Clowdy's client does not. See [vendor-multi-account.md](vendor-multi-account.md).
4. **Terms facts**: Anthropic's legal page says developers may not "collect, store, or intermediate Claude.ai credentials or session tokens" or "route requests through Free, Pro, Max, or Ultra plan credentials on behalf of their users", while allowing an end user to sign in to the unmodified Claude Code binary with their own subscription; its authentication page documents several accounts through separate config dirs; the Consumer Terms (effective 2025-10-08) bar sharing account credentials and making the account available to others. OpenAI says app-server authentication "has never been permitted for commercial or hosted services" and documents copying your own `auth.json` to your own headless machine; the live Terms of Use returned HTTP 403. No vendor page read addresses rotating several subscriptions. A side-by-side table of who stores and who uses tokens in each approach is in [policy-facts.md](policy-facts.md).
5. **Clowdy fit**: (a) needs identity reads with the same environment as a run (today's version probe omits agent overrides) and runs into the fact that only `PATH` is taken from the login shell; (b) adds a long-lived login child in the daemon, link capture (Windows cannot use Orca's `BROWSER` trick), an event path to the app, and ACP `auth` capabilities Clowdy does not send; (c) adds an account store, per-account env injection through a registry path that has no account parameter, history and settings provisioning, and exposes per-engine limit and pause logic to the several-accounts case. See [clowdy-fit.md](clowdy-fit.md).

**Single most important difference between Orca and bb:** Orca makes accounts a first-class thing the app owns (one vendor config dir per account, the vendor CLI keeps the tokens, the app chooses which dir an agent starts with). bb keeps exactly one identity per vendor, the machine's, only helps run the vendor's own login command, and puts several accounts in a separate opt-in plugin that holds its own tokens and proxies the traffic.

## Topic pages

| Page | Covers |
| --- | --- |
| [orca-accounts.md](orca-accounts.md) | Q1: Claude and Codex account storage, login drivers, identity, System default, binding, switching, refresh, provisioning; Cursor, Grok, Antigravity; modules and sizes |
| [bb-accounts.md](bb-accounts.md) | Q2: provider health probes, guided sign-in, Account Pooler mechanism, bb account |
| [vendor-multi-account.md](vendor-multi-account.md) | Q3: Claude Code, Codex, Cursor docs and source facts; ACP adapters and registry auth rules |
| [policy-facts.md](policy-facts.md) | Q4: quotes with URLs and dates; per-approach credential-handling table |
| [clowdy-fit.md](clowdy-fit.md) | Q5: what Clowdy has, and what (a), (b), (c) require and risk |

### Related (written in parallel)

- [limits.md](limits.md)

## Corrections to earlier notes

- `.briefback/acp/research/policy.md` (table row "bb / Orca usage reads", "bb: no (CLI output)"): holds for **Claude** only. bb reads `auth.json` (Codex) and the Cursor token store directly, and its Account Pooler stores and uses OAuth tokens. See `bb-accounts.md` sections 1 and 3.
- `.briefback/acp/research/bb-source.md` marked the Account Pooler "not read in detail": now read (mechanism, storage, routing, env variables).
- `.briefback/acp/research/orca-source.md` inferred that Orca's account `selection/` module "takes a rate-limit source" to choose by remaining limit. The code shows selection is explicit (the user selects an account; the rate-limit service is only told to refresh usage after a change, and Orca's docs say it does not pool quota across accounts). See `orca-accounts.md`.
- The brief's premise "bb never runs a login": see Summary 2.

## Important files and sources

| Source | Version / commit | Date |
| --- | --- | --- |
| Orca `stablyai/orca` (MIT) | `3941b73d` (earlier notes: `cbc8119e`) | 2026-11-18 |
| bb `get-bb/bb` (MIT) | `48c3a78` (app 0.49.0; Account Pooler added in 0.42.0) | 2026-11-18 |
| `agentclientprotocol/claude-agent-acp` | `96dd2bb` | 2026-11-18 |
| `agentclientprotocol/codex-acp` | `b9503ae` (package 2.7.0 per earlier notes) | 2026-11-17 |
| `openai/codex` (sparse: `docs`, `codex-rs/{login,cli,config,utils}`) | `ad5dd4a` | 2026-11-18 |
| ACP registry `agentclientprotocol/registry` (existing clone) | `df2ae8a` | 2026-11-17 |
| Anthropic: legal-and-compliance, authentication, cli-reference, env-vars, Consumer Terms (effective 2025-10-08) | fetched | 2026-11-18 |
| OpenAI: app-server, auth (learn.chatgpt.com); ToU mirror of 2024-12-11 (live page 403) | fetched | 2026-11-18 |
| Cursor: `docs/cli/reference/authentication`, `docs/cli/acp` | fetched, pages undated | 2026-11-18 |

Clones (read only, nothing installed or run): `/private/tmp/claude-501/-Users-bionic-WORK-My--kachurun-clowdy/3d1c8519-767b-480f-8ec2-cf732f8ec938/scratchpad/refs/accounts/{orca,bb,claude-agent-acp,codex-acp,codex}/`.

Key files read:

- Orca: `src/main/claude-accounts/{service,runtime-auth-service}.ts`, `.../sign-in/*`, `.../profiles/{claude-profile-paths,routing/claude-profile-router,setup/*}.ts`, `.../runtime-auth/{keychain,environment}.ts`, `.../selection/claude-account-selection.ts`; `src/main/codex-accounts/{service,login/*,managed-homes/*,runtime-home/**,credentials/*}`; `src/shared/shell/launch/agents/claude-shell-function.ts`; `src/main/rate-limits/providers/{claude,codex,cursor}/*`; `src/main/acp/launch/acp-account-binding.ts`; `docs/site/content/docs/agents/{codex-hot-swap,antigravity-accounts}.mdx`.
- bb: `plugins/provider-claude-code/src/bridge/{provider-maintenance,initialization-probe}.ts`, `plugins/provider-codex/src/{bridge/provider-maintenance,ai/codex-auth,ai/chatgpt-client}.ts`, `packages/provider-bridge-acp/src/bridge/provider-maintenance.ts`, `apps/app/src/components/onboarding/{useAgentSignIns.ts,onboarding-model.ts,OnboardingViews.tsx}`, `plugins/account-pool/{PLUGIN_OVERVIEW.md,skills/account-pool/**,src/{oauth-login,claude-adapter,codex-adapter,store,server}.ts}`, `plugins/bb-account/{PLUGIN_OVERVIEW.md,README.md}`.
- Adapters and Codex: `claude-agent-acp/src/{auth-methods,auth-status,paths}.ts`, `src/v1/acp-agent.ts` (authenticate); `codex-acp/src/{CodexAuthMethod,CodexAcpClient,AuthStatusMeta,CodexAccountLogin,login}.ts`; `codex-rs/login/src/{server.rs,auth/storage.rs}`, `codex-rs/cli/src/login.rs`, `codex-rs/config/src/types.rs`, `codex-rs/utils/home-dir/src/lib.rs`.
- Clowdy: see the first lines of `clowdy-fit.md`.

## Probe for the owner

Everything below can only be learned by running a command. None was run by me. Use a scratch directory so nothing touches your real login; the commands print metadata, not secrets. Stop before entering any password or approving a login you do not want.

1. **Claude status shape.** `claude auth status --json; echo "exit=$?"`, then `CLAUDE_CONFIG_DIR="$(mktemp -d)" claude auth status --json; echo "exit=$?"`, then `claude auth login --help`. Look at: the exact JSON fields (`loggedIn`, `authMethod`, `email`, `orgName`, `subscriptionType`, `planTier`, `configDirectory`), exit codes (0/1), whether `--claudeai` is listed.
2. **Claude link capture.** `printf '#!/bin/sh\nprintf "%%s\\n" "$1" > /tmp/claude-link.txt\n' > /tmp/cb.sh; chmod 700 /tmp/cb.sh; BROWSER=/tmp/cb.sh CLAUDE_CONFIG_DIR="$(mktemp -d)" claude auth login --claudeai`, then `cat /tmp/claude-link.txt`, then Ctrl-C. Look at: whether the script is called, whether the URL's `redirect_uri` is `http://localhost:<port>/...` (local callback), whether the terminal also prints a different `code=true` link, how long the callback server lives.
3. **Where credentials land (names only).** Before and after Probes 2, 5 and 6: `security dump-keychain 2>/dev/null | grep '"svce"' | grep -E 'Claude Code-credentials|Codex Auth|cursor-access-token'`. Look at: whether an item `Claude Code-credentials-<8 hex>` appears for a scratch `CLAUDE_CONFIG_DIR` and whether the suffix equals `printf %s "$DIR" | shasum -a 256 | cut -c1-8` for `$DIR` as typed or as `realpath "$DIR"` (on macOS `mktemp -d` returns a `/var/...` symlink of `/private/var/...`; Orca checks both spellings and the `~` and `$HOME` spellings too); whether `Codex Auth` or `cursor-access-token` items change. On Linux or Windows look for `<dir>/.credentials.json` instead. (`dump-keychain` without `-d` lists attributes only.)
4. **Codex status and store mode.** `codex login status; echo "exit=$?"`, `CODEX_HOME="$(mktemp -d)" codex login status; echo "exit=$?"`, and `grep -n cli_auth_credentials_store ~/.codex/config.toml`. Look at: the stderr line, exit codes, whether you use `file`, `keyring` or `auto`.
5. **Codex login prompts.** `CODEX_HOME="$(mktemp -d)" codex login` and, separately, `CODEX_HOME="$(mktemp -d)" codex login --device-auth`; copy the first lines. Look at: the "navigate to this url" line, the redirect port (1455 expected), the device-code layout; after a real login in a scratch home, whether `auth.json` exists in it (file mode) or only a keychain item (Probe 3).
6. **Cursor.** `cursor-agent status` (or `agent status`; note the exact output), then `NO_OPEN_BROWSER=1 CURSOR_CONFIG_DIR="$(mktemp -d)" cursor-agent login` (does it print a URL?), and after a login there, `CURSOR_CONFIG_DIR=<another scratch dir> cursor-agent status`. Look at: whether the login follows `CURSOR_CONFIG_DIR` or is global (Keychain item `cursor-access-token`, Probe 3), and what status prints (email, plan?).
7. **What the adapters advertise to Clowdy's client.** From `apps/daemon`: `bun run probe claude codex cursor`. Look at: the printed `authMethods` per agent (Clowdy sends no auth capability, so the Claude adapter should list none and the Codex adapter `api-key` and `chat-gpt`), and whether `agentCapabilities._meta.authStatus` exists (add a `console.log(init.agentCapabilities)` in a scratch copy of `probe.ts` if the probe does not print it).
8. **What the daemon sees.** Find the daemon pid (`ps -axo pid,command | grep '[d]aemon/src/main'`), then `ps eww -p <pid> | tr ' ' '\n' | grep -E '^(CLAUDE_CONFIG_DIR|CODEX_HOME|CURSOR_CONFIG_DIR)='`, and compare with `echo "$CLAUDE_CONFIG_DIR $CODEX_HOME"` in a terminal. Run it once for a daemon started from the Dock and once from a terminal. Look at: whether variables exported in shell files reach the daemon.
9. **Adapter under another home.** `CLAUDE_CONFIG_DIR="$(mktemp -d)" bun run probe claude` (from `apps/daemon`), then `CLAUDE_CONFIG_DIR=<same dir> claude auth status --json`. Look at: whether the adapter reports a signed-out state under the scratch home, and `configDirectory` in the status JSON (the variable should reach the CLI through the adapter). Repeat with `CODEX_HOME="$(mktemp -d)"` for `codex`.

## Open questions

- Whether any bb settings screen (not only onboarding) offers sign-in later; which bb feature calls the Codex ChatGPT client; the provenance of the Claude OAuth client id the pooler hard-codes.
- What Orca does for a Codex user whose store is `keyring` or `auto`, and which Claude call sites pass `stripAuthEnv`.
- Whether Cursor's login follows `CURSOR_CONFIG_DIR` (Probe 6).
- Whether a re-login or an account change affects a running adapter session (not checked).
- OpenAI's and Cursor's current terms (not read); Anthropic's Usage Policy and Commercial Terms (not read).
- The `claude auth status` object on the owner's installed version (Probe 1).

## Assumptions and coverage limits

- **Nothing was run.** No vendor CLI, adapter, daemon script or reference-project code was executed or installed; every behavior statement is from source and docs and labelled observed or inferred on the topic pages. No credential store (keychain, `~/.claude`, `~/.codex`, `~/.cursor`, `auth.json`, `.credentials.json`) was read and no vendor endpoint was called with a token.
- **Web pages** were summarized by a fetch tool, not saved verbatim; quoted sentences are as returned. The Claude env-vars page (192 k characters) was read in two parts; the OpenAI Terms of Use pages returned HTTP 403, so only a mirror of the 2024-12-11 version was read. Search-result pages (news and blogs about enforcement, multi-account tools) were not opened.
- **Not read:** Orca's mobile, cloud, remote-runtime (`orcad`) and WSL account variants beyond skimming, its Codex reset-credit code, most of the settings renderer; bb's `hub.ts` (1,600 lines), `server.ts` beyond the environment contributions, the Pi and OpenCode providers, `plugin-sdk` policy code; Cursor's CLI (closed source); the Gemini, Grok, Copilot, Hermes, omp adapters' auth code.
- **Orca and bb change daily.** Every citation carries its commit; Orca moved from `cbc8119e` to `3941b73d` between this note and the earlier ones.
- The Clowdy working tree has uncommitted changes (attachments, composer); none touch the agent registry files read here.

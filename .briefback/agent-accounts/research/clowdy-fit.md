# How each approach would fit Clowdy's architecture (facts, not a recommendation)

Snapshot 2026-11-18. Clowdy files read: `AGENTS.md`, `apps/daemon/AGENTS.md`, `apps/daemon/src/engine/acp/{catalog,registry,discovery,env,engine,session,probe,failure}.ts`, `packages/protocol/src/agents.ts`, `apps/desktop/src/renderer/features/settings/EnginePage.tsx`, `apps/desktop/src/main/{daemonHost,loginShell}.ts`, `apps/desktop/AGENTS.md` (Daemon section). Reference facts come from `orca-accounts.md`, `bb-accounts.md`, `vendor-multi-account.md`. No design, no recommendation. `[observed]` = read; `[inferred]` = my reading. Probe numbers refer to `index.md`.

## 1. What Clowdy has today (relevant to accounts)

| Piece | Fact |
| --- | --- |
| Agent catalog | `KNOWN_AGENTS` in `catalog.ts`: id, `programs`, launch (`binary` args or `package` adapter via `bun x --bun <pkg>@<pin>` with `pathEnv` pointing at the user's own program), `env`, `scrub`, `login` (text), `sessionMeta`. Claude: `login: 'claude auth login'`, scrub `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`; Codex: `login: 'codex login'`, scrub `OPENAI_API_KEY`, `CODEX_API_KEY`; Cursor: `login: 'cursor-agent login'` (no scrub). **[observed]** |
| Per-agent user overrides | `<dataDir>/agents.json` (mode 0600): `agents` (custom) and `overrides[id] = { enabled?, path?, env? }`. `env` is applied last in `AgentRegistry.build()`; so `CLAUDE_CONFIG_DIR` or `CODEX_HOME` can already be set per agent id by hand. Overrides are per agent id, not per account, chat or run. **[observed]** |
| Detection | `Discovery`: login shell's `PATH`, the daemon's, usual install dirs; `version()` runs `<program> --version` with `buildAgentEnv({ daemonEnv, path })` (no agent overrides, no scrub). `AgentRegistry.list()` caches 30 s; `GET /v1/agents` returns `AgentInfo` (`status`, `version`, `path`, `launch`, `login`, `enabled`); commands `agent.add|update|remove`, `agents.refresh`; event `agents.changed`. **[observed]** |
| Identity / usage / limits | None. `AgentInfo` has no account, plan or usage field. The Settings "Engine" page prints one sentence: "Engines and accounts are part of the daemon's configuration, so there is nothing to connect here yet." **[observed]** |
| Sign-in failure | `engine/acp/failure.ts` maps JSON-RPC -32000, `authentication_failed`, sign-in wording and HTTP 401 to code `not_logged_in` with "<agent> is not signed in. Run `<login>` in a terminal, then start again." **[observed]** |
| ACP client capabilities | `initialize` sends `fs.readTextFile=false, writeTextFile=false, terminal=false`; no `auth` block, no elicitation (`session.ts:289`, `probe.ts:65`). Nothing consumes `_auth/status_update` or `auth/status`. **[observed]** |
| Environment of agents | `buildAgentEnv`: the daemon's environment minus `CLOWDY_*`, `ELECTRON_*`, `NODE_OPTIONS`, `CLAUDECODE`, `CLAUDE_CODE_{ENTRYPOINT,SSE_PORT,EXECPATH}`, `CLAUDE_AGENT_SDK_*`, the agent's `scrub`; `PATH` replaced by the login-shell path; then `spec.env`, overrides. "Home folder, keychain access, proxies, the agent's own config variables all pass". **[observed]** |
| Daemon lifecycle | A Bun process started detached by the desktop app (`spawn(..., { detached: true })`, `unref()`), survives the app, one per data folder (lock), loopback HTTP + SSE with a bearer token. The desktop takes only `PATH` from the login shell (`loginShell.ts`, `Discovery.readLoginPath`); other variables exported in shell startup files are not read. **[observed]** |
| Runs, chats, projects | A chat has one orchestrator run for life; child runs per task; every run turn is one engine session = one adapter process (own process group), resumed by session id (`resumeSessionId`: `session/resume`, else `load`, else new). After a usage-limit pause runs "continue the same session". Limits and pauses are tracked per **engine id** (`EngineLimits`, `engine_pauses`), caps per engine (`CLOWDY_MAX_RUNS_CLAUDE=6`, `_CODEX=4`, `_AGENT=4`). **[observed]** |
| What the Claude run loads | The adapter "loads the user's own settings (`~/.claude` hooks, plugins, MCP servers, CLAUDE.md, the project's and the local ones), as a terminal would" (daemon `AGENTS.md`). Skills for Clowdy's tools are delivered as text, user skills are found by the agent itself. **[observed]** |

## 2. Option (a): system default only; show who is signed in; print the vendor's login command

### What the daemon would have to do

1. **Read the signed-in identity per agent without holding a token.** The routes the references and vendors expose:
   - Claude: `claude auth status --json` (spawn the user's `claude`; exit 1 when logged out, still JSON; fields `loggedIn`, `authMethod`, `apiProvider`, `apiKeySource`, `email`, `orgName`, `subscriptionType`, `planTier`, `configDirectory` on v2.1.268+). Or the adapter's `_auth/status_update` / `auth/status` on an ACP connection. Orca instead reads `.claude.json` `oauthAccount` from the config dir; bb uses the Agent SDK's account info. **[observed]**
   - Codex: `codex login status` says only the mode (stderr, no email). Email and plan are in `auth.json` (`id_token` claims; what Orca and bb read) or in `codex app-server` `account/read`; the Codex adapter pushes `_auth/status_update` from `account/updated`. In keyring mode `auth.json` does not exist. **[observed]**
   - Cursor: `cursor-agent status` is documented to show authentication state and account information, output unverified (Probe 6); Orca and bb read `cli-config.json`, the macOS Keychain item and the IDE's state DB; bb's email comes from the IDE, not the CLI. **[observed]**
2. **Run those reads with the same environment a run would use.** Today the version probe does not (it omits agent overrides and scrub), and the registry cache is 30 s. An identity read that ignores a `CLAUDE_CONFIG_DIR` or `CODEX_HOME` set through `agents.json` would show another account than the run uses. **[observed gap]**
3. **Expose it**: a new field on `AgentInfo` (or a new route) plus the existing `agents.changed` event; the Providers screen reads it. Printing the login command already exists (`AgentInfo.login`, catalog text).
4. **Decide freshness**: the adapters push on change; a CLI probe needs polling or a trigger (bb polls provider health every 3 s only while a sign-in is open).

### What could break or is unknown

- **Environment mismatch.** The daemon is started by the desktop app, possibly from the Dock with launchd's environment; only `PATH` is recovered from the login shell. A `CLAUDE_CONFIG_DIR`, `CODEX_HOME` or API key exported in `~/.zshrc` is invisible to the daemon, so an identity read and a run would use the **default** home while the user's terminal `claude` uses another. Orca hit the same case and resolves the login-shell environment for it ("Dock launches lack CLAUDE_CONFIG_DIR exported by shell startup files", `claude-profile-router.ts@3941b73d`). **[observed in code; consequence inferred; Probe 8]**
- **Several auth modes.** `authMethod` can be `claude.ai`, `oauth_token`, `api_key`, `api_key_helper` or `third_party`; Codex can be ChatGPT, API key, workload identity and others; "who is signed in" may have no email and a different billing. **[observed]**
- **CLI output drift**: `configDirectory` appeared in v2.1.268; Codex status text is prose on stderr; Cursor's format is undocumented. **[observed]**
- **Cost of a probe**: an ACP-based probe starts `bun x --bun <adapter>` (network on first use) plus the vendor process; the CLI probe is one short process (the Claude adapter caps it at 5 s). **[observed / inferred]**
- Reading `auth.json` or a Keychain item puts the daemon in the position Orca and bb are in for Codex and Cursor (reading another program's credential store). Reading only status output does not. **[observed]**

## 3. Option (b): (a) plus the app runs the vendor login for the user (link capture), still one account

### What the daemon would have to do

1. **Start the vendor's login command as a child** (`claude auth login --claudeai`, `codex login` or `codex login --device-auth`, `cursor-agent login`; with `NO_OPEN_BROWSER=1` Cursor prints the URL), in its own process group (the daemon already has `spawnInOwnGroup`), with the same environment as a run.
2. **Capture the link or code.** Two patterns exist in the references:
   - Parse stdout/stderr: Codex ("navigate to this url to authenticate:" on `auth.openai.com`; device code `XXXX-XXXX`), bb's generic parser (last OSC-8 link or first https URL, user code, "paste code" prompt).
   - Claude: set `BROWSER` to a helper script that writes `$1` to a file (Orca), because Claude "discards BROWSER stdout"; or use the pasted-code flow (printed link with `code=true`, write the code to stdin).
3. **Deliver link and code to the desktop** over the existing SSE feed or a new command/stream, **open or copy** it in the app, accept a pasted code, support cancel.
4. **Detect completion**: process exit 0, then re-read identity (bb polls health every 3 s; Orca checks credential bytes or `.claude.json`).
5. **Survive the app**: the daemon outlives the app, so a login child can outlive a closed window; a timeout and cleanup are needed (Orca: Claude 600 s, Codex 180 s, device 15 min). **[inferred from lifecycle facts]**
6. **Alternative through ACP** rather than the CLI: add `auth` capabilities to `initialize` so the adapters offer methods (Claude: terminal methods that run `claude-agent-acp --cli auth login ...` in a terminal the client provides, which needs `terminal` support; Codex: `authenticate("chat-gpt")` where the adapter itself calls `open(authUrl)`, or `chat-gpt-device-code` with a URL elicitation the client must render; Cursor: `authenticate("cursor_login")`, which "opens a browser and waits" per Orca's spec comment). Clowdy's client advertises none of these today. **[observed]**

### What could break or is unknown

- **Local callback.** Claude's copy-link flow and Codex's browser flow use a callback on `localhost`/`127.0.0.1` (Codex `127.0.0.1:1455`); the browser must be on the daemon's machine. Pasted-code (Claude) and device code (Codex) work from another device. A second Codex login on the same machine sends `GET /cancel` to the first. **[observed]**
- **Windows.** Orca cannot capture Claude's link on a native Windows host (no shell script for `BROWSER`) and runs the Codex login in a visible console that reads paste/device prompts; Clowdy lists Windows as a target. **[observed in Orca; Clowdy Windows behavior unchecked, as in the daemon notes]**
- **A login rewrites the default credential while runs are active.** The vendor writes its own store; whether a running adapter session keeps working across a re-login of the same account, or an account change, was not checked. **[open]**
- **Output-format dependence** of link capture (strings like "navigate to this url to authenticate:" and URL hosts are parsed by both references and have changed over time per their code comments).
- **Stray API keys** (`ANTHROPIC_API_KEY` etc.) in the environment change which credential wins even after a successful login (Claude's precedence list); Clowdy already scrubs them for the Claude and Codex agents. **[observed]**
- **Single account only**: with one default home there is one login per vendor, so signing in as another account replaces the first; the app holds nothing to restore it. **[inferred from "Each directory has its own ... login" in the Anthropic docs and the `logout` descriptions]**

## 4. Option (c): managed accounts with per-account config dirs, as Orca does

### What the daemon would have to do

1. **Own an account store** under the daemon data dir (for example one folder per account, mode 0700), with metadata (id, provider, email, organization, path) in SQLite or `agents.json`, and delete the vendor's keychain items on removal (Claude: service `Claude Code-credentials-<hash>`; Codex keyring: service `Codex Auth`, key `cli|<hash>`). **[observed in references; the hash rules are version-specific]**
2. **Run the vendor login per account** with `CLAUDE_CONFIG_DIR` / `CODEX_HOME` set to the account folder (option (b) mechanics, once per account), serialized (Orca queues all account mutations; Codex's login port is exclusive).
3. **Read the identity of each folder** (Claude: the folder's `.claude.json` `oauthAccount`; Codex: `auth.json` JWT; unknown for keyring mode), detect duplicates, mark "needs sign-in".
4. **Choose and bind an account**: a selection state (global, per project, per chat or per run), injected as an environment variable when the engine session is spawned. Today `AgentRegistry.resolve(id)` takes only an agent id and per-agent `env` is the only per-launch input, so an account would have to be added to that path (`registry.build` → `AcpSession` → spawn). Orca pins the resolved home when a chat session is created. **[observed]**
5. **Make history survive an account change.** Claude keeps transcripts under `<CLAUDE_CONFIG_DIR>/projects` and Codex under `<CODEX_HOME>/sessions`; Clowdy resumes a chat's session by id every turn (and after limit pauses). A new account folder does not contain those files unless they are linked or copied; Orca symlinks `projects`, `session-env`, `file-history`, `todos`, `plans`, ... into the default home for Claude and links Codex sessions across homes (setting default on). **[observed]**
6. **Provision each folder.** A fresh `CLAUDE_CONFIG_DIR` has none of the user's settings, hooks, plugins, skills, MCP servers, CLAUDE.md; Clowdy's Claude runs rely on those being loaded (daemon notes). Orca links or copies a long list from the default home, merges `settings.json` by digest and `.claude.json` by a key whitelist, and for Codex mirrors `config.toml` and links skills, hooks, plugins, prompts. About 4,700 non-test lines for Claude and 7,900 for Codex in Orca (the Codex figure includes a WSL migration module). **[observed]**
7. **Handle running work on a switch**: running sessions keep their env; Orca asks whether to restart them (Ask / Always restart / Never restart). Clowdy runs are daemon-owned and unattended; a pause-and-continue cycle would resume under whatever account is selected at spawn unless the run keeps its own pin. **[inferred]**
8. **Limits per account.** `EngineLimits`, `engine_pauses` and caps are per engine id; a usage-limit rejection on one account would pause the whole engine (`rejected` pauses the engine until `resetsAt`) and the scheduler would not know another account is free. **[observed per-engine design; consequence inferred]**
9. **Cursor**: unknown whether the CLI login follows `CURSOR_CONFIG_DIR` (Probe 6); Orca offers no managed Cursor accounts and pins the variable only to record the session's home.

### What could break or is unknown

- **Wrong-account starts.** Orca's code carries repeated guards against it ("Why a refusal, not a drop: a dropped home would start the agent under another account", never fall back from a missing account folder to System default, ownership markers, "Refuse launch without switching accounts behind a UI that still shows this selection"). **[observed]**
- **Vendor storage drift**: Keychain naming "Claude 2.1+", `.claude.json` identity fields, `auth.json` claim names, store mode (`file`/`keyring`/`auto`), keyring key from the path hash; each is an internal detail the reference code tracks by version. **[observed]**
- **Shared state fights**: Orca excludes `sessions` (live-process registry) from sharing for a reason; skills and plugins symlinked from the default home mean an account folder is not self-contained. **[observed]**
- **Removing an account in use**: Orca's message "Quit any Claude running in this account, then remove it again." **[observed]**
- **Manual path that exists now**: a user can set `agents.json` `env` per agent, or add a custom agent entry with its own `env` (for example a second Claude adapter entry with `CLAUDE_CONFIG_DIR`), without any product support; none of the provisioning, login or identity work above would exist. **[inferred from `registry.ts`]**
- **Policy surface** differs by sub-variant: per-dir folders keep tokens in the vendor's store; an app-held login plus proxy is the bb Account Pooler pattern. See `policy-facts.md` for the quoted conditions; nothing here assesses them.

## 5. Per-agent summary of what each option needs

| | (a) show + print login | (b) + run vendor login | (c) per-account dirs |
| --- | --- | --- | --- |
| Claude Code | `claude auth status --json` or adapter push; command text exists | `claude auth login --claudeai` with `BROWSER` helper or pasted code; no link capture on native Windows (Orca); adapter terminal methods need client `auth.terminal` | `CLAUDE_CONFIG_DIR` per account (vendor-documented); Keychain item per dir; provisioning and history linking |
| Codex | `auth.json` claims or app-server `account/read` (status command has no email); keyring case unreadable | `codex login` (127.0.0.1:1455) or `--device-auth`; adapter `authenticate(chat-gpt)` opens the browser itself, device code needs URL elicitation | `CODEX_HOME` per account (documented only as the `auth.json` location; source keys keyring by path); history and config mirroring |
| Cursor | `cursor-agent status` (format unknown) or file/Keychain reads | `cursor-agent login`, `NO_OPEN_BROWSER=1` prints URL; ACP `authenticate(cursor_login)` | not shown by any reference; whether `CURSOR_CONFIG_DIR` isolates the login is open |

## Open questions

- Which of the identity routes works without a token read on the owner's three installed agents (Probes 1, 4, 6).
- Whether a daemon started from the Dock sees `CLAUDE_CONFIG_DIR`, `CODEX_HOME` or `ANTHROPIC_API_KEY` from the owner's shell files (Probe 8).
- Whether the ACP adapters behave when started with a different `CLAUDE_CONFIG_DIR` / `CODEX_HOME` than the default (session files, `session/resume` of a chat made under another home) (Probe 9).
- Whether `bun x --bun` adapters keep working as login helpers (the daemon notes say whether adapters run under Bun "is not checked").

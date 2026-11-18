# Terms and risk facts per approach

Snapshot 2026-11-18. Facts and quotes with URLs and dates only; no legal judgment, no verdict on any product. This page extends `.briefback/acp/research/policy.md` (2026-11-17), whose Anthropic and OpenAI quotes I re-fetched today and found unchanged. Web pages were summarized by a fetch tool; quoted sentences are as it returned them. Where a page could not be fetched that is said. `[observed]` = read; `[inferred]` = my reading.

## 1. What the primary sources say

### Anthropic

- https://code.claude.com/docs/en/legal-and-compliance (fetched 2026-11-18, undated page), "Usage policy / Acceptable use": "Advertised usage limits for Pro, Max, and Ultra plans assume ordinary, individual usage of Claude Code and the Agent SDK."
- Same page, "Authentication and credential use":
  - "OAuth authentication is intended exclusively for purchasers of Claude Free, Pro, Max, Ultra, Team, and Enterprise subscription plans and is designed to support ordinary use of Claude Code and other native Anthropic applications."
  - "Developers building products or services that interact with Claude's capabilities, including those using the Agent SDK, should use API key authentication through Claude Console or a supported cloud provider. Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, Max, or Ultra plan credentials on behalf of their users. Moreover, developers may not collect, store, or intermediate Claude.ai credentials or session tokens — sign-in to a Claude account must complete through Anthropic's own flow."
  - "Nor does it prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription, including where a platform hosts Claude Code as described under *Can customers offer Claude Code in their products?* above."
  - "Anthropic reserves the right to take measures to enforce these restrictions and may do so without prior notice."
- Same page, "Can customers offer Claude Code in their products?": "The Claude Code binary must not be modified. Claude Code must be installed and run as published by Anthropic, and customers may not remove, disable, or restrict any authentication method built into it (including methods that permit signing in with a Claude account or the user's own API key)." "Customers may not pay for, resell, or intermediate Claude usage on their end users' behalf. Each end user must authenticate with their own Anthropic API key, Claude subscription plan credentials, or 3P inference provider credential."
- https://code.claude.com/docs/en/authentication (fetched 2026-11-18), "Log in with multiple accounts": "To stay signed in to multiple accounts at once, such as work and personal accounts, give each account its own configuration directory." (the vendor's own documentation of several accounts; no limit on their number or purpose is stated on the page).
- https://www.anthropic.com/legal/consumer-terms (Consumer Terms of Service, effective Oct 8, 2025, fetched 2026-11-18). Section 2, "Your Anthropic Account": "You may not share your Account login information, Anthropic API key, or Account credentials with anyone else." "You also may not make your Account available to anyone else." Section 3, "Use of our Services", item 7: "Except when you are accessing our Services via an Anthropic API Key or where we otherwise explicitly permit it, to access the Services through automated or non-human means, whether through a bot, script, or otherwise." Also in section 3: "bypassing any of our systems or protective measures" and "or resell the Services". The page has no sentence on multiple accounts or on circumventing usage limits, and none on Claude Code or the Agent SDK. The summary tool noted the Commercial Terms govern "any Anthropic API key, the Anthropic Console, or any other Anthropic offerings that reference the Commercial Terms of Service."
- https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan (fetched 2026-11-17, in `policy.md`): "Jun 15, 2026: We've paused the previously-announced changes to Claude Agent SDK usage"; "Oct 7, 2026: ... the Claude Agent SDK and `claude -p` still draw from your subscription limits". Not re-fetched today.
- Claude Code docs on hosts (env-vars page, 2026-11-18): `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST` "Set by host platforms that embed Claude Code and manage model provider routing on its behalf"; `ANTHROPIC_BASE_URL` "As of v2.1.196, Remote Control is disabled when this points at a host other than `api.anthropic.com`"; `claude setup-token` token "can only make model requests".
- Search results about enforcement, titles only, pages not read: The Register 2026-02-20 "Anthropic: No, absolutely not, you may not use third-party harnesses with Claude subs"; AlternativeTo 2026-02 "Anthropic officially bans using subscription authentication for third-party Claude use"; several 2026-04 posts about the April 4 enforcement. One secondary summary says the Claude Code legal page was updated on 2026-02-19. A search for an Anthropic statement on account pooling or several Max subscriptions found none (2026-11-18). **[secondary, unverified]**

### OpenAI

- https://learn.chatgpt.com/docs/app-server (redirect target of developers.openai.com/codex/app-server; fetched 2026-11-18, undated): "If you've built a local or open-source application using Codex app-server authentication, you can continue using it" ... "though we recommend migrating to Sign in with ChatGPT so users have greater control over and visibility into their usage." "App-server authentication has never been permitted for commercial or hosted services." "We launched Sign in with ChatGPT to support these use cases". The `chatgptAuthTokens` mode is "intended for host apps that already own the user's ChatGPT auth lifecycle."
- https://learn.chatgpt.com/docs/auth (fetched 2026-11-18, undated): "Treat `~/.codex/auth.json` like a password: it contains access tokens." "Don't commit it, paste it into tickets, or share it in chat." It documents copying `auth.json` to a headless machine you own. "API keys are still the recommended default for automation." "Access tokens are intended for trusted scripts, schedulers, and private CI runners." No multi-account section.
- OpenAI Terms of Use: the live pages `openai.com/policies/terms-of-use/` and `.../row-terms-of-use/` returned HTTP 403 to the fetch tool, so **the current text was not read**. A mirror of the 2024-12-11 version (open.windriver.com/info/uni-license-list/licenses/openai-tou-20241211.html) gives, under "Registration": "You may not share your account credentials or make your account available to anyone else" and, under "What you cannot do": "Automatically or programmatically extract data or Output" and "circumvent any rate limits or restrictions or bypass any protective measures or safety mitigations". Treat these as a possibly outdated copy. A search (2026-11-18) did not surface an OpenAI statement on rotating several ChatGPT accounts for Codex; community threads and open-source plugins that do so exist (secondary, not read in full).

### Cursor

- https://cursor.com/docs/cli/acp (2026-11-18): "ACP is intended for building custom clients and integrations." https://cursor.com/docs/cli/reference/authentication: API keys are "recommended" for scripts and CI; `agent logout` "clear[s] stored authentication". No statement on several accounts. The Cursor Terms of Service were not fetched (the ACP registry points its license URL at https://cursor.com/terms-of-service).

### Other agents

Not researched (Gemini, OpenCode, Pi, Grok, Copilot, Hermes, omp): see `policy.md`.

## 2. What each reference product says about itself

- Orca docs (`docs/site/content/docs/agents/codex-hot-swap.mdx@3941b73d`): "Running multiple Codex accounts to maximize tokens is common. Orca lets you add each account once and switch the active one in a click, with no config editing." "Usage still counts against each account's own plan; Orca does not pool quota across accounts." Cursor settings: "Orca only reads it — it never changes your Cursor login." Antigravity docs: "Saving several accounts does not give you parallel, isolated identities, and Orca does not pool quota across them."
- bb Account Pooler (`plugins/account-pool/PLUGIN_OVERVIEW.md@48c3a78`): "Accounts you own and are permitted to use this way." "Experimental: routing, storage, and CLI may change." "The pool does not enable extra usage, purchase credits, or change spending limits." Skill file: "The builtin Account Pooler plugin is disabled by default." "the pool therefore never copies this machine's Claude Code or Codex login".
- `claude-agent-acp` (`src/hide-claude-auth.ts@3205f0b`, from `policy.md`): "this integration must never bill a claude.ai subscription, except a Claude Enterprise plan".

## 3. How each approach handles credentials (facts, side by side)

Columns follow the quoted wording: who collects or stores a credential, who signs in, whether requests go through plan credentials held by the app.

| Approach | Who runs the sign-in | Credential stored by the app | Where tokens live | Model requests made by | Concrete cases |
| --- | --- | --- | --- | --- | --- |
| System default only (a) | the user, with the vendor's command in a terminal | none | the vendor's own store | the vendor binary (or the vendor's adapter around it) | Clowdy today; bb default |
| System default + app runs the vendor login (b) | the vendor CLI, started by the app | none (the CLI writes its own store; the app captures a link or code printed in output) | the vendor's own store | the vendor binary | bb onboarding; Orca's "Add Account" is the same mechanism, once per account |
| Per-account config dirs (c) | the vendor CLI, started by the app with `CLAUDE_CONFIG_DIR` / `CODEX_HOME` | metadata only (email, organization, folder path) | the vendor's store, keyed to the app-owned dir (Keychain item per directory, or file in it) | the vendor binary, started with that variable | Orca (Claude, Codex); the pattern Anthropic documents for work/personal |
| App-held OAuth login plus proxy | the app, through its own OAuth client (PKCE or device code) | yes: access and refresh tokens, plaintext JSON mode 0600 | the app's data dir | the app's hub, with the stored bearer token, on behalf of the agent | bb Account Pooler |
| Credential-store reads for usage | n/a (reads an existing login) | none persisted; reads token at poll time | the vendor's store | the app, calling vendor usage endpoints with the token | Orca (Claude `api/oauth/usage`, Codex `wham/usage`, Cursor dashboard API); bb (Codex `wham/usage`, Cursor dashboard API; Claude usage goes through the SDK and the binary) |
| Credential-store swap | the user, with the vendor's tool | yes: saved copies | the vendor's own store, overwritten on switch | the vendor binary | Orca for Antigravity; older Orca versions for Claude and Codex |

Source for the table rows: `orca-accounts.md`, `bb-accounts.md` in this folder. **[observed]**

Facts that bear on the quoted conditions:

- The Anthropic page names "collect, store, or intermediate Claude.ai credentials or session tokens" and "route requests through ... plan credentials". In rows a, b and c the app's code does not read, store or send the vendor's tokens: the vendor binary signs in, keeps the tokens and makes the requests. In the app-held-login row the app stores the tokens and its hub makes the upstream requests with them. In the usage-read row the app reads an existing token and sends it to a vendor endpoint. **[observed mechanics; no assessment]**
- The page's carve-out is for "an end user ... signing in to the unmodified Claude Code binary with their own Claude subscription". In rows a to c the vendor binary is the one signing in; in (c) several of those sign-ins exist at once, which the Claude Code docs describe as supported use of `CLAUDE_CONFIG_DIR`. Whether several subscriptions used to extend capacity fall under "ordinary, individual usage" is not addressed on any page read. **[observed absence]**
- OpenAI's `auth.json` guidance allows copying your own login to your own headless machine and says to treat it like a password; app-server authentication is stated to have never been permitted for commercial or hosted services. An ACP adapter for Codex runs the app-server (see `policy.md`). **[observed]**
- Third-party identification: Orca sends `User-Agent: claude-code/2.1.0` and `anthropic-beta: oauth-2025-04-20` when it reads Claude usage (`rate-limits/providers/claude/claude-oauth-usage-request.ts@3941b73d`). bb's pool forwards a filtered copy of the agent's headers (`user-agent` and `x-app` among them) with its own bearer token (`src/claude-adapter.ts@48c3a78`). bb's own Codex calls use `originator: bb`. **[observed]**
- Refresh tokens: bb states that "Anthropic and OpenAI refresh tokens are single use and rotate, so two programs holding one login sign each other out at the next refresh", and Orca keeps a separate Codex home per account for the reason "concurrent accounts cannot race one auth.json". I found no vendor page that says this; it is the references' own claim. **[observed claims, not verified]**

## 4. Facts about volatility

- The Claude subscription-in-third-party-tools rules changed several times in 2026 per `policy.md` (February docs wording, April enforcement reports, May Zed account of an announced Agent SDK credit pool, June 16 pause, October 7 support note). Anthropic's page says "Anthropic reserves the right to take measures to enforce these restrictions and may do so without prior notice." **[observed]**
- Claude Code's own storage and flags move: Keychain naming is "Claude 2.1+ config-scoped" (Orca comment), `claude auth status` gained `configDirectory` only in v2.1.268, the keyless Console sign-in "Requires Claude Code v2.1.242 or later" and "Claude Code stores that kind of sign-in outside the configuration directory". Codex's default credential store is `file` but `auto` and `keyring` exist, and the keyring key is derived from the path. **[observed]**

## 5. Not covered

- Cursor, Gemini, Grok, Copilot terms; OpenAI's current Terms of Use (403); Anthropic's Usage Policy page and Commercial Terms; export-control or regional rules; any contract the owner or users may have with a vendor.
- No vendor was contacted. No statement here says a product or approach is allowed or disallowed.

## Sources

- https://code.claude.com/docs/en/legal-and-compliance, https://code.claude.com/docs/en/authentication, https://code.claude.com/docs/en/cli-reference, https://code.claude.com/docs/en/env-vars (all fetched 2026-11-18)
- https://www.anthropic.com/legal/consumer-terms (effective Oct 8, 2025; fetched 2026-11-18)
- https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan (2026-11-17)
- https://learn.chatgpt.com/docs/app-server, https://learn.chatgpt.com/docs/auth (fetched 2026-11-18)
- https://open.windriver.com/info/uni-license-list/licenses/openai-tou-20241211.html (mirror of the 2024-12-11 OpenAI Terms of Use, fetched 2026-11-18; the live OpenAI pages returned 403)
- https://cursor.com/docs/cli/acp, https://cursor.com/docs/cli/reference/authentication (fetched 2026-11-18)
- Search result titles (2026-11-18, pages not read): https://www.theregister.com/2026/02/20/anthropic_clarifies_ban_third_party_claude_access, https://alternativeto.net/news/2026/2/anthropic-officially-bans-using-subscription-authentication-for-third-party-claude-use
- Orca `3941b73d`, bb `48c3a78`, `claude-agent-acp` `96dd2bb`, `codex-acp` `b9503ae`, `openai/codex` `ad5dd4a`, files named inline.

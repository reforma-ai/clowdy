# Subscription login and terms: does going through ACP change the picture

Snapshot 2026-11-17. This page reports what primary sources say and what the code does. It is not legal advice and gives no verdict. Existing Clowdy note: `.briefback/mvp/research/claude-agent-sdk.md` (section 1, dated 2026-11-17) and `.briefback/mvp/research/codex-sdk.md`. I re-fetched the three Anthropic pages and the OpenAI app-server page on 2026-11-17; the pages carry no revision dates except where stated.

## Summary

- **The Claude ACP adapter is a wrapper over the Claude Agent SDK, which runs a real `claude` binary.** By default that binary is the one the SDK package ships (about 350 MB, platform package); with `CLAUDE_CODE_EXECUTABLE` it is the user's installed `claude`. So subscription traffic through the adapter is Agent-SDK-class traffic from a third-party client, the same category as Clowdy's current engine. Nothing I read from Anthropic treats ACP as a separate category.
- **Anthropic's pages do not mention ACP.** The legal-and-compliance page and the Agent SDK plan support article say nothing about ACP, Zed or editors. The only primary statement tying ACP to subscription billing is a Zed blog post (2026-05-14, updated 2026-06-16) describing a planned Anthropic billing split that was then paused.
- **The Zed/JetBrains-maintained Claude adapter ships a switch that refuses subscription billing.** `--hide-claude-auth` makes the adapter "never bill a claude.ai subscription, except a Claude Enterprise plan" (`src/hide-claude-auth.ts`). It is opt-in, not the default. It shows that integrators embedding the adapter treat subscription use as something they may need to disable.
- **Codex:** OpenAI's app-server page states "App-server authentication has never been permitted for commercial or hosted services." The Codex ACP adapter drives `codex app-server`, so the same sentence applies to its ChatGPT-login path. No OpenAI page I read mentions ACP.
- **Other agents (Cursor, OpenCode, Gemini CLI, Pi, Grok...)**: their ACP modes are the vendor's own binary on the user's machine (native `acp` subcommands) or a thin adapter around the user's installed CLI (Pi). I found no subscription-terms text about third-party ACP clients for any of them. Cursor documents ACP as "for building custom clients and integrations".

## Claude (Anthropic)

### What the primary sources say (re-read 2026-11-17)

- https://code.claude.com/docs/en/legal-and-compliance ("Authentication and credential use"): "Advertised usage limits for Pro, Max, and Ultra plans assume ordinary, individual usage of Claude Code and the Agent SDK." "**Developers** building products or services that interact with Claude's capabilities, including those using the Agent SDK, should use API key authentication through Claude Console or a supported cloud provider. Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, Max, or Ultra plan credentials on behalf of their users. Moreover, developers may not collect, store, or intermediate Claude.ai credentials or session tokens — sign-in to a Claude account must complete through Anthropic's own flow." The same section's carve-out: this "does not prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription, including where a platform hosts Claude Code". "Anthropic reserves the right to take measures to enforce these restrictions and may do so without prior notice."
- Same page, "Can customers offer Claude Code in their products?": the binary "must not be modified", customers "may not pay for, resell, or intermediate Claude usage on their end users' behalf", and "Each end user must authenticate with their own Anthropic API key, Claude subscription plan credentials, or 3P inference provider credential". Naming: you may say your product "runs Claude Code" in plain text but not use the name or logo as part of your product name.
- https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan: update notes "Jun 15, 2026: We've paused the previously-announced changes to Claude Agent SDK usage" and "Oct 7, 2026: ... the Claude Agent SDK and `claude -p` still draw from your subscription limits" (also: Max, Ultra and Team plans now include monthly API credits). The article does not mention ACP or third-party apps beyond the June note ("third-party app usage still draw from your subscription limits").
- https://zed.dev/blog/anthropic-subscription-changes (published 2026-05-14, by Zed): reports Anthropic's plan to split subscription billing on June 15 into first-party tools versus third-party agents/SDK ("including ACP, `claude -p`") with a separate monthly "Agent SDK credit" ($20 Pro, $100 Max 5x, $200 Max 20x); "Update, June 16, 2026": Anthropic told subscribers the change "is not taking effect yet", ACP, `claude -p`, the Agent SDK and third-party Agent SDK apps "continue to work with subscriptions as before", and Anthropic "will give advance notice before any future change". This is Zed's account, not an Anthropic page.
- https://code.claude.com/docs/en/authentication and the earlier notes: credential precedence (a stray `ANTHROPIC_API_KEY` switches billing off the subscription), `claude setup-token`, history of volatility in 2026 (Feb docs wording, April enforcement against third-party harnesses, May credit-pool announcement, June pause). Not re-fetched today.

### What the adapter and its siblings do (observed in source)

- `claude-agent-acp` (`3205f0b`): `package.json` depends on `@anthropic-ai/claude-agent-sdk` 0.3.326; README: "implements an ACP agent by using the official Claude Agent SDK". Registry entry `claude-acp`: name "Claude Agent", authors "Anthropic, Zed Industries, JetBrains", license field `proprietary` (the adapter's own `LICENSE` is Apache-2.0).
- `src/hide-claude-auth.ts`: the flag `--hide-claude-auth` hides the claude.ai login method from `initialize` and refuses `auth_required` on every session and turn that a Free, Pro, Max or Team plan would pay for, judged from the SDK's `accountInfo()` (`subscriptionType`, `tokenSource`, `apiProvider`, `apiKeySource`). Its header comment: "this integration must never bill a claude.ai subscription, except a Claude Enterprise plan"; and "Anthropic allows an Enterprise plan in third-party integrations." The change log lists the original (#1079) and the Enterprise exception (#1641). Whether any shipped product runs the adapter with this flag was not established.
- The adapter advertises terminal login methods that make the **client** run the Claude CLI's own login (`src/auth-methods.ts`: `claude-ai-login` with args `--cli auth login --claudeai`, `console-login` with `--cli auth login --console`, and `claude /login` on remote machines). Credentials stay in the Claude CLI's store. The adapter learns who pays from the SDK's `accountInfo()` and a `claude auth status --json` probe, and reports it to clients through `_auth/status_update` (advertised as `agentCapabilities._meta.authStatus`) and the unstable ACP `auth/status` request (`src/auth-status.ts`). A search of its `src` for keychain, `credentials.json` and token reads found only a comment; I saw no code that reads or stores the OAuth token itself.
- bb (`f1c5304`): drives Claude through the SDK against the user's `claude`, reads only the CLI's own account/usage output for Claude (`provider-maintenance.ts`), documents `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) for machines without a login. FAQ copy: "Can I use my existing AI subscriptions with bb? Yes. bb runs the agents you already use, signed in the way you already pay for them: a Claude Pro or Max plan, a ChatGPT plan for Codex, a Cursor plan, API keys, or any other provider's plan" (`apps/web/src/compare/compare-content.tsx`, `FAQ_SUBSCRIPTIONS`).
- Orca (`cbc8119e`): reads the Claude OAuth access token from the keychain or `.credentials.json` and sends it as a Bearer to `https://api.anthropic.com/api/oauth/usage` (`src/main/rate-limits/providers/claude/claude-oauth-credentials.ts`, `claude-oauth-usage-request.ts`); runs `claude auth login` itself to manage several accounts (`src/main/claude-accounts/*`). Those are the behaviors the legal page's "collect, store, or intermediate Claude.ai credentials or session tokens" sentence is closest to; the existing Clowdy note files "pulling the OAuth token out of the Keychain" under paths to avoid. I make no judgement about whether Orca's usage read is within the terms.

### How the paths line up against the quoted conditions (facts only)

| Path | Binary | Who signs in | Clowdy touches credentials? |
| --- | --- | --- | --- |
| Current Clowdy engine | SDK-bundled `claude` (unmodified, per `claude-agent-sdk.md`) or `CLOWDY_CLAUDE_BIN` | the user, `claude auth login` | no (daemon env allowlist strips `ANTHROPIC_*`) |
| ACP adapter, default | the adapter package's SDK-bundled `claude`, or the `claude` shipped in the adapter's release archive | the user, via the CLI's own login | no, unless Clowdy reads account info through adapter extensions |
| ACP adapter with `CLAUDE_CODE_EXECUTABLE` | the user's installed `claude` | the user | no |
| bb / Orca usage reads | n/a | n/a | bb: no (CLI output). Orca: yes, reads the token to call the usage endpoint. |

The existing note's conclusion ("personal use on the user's own machine and login is what Anthropic's terms allow; shipping Clowdy to others with subscription login is not cleared") is unchanged by anything read here: the adapter does not change who the "developer" is or what is being routed, and the legal page's carve-out wording (unmodified binary, the end user's own sign-in) matches the `CLAUDE_CODE_EXECUTABLE` path at least as well as the bundled-binary path **[inference]**.

## Codex (OpenAI)

- https://learn.chatgpt.com/docs/app-server (redirected from developers.openai.com/codex/app-server; fetched 2026-11-17; page undated): "Use it when you want a deep integration inside your own product." Auth modes: `apiKey`, `chatgpt` ("Codex owns the ChatGPT OAuth flow, persists tokens, and refreshes them automatically"), and experimental `chatgptAuthTokens` "intended for host apps that already own the user's ChatGPT auth lifecycle" (needs `capabilities.experimentalApi = true`). "If you built a local or open-source application with app-server authentication, you can keep using it, but OpenAI recommends migrating to Sign in with ChatGPT." And: "**App-server authentication has never been permitted for commercial or hosted services.**" Rate limits: `account/rateLimits/read`, `account/rateLimits/updated` with `usedPercent`, `windowDurationMins`, `resetsAt`, `planType`, `credits`.
- https://learn.chatgpt.com/docs/auth (redirected from developers.openai.com/codex/auth; page undated): ChatGPT sign-in or API key; "Codex caches login details locally in a plaintext file at `~/.codex/auth.json` or in your OS-specific credential store"; access tokens "intended for trusted scripts, schedulers, and private CI runners"; "API keys are still the recommended default for automation." No text about third-party apps or ACP.
- The existing note `codex-sdk.md` records the Sign in with ChatGPT (SIWC) open-source track ("ChatGPT plan usage is available to all open-source partners and selected private clients") from OpenAI pages read earlier today; not re-fetched here.
- `codex-acp` (`b9503ae`): starts `codex app-server` from its bundled `@openai/codex` dependency or `CODEX_PATH`; offers ChatGPT login, API key, and a client-provided gateway. Orca additionally calls `https://chatgpt.com/backend-api/wham/usage` with Codex credentials (`src/main/rate-limits/providers/codex/*`).

## Other agents

- Cursor: the registry entry points the license URL at https://cursor.com/terms-of-service; the ACP page https://cursor.com/docs/cli/acp (fetched 2026-11-17) says ACP is "for building custom clients and integrations"; auth by `agent login` reuse, `CURSOR_API_KEY`, `CURSOR_AUTH_TOKEN`. No subscription-use clause was read.
- Gemini CLI: ACP mode doc (page updated 2026-04-10) notes Gemini CLI "was replaced by Antigravity CLI on June 18th, 2026" for unpaid-tier and Google One users. No terms read.
- OpenCode, Pi, Grok, Copilot, Hermes, omp, Kimi: license fields only (registry). OpenCode's own usage reader in bb reads its local database and credential file (`opencode-usage.ts`).

## What would change the picture

- An Anthropic or OpenAI statement naming ACP clients. None exists in the pages above.
- The June 2026 Anthropic billing split coming back: Zed reports "advance notice" will precede it; the support article's Oct 7 note still says SDK and `claude -p` draw from subscription limits.

## Sources

- https://code.claude.com/docs/en/legal-and-compliance (fetched 2026-11-17)
- https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan (fetched 2026-11-17; notes dated 2026-06-15 and 2026-10-07)
- https://zed.dev/blog/anthropic-subscription-changes (published 2026-05-14, updated 2026-06-16)
- https://learn.chatgpt.com/docs/app-server and https://learn.chatgpt.com/docs/auth (fetched 2026-11-17)
- https://cursor.com/docs/cli/acp; https://geminicli.com/docs/cli/acp-mode/ (page says updated 2026-04-10)
- claude-agent-acp `3205f0b`: `src/hide-claude-auth.ts`, `src/auth-methods.ts`, `README.md`, `CHANGELOG.md`; codex-acp `b9503ae`: `README.md`
- bb `f1c5304`: `apps/web/src/compare/compare-content.tsx`, `plugins/provider-claude-code/src/bridge/provider-maintenance.ts`; Orca `cbc8119e`: `src/main/rate-limits/providers/**`, `src/main/claude-accounts/**`
- `.briefback/mvp/research/claude-agent-sdk.md`, `.briefback/mvp/research/codex-sdk.md`

## Open questions

- Does any Anthropic page address third-party ACP clients or editors? A search on 2026-11-17 surfaced only the Zed post and community adapters, not an Anthropic statement.
- Who ships `--hide-claude-auth` and why (the flag history is in the adapter's changelog but the product context is not).
- Whether the adapter's default (SDK-bundled) binary counts as "the Claude Code binary ... as published by Anthropic" for the legal page's condition; the adapter release archives include their own copy of `claude`.

## Assumptions and limits

- Web pages were summarized by a fetch tool, not saved verbatim; quoted sentences are as the tool returned them and match the existing note where the two overlap. The OpenAI SIWC pages were not re-fetched.
- No agent was run; billing source was not observed.

# Claude Agent SDK (TypeScript) as Clowdy's Claude engine

Researched 2026-11-17. SDK `@anthropic-ai/claude-agent-sdk@0.3.325`, which bundles Claude Code `2.1.325` (build 2026-11-13). Smoke-tested on this machine with Bun 1.4.4.

## Verdict

- **Use it.** The daemon should run Claude agents through `query()` from `@anthropic-ai/claude-agent-sdk`. The smoke test ran on the user's **Claude Max login with no API key**: the init message reported `apiKeySource: "none"` and `accountInfo()` returned `subscriptionType: "Claude Max"`. Anthropic's help center says that SDK usage under plan sign-in draws from the subscription's limits.
- **Personal use is the supported path.** That means the user's own machine, their own login done through Anthropic's own flow (`claude auth login`), and the unmodified bundled binary. **Shipping Clowdy to other people with subscription login is not cleared.** It needs Anthropic's approval, or each user brings an API key or cloud credentials.
- **What scale costs:** each top-level agent is one native `claude` process, about 130 MB idle. To fan out wider, use in-process subagents (default cap: 20 running at once per session) or the `Workflow` tool. The subscription's rate limits will cap throughput before CPU or RAM do.

## Key facts

### 1. Subscription auth and policy (quoted from current pages)

- **How it works.** The SDK spawns its bundled `claude` binary. That binary reads the same credential store as the user's CLI: the macOS Keychain, or `~/.claude/.credentials.json` on Linux and `%USERPROFILE%\.claude\.credentials.json` on Windows. The smoke test needed no env var at all; the Max login was picked up automatically.
- **Credential precedence** (docs): cloud provider env vars, then `ANTHROPIC_AUTH_TOKEN`, then `ANTHROPIC_API_KEY`, then `apiKeyHelper`, then `CLAUDE_CODE_OAUTH_TOKEN`, then Anthropic profile, then **the subscription login from `/login`** (last). A stray `ANTHROPIC_API_KEY` in the daemon env silently switches billing to the API. Strip it, or make it an explicit setting.
- **`claude setup-token`** mints a "one-year OAuth token" for `CLAUDE_CODE_OAUTH_TOKEN`, meant "for CI pipelines and scripts where browser login isn't available". It "can only make model requests". `--bare` mode doesn't read it.
- **Usage policy** (legal-and-compliance page): *"Advertised usage limits for Pro, Max, and Ultra plans assume ordinary, individual usage of Claude Code and the Agent SDK."*
- **Developers** (same page): *"Developers building products or services that interact with Claude's capabilities, including those using the Agent SDK, should use API key authentication through Claude Console or a supported cloud provider. Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, Max, or Ultra plan credentials on behalf of their users. Moreover, developers may not collect, store, or intermediate Claude.ai credentials or session tokens — sign-in to a Claude account must complete through Anthropic's own flow."*
- **Carve-out** (same page): *"Nor does it prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription, including where a platform hosts Claude Code."* Its conditions: *"The Claude Code binary must not be modified"*, and *"Each end user must authenticate with their own Anthropic API key, Claude subscription plan credentials, or 3P inference provider credential."*
- **Enforcement:** *"Anthropic reserves the right to take measures to enforce these restrictions and may do so without prior notice."*
- **SDK overview note:** *"Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK."*
- **Help center**, "Use the Claude Agent SDK with your Claude plan" (updates dated Jun 15 and Oct 7, 2026): *"when you're signed in with your Claude plan, the Claude Agent SDK and `claude -p` still draw from your subscription limits"* and *"We've paused the previously-announced changes to Claude Agent SDK usage."* Max, Ultra and Team plans also get monthly API credits ($100 for Max, $200 for Ultra). Those credits cover the SDK only when it runs with an API key from the linked Console org.
- **Consumer Terms §3.7** bans automated access *"Except when you are accessing our Services via an Anthropic API Key or where we otherwise explicitly permit it"*. The help center article above is that explicit permission for the SDK under plan sign-in.
- **History** (shows how volatile this is):
  - Feb 2026: docs said plan OAuth was not allowed in the Agent SDK. Anthropic then called that a "docs clean up".
  - Apr 2026: enforcement against third-party harnesses (OpenClaw, OpenCode) that call the API with plan tokens.
  - May 2026: a separate SDK credit pool was announced.
  - Jun 15, 2026: that change was paused.
- **How this applies to Clowdy:**
  - **Personal tool (this machine, the user's own login): OK.** The supported, non-hacky path:
    1. The user runs `claude auth login` once.
    2. The daemon calls `query()` with the bundled, unmodified binary.
    3. Clowdy never reads, stores or proxies the token.
    4. A `CLAUDE_CODE_OAUTH_TOKEN` the user pastes into Clowdy's local config works too. It is acceptable for personal use, but it does mean "storing" a credential.
  - **Distributing Clowdy:** no Clowdy-owned claude.ai login UI and no token collection. The default should be an API key or Bedrock/Vertex. At most, Clowdy points users at Anthropic's own `claude auth login`. Get Anthropic's approval before advertising subscription support.
  - **The hacky path to avoid:** pulling the OAuth token out of the Keychain and calling `api.anthropic.com` directly, or wrapping it in another harness. That is exactly what got blocked in 2026.

### 2. Capabilities (verified in `sdk.d.ts` 0.3.325 and the docs)

- **Entry point:** `query({ prompt: string | AsyncIterable<SDKUserMessage>, options }) → Query`, an `AsyncGenerator<SDKMessage>`. `Query` methods:
  - control: `interrupt()`, `close()`, `stopTask(taskId)`, `streamInput()`, `setModel()`, `setPermissionMode()`, `applyFlagSettings()`
  - info: `accountInfo()`, `supportedModels()`, `supportedAgents()`, `mcpServerStatus()`, `getContextUsage()`
  - other: `rewindFiles()`, `setMcpServers()`
- **Message union (40 members).** The ones Clowdy needs:
  - `system/init` carries `apiKeySource`, `model`, `tools`, `mcp_servers`, `permissionMode`, `claude_code_version`, `capabilities` and `session_id`.
  - `assistant` wraps a Messages API `BetaMessage` (`text`, `thinking` and `tool_use` blocks) and carries `parent_tool_use_id`, `agent_id`, `uuid` and `session_id`.
  - `user` carries `tool_result` blocks.
  - `stream_event`: raw token deltas, only with `includePartialMessages: true`.
  - `result` has subtype `success`, or one of `error_during_execution`, `error_max_turns`, `error_max_budget_usd`, `error_max_structured_output_retries`. It carries `result`, `num_turns`, `total_cost_usd`, `usage` (main loop only), `modelUsage` (all calls, including subagents), `permission_denials` and `session_id`.
  - `rate_limit_event` carries `rate_limit_info.{status: allowed|allowed_warning|rejected, rateLimitType: five_hour|seven_day|…, utilization, resetsAt, errorCode: credits_required}`. Use it as the subscription quota signal.
  - Also: `system/task_started|task_progress|task_updated|task_notification`, `tool_progress`, `compact_boundary`, `api_retry`, `status` and `thinking_tokens`.
- **Tool events:** the model's `tool_use` arrives in `assistant.message.content`. The result comes back as a `user` message whose `tool_result` has `tool_use_id` equal to that `tool_use.id`.
- **Subagents:**
  - Define them with the `agents: Record<string, AgentDefinition>` option. Fields: `description`, `prompt`, `tools`, `disallowedTools`, `model`, `effort`, `maxTurns`, `background`, `permissionMode`, `mcpServers`, `skills` and `omitClaudeMd`.
  - The model invokes them through the **`Agent`** tool. The init `tools` list still shows it as `"Task"`, so match both names.
  - Messages from inside a subagent carry `parent_tool_use_id` (the `Agent` tool_use id) and `agent_id`, which equals the `task_id` of its `task_*` events.
  - **Only tool_use and tool_result blocks from subagents are forwarded by default.** Set `forwardSubagentText: true` for a full nested transcript, and `agentProgressSummaries: true` for one-line progress summaries.
  - Caps, set through `env`: `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` (default 3) and `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` (default 20; ultracode sessions are never refused). Spend cap: `maxBudgetUsd`.
  - Subagents run **inside the parent's process**. Verified: no extra OS process appeared during a subagent run.
- **Many agents in one session:** for "dozens to hundreds of agents", the docs point to the `Workflow` tool (TS SDK 0.3.149 or later), which is what ultracode drives. Ultracode turns on with `applyFlagSettings({ effortLevel: "ultracode" })` or the setting `"ultracode": true`.
- **Custom in-process tools:** `tool(name, desc, zodShape, handler, {annotations})` plus `createSdkMcpServer({name, version, tools})`, passed as `mcpServers: { clowdy: server }`. Tool names become `mcp__clowdy__<tool>`. The `zod` ^4 peer dependency is auto-installed by bun.
- **Permissions:**
  - Modes: `default | acceptEdits | bypassPermissions | plan | dontAsk | auto`. `bypassPermissions` also needs `allowDangerouslySkipPermissions: true`.
  - Evaluation order: hooks, then deny rules, then ask rules, then mode, then allow rules (`allowedTools`), then `canUseTool`.
  - `canUseTool(toolName, input, {signal, suggestions, decisionReason, blockedPath, …})` returns `{behavior:"allow", updatedInput?}` or `{behavior:"deny", message, interrupt?}`. It is **never called for auto-approved calls**. To audit every call, use a `PreToolUse` hook.
  - With CLI 2.1.302 or later, a run starts in `default` and denies anything that needs approval unless something approves it.
  - Subagents inherit `acceptEdits`, `auto` and `bypassPermissions` from the parent.
- **cwd** can be set per query (`cwd`), plus `additionalDirectories`. This is where Clowdy points each run at its own git worktree.
- **`settingSources`**: any of `'user' | 'project' | 'local'`; the default is all of them, and `[]` disables all three. Auto-memory loads regardless; turn it off with `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`.
- **Sessions:**
  - Options: `sessionId` (pick your own UUID), `resume`, `forkSession`, `continue`, `persistSession: false`, and `sessionStore` (adapter to mirror transcripts to shared storage).
  - Transcripts live at `~/.claude/projects/<cwd with non-alphanumerics replaced by '-'>/<id>.jsonl`.
  - Helpers: `listSessions()`, `getSessionMessages()`, `renameSession()` and `tagSession()`.
- **Cancellation:**
  - `abortController.abort()`: hard stop. The SDK closes stdin, waits about 2 s, then kills the process.
  - `q.interrupt()`: streaming mode only. The current turn ends with `error_during_execution` and the session stays alive.
  - `q.close()`: kills the process.
  - `q.stopTask(taskId)`: stops one subagent or background task.
  - There is no session timeout, so use `maxTurns`.
- **Streaming input:** pass an async generator of `{type:"user", message:{role:"user", content}, parent_tool_use_id:null, priority?:"now"|"next"|"later", uuid?}`. Follow-ups pushed mid-turn are folded in after the current tool calls finish. Each response ends with its own `result`. `interrupt`, `setModel` and `setPermissionMode` only work in this mode.
- **Usage and cost:**
  - `total_cost_usd` and `modelUsage[model].{inputTokens, outputTokens, cache*, costUSD, contextWindow}` are cumulative per `query()`. **Read the latest value; don't sum across results.**
  - Costs are estimates at **list price** (`costBasis: "list"`), even on a subscription. Show them as "API-equivalent cost" and use `rate_limit_event.utilization` for the real quota.
- **Models:**
  - `model` takes an alias or a full model ID. Aliases: `opus` (Opus 5.5), `sonnet` (Sonnet 5.5), `haiku` (Haiku 5.5), `fable` (Fable 5.2), `default`.
  - Can be changed per subagent through `AgentDefinition.model`, or mid-session with `setModel()`. `effort` ranges over `low…max`.

### 3. Process model and packaging

- **One process per agent:** each `query()` spawns one native `claude` binary and talks to it over stdio (docs: "One agent session maps to one subprocess"). Subagents add no process.
- **Measured on an M-series Mac (12 cores, 32 GB), with `settingSources: []` and no MCP servers:**

  | What | Result |
  |---|---|
  | 10 concurrent `startup()` warm-ups | all ready in about 0.84 s |
  | CPU during init | about 50% of one core per process, under 1 s |
  | CPU idle | about 2% per process |
  | RSS | 190–210 MB per process |
  | **Physical footprint** | **about 127–129 MB per process** (peak 145 MB) |
  | Cleanup | `close()` reaped all processes |

- **The docs' sizing guide:** start at "1 GiB RAM, 5 GiB disk, and 1 CPU per agent", and plan for memory to grow with session length.
- **What that means for Clowdy:**
  - A laptop handles about 10–30 live top-level agents, each of which can fan out to up to 20 subagents.
  - "1000 agents" has to mean subagents or workflow agents inside a few dozen processes, queued by a daemon scheduler, not 1000 OS processes.
  - The real ceiling is the plan's five-hour and seven-day windows, which are shared with the user's own interactive Claude use.
- **Runtime:**
  - The SDK is ESM, needs Node 18.14 or later, and works under Bun (verified). The CLI is a native binary, so it needs no Node.
  - `executable` and `executableArgs` (`bun|node|deno`) only matter for a JS CLI. `pathToClaudeCodeExecutable` overrides the binary; verified working with the user's installed `claude` 2.1.322.
  - `spawnClaudeCodeProcess` lets you run the binary in a VM or container.
- **Binary sizes** (from optional deps `@anthropic-ai/claude-agent-sdk-<platform>`):

  | Platform | Size |
  |---|---|
  | darwin-arm64 | 347 MB |
  | darwin-x64 | 362 MB |
  | win32-x64 | 372 MB |
  | win32-arm64 | 354 MB |

  The macOS binary is signed with Anthropic's Developer ID, uses the hardened runtime and is notarized. The Windows binary is signed "Anthropic, PBC".
- **Electron packaging, for a daemon that is a separate process:**
  - Ship the SDK plus one platform binary per build target, with the binary outside `asar` (`asarUnpack`). Pass its path through `pathToClaudeCodeExecutable`.
  - Make per-arch macOS builds. A universal build would carry about 710 MB of binaries.
  - Keep electron-builder from re-signing the binary (check `signIgnore`); the terms say the binary "must not be modified".
  - If the daemon is compiled with `bun build --compile`, embed the binary with `with { type: 'file' }` and use `extractFromBunfs()` from `@anthropic-ai/claude-agent-sdk/extract`.
  - The bundled binary is pinned to the SDK version. Using the user's installed CLI instead makes the app smaller but risks version skew.
- **Windows:** Git for Windows is optional. Without it, Claude Code uses its PowerShell tool instead of Bash. Bash sandboxing is not available on native Windows.

### 4. Smoke tests (scratchpad `research/claude-agent-sdk/`)

All runs used a clean environment: `env -i HOME PATH USER LANG` for the process, plus an explicit `env` option. Model: `haiku`. Total spend was about $0.006 at list price, across 6 tiny queries.

| Script | What it did | Messages received | Key output |
|---|---|---|---|
| `smoke.ts` "plain" | Sent "Reply with the word OK" with `tools: []` | `system/init`, `rate_limit_event`, `assistant`, `result/success` | `apiKeySource:"none"`; accountInfo `{subscriptionType:"Claude Max", apiProvider:"firstParty"}`; result `"OK"`, 1 turn, $0.00013, api 0.8 s |
| `smoke.ts` "mcp-tool" | Called an in-process `add` tool | init, `rate_limit_event`, `assistant`(tool_use), `user`(tool_result), `assistant`, `result/success` | init `tools:["mcp__smoke__add"]`, `mcp_servers:[{name:"smoke",status:"connected",source:"sdk"}]`; tool_use `{"a":2,"b":3}`, tool_result `"5"`, answer `"5"`, 2 turns, $0.0012 |
| `sub.ts` | Streaming input plus one `echo` subagent | init(`tools:["Task"]`), `assistant`(tool_use `Agent` with `subagent_type:"echo", run_in_background:false`), `system/task_started`, `user`(subagent prompt, `parent_tool_use_id`=Agent id, `agent_id`=task_id), `task_updated`(completed), `task_notification`, `user`(tool_result starting "[Subagent hand-back] …"), `thinking_tokens`, `assistant`, `result/success` | answer `"PONG"`, 2 turns, $0.0019; still a single `claude` process during the subagent |
| `procs.ts`, `foot.ts`, `ext.ts` | Ran 10× `startup()` and measured RAM; no model calls | — | numbers in section 3 |

## How to use it (code that ran)

```ts
import { query, tool, createSdkMcpServer, startup, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

// TS `env` REPLACES process.env. Build it explicitly. Never forward CLAUDECODE / CLAUDE_CODE_* / ANTHROPIC_API_KEY by accident.
const env = { HOME: process.env.HOME!, PATH: process.env.PATH!, USER: process.env.USER!, LANG: process.env.LANG ?? "en_US.UTF-8" };

// Clowdy-side tools the orchestrator can call (backed by the daemon DB)
const spawnRun = tool("spawn_run", "Start an executor run for tasks", { taskIds: z.array(z.string()), brief: z.string() },
  async ({ taskIds, brief }) => ({ content: [{ type: "text", text: await daemon.spawnRun(taskIds, brief) }] }));
const clowdy = createSdkMcpServer({ name: "clowdy", version: "0.1.0", tools: [spawnRun] });

// Long-lived agent run: streaming input; the run id doubles as the SDK session id
async function* inbox(runId: string): AsyncGenerator<SDKUserMessage> { /* yield {type:"user", message:{role:"user", content}, parent_tool_use_id:null} */ }
const q = query({
  prompt: inbox(runId),
  options: {
    env, cwd: worktreePath, sessionId: runId, model: "opus",
    settingSources: ["project"],                 // repo CLAUDE.md / .claude; [] for full isolation
    mcpServers: { clowdy }, allowedTools: ["mcp__clowdy__spawn_run", "Agent", "Read", "Grep", "Glob"],
    permissionMode: "acceptEdits",               // or "bypassPermissions" + allowDangerouslySkipPermissions: true inside a worktree
    agents: { executor: { description: "Implements one task", prompt: "...", model: "sonnet", maxTurns: 50 } },
    forwardSubagentText: true, agentProgressSummaries: true, includePartialMessages: true,
    maxBudgetUsd: 20, abortController,
  },
});
for await (const m of q) daemon.appendEvent(runId, m);   // key on m.uuid; nest by parent_tool_use_id / agent_id
// controls: q.interrupt(); q.setModel("haiku"); q.setPermissionMode("plan"); q.stopTask(taskId); q.close(); abortController.abort();
// quota:    m.type === "rate_limit_event" -> m.rate_limit_info.{status, utilization, rateLimitType, resetsAt}
// identity: await q.accountInfo()  -> { subscriptionType, apiProvider }   (call while the query is live)

// Pre-warm a pool so first-token latency stays low (no model call until .query())
const warm = await startup({ options: { env, cwd: worktreePath, settingSources: [] } });
const q2 = warm.query("Reply with the word OK");      // or warm.close()
```

How Clowdy's data model maps onto this:

| Clowdy concept | SDK concept |
|---|---|
| `AgentRun` | one `query()` = one process = one SDK session (`sessionId` = run id), with `cwd` = its worktree |
| Run ↔ task links (many-to-many) | rows in Clowdy's DB; the SDK knows nothing about tasks |
| Subagent work inside a run | `task_started` / `task_notification` events, keyed by `task_id` = `agent_id` |
| Linking subagent work to tasks | the orchestrator's custom MCP tools |

## Limits and risks

- **Policy risk is the biggest risk.**
  - "Ordinary, individual usage" and hundreds of parallel agents on one Max plan are in tension. Expect rate-limit `rejected` events. Enforcement is "without prior notice", and the rules changed four times in 2026.
  - Keep a provider setting (subscription, API key, or Bedrock/Vertex) so Clowdy can switch without code changes.
- **Quota sharing:** Clowdy's agents and the user's own Claude Code and claude.ai use draw from the same limits. The scheduler should throttle on `rate_limit_event` (`allowed_warning`, `utilization`).
- **Per-agent `CLAUDE_CONFIG_DIR` breaks login.** The Keychain entry is keyed to the config directory, so a different directory means "not logged in" (per the docs; not tested). Keep the default config dir, or use `CLAUDE_CODE_OAUTH_TOKEN`.
- **The user's `~/.claude` loads into every agent by default:** plugins, hooks, MCP servers and CLAUDE.md. That costs RAM and startup time, and hooks fire 100×. Choose `settingSources` deliberately.
- **Memory grows with session length**, and there is no wall-clock limit for a session or a subagent. Recycle long runs with `maxTurns`, or resume into a fresh process.
- **Version churn:** 0.3.x releases about daily (35 tested wrapper versions in one manifest), and `sdk.d.ts` is 600 KB. Pin the exact version and read the changelog before bumping.
- **Each run needs its own worktree.** Forking a session copies the conversation but not the files.
- **Size:** the binary adds about 350 MB per platform to the installer.
- **Branding:** "Claude Code" may not be used in the product name. "Powered by Claude" is allowed.

## Open questions (for briefback)

1. Is Clowdy personal-only for now? If it will be distributed, the default auth should be an API key, with subscription support only as "use your own `claude` login" (and Anthropic's approval).
2. Should agents load the user's `~/.claude` (skills, plugins, MCP), or start isolated with `settingSources: ["project"]`?
3. What should the default permission posture be for executors in worktrees: `bypassPermissions`, `acceptEdits` plus a Bash allowlist, or the `auto` classifier?
4. Bundle the pinned binary (bigger app, no version skew) or use the user's installed `claude`?
5. Where does orchestration live: Clowdy-level runs (one process each), in-session subagents and Workflow/ultracode, or both?
6. Should there be a global concurrency or budget policy (maximum live processes, pause below an X% rate-limit headroom)?

## Sources

- https://code.claude.com/docs/en/agent-sdk/overview (claude.ai login note, branding, Commercial Terms)
- https://code.claude.com/docs/en/legal-and-compliance (authentication and credential use, usage policy, "offer Claude Code in products")
- https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan (Jun 15 and Oct 7, 2026 updates)
- https://support.claude.com/en/articles/17154008-monthly-api-credits-for-max-ultra-and-team-plans
- https://www.anthropic.com/legal/consumer-terms (§3.7)
- https://code.claude.com/docs/en/authentication (precedence, setup-token, credential storage, CLAUDE_CONFIG_DIR)
- https://code.claude.com/docs/en/agent-sdk/quickstart
- https://code.claude.com/docs/en/agent-sdk/typescript
- https://code.claude.com/docs/en/agent-sdk/subagents
- https://code.claude.com/docs/en/agent-sdk/sessions
- https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode
- https://code.claude.com/docs/en/agent-sdk/permissions
- https://code.claude.com/docs/en/agent-sdk/hosting (subprocess model, resources, multi-tenant isolation)
- https://code.claude.com/docs/en/model-config (aliases, ultracode)
- https://code.claude.com/docs/en/setup (Windows, binary signing)
- https://www.theregister.com/2026/02/20/anthropic_clarifies_ban_third_party_claude_access (2026 history; secondary source)
- Local evidence: `node_modules/@anthropic-ai/claude-agent-sdk/{sdk.d.ts,README.md,manifest.json}` 0.3.325, and smoke scripts in the scratchpad `research/claude-agent-sdk/`

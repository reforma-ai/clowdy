# OpenAI Codex as a Clowdy engine (SDK, `codex exec --json`, app-server)

Researched 2026-11-17. Versions: `@openai/codex-sdk` 0.169.0 (npm latest, published 2026-11-13), bundled `@openai/codex` 0.169.0, system `codex-cli` 0.166.0, Bun 1.4.4, macOS arm64.

## Verdict

- It works on the user's ChatGPT subscription. The SDK spawns the bundled `codex` binary, which uses the existing CLI login (`~/.codex`, "Logged in using ChatGPT"). The smoke run reported `plan_type=plus` and `limit_id=codex`, with no API key in the environment.
- Terms: OpenAI tolerates the CLI's own login for **local or open-source** apps. It was "never permitted for commercial or hosted services". The supported long-term path is Sign in with ChatGPT (SIWC) open-source plan usage, which plugs into app-server as a custom model provider.
- For many parallel agents, **app-server** (JSON-RPC over stdio) beats the TS SDK. One process hosts many threads, and it adds steer/interrupt, approvals, client-side "dynamic tools", rate-limit reads and subagent items. The SDK spawns one `codex exec` process per turn and has no tool callbacks. Use the SDK only as a day-1 shortcut, behind an engine interface.

## Key facts

**Auth / terms**
- Codex auth docs: you can sign in with ChatGPT for subscription access or with an API key for usage-based billing. Credentials live in `~/.codex/auth.json` or the OS keyring (`cli_auth_credentials_store = file|keyring|auto|ephemeral`). "Codex refreshes tokens automatically during use". The docs still call API keys "the recommended default for automation".
- The app-server doc's auth section says local/OSS apps already built on app-server auth can keep using it. It recommends migrating to SIWC "so users have greater control over and visibility into their usage". Verbatim: "App-server authentication has never been permitted for commercial or hosted services."
- SIWC open-source track: "ChatGPT plan usage is available to all open-source partners and selected private clients". The docs cover "open-source and locally hosted apps"; paid or remotely hosted apps must use the interest form. The flow is OIDC + PKCE with a loopback redirect and dynamic client registration bound to a saved `ext_agent_host_id`, and the user consents to plan scopes. Inference then goes to `POST https://api.openai.com/v1/responses` (stream=true, store=false). For Codex there is a documented recipe: set `ACCESS_TOKEN` in the app-server env and pass `-c model_provider="openai_chatgpt_plan"` plus `model_providers.openai_chatgpt_plan.{env_key="ACCESS_TOKEN", wire_api="responses", supports_websockets=false}`. On token refresh you restart app-server and call `thread/resume`.
- app-server also has `account/login/start` with `type: "chatgpt"` (browser), `"chatgptDeviceCode"`, `"apiKey"`, and an experimental `"chatgptAuthTokens"` mode for host apps that own the token lifecycle (the server asks the host to refresh tokens via `account/chatgptAuthTokens/refresh`).
- Usage limits: the Plus plan showed a 300-minute primary window and a 10080-minute (weekly) secondary window (`account/rateLimits/read`). Codex shares one allowance with other ChatGPT agent features.

**TS SDK surface (0.169.0, from `dist/index.d.ts`)**
- `new Codex({ codexPathOverride?, baseUrl?, apiKey?, config?, configOverrides?, env? })`. `env` replaces `process.env` entirely, which is what we want for Electron/daemon isolation.
- `codex.startThread(ThreadOptions)` / `codex.resumeThread(id, ThreadOptions)`. ThreadOptions: `model`, `sandboxMode` (`read-only|workspace-write|danger-full-access`), `workingDirectory`, `skipGitRepoCheck`, `modelReasoningEffort` (`minimal…xhigh|max|ultra|persistent`), `networkAccessEnabled`, `webSearchMode`, `approvalPolicy` (`never|on-request|on-failure|untrusted`), `additionalDirectories`, `threadSource`.
- `thread.run(input, { outputSchema?, signal? })` returns `{ items, finalResponse, usage }`. `thread.runStreamed(...)` returns `{ events: AsyncGenerator<ThreadEvent> }`. Input is a string or `[{type:"text"},{type:"local_image",path}]`. `thread.id` is set after `thread.started`.
- Events: `thread.started{thread_id}`, `turn.started`, `item.started|item.updated|item.completed{item}`, `turn.completed{usage}`, `turn.failed{error}`, `error{message}`.
- Item types: `agent_message`, `reasoning`, `command_execution{command,aggregated_output,exit_code,status}`, `file_change{changes[{path,kind}],status}`, `mcp_tool_call{server,tool,arguments,result,error,status}`, `web_search`, `todo_list{items[{text,completed}]}`, `error`. The SDK has **no subagent/collab item type**.
- Usage: `input_tokens, cached_input_tokens, cache_write_input_tokens, output_tokens, reasoning_output_tokens`.
- Implementation: each `run`/`runStreamed` spawns `codex exec --experimental-json [--config …] [--model] [--sandbox] [--cd dir] [--add-dir] [--skip-git-repo-check] [--output-schema tmpfile] [resume <id>]`, writes the prompt to stdin and reads JSONL from stdout. The SDK sets `CODEX_INTERNAL_ORIGINATOR_OVERRIDE=codex_sdk_ts`. Cancellation passes `signal` to `child_process.spawn`, which kills the process.
- Custom tools: MCP servers only, through config (`config: { mcp_servers: { x: { command, args, env, enabled_tools, tool_timeout_sec } } }`, flattened into `--config`). There is no in-process tool callback and no approval callback, so unattended runs need `approvalPolicy: "never"`. Per the config reference, `untrusted` is unsupported and `on-failure` is deprecated.
- Threads persist as rollout JSONL under `$CODEX_HOME/sessions/YYYY/MM/DD/`. `resumeThread` re-spawns the binary and reloads that history.

**app-server surface (generated with `codex app-server generate-ts --experimental` from 0.169.0)**
- Transports: stdio JSONL (default), `unix://` (WebSocket over a UDS), and `ws://` ("experimental and unsupported"). Messages are JSON-RPC 2.0 without the `jsonrpc` field. The client sends `initialize{clientInfo, capabilities:{experimentalApi}}` and then the `initialized` notification.
- Threads: `thread/start{model,cwd,sandbox,approvalPolicy,config,baseInstructions,developerInstructions,ephemeral,dynamicTools*}`, `thread/resume`, `thread/fork`, `thread/list` (experimental `parentThreadId` / `ancestorThreadId` filters for spawned children), `thread/read`, `thread/loaded/list`, `thread/archive`, `thread/compact/start`, `thread/goal/*`.
- Turns: `turn/start{threadId,input,model,cwd,sandboxPolicy,outputSchema}` (overrides persist; `outputSchema` applies to that turn only), `turn/steer{expectedTurnId}` to inject input mid-turn, and `turn/interrupt`, which ends the turn with `status:"interrupted"`.
- Notifications include `item/started|completed`, `item/agentMessage/delta`, `item/commandExecution/outputDelta`, `item/reasoning/summaryTextDelta`, `turn/diff/updated`, `turn/plan/updated`, `thread/tokenUsage/updated`, `account/rateLimits/updated` and `thread/status/changed`.
- Server→client requests: `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval`, `item/tool/requestUserInput`, `mcpServer/elicitation/request`, and **`item/tool/call` (dynamic tools)**, which the client answers with `{contentItems, success}`.
- Item types: `agentMessage, reasoning, plan, commandExecution, fileChange, mcpToolCall, dynamicToolCall, webSearch, collabAgentToolCall, subAgentActivity, contextCompaction, imageView, …`. `CollabAgentTool` = `spawnAgent|sendInput|resumeAgent|wait|closeAgent|sendMessage|followupTask|interruptAgent|listAgents`.
- Other useful RPCs: `model/list`, `account/read`, `account/rateLimits/read`, `account/usage/read`, `config/read`, `config/batchWrite`, `mcpServerStatus/list`, `command/exec`, `fs/*`, `review/start`, `windowsSandbox/setupStart|readiness`.
- OpenAI positions the two surfaces this way: SDK for "automate coding tasks, including jobs in CI"; app-server for "custom clients that handle authentication, conversation history, approvals, and streamed agent events". The **Python** SDK (`openai-codex`) is already built on app-server. The TS SDK still wraps `exec`.

**Native subagents**
- Yes, and they are on by default ("Current Codex releases enable subagent workflows by default"; `features.multi_agent` is stable and true locally). The model spawns and coordinates child agent threads itself. Built-in roles are `default`, `worker` and `explorer`. Custom roles are TOML files in `~/.codex/agents/` or `.codex/agents/` with `name`, `description`, `developer_instructions` and optional `model` / `model_reasoning_effort`.
- Config: `agents.enabled`, `agents.max_concurrent_threads_per_session` (legacy `agents.max_threads`; third-party sources say the default is 6, and the official reference doesn't state one), `agents.default_subagent_model`, `agents.default_subagent_reasoning_effort`.
- Subagents inherit the parent's sandbox and approval settings; custom agent files can't override them. In non-interactive flows, an action that needs a new approval fails and the error returns to the parent. Children are visible as `collabAgentToolCall` items and child threads in app-server. The `exec` JSONL/SDK item union has no type for them.

**Process model / packaging**
- SDK: one native process **per turn** (not per thread). It exits at turn end, and a resume spawns a new one. Peak RSS was ~179 MB for a trivial turn. The process also launches every MCP server in the effective config, and this user's `~/.codex/config.toml` has 7.
- app-server: one process, many threads. RSS was 75 MB after init and 138 MB with 5 loaded idle threads (~13 MB each). Memory under active turns was not measured.
- The `@openai/codex` npm package is a shim with `optionalDependencies` on platform packages (`npm:@openai/codex@<ver>-darwin-arm64|darwin-x64|win32-x64|win32-arm64|linux-*`). Layout: `vendor/<triple>/bin/codex[.exe]` (280 MB on darwin-arm64), `bin/codex-code-mode-host` (70 MB), `codex-path/rg`, `codex-resources/` (voice etc.). npm unpacked sizes: darwin-arm64 377 MB, darwin-x64 402 MB, win32-x64 515 MB, win32-arm64 445 MB.

## How to use it

**Smoke test (ran OK).** Scratch dir: `/private/tmp/claude-501/-Users-bionic-WORK-My--kachurun-clowdy/fe81786a-671c-474f-b97c-3f5245a4e4fd/scratchpad/research/codex-sdk/` (`smoke.ts`, `abort.ts`, `appserver-probe.ts`, `*.out`, generated `schemas-ts-exp/`). Run with `env -i HOME PATH USER LANG bun run smoke.ts`.

```ts
import { Codex } from "@openai/codex-sdk";
const env = Object.fromEntries(["HOME","PATH","USER","LANG"].flatMap(k => process.env[k] ? [[k, process.env[k]!]] : []));
const codex = new Codex({ env });                 // no apiKey -> CLI's ChatGPT login is used
const thread = codex.startThread({ workingDirectory: dir, skipGitRepoCheck: true,
  sandboxMode: "read-only", approvalPolicy: "never", modelReasoningEffort: "low", webSearchMode: "disabled" });
const { events } = await thread.runStreamed("Reply with the word OK");
for await (const ev of events) { /* ev.type, ev.item?.type */ }
const again = codex.resumeThread(thread.id!, { workingDirectory: dir, skipGitRepoCheck: true, sandboxMode: "read-only" });
const r = await again.run("Return status OK as JSON.", { outputSchema: { type: "object",
  properties: { status: { type: "string" } }, required: ["status"], additionalProperties: false } });
```

Observed:
- Turn 1 events, in order: `thread.started, turn.started, item.completed:agent_message, turn.completed`.
- Turn 1 took 6.4 s wall time; the first event arrived after 0.57 s. Usage was `input 14,279 / cached 0 / output 5 / reasoning 0`. That ~14k-token baseline per fresh turn is the system prompt plus tools.
- Turn 2 (resumed in a new `Thread` object, same id) returned `{"status":"OK"}` in 6.0 s with usage `input 40,384 / output 20`.
- Rollout `session_meta`: `originator=codex_sdk_ts`, `source=exec`, `cli_version=0.169.0`, `model_provider=openai`. `turn_context`: `model=gpt-6-sol` (from the user's config.toml), sandbox `read-only`, approval `never`. `token_count.rate_limits.plan_type=plus`, `limit_id=codex`. Together these show that **ChatGPT plan auth** was used.
- Abort: `AbortController.abort()` at 150 ms threw `AbortError` after 169 ms and left no `codex exec` process behind.
- app-server probe (no turns, zero quota): `initialize` took 457 ms. `account/read` returned `type=chatgpt, planType=plus`. `model/list`: `gpt-6.1-sol*` (default), `gpt-6-astra`, `gpt-6.1-terra`, `gpt-6-sol`, `gpt-6-luna`, `gpt-5.6-{sol,terra,luna}`, with efforts low…ultra. 5× `thread/start{ephemeral:true}` all succeeded in one process.

**app-server client sketch (recommended target)**

```ts
const p = spawn(codexBin, ["app-server", "-c", 'approval_policy="never"'], { env: { ...minimalEnv, CODEX_HOME } });
send({ id: 1, method: "initialize", params: { clientInfo: { name: "clowdy", version }, capabilities: { experimentalApi: true } } });
send({ method: "initialized" });
const { thread } = await call("thread/start", { cwd: worktreePath, sandbox: "workspace-write", approvalPolicy: "never",
  developerInstructions: taskBrief, dynamicTools: [{ type: "function", name: "clowdy_update_task",
  description: "…", inputSchema: {/* JSON Schema */} }] });
await call("turn/start", { threadId: thread.id, input: [{ type: "text", text: prompt }] });
// handle notifications item/*, turn/completed; answer server requests "item/tool/call" with { contentItems, success }
// cancel: turn/interrupt { threadId, turnId };  nudge: turn/steer { threadId, expectedTurnId, input }
```

Generate typings pinned to the shipped binary with `codex app-server generate-ts --experimental --out <dir>`, and regenerate on every Codex bump.

**Electron/daemon packaging**
- Depend on `@openai/codex@<pinned>`, and ship the platform package's `vendor/<triple>` via `extraResources` (or asarUnpack).
- Spawn it with `codexPathOverride` (SDK) or directly (app-server). With an override, the SDK no longer prepends `codex-path/` (bundled `rg`) to `PATH`, so add it yourself.
- Build per-arch installers. A universal macOS build would carry ~780 MB of Codex alone.

**Config isolation**
- Give Clowdy its own `CODEX_HOME` (for example `~/.clowdy/codex`) and run the login there, through app-server `account/login/start{type:"chatgpt"}` or `CODEX_HOME=… codex login`.
- This keeps the user's personal MCP servers, hooks, AGENTS.md and session history out of agent runs. The plan quota is shared either way.
- `codex exec` has `--ignore-user-config` ("auth still uses CODEX_HOME"), but the SDK does not expose it.

## Limits and risks

- **Terms:** piggy-backing on the CLI login is fine for a local or open-source Clowdy, but it rules out a commercial or hosted product. Plan to add the SIWC OSS flow (own `ext_agent_host_id`, own OAuth tokens → app-server custom provider) before any distribution. The general Terms of Use also bar "automatically or programmatically" extracting output outside permitted channels. Codex/SIWC are the permitted channels, so don't call ChatGPT `backend-api` directly.
- **Quota is the real ceiling, not processes.** A trivial fresh turn costs ~14k input tokens, and cache hits were 0 in our runs. Plus has a 5 h window and a weekly window. "Thousands of agents" will exhaust Plus/Pro limits quickly. The orchestrator needs a concurrency governor that reads `account/rateLimits/read` / `rateLimits/updated` and handles `usage_limit` failures.
- **SDK per-turn process:** ~180 MB peak RSS plus MCP children per running agent, and resume cost on every turn. App-server amortizes this, though turns may still spawn sandboxed shells. Load is untested beyond 5 idle threads.
- **SDK gaps:** no approval callbacks, no steer, no client-side tools, no subagent items, no rate-limit/account API, no model list. `exec --experimental-json` carries "experimental" in the flag name.
- **app-server stability:** the CLI marks app-server "[experimental]", and the protocol changes per release (many removed/renamed feature flags). Pin the binary version and regenerate types. `dynamicTools`, `chatgptAuthTokens`, `collaborationMode/list` and the parent-thread filters require `experimentalApi`.
- **Native subagents vs. Clowdy orchestration:** Codex subagents are model-driven, capped per session (`max_concurrent_threads_per_session`), share the parent's sandbox, and are not visible in the SDK stream. For many-to-many task linking, Clowdy should spawn and own each Codex thread itself, with optional native subagents inside one thread, surfaced via `collabAgentToolCall` in app-server.
- **Sandbox and worktrees (unverified):** `workspace-write` allows writes only to `cwd` + `additionalDirectories`. A git worktree's `.git` is a file that points into the main repo's `.git/worktrees/…`, so `git commit` from inside the sandbox may need the main `.git` dir added as a writable root. Test this. Network is off in workspace-write unless `sandbox_workspace_write.network_access=true`.
- **Windows:** binaries exist (win32-x64/arm64, ~515 MB). The sandbox needs a setup step (`windowsSandbox/setupStart`, `windowsSandbox/readiness`). Not tested.
- **Size:** ~370–520 MB per platform added to the installer.

## Open questions

- Is `turn.completed.usage` per turn or cumulative for a resumed thread? The resumed turn reported 40k input against a ~14k baseline.
- How does app-server memory and CPU behave with 20–100 *active* turns in one process? Should we pool several app-server processes?
- Can one app-server process serve threads with different `CODEX_HOME`/auth, or do we need one process per account? Process-wide auth seems likely.
- SIWC OSS: is Clowdy eligible as "locally hosted" without being open-source? How exactly does `ext_agent_host_id` registration work, and what does the refresh flow look like in practice?
- Does a `-c` override disable all user MCP servers cleanly, or is a separate `CODEX_HOME` the only clean option?
- Does dynamic-tool latency or timeout fit long-running Clowdy tools (for example "wait for sibling task")?

## Sources

- Codex SDK docs: https://developers.openai.com/codex/sdk (→ https://learn.chatgpt.com/docs/codex-sdk)
- TS SDK README: https://github.com/openai/codex/blob/main/sdk/typescript/README.md
- App Server docs: https://developers.openai.com/codex/app-server (→ https://learn.chatgpt.com/docs/app-server.md)
- Codex authentication: https://learn.chatgpt.com/docs/auth
- Subagents: https://developers.openai.com/codex/subagents (→ https://learn.chatgpt.com/docs/agent-configuration/subagents)
- Config reference: https://learn.chatgpt.com/docs/config-file/config-reference
- SIWC quickstart: https://developers.openai.com/siwc/quickstart
- SIWC open-source plan usage: https://developers.openai.com/siwc/token-sharing-open-source , …/models-and-inference , …/codex-app-server
- Help center, Codex with ChatGPT plan (403 to fetcher; cited via search snippet): https://help.openai.com/en/articles/11369540
- OpenAI Terms of Use (extraction clause, via search snippets): https://openai.com/policies/row-terms-of-use/
- npm: https://www.npmjs.com/package/@openai/codex-sdk , https://www.npmjs.com/package/@openai/codex
- Local evidence: `node_modules/@openai/codex-sdk/dist/index.{d.ts,js}` 0.169.0; `codex features list`; `codex exec --help`; generated app-server TS schema.

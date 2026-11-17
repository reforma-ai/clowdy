# Vercel AI SDK between the daemon and the engines?

Researched 2026-11-17. Versions on npm that day: `ai` 7.0.173, `@ai-sdk/harness` 1.0.184,
`@ai-sdk/harness-claude-code` 1.0.188, `@ai-sdk/harness-codex` 1.0.186,
`ai-sdk-provider-claude-code` 4.4.1, `ai-sdk-provider-codex-cli` 2.4.0,
`@anthropic-ai/claude-agent-sdk` 0.3.326, `@openai/codex-sdk` 0.169.0. Local CLIs: `claude` 2.1.322, `codex` 0.166.0.

## Verdict

Skip it as a runtime layer. AI SDK 7 offers two ways in. One treats Claude Code or Codex as a `LanguageModel`, a "model" that secretly runs a whole agent (community providers). The other is the official `HarnessAgent`, which is experimental, needs a remote network sandbox, and handles subscription auth by pulling OAuth tokens out of the keychain. Neither fits a local daemon running many engine sessions in git worktrees on the user's subscription. Write two thin adapters straight over `@anthropic-ai/claude-agent-sdk` and `codex app-server`. Borrow AI SDK's message-part vocabulary for our own protocol. Don't adopt its runtime or its persisted format.

## Key facts

### 1. What AI SDK 7 offers for agents (released 2026-06-25)

- **`ToolLoopAgent`** (`ai`): `model`, `instructions`, `tools`, `stopWhen` (default `isStepCount(20)`; v6's `stepCountIs` is gone),
  `prepareStep`, `toolApproval`, `runtimeContext`, `toolsContext`, timeouts, `generate()`/`stream()`. AI SDK runs the loop and executes
  the tools itself. That's useless here, because Claude Code and Codex run their own loop and tools.
- **`WorkflowAgent`** (`@ai-sdk/workflow`): durable, resumable steps. Overlaps with the daemon's own SQLite run state.
- **`HarnessAgent`** (`@ai-sdk/harness`): runs existing harnesses behind the AI SDK `Agent` interface. Adapters: Claude Code, Codex,
  Cline, Cursor, Copilot, Deep Agents, OpenCode, Pi, fx, plus generic ACP. The docs say: "Harness packages are **experimental**.
  Expect breaking changes between releases."
  - Claude Code and Codex are **sandbox-bridge** adapters. The adapter installs a bridge inside the sandbox and talks to it over a
    sandbox-exposed WebSocket. The Claude bridge pins `@anthropic-ai/claude-agent-sdk` 0.3.319 and `@anthropic-ai/claude-code` 2.1.319;
    the Codex bridge drives `codex app-server`. Docs: "Bridge-backed harnesses such as Claude Code and Codex require using real network
    sandbox like `@ai-sdk/sandbox-vercel`." `@ai-sdk/sandbox-local` and `@ai-sdk/sandbox-docker` return 404 on npm. `sandbox-just-bash`
    is an in-process JS bash with a virtual filesystem and only serves host-runtime harnesses (Pi).
  - The session workdir is composed as `<defaultWorkingDirectory>/<harnessId>-<sessionId>`, not an arbitrary worktree path.
  - The Claude bridge hard-codes `settingSources: ['user']` (bridge `index.ts` l.1017). Project `CLAUDE.md`, `.claude/skills`, hooks and
    `AGENTS.md` are not loaded (documented under "Known Limitations"). That rules it out for Clowdy working on Clowdy.
  - Codex adapter: "Codex does not support built-in tool approval requests. Use `permissionMode: 'allow-all'`."
  - **"Native subscription" auth reads tokens directly.** The source (`claude-code-subscription.ts`) reads the `Claude Code-credentials`
    keychain item or `~/.claude/.credentials.json`. It refreshes the token against `platform.claude.com/v1/oauth/token` using Claude
    Code's client ID, writes the result back to the keychain, and forwards `CLAUDE_CODE_OAUTH_TOKEN` into the sandbox.
    `codex-subscription.ts` does the same with `~/.codex/auth.json` or the keyring and sends the token as `CODEX_API_KEY` to
    `chatgpt.com/backend-api/codex`. Anthropic's terms say developers "may not collect, store, or intermediate Claude.ai credentials or
    session tokens". Two processes refreshing one rotating refresh token can also race with the CLI.
- **UI message stream**: SSE `data:` chunks, header `x-vercel-ai-ui-message-stream: v1`. Chunk types: `start`, `start-step`,
  `text-*`, `reasoning-*`, `tool-input-start|delta|available`, `tool-approval-request|response`, `tool-output-available|denied`,
  `data-*`, `file`, `source-*`, `finish-step`, `finish`, `abort`, `error`, `[DONE]`. Persisted `UIMessage.parts`: `text`,
  `reasoning`, `tool-<name>` / `dynamic-tool` (states `input-streaming → input-available → approval-requested → approval-responded →
  output-available | output-error | output-denied`, flag `providerExecuted`), `data-*`, `file`, `source-*`, `step-start`,
  `steering-message`. The protocol has no event ids or cursors, and each stream carries a single assistant message.
- **No official subscription provider.** `@ai-sdk/anthropic` and `@ai-sdk/openai` take API keys. Subscription access goes through either
  the community providers or HarnessAgent's token-reading path.

### 2. Community providers keep subscription auth, at a cost

Both spawn the vendor's own code (Agent SDK, or the `codex` binary), and that code reads its own credential store. The provider never
touches a token. **Smoke-tested 2026-11-17 with a clean env (`env -i HOME PATH USER LANG`), no API keys:**

- `ai-sdk-provider-claude-code` + haiku, `tools: []`, `maxTurns: 1`: text `"OK"`; parts `start, start-step, reasoning-start/end,
  text-start/delta/end, finish-step, finish`; `providerMetadata['claude-code']` = `costUsd, durationMs, mcpServers, modelUsage,
  sessionId, terminalReason, ttftMs, ...`.
- `ai-sdk-provider-codex-cli` app-server mode, `codexPath` = local `codex`, effort `low`: `listModels()` returned `gpt-6.1-sol`
  (default), `gpt-6-astra`, ...; text `"OK"`; parts `start, start-step, text-*, finish-step, finish`; metadata `threadId, turnId,
  toolExecutionStats`.

What you get, and what you still have to hand-wire, per capability (from READMEs and type definitions):

| Capability | claude-code provider 4.4.1 | codex-cli provider 2.4.0 |
| --- | --- | --- |
| Engine version | pins `claude-agent-sdk` **exactly 0.3.283** (latest is 0.3.326) | "validated baseline" 0.156; local CLI is 0.166 |
| Subagents | Task tool runs; child tool parts carry `providerMetadata.parentToolCallId`, which is **null when parallel Tasks make the parent ambiguous**; `onTaskEvent` callback | nothing documented |
| Resume | `resume` / `forkSession` / `sessionId` settings. Replaying `messages` instead turns old tool calls into text lines (`[Tool call: Read({...})]`) | `threadId` / `resume` in `providerOptions`; ephemeral thread by default |
| Tool events | provider-executed dynamic `tool-call`/`tool-result`, `tool-input-delta` | `providerExecuted: true`; exec mode emits text and tool output only at the end |
| Permissions | AI SDK `toolApproval` is **not bridged**. Pass Agent SDK `canUseTool` / `permissionMode` through provider settings | `approvalPolicy` / `serverRequests` handlers in provider settings |
| Interrupt / steer | `abortSignal`; live control through `onQueryControllerCreated` (raw SDK `Query`); injection needs `streamingInput: 'always'` | `session.interrupt()` / `injectMessage()` via `onSessionCreated` |
| Our own tools | AI SDK `tools` are ignored; wrap them as in-process MCP with `createAiSdkMcpServer` | local MCP server |
| AI SDK params | `temperature`, `maxOutputTokens`, `stopSequences`, ... ignored | same |

Each row Clowdy needs (subagent tree, resume, approvals, interrupt) goes through provider-specific settings, callbacks and
`providerMetadata`. We'd write engine-specific code anyway, one layer further from the engine, behind a pinned SDK, and inside an
abstraction where one `streamText()` call is one whole agent turn. Putting `ToolLoopAgent` on top adds nothing.

### 3. UIMessage as Clowdy's persisted model? No. Use a thin engine-neutral event log

The spec (§3.2) asks for events with a cursor, time, projectId and entity refs; snapshot plus continue-from-cursor; stream fragments
folded into durable messages without duplicates on reconnect; an `interrupted` run state; parent/child runs; many-to-many runs↔tasks.
UIMessage covers only the last mile, rendering one assistant message:

- no event ids or cursors (only the `v1` header), so reconnect and dedupe would be ours to build anyway;
- no run, parent run, task, worktree or project fields; engine-specific facts (subagent progress, Codex `fileChange`, compaction,
  cost) end up in untyped `providerMetadata` or `data-*` parts;
- format churn: the provider's npm dist-tags track four `ai` majors (v4 to v7), each needing its own provider line. v7 removed `stepCountIs` and
  deprecated `needsApproval` and tool-part `rawInput`, and the persistence guide tells you to re-validate stored messages with
  `validateUIMessages` and migrate them by hand. A database in this format follows Vercel's release schedule.

Better: a versioned `packages/protocol` event model that is ours. Copy UIMessage's part names and tool-state machine so a
`toUIMessage()` projection stays trivial if we ever want `useChat` or AI Elements. Also keep the raw engine event JSON next to each
normalized event so we can re-project after mapping bugs.

## How to use it

Reference snippets that worked (scratchpad only, not for the repo):

```ts
// Claude via subscription (spawns Agent SDK; clean env)
import { streamText } from 'ai';
import { claudeCode } from 'ai-sdk-provider-claude-code';
const r = streamText({
  model: claudeCode('haiku', { maxTurns: 1, tools: [], settingSources: [], persistSession: false }),
  prompt: 'Reply with the word OK',
});
for await (const p of r.stream) { /* p.type: text-delta, reasoning-*, tool-call, ... */ }
const sessionId = (await r.finalStep).providerMetadata?.['claude-code']?.sessionId;
```

```ts
// Codex via ChatGPT subscription (persistent app-server process)
import { createCodexAppServer } from 'ai-sdk-provider-codex-cli';
const provider = createCodexAppServer({ defaultSettings: { codexPath: '/path/to/codex', effort: 'low', threadMode: 'persistent' } });
const { defaultModel } = await provider.listModels();
const r = streamText({ model: provider(defaultModel!.id), prompt: 'Reply with the word OK' });
// threadId: (await r.finalStep).providerMetadata?.['codex-app-server']?.threadId
await provider.close();
```

Recommended shape for Clowdy instead:

```ts
// packages/agent-runtime: one adapter per engine, no AI SDK in between
interface EngineAdapter {
  start(run: RunSpec): EngineSession;          // cwd = worktree, model, prompt, resume id, permission policy
}
interface EngineSession {
  events: AsyncIterable<EngineEvent>;          // normalized + raw
  send(msg: UserInput): Promise<void>;         // steer / follow-up
  interrupt(): Promise<void>;
  respondApproval(id: string, d: Decision): Promise<void>;
  engineSessionId(): string | undefined;       // Claude session_id / Codex threadId, persisted on AgentRun
}
// EngineEvent parts mirror AI SDK names: text, reasoning, tool (input-streaming → input-available →
// approval-requested → output-available|output-error|output-denied), file-change, subagent-start/end,
// usage, compaction, plus {runId, parentRunId, seq, ts, raw}.
```

Claude adapter: `query()` from `@anthropic-ai/claude-agent-sdk` with streaming input, `canUseTool`, `hooks`, `agents`, `resume`,
`settingSources: ['user','project','local']`, `interrupt()`. Codex adapter: `codex app-server` JSON-RPC (`thread/start`,
`turn/start`, `turn/interrupt`, approval server requests); see `codex-sdk.md`. The community providers' source (MIT) is a good
reference for mapping SDK messages to parts, e.g. its `parentToolCallId` logic and app-server notification handling.

## Limits and risks

- **HarnessAgent:** experimental; Claude Code and Codex need a network-sandbox implementation (Vercel or a custom one we would write);
  project config is disabled; Codex approvals are unsupported; subscription mode extracts and refreshes OAuth tokens outside the CLI.
  That breaks Anthropic's credential terms and the spec's "secrets never leave their store" rule.
- **Community providers:** single maintainer, unofficial ("not affiliated with or endorsed by Anthropic or Vercel"); the exact SDK pin
  lags weeks behind; any engine feature we need waits on a provider release or ends up behind `rawQuery` / raw chunks anyway.
- **Abstraction mismatch:** `LanguageModel` assumes one step and a stateless history. The engines are stateful sessions with their own
  history, compaction and subagents. Mixing the two leads to double history (AI SDK messages next to the engine transcript).
- **Billing doesn't change with the wrapper.** Since 2026-06-15, Agent SDK, `claude -p` and third-party use draw from a separate
  programmatic credit pool equal to the plan price; the subscription-auth note owns this topic.
- **If we skip AI SDK:** we own the `useChat`-style stream folding ourselves. That's a small reducer over our own events, and the
  spec requires it regardless.

## Open questions

1. Will Clowdy want API-key or local models (OpenRouter, Ollama) for cheap side calls such as titles, task summaries and triage? If yes,
   that is the concrete need that justifies `ai` + `@ai-sdk/*` providers, confined to one utility module and off the agent path.
2. Revisit HarnessAgent when it leaves experimental, if it gains a host-local sandbox, project `settingSources`, and auth that delegates
   to the CLI instead of reading tokens.
3. Does the renderer want AI Elements or `useChat`? With Reforma components, probably not, so the `toUIMessage()` projection stays optional.

## Sources

- AI SDK 7 announcement (2026-06-25): <https://vercel.com/blog/ai-sdk-7>, <https://vercel.com/changelog/ai-sdk-7>
- HarnessAgent: <https://ai-sdk.dev/docs/ai-sdk-harnesses/harness-agent>
- Harness overview (experimental notice): <https://ai-sdk.dev/docs/ai-sdk-harnesses/overview>
- Harness adapter list: <https://ai-sdk.dev/docs/ai-sdk-harnesses/harness-adapters>, <https://ai-sdk.dev/providers/ai-sdk-harnesses>
- Claude Code harness: <https://ai-sdk.dev/providers/ai-sdk-harnesses/claude-code>
- Codex harness: <https://ai-sdk.dev/providers/ai-sdk-harnesses/codex>
- Agents overview: <https://ai-sdk.dev/docs/agents/overview>
- UI stream protocol: <https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol>
- Message persistence: <https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-message-persistence>
- Community providers: <https://ai-sdk.dev/providers/community-providers/claude-code>, <https://github.com/ben-vargas/ai-sdk-provider-claude-code>,
  <https://ai-sdk.dev/providers/community-providers/codex-cli>, <https://ai-sdk.dev/providers/community-providers/codex-app-server>
- Anthropic credential terms: <https://code.claude.com/docs/en/legal-and-compliance>
- Programmatic usage pool from 2026-06-15: <https://www.theregister.com/ai-ml/2026/05/14/anthropic-tosses-agents-into-the-api-billing-pool/5240748>
- Package sources read locally (npm tarballs): `@ai-sdk/harness-claude-code@1.0.188` `src/claude-code-subscription.ts`, `src/bridge/index.ts`;
  `@ai-sdk/harness-codex@1.0.186` `src/codex-subscription.ts`; `ai@7.0.173` `dist/index.d.ts`; provider READMEs and `package.json`.

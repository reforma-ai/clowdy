# Research: driving external coding agents through ACP (index)

Snapshot 2026-11-17. Research only; no plan or design. Slug `acp`; notes in this folder.

## Question and scope

Clowdy's daemon runs agents only through `@anthropic-ai/claude-agent-sdk` (`apps/daemon/src/engine/claude/*`, seam in `engine/types.ts`, a Codex engine planned). The owner wants it to drive **any** coding agent (Claude Code, Codex, Cursor, OpenCode, Gemini CLI, Pi, ...) over the **Agent Client Protocol**, **without shipping the agents**: use what the user has installed and logged in, as the product bb does (any ACP agent addable in Settings or by plugin, an agent per thread, agents messaging across providers, a worktree per thread). The ten questions asked:

1. ACP itself. 2. Agents and adapters. 3. How bb and Orca find installed agents. 4. How they run sessions. 5. Mapping to Clowdy's `EngineEvent`s. 6. Tools and orchestration over MCP. 7. Skills. 8. Subscription and terms. 9. What survives of the Claude engine. 10. Product surface.

## Summary

- **ACP is a good fit for the event shape and a poor fit for four things Clowdy relies on today.** Text, tool calls with status, permission requests, cancel, resume, config/model options, system prompt and stdio MCP servers are in stable v1. Per-turn token usage (an unstable field, but both Zed adapters send it), native sub-agent events (unstable, two adapters), subscription rate-limit signals (vendor `_meta` only) and mid-turn `send` (pre-standard `_session/steering`) are not. Details in `acp-protocol.md` and `clowdy-mapping.md`.
- **Neither reference project runs Claude Code or Codex over ACP.** bb uses the Agent SDK pointed at the user's `claude` and `codex app-server`; Orca does the same. Both use ACP only for the other agents (bb: Cursor, OpenCode, omp, Grok, Hermes, plus any custom or registry agent; Orca: nine hand-integrated agents). `.briefback/references.md` says bb lists all eight as ACP; the source shows otherwise. See `bb-source.md`, `orca-source.md`.
- **The official adapters for Claude and Codex bundle the agent by default** (SDK + about 350 MB binary; `@openai/codex` dependency) and run the user's installed binary only when told (`CLAUDE_CODE_EXECUTABLE`, `CODEX_PATH`). Native `acp` subcommands exist for Cursor, OpenCode, Gemini CLI, Copilot CLI, Grok, omp, Hermes. The ACP registry (47 agents) describes **fetch-and-run** launches (binary archive, `npx`, `uvx`), not "find it on PATH". See `agents-and-adapters.md`.
- **Finding what is installed is the client's job.** bb: login-shell PATH snapshot, `which`/version probes with a 30 s stale-while-revalidate cache, a known-agent table with `visibility: "installed"`, custom-agent JSON, registry import limited to `npx`/`uvx`. Orca: per-agent `detectCmd` (45 agents), a command-resolution order (setting, managed release, PATH + install dirs), minimum-version gates. Both turn missing/outdated/logged-out into guidance text.
- **Tools for ACP agents** must come as an MCP server in `mcpServers`: stdio is mandatory for every agent, HTTP optional, MCP-over-ACP unstable. bb uses a stdio proxy that calls back over loopback TCP with a per-process token; Orca injects nothing and gives agents a CLI plus skills. At least Pi's adapter ignores `mcpServers`; Codex starts MCP servers after `session/new` returns. See `tools-and-mcp.md`.
- **Skills have no ACP delivery path.** Routes: `additionalDirectories` (both Zed adapters; Codex adapter maps each root to `<root>/.agents/skills`), Claude's `_meta.claudeCode.options.plugins`, per-agent launch config (Orca), prompt injection (bb), `systemPrompt`. See `skills.md`.
- **Subscription terms:** the Claude adapter is an Agent SDK wrapper running a real `claude`; no Anthropic page mentions ACP; the adapter ships an opt-in `--hide-claude-auth` that refuses subscription billing except Enterprise; OpenAI says app-server auth "has never been permitted for commercial or hosted services". Orca reads Claude's OAuth token to call the usage endpoint. See `policy.md`.
- **What survives of the Claude engine:** process-group spawn/kill, the run runtime (scheduler, limits, wake-ups, process safety), failure-classification helpers, the seam and test engines. **Replaced:** `mapper.ts`, `session.ts`, `tools.ts`, most of `config.ts`. `EngineId` is a closed union in seven places. See `clowdy-mapping.md`.

## Topic pages

| Page | Covers |
| --- | --- |
| [acp-protocol.md](acp-protocol.md) | Q1: lifecycle, methods, update kinds, permissions, fs/terminal, MCP transports, usage/limits gaps, TS SDK 2.7.0, v2 draft |
| [agents-and-adapters.md](agents-and-adapters.md) | Q2: per-agent launch, adapters and what they bundle, login reuse, the registry |
| [bb-source.md](bb-source.md) | Q3, Q4 (bb): discovery, versions, auth, sessions, processes, resume, permissions, worktrees, cross-agent messaging, usage |
| [orca-source.md](orca-source.md) | Q3, Q4 (Orca): own ACP client, launch specs, process ownership journal, orchestration, accounts and usage reads |
| [clowdy-mapping.md](clowdy-mapping.md) | Q5, Q9: event-by-event mapping, gaps and options, what survives, the closed `EngineId` set |
| [tools-and-mcp.md](tools-and-mcp.md) | Q6: hosting options, bb's stdio proxy, per-agent MCP quirks |
| [skills.md](skills.md) | Q7: delivery routes, per-agent discovery roots, what bb and Orca did |
| [policy.md](policy.md) | Q8: Anthropic, OpenAI and other sources, adapter behavior |
| [product-surface.md](product-surface.md) | Q10: bb's Settings and picker, the FAQ writing, what in Clowdy's desktop app and protocol would change |

## Important sources and snapshots

| Source | Version / commit | Date |
| --- | --- | --- |
| ACP protocol repo `agentclientprotocol/agent-client-protocol` | `ecd1765`; schema crate v1 1.32.0 | 2026-11-17; schema 2026-11-14 |
| `@agentclientprotocol/sdk` (TS) | 2.7.0, repo `typescript-sdk@1bdba77` | 2026-11-14 / 2026-11-17 |
| ACP registry `agentclientprotocol/registry` | `df2ae8a`, 47 agents | 2026-11-17 |
| `@agentclientprotocol/claude-agent-acp` | 0.108.0, repo `@3205f0b` (SDK dependency 0.3.326) | 2026-11-17 |
| `@agentclientprotocol/codex-acp` | 2.7.0, repo `@b9503ae` (`@openai/codex ^0.166.0`) | 2026-11-17 |
| bb `get-bb/bb` (MIT) | `f1c5304` | 2026-11-17 |
| Orca `stablyai/orca` (MIT) | `cbc8119e` | 2026-11-17 |
| Anthropic legal-and-compliance, Agent SDK plan article, Zed blog; OpenAI app-server and auth pages | fetched 2026-11-17; Zed post 2026-05-14 (update 2026-06-16); support-article notes 2026-06-15 and 2026-10-07 | see `policy.md` |

Clowdy files read: `AGENTS.md`, `apps/daemon/AGENTS.md`, `apps/daemon/src/engine/{types,index,fake}.ts`, `engine/claude/*.ts`, `apps/daemon/src/runs/{driver,limits,service,native,tools,tool-kit}.ts`, `apps/daemon/src/config.ts`, `packages/protocol/src/{domain,commands}.ts`, `apps/desktop/src/renderer/features/settings/{Screen,EnginePage}.tsx`, `.briefback/mvp/research/{claude-agent-sdk,codex-sdk,skills-in-engines}.md`, `.briefback/references.md`.

Clones are in the scratchpad (`.../scratchpad/{bb-clone,orca-clone,acp-protocol-clone,acp-sdk-clone,acp-registry-clone,acp-claude-adapter-clone,acp-codex-adapter-clone}/`); read only, nothing installed or run.

## Open questions research could not answer

- Which agents actually advertise `mcpCapabilities.http`/`sse`/`acp`, `sessionCapabilities.resume`, `additionalDirectories` and `systemPrompt` in a real `initialize` reply. Needs a live probe of each installed agent.
- Whether a legacy HTTP MCP server works unchanged with Claude Code 2.1.325+ and Codex 0.166+ launched through the adapters (both may send `server/discover` first).
- Whether Codex rate-limit data reaches a plain ACP client (it is read inside `codex-acp`; client exposure was not verified).
- Whether the Claude adapter can start Claude Code without the user's global settings, hooks and plugins other than through hand-written `_meta.claudeCode.options`.
- Whether skills reached through an ACP `additionalDirectories` root keep the `clowdy:` namespace that the first-message `/clowdy:orchestrate` relies on.
- `spec.md` (named in `AGENTS.md`) is not in the working tree; the product spec's statements on agents and Settings were not read.
- Whether any Anthropic or OpenAI page names ACP clients (none found).

## Assumptions and coverage limits

- **Nothing was run.** No agent, adapter, SDK or reference-project code was executed or installed; every behavior statement is from docs and source and is labelled observed or inferred in the topic pages.
- **Not read:** bb's UI beyond the providers section, plugin system internals, Account Pooler; Orca's mobile, cloud and remote runtime, plugin system, renderer, `codex-accounts`/`cursor-accounts`/`grok-accounts`; the bodies of `docs/protocol/v1/{terminals,content,slash-commands,session-list}.mdx`; the v2 draft beyond its RFD list; the Gemini, Copilot, Grok, Hermes, omp, Kimi, Antigravity and Devin ACP implementations.
- **Web pages** were summarized by a fetch tool (Anthropic legal and support pages, Zed blog, OpenAI pages, Cursor and Gemini ACP docs, pi-acp README); quoted sentences are as returned.
- bb and Orca move daily; all file citations carry the commit they were read at.
- The Clowdy working tree has uncommitted changes (branch `kachurun/feat/task-hotkeys`); none touch the engine files read.

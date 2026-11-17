# Reforma agent catalog 05: skills, memory, MCP / dynamic tools, plugins

Scope: `apps/sandbox/src/chat/agent/{skills,memory,tools/{skill,remember,mcp-tools,install-plugin}}`, `apps/sandbox/src/chat/mcp-client`, `apps/sandbox/src/core/{global-skills.ts,integrations,workspace/preferences-service.ts}`, `packages/lib/src/{skills,mcp}.ts`, `packages/reforma-system`, `apps/api/.catalog`. All paths below are relative to the Reforma repo root. Read-only research, code verified (not docs). Reforma docs: `.briefback/docs/desktop/local-projects.md` (Global skills section), `.briefback/docs/agent/model-context.md` (tool discovery; partly stale, see 3.4).

Two lenses used for verdicts: **(a)** we keep the Vercel AI SDK loop, **(b)** an engine (Claude Agent SDK / Codex) owns the loop and we reuse only logic.

## 0. Summary

- Skills are the best-factored area: discovery (`packages/lib/src/skills.ts`) is pure `node:fs`, ~285 lines, no Reforma deps. The catalog/Skill-tool layer is ~250 lines glued to `config.*` and module singletons.
- Under (b) almost all of the skill, MCP and dynamic-tool *runtime* is redundant: Claude Code and Codex already load `SKILL.md`, run MCP and defer tool schemas. What stays valuable is (1) multi-root layering rules, (2) MCP status/auth-detection logic, which engines do NOT do for us (the Claude SDK never opens a browser for OAuth), (3) the `mcp.json` config shape.
- Memory is a small sqlite + embeddings store that needs the LiteLLM `/v1/embeddings` endpoint. Not worth porting; engines have `CLAUDE.md` / `AGENTS.md`.
- Plugins are 90% Reforma Cloud (API catalog, vault, Composio, approval UI). Only the folder convention is reusable.
- Global gotcha: every singleton here assumes ONE project per process (`mergedCatalogCache`, `McpConnectionManager.shared`, `preferencesService`, `config.PROJECT_CONFIG_FOLDER`, `getRequestProjectId` ALS). Clowdy's daemon is multi-project, so anything ported must take roots/project as parameters.

| Part | File:symbol | Verdict |
| --- | --- | --- |
| Skill discovery + parsing | `packages/lib/src/skills.ts` | PORT-WITH-CHANGES |
| Catalog merge, cache, readSkillByName | `apps/sandbox/src/chat/agent/skills/workspace-skills.ts` | PORT-WITH-CHANGES (a) / SKIP (b) |
| Skill tool | `.../tools/skill/Skill.ts` | PORT-AS-IS (a) / SKIP (b) |
| available-skills block, slash blocks | `.../skills/skills-info.ts`, `slash-skills.ts` | REWRITE-USING-IDEA |
| Global skills switch | `core/global-skills.ts`, `apps/desktop/src/skills.ts` | PORT-WITH-CHANGES |
| Skills watcher / catalog sync | `.../skills/skills-sync.ts` | REWRITE-USING-IDEA |
| Plugin rules | `.../skills/workspace-rules.ts` | SKIP |
| Project memory | `.../memory/*`, `.../tools/remember/*` | REWRITE-USING-IDEA |
| MCP connection manager | `apps/sandbox/src/chat/mcp-client/mcp-connection-manager.ts` | REWRITE-USING-IDEA |
| MCP config layering | `core/workspace/preferences-service.ts` | REWRITE-USING-IDEA |
| MCP name/schema helpers | `mcp-client/mcp-configured-tools.ts`, `packages/lib/src/mcp.ts` | PORT-AS-IS |
| PRM probe | `mcp-client/mcp-oauth-prm.ts` | PORT-AS-IS |
| Transports | `mcp-client/sdk-mcp-transport.ts`, `sdk-mcp-stdio-transport.ts` | PORT-WITH-CHANGES (a) / SKIP (b) |
| Dynamic tools gateway | `tools/mcp-tools/{GetDynamicTools,CallDynamicTool,helpers,deferred-tools,repair-deferred-tool-call}.ts`, `tools/tool-groups.ts` | REWRITE-USING-IDEA |
| McpAuth, runtime auth, API OAuth client | `tools/mcp-tools/McpAuth.ts`, `core/integrations/mcp-runtime-auth.ts`, `apps/api/src/projects/integrations/mcp-oauth-client.ts` | SKIP / REWRITE-USING-IDEA |
| GetMcpResources | `tools/mcp-tools/GetMcpResources.ts` | PORT-WITH-CHANGES (a) / SKIP (b) |
| Plugin install/hydrate + catalog | `core/integrations/integrations-sync.ts`, `tools/install-plugin/*`, `apps/api/.catalog` | SKIP |

## 1. Skills

### 1.1 Roots and precedence

Built in `skillsRoots()` (`apps/sandbox/src/chat/agent/skills/workspace-skills.ts:143`). Roots are merged in this order, **later wins by name**:

| # | Root | Path | Follows symlinks | Notes |
| --- | --- | --- | --- | --- |
| 1 | global `~/.claude/skills` | `config.GLOBAL_SKILLS_FOLDERS[1]` | anywhere | lowest |
| 2 | global `~/.agents/skills` | `GLOBAL_SKILLS_FOLDERS[0]` | anywhere | beats `.claude`; list is reversed so index 0 is merged last |
| 3 | system | `REFORMA_SYSTEM_FOLDER/skills` (`/etc/reforma/skills`, source `packages/reforma-system/skills`) | only into allowed dirs | 11 web-builder skills, 46 KB total |
| 4 | plugins | `PLUGINS_FOLDER/<id>/skills` for each dir, sorted | allowed dirs | `pluginId` stamped from the dir name; `custom_<uuid>` maps back to `custom:<uuid>` |
| 5 | project | `PROJECT_CONFIG_FOLDER/skills` (`<ws>/.reforma/skills`) | allowed dirs | highest |

- Global roots (1, 2) exist only while the desktop switch is on (see 1.6). The two folders are hardcoded in `apps/desktop/src/skills.ts` as `~/.agents/skills` then `~/.claude/skills`. Other agents' folders (`~/.codex`, `~/.cursor`) are not read.
- Inside one root: BFS shallowest first, then sorted path; the first valid skill of a name wins (`readSkills`).
- Merge keeps `pluginId` from the overridden entry if the winner has none (`mergeSkillCatalogs`), so a project override of a plugin skill still shows the plugin label.
- Result sorted by `localeCompare(name)`. `undefined` (not `[]`) when there are no skills.
- A skill dir shadows wholesale: a sibling file missing in the winning copy does NOT fall through to a lower layer (test `does not fall through to another layer for a missing sibling`).

### 1.2 SKILL.md format (`packages/lib/src/skills.ts`)

A skill = a folder directly containing `SKILL.md`. Folder name is the skill name. Folders starting with `.` and `node_modules` are skipped; a folder that has `SKILL.md` is never searched deeper (no nested skills); `SKILL.md` in the root itself is ignored (`dir !== root`); each real dir visited once (`realpath` set, so symlink loops are safe). There is NO depth limit.

| Frontmatter key | Meaning |
| --- | --- |
| `name` | optional; if present must equal the folder name or the skill is silently dropped |
| `description` | **required**, non-empty after trim, else silently dropped (no log, no diagnostic) |
| `disable-model-invocation: true` | hidden from `<available-skills>`; user can still pick it as a slash chip. NOT enforced in `readSkillByName`, so the model can still load it if it guesses the name |
| `disable-user-invocation: true` | hidden from the user-facing catalog (`publicSkillCatalog`) but still listed to the model |

Not read at all: `allowed-tools`, `argument-hint`, `model`, `context`, `user-invocable` (Claude Code's name for the inverse of `disable-user-invocation`), `when_to_use`, `agents/openai.yaml` (Codex). Skills authored for Claude Code that rely on those lose them silently.

Parser quirks (`splitSkillMarkdown`, `parseFrontmatterField`, `parseBooleanField`): hand-rolled, no YAML library. BOM stripped. Frontmatter must start at char 0 with `---` and close with `\n---`, otherwise the whole file is body and the skill has no description (dropped). Keys must start at column 0. Scalars: surrounding quotes stripped, no escapes, no inline comments. `>`, `>-`, `|`, `|-` blocks are joined with single spaces (literal newlines are NOT preserved even for `|`). Booleans: only `true`/`yes` are truthy, anything else is `false`. No lists/maps (`tools:` for agents is whitespace/comma split in `workspace-agents.ts`).

Name rule `isValidSkillName`: `/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/`, no `..`, `/`, `\`. Applies to the skill folder AND to every path segment of a file request. So a file named `_notes.md`, `.hidden`, `my file.md` or with non-ASCII chars cannot be loaded through the Skill tool.

### 1.3 Catalog cache and fingerprint

`loadSkillsCatalog()` (`workspace-skills.ts:162`): on EVERY call it re-walks all roots (`findSkillFiles`, level by level with sequential awaits, plus a `stat` of each `SKILL.md`), builds `fingerprint = JSON.stringify(files)` where each entry is `{name, dir, mtimeMs, size}`, and only reuses the cached parsed catalog when that string is identical. So the cache saves reads and parsing, not directory traversal. One global cache entry (single project). Editing a SKILL.md changes mtime/size, so no explicit invalidation is needed (test `reloads a nested skill whose SKILL.md changed without clearing the cache`). Callers: system prompt build, every `Skill` call, every slash block, subagent system build, `InstallPlugin` result, catalog publish.

Cost note for a big `~/.claude/skills`: each Skill call walks the whole tree. Fine for tens of skills; a port should add a watcher-driven or TTL cache.

### 1.4 Limits and numbers

| Value | Where | What |
| --- | --- | --- |
| `MAX_SKILL_BODY_CHARS = 50_000 * 4` = 200,000 chars | `workspace-skills.ts:30` | cap per Skill load (SKILL.md body or any file); suffix `_(Truncated; skill file exceeds maximum length.)_` |
| none | `formatAvailableSkills` | NO cap on number of skills or description length in the prompt catalog. Codex caps its list at 2% of context (8,000 chars if unknown, `skills.max_context_tokens` up to 10,000). A big global skill set would bloat Reforma's prompt |
| `RELOAD_DEBOUNCE_MS = 300` | `skills-sync.ts:19` | fs-watch debounce |
| `MAX_RULE_CHARS = 10 * 1024` | `workspace-rules.ts:14` | per plugin rule |
| `MAX_AGENT_BODY_CHARS = 32 * 1024` | `subagents/workspace-agents.ts:22` | declared subagent body (`agents/*.md`); `tool-groups.ts:190` has `MCP_NAMESPACE_INSTRUCTIONS_CHARS = 280` |

### 1.5 Path containment and symlink rules

- Skill file request `name` = `skill` or `skill/rel/path`. `parseSkillRequest` splits on first `/`, validates each segment, then `containedSkillFile` does a LEXICAL check (`path.resolve(root, rel)` must start with `root + sep`).
- Non-global skills then go through `validatePath(file)` (`apps/sandbox/src/core/files/path.ts:172`): realpath must stay inside `defaultAllowedDirs()` (project, project config, system folder, plugins, scratch `/tmp/reforma` + `/mnt/reforma`, `/tmp`, deploy folder, global roots while on). A symlink inside a project skill pointing outside is rejected. Global skills skip `validatePath` entirely (user-owned, symlinks anywhere, even out of the skill folder).
- Discovery uses the same predicate as `follow` (`isAllowedPath`) for non-global roots: a symlinked skill folder or symlinked `SKILL.md` is followed only if its real target is allowed. A non-global root that is itself not allowed yields zero skills.
- The Skill result returns the absolute `directory` so the agent can reach scripts the skill mentions (via Bash/Read).
- Binary files inside a skill are read as utf-8 text with no binary guard (`readFileHelper`).

### 1.6 Prompt injection, Skill tool, slash skills, global switch

- **Catalog in prompt:** `skillsInfo(catalog)` = always-on plugin `<rules>` + `<available-skills>`: preface line `Skills: summaries below; call Skill(name) to load full playbook when a skill might apply.` then `<skill name="x">description</skill>` per entry (via `wrapSystem` XML-ish tags). Skills with `disable-model-invocation` are omitted. Built in `AgentProfile.buildSystem` (`profiles/agent-profile.ts:524`) and `SubagentProfile.buildChildSystem` (only when the child has the `Skill` tool).
- **Frozen:** the whole system prompt is frozen per thread (`thread.frozenSystem`, `helpers/runtime-context.ts`); skill changes appear in a NEW chat or after compaction (`thawFrozenSystem`). That is why `InstallPlugin` echoes the plugin's skills/rules/MCP into its tool result.
- **Skill tool** (`tools/skill/Skill.ts`): input `{name}` (`plan` or `plan/openui-reference.md`), output `{content?, directory?, error?}`. No approval, not deferred. SKILL.md returns frontmatter-stripped body; other files return trimmed raw text. Empty body is an error. Errors: `Invalid skill name`, `Unknown skill`, `Unknown skill file`, `Skill file is empty`, `Could not read skill`.
- **User-invoked ("slash") skills:** the client sends names in `message.metadata.skills` (legacy `commands` folded in); `assembleUserTurn` (`helpers/messages/wrap-user-message.ts:440`) loads each and prepends `<invoked-skill name="x" directory="/abs">body</invoked-skill>` to the user turn together with opt-plugins, hook context, project memory and selection context. `dropRepeatedSkillAttachments` (`sanitize-ui-messages.ts:464`) keeps only the first listing of a name in the window (no content hash; reloaded when the first copy leaves the window). `/summarize` is reserved for compaction. The onboarding profile force-tags `['onboarding']`.
- **Global skills switch:** desktop stores `<userData>/skills.json` = `{enabled:boolean, disabled:string[]}` (deny list, so new skills start on). Controller env `GLOBAL_SKILLS_FOLDERS` (path-delimited, highest first) + `GLOBAL_SKILLS_SETTINGS`. `core/global-skills.ts` re-reads the file when `mtime:size` changes; any parse/stat error means OFF. Deny list filters only global roots. While on, both folders join the allowed read dirs; in the macOS/Linux sandbox they are read-only.
- **Watching** (`skills-sync.ts`): recursive `fs.watch` on project config, system folder, plugins folder (events filtered to paths containing a `skills` segment), each global root (all events), and the DIRECTORY holding `skills.json` (an atomic save replaces the file a watcher holds). 300 ms debounce, then clear cache and push `PLUGINS_UPDATED_EVENT` via `setSync` only if JSON changed. Watchers do not follow symlinks out of roots, so a linked skill's list can lag while reads stay current.

### 1.7 Parts table

| Part | File:symbol | Deps | Verdict |
| --- | --- | --- | --- |
| Discovery, parse, name rule | `packages/lib/src/skills.ts`: `findSkillFiles`, `readSkills`, `splitSkillMarkdown`, `parseSkillFrontmatter`, `isValidSkillName` | node:fs only | PORT-WITH-CHANGES: swap hand parser for a YAML lib, accept `user-invocable`, `allowed-tools`, `when_to_use`; log dropped skills; add description cap. Under (b) still useful for Clowdy's own skills UI and to expose `~/.agents/skills` to Claude (it only reads `.claude/skills`) |
| Layered catalog | `workspace-skills.ts`: `skillsRoots`, `loadSkillsCatalog`, `mergeSkillCatalogs`, `readSkillByName`, `containedSkillFile` | `config`, `validatePath`, `globalSkills`, plugin dirs | PORT-WITH-CHANGES for (a): pass roots in, key cache per project, drop plugin/system roots. SKIP for (b) |
| Skill tool | `tools/skill/Skill.ts` | `ai` `tool`, zod | PORT-AS-IS for (a) once the above is ported |
| Prompt block | `skills-info.ts: formatAvailableSkills` | `wrapSystem` | REWRITE-USING-IDEA: add budget cap like Codex |
| Slash blocks | `slash-skills.ts` | message metadata shape | REWRITE-USING-IDEA: Claude SDK dispatches `/name` itself, Codex uses `$name` |
| Global switch | `core/global-skills.ts` (66 lines), `apps/desktop/src/skills.ts` (74 lines) | desktop settings | PORT-WITH-CHANGES: becomes a daemon setting with a deny list |
| Watcher | `skills-sync.ts: watchSkills`, `isSkillsPath` | `setSync` channel | REWRITE-USING-IDEA (debounced watch of dirs, not files) |
| Plugin rules | `workspace-rules.ts` (`rules/*.{md,mdc,markdown}`, 10 KB each, injected every turn, concatenated, no name override) | plugin dirs | SKIP: this is `CLAUDE.md` / `AGENTS.md` in engines |
| System skills | `packages/reforma-system/skills/*` (design, plan, tokens, nextjs, seo, shadcn, stories, svg, fonts, analytics, onboarding) | web-project tools | SKIP: Reforma website-builder content |

### 1.8 What the engines give natively (verified from docs, Nov 2026)

| Capability | Reforma | Claude Code / Agent SDK | Codex |
| --- | --- | --- | --- |
| Roots | global `.agents` + `.claude`, system, plugins, project | `~/.claude/skills`, `<cwd>/.claude/skills` up to repo root, `additionalDirectories`, plugin skills; gated by `settingSources` (`'user'`, `'project'`; both on by default, an explicit list without them loads none) | `.agents/skills` from cwd up to repo root, `$HOME/.agents/skills`, `/etc/codex/skills`, bundled system skills; follows symlinks; same-name skills are NOT merged |
| Invocation | Skill tool + metadata chips | built-in Skill tool; `skills` option (`"all"`, name list, `[]`; plugin skills `plugin:skill`); `/name` dispatch; init message lists `skills` | implicit by description, explicit `$skill`; `agents/openai.yaml` `policy.allow_implicit_invocation` |
| Frontmatter | name, description, 2 flags | adds `allowed-tools`, `user-invocable`, `when_to_use`, `$ARGUMENTS`, `` !`cmd` `` injection | `name`, `description`; `openai.yaml` for UI/deps |
| Prompt budget | none | not documented here | 2% of context or 8,000 chars; `skills.max_context_tokens` (max 10,000); descriptions shortened first |
| Disable one | global deny list | `skills` allow list | `[[skills.config]]` `enabled=false` by name or path |

Redundant under (b). To expose the user's `~/.agents/skills` to Claude, symlink/mirror into a Clowdy-owned `.claude/skills` or pass `plugins`/`additionalDirectories` (to verify).

## 2. Memory

Design: ONE scope, per project, semantic facts, recalled at message send time. Files `apps/sandbox/src/chat/agent/memory/{constants,embed,recall,store}.ts` (344 lines) + `tools/remember/{Remember,Forget}.ts`.

| Item | Detail |
| --- | --- |
| Storage | `node:sqlite` `DatabaseSync` at `PROJECT_CONFIG_FOLDER/memory.db` (`<ws>/.reforma/memory.db`), table `memories(id, section, text, embedding BLOB, created_at, updated_at)` + index on `section`. Opened lazily, one module-level handle |
| Sections | `never` (hard prohibitions), `facts` (stable truths, default), `decisions` (enduring choices). Enum `PROJECT_MEMORY_SECTIONS` |
| Identity | `id = sha256(section + "\n" + trimmed text)` first 16 hex; same section+text upserts (keeps `created_at`) |
| Embeddings | `POST {LLM_API_URL}/v1/embeddings`, model `text-embedding-3-small`, via `gatewayFetch` (LiteLLM, run-stamped billing). Stored as Float32 BLOB. Failure of `Remember` throws; failure of recall is swallowed (`logger.warn`, turn proceeds) |
| Recall | `PROJECT_MEMORY_RECALL_LIMIT = 5`, `PROJECT_MEMORY_MIN_SCORE = 0.25` cosine. Loads ALL rows and scores in JS (O(n)); no vector index. No dimension check if the embed model changes |
| Limits | none on fact length or total count; one fact per `Remember` call |
| Tools | `Remember({fact, section})`, `Forget({id? section? text? all?})`. Both `DYNAMIC_TOOL` (deferred), in the `memory` group with `ListChats/SearchChats/ReadChat`. Not given to subagents. Writes take the `worktree` mutex (shared with file ops) |
| Prompt guidance | `packages/reforma-system/rules/project.md`: remember stable truths, prohibitions, explicit requests, never chat/task progress; forget stale facts |
| Injection | NOT in the system prompt. `tagTurnMessages` (`chat/threads/helpers.ts:682`, only when the last message is a user message) calls `recallProjectMemoryFacts(userText)` and stamps `metadata.projectMemory` (a frozen copy, persisted with the message). `assembleUserTurn` renders `<project-memory>` lines `- [section] text` inside the user turn. Keeps the system prefix cache-stable |

Verdict REWRITE-USING-IDEA. Ideas worth keeping: sectioned facts with a hard `never` bucket, recall-at-send frozen on the user message (cache-friendly, replayable), recall failure never blocks a turn. Do not port: embedding dependency on a gateway, brute-force scan, `worktree` mutex coupling. Natively: Claude Code has `CLAUDE.md` (loaded via `settingSources`) and Codex has `AGENTS.md`; a daemon-level "facts" markdown file injected into the task prompt is enough for MVP. If semantic recall is wanted later use local FTS5 or a local embedding model, and check Node/Electron `node:sqlite` availability first.

## 3. MCP and dynamic tools

### 3.1 Config

- Format (`core/workspace/preferences-service.ts`): `{ "mcpServers": { "<id>": entry } }`, same envelope as `.mcp.json`. Exactly one of `url` (streamable HTTP, optional `headers`) or `command` (stdio, `args`, `env`, `cwd` default project folder); both or neither -> skipped with a warning. The `type` field (e.g. `streamable-http` in catalog files) is ignored, transport is inferred. Legacy SSE is not implemented.
- Shared fields: `description` (shown in the prompt), `tools` (packed schema map `name -> {title, description, inputSchema, outputSchema}`), `allow` (alias `allowed`, or Cursor-style `tools: {allow:[...]}`), `blacklisted`, `resources`, `resourceTemplates` (index only, no bodies). `${VAR}` placeholders are substituted server-side by the API before the sandbox sees them.
- Layers (`PreferencesService.load`): system `REFORMA_SYSTEM_FOLDER/mcp.json` (cached once per process; ships `context7` and `google_maps` through the LiteLLM gateway, `packages/reforma-system/mcp.json`) < plugin `PLUGINS_FOLDER/<id>/mcp.json` < project `.reforma/mcp.json`. Plugin server ids are reserved and removed from the project layer. Project dir watched (non-recursive, filename match), 300 ms debounce; changes take effect at the next run's `mcp.reload`.
- Allow/deny semantics (handshake, `mcp-connection-manager.ts:779`): if `tools` map is present it is the ONLY filter (live tools not in it are dropped, and `allow`/`blacklisted` are ignored). Otherwise `allow` first, then `blacklisted`. Matching uses the bare name after stripping `<server>-` / `<server>__` prefixes and folding `-` to `_` (`mcpToolNamesEqual`). Catalog key is `<server>__<tool>`.

### 3.2 Connection manager (`McpConnectionManager`, 1158 lines)

Process-wide singleton (`McpConnectionManager.create()`), one `@ai-sdk/mcp` client per server, tools cached after connect.

| Behaviour | Detail |
| --- | --- |
| Reload | `reload(config)` at every run start (`createRuntimeContext`) and after plugin hydrate. Drops removed servers, compares `connectionFingerprint` (transport, url/headers or command/args/env/cwd, tools, allow, blacklisted); unchanged + ready/connecting/error -> skip. Handshakes run in the BACKGROUND, not awaited by the run |
| States | `McpRuntimeStatus`: `connecting`, `ready`, `unauthorized`, `error` (`packages/types/src/sandbox/tools/mcp-tools.ts`). `error` is sticky until a call (`ensureConnected` restarts the handshake) or a config change; `unauthorized` is retried by `reload({retryUnauthorized:true})` |
| Timeouts | `MCP_HANDSHAKE_TIMEOUT_MS = 15_000` (connect + `tools()`; aborts and closes transport). PRM probe 3,000 ms. No per-tool-call timeout here (only the run abort signal) |
| Stale-handshake guard | after each await it checks `entries.get(id) === entry`, else closes the client |
| Liveness | NO onclose/reconnect handling: a server that dies mid-session stays `ready` until a call fails. Claude Code reconnects 5 times and exposes `reconnectMcpServer()` |
| Instructions | `client.instructions` (initialize) stored per server; clipped to 280 chars (`MCP_NAMESPACE_INSTRUCTIONS_CHARS`) in OpenAI namespace blurbs |
| Output | tool result returned raw (`CallToolResult`); on a thrown error or `isError` result, `mcpInputMismatch` appends a schema explanation (`z.fromJSONSchema` against the catalog schema). It never blocks a call. NO size cap in this layer. Claude Code caps at 25,000 tokens / 50,000 chars and spills to a file |
| Resources | `listResourceIndex` (packed index, else one lazy `listResources`+templates cached per connection), `readResource` |
| Transports | HTTP: `@modelcontextprotocol/sdk` `StreamableHTTPClientTransport`, chosen over `@ai-sdk/mcp`'s own because the AI SDK client sends `mcp-protocol-version: 2025-11-25` before negotiation and some servers (Next.js devtools, max 2025-06-18) reject it. Static `Authorization` header is stripped; token injected per request by a fetch wrapper. Stdio: SDK `StdioClientTransport` launched through `buildInvocation` (bubblewrap/Seatbelt, cleared env, `BASE_ENV_ALLOWLIST`; controller env NOT inherited) |

### 3.3 Authentication

1. Detect: `readMcpErrorSignal` walks the `.cause` chain (the AI SDK nests errors) for `statusCode/httpStatus/status/code`, `scope=` from `WWW-Authenticate` or message, and `insufficient_scope`. `UnauthorizedError` or 401 -> unauthorized; 403 only with `insufficient_scope`. Servers configured with a non-`Authorization` header (x-api-key etc.) are never treated as OAuth: 401 becomes `error`.
2. Lazy-auth servers (initialize and `tools/list` succeed with no token, e.g. Google Drive MCP): after a successful handshake with no token and no header credential, `probeOauthProtectedResource` (RFC 9728, tries `/.well-known/oauth-protected-resource/<path>` then root, 3 s each) -> if `authorization_servers` is non-empty mark `unauthorized` (tools stay listed).
3. Surface: `McpAuth({server})` tool: `needsApproval` is true only when, after `whenSettled`, the server is `unauthorized`. UI shows Login/Skip card; Login = Reforma API OAuth popup. Execute just waits for settle and returns the refreshed catalog. `CallDynamicTool` on an unauthorized server throws `Unauthorized. Call McpAuth to authorize, then retry.`
4. Tokens (Reforma-only): API vault -> `POST /integrations/sync` -> `setIntegrationAuth` -> `getMcpAccessToken(serverId)`; refresh `REFRESH_SKEW_MS = 60_000` before `expiresAt` via `GET /projects/:id/integrations/:id/auth/token` with the pod token, in-flight refresh deduped (`refreshInflight`). Composio sessions and `apiProxy` URLs ride the same bag. LiteLLM-origin URLs get `x-litellm-api-key` stamped.
5. API-side OAuth client `apps/api/src/projects/integrations/mcp-oauth-client.ts` (677 lines, pure functions): PRM -> AS metadata (RFC 8414) -> S256 PKCE required -> registration via pre-registered / CIMD / DCR, `resource` param (RFC 8707), `iss` check flag, `exchangeCode`, `refreshTokens`. Tied to `publicFetch` and `isAllowedMcpUrl` SSRF guard (refuses localhost, which a local app needs). Reference for a Clowdy OAuth flow; prefer the `@modelcontextprotocol/sdk` auth helpers (`OAuthClientProvider`) and keep tokens in the OS keychain.

### 3.4 Dynamic tools (progressive tool disclosure)

Why: keep the tool prefix byte-stable for provider prompt caches and keep rarely used tool schemas out of context. `activeTools` is never shrunk per step.

- A builtin tool tagged `providerOptions.reforma.dynamic` (`tools/shared/dynamic-tool.ts`) is "deferred". Builtin groups are named in `tools/tool-groups.ts` (`files, preview, development, planning, memory, integrations, media, bash, agents, http`).
- Mode A, `familyHasToolSearch` (`models/resolve-provider-tools.ts:20`): true ONLY for OpenAI with a normal API key (false for ChatGPT OAuth, "plan usage rejects `tool_search`"). Every frozen MCP tool becomes a typed deferred function `server__tool` (`deferred-tools.ts: mcpToolsFromSnapshot`) with `deferLoading`, grouped into OpenAI namespaces, plus hosted `ToolSearch`. MCP snapshot frozen per thread (`thread.frozenMcp`, thawed on compaction).
- Mode B (Claude, Gemini, Grok, ChatGPT-OAuth): only eager tools + `GetDynamicTools` + `CallDynamicTool` are advertised. System prompt carries a `<dynamic-namespaces>` TOC (`profiles/instructions/mcp-servers.ts`): per namespace its description, status if not ready, `resources: use GetMcpResources`, and `tools: a, b, c` (names only). The model calls `GetDynamicTools({namespace, tool?})` for schemas, then `CallDynamicTool({namespace, tool, input})`.
- NOTE: `.briefback/docs/agent/model-context.md` claims Anthropic gets native tool search; the code says only OpenAI. Trust the code.
- `GetDynamicTools` output schemas are compacted (`helpers.ts: catalogInputSchema`: `$ref/$defs` inlined with a cycle guard; only type/required/enum/const/properties/items/additionalProperties/anyOf/oneOf/allOf kept, prose dropped). `deferredToolSignature` renders call shapes like `TodoWrite({ todos: [{ id?, content, status?: a | b }] })`, depth limit 3.
- `executeCallDynamicTool` order: builtin group + deferred tool -> `safeParse` with a model-readable error `Invalid input for ns.tool: <issues>\nInput schema: {...}`; no `execute` -> delegated to the editor over the stream (`client-tool-delegate.ts`, `CLIENT_TOOL_TIMEOUT_MS = 20_000`); else MCP namespace -> must be configured, status gate, `callMcpToolExplained`. Unknown namespace error lists available ones.
- `repair-deferred-tool-call.ts`: AI SDK `NoSuchToolError` on a direct call to a deferred builtin is rewritten to `CallDynamicTool` before parsing.
- Subagents: declared agent frontmatter `mcp: true` adds `GetDynamicTools, McpAuth, GetMcpResources, CallDynamicTool` (+ `InstallPlugin` only for non-readonly agents without an explicit `tools:` list); `tools:` names must be in `DECLARABLE_TOOLS` or the agent errors. `child-profile.ts: enableMcp` per phase.
- No per-call approval for MCP tools (only `McpAuth` and `InstallPlugin` use `needsApproval`); permissions are handled by hooks elsewhere.

### 3.5 Parts table

| Part | File:symbol | Deps | Verdict |
| --- | --- | --- | --- |
| Name/schema normalisers | `mcp-client/mcp-configured-tools.ts` (117 lines), `packages/lib/src/mcp.ts` | types only | PORT-AS-IS (needed only if we match tool names ourselves, i.e. (a) or an allow/deny UI) |
| Connection manager | `McpConnectionManager` | `@ai-sdk/mcp`, `ai` Tool, `config.LLM_*`, `getMcpAccessToken`, `buildInvocation` | (a) PORT-WITH-CHANGES: remove LiteLLM stamping and Reforma token source, make it per-project, add onclose/reconnect and tool timeout. (b) REWRITE: keep status model + error classification, drive from engine status calls |
| Error signal + PRM probe | `readMcpErrorSignal`, `isUnauthorizedSignal`, `mcp-oauth-prm.ts` (111 lines) | none | PORT-AS-IS: useful whenever we show MCP health or login state |
| Transports | `sdk-mcp-transport.ts`, `sdk-mcp-stdio-transport.ts` | `@modelcontextprotocol/sdk`, bwrap | PORT-WITH-CHANGES (a): keep the protocol-version workaround, replace sandboxing with plain spawn using the user's env/PATH. (b) SKIP |
| Dynamic gateway | `GetDynamicTools`, `CallDynamicTool`, `helpers.ts`, `deferred-tools.ts`, `repair-deferred-tool-call.ts`, `tool-groups.ts` | provider family logic, editor client tools, builtin group names | REWRITE-USING-IDEA. Reusable bits: schema compaction, mismatch explainer, TOC format. (b) SKIP: engines defer natively |
| `McpAuth` tool + `mcp-runtime-auth.ts` | see 3.3 | Reforma API vault, Composio | SKIP (idea: approval gate when status = unauthorized) |
| `GetMcpResources` | `tools/mcp-tools/GetMcpResources.ts` (173 lines): list or read, `downloadPath` writes text/base64 blob into the workspace, rejects unfilled `{template}` URIs | `validateAgentPath` | PORT-WITH-CHANGES (a) / SKIP (b) |
| Config layering | `PreferencesService` | `config.*`, plugin dirs | REWRITE-USING-IDEA: keep the `.mcp.json`-compatible envelope, add Clowdy global + per-project layers |

### 3.6 What the engines give natively

| Capability | Claude Agent SDK | Codex |
| --- | --- | --- |
| Config | `mcpServers` option: stdio, `http`, `sse`, in-process SDK servers (`createSdkMcpServer`); `.mcp.json` via `'project'` setting source; `${VAR}` expansion | `~/.codex/config.toml` `[mcp_servers.<name>]`, project `.codex/config.toml` (trusted only), stdio + streamable HTTP; per-thread config via SDK/app-server not documented on the MCP page |
| Allow/deny | `allowedTools` / `disallowedTools` with `mcp__<server>__<tool>` and `mcp__<server>__*` (`.`/space in server name become `_`) | `enabled_tools` (allow), `disabled_tools` (deny after), `default_tools_approval_mode` (`auto/prompt/writes/approve`), per-tool `approval_mode` |
| Status | init message `mcp_servers[].status` = `pending/connected/failed/needs-auth/disabled`, `mcpServerStatus()`, `reconnectMcpServer()` (auto-reconnect 5x) | not documented here |
| Auth | NO browser OAuth in the SDK: reports `needs-auth`; app must run OAuth and pass `headers.Authorization`, or reuse an interactive Claude Code login on the same machine | `codex mcp login <name>` (`--no-browser`); `bearer_token_env_var`, `http_headers`, `env_http_headers` |
| Timeouts | `MCP_TIMEOUT` 30 s connect, `MCP_TOOL_TIMEOUT`, `CLAUDE_CODE_MCP_STARTUP_WAIT_MS` | `startup_timeout_sec` 10, `tool_timeout_sec` 60 |
| Deferral | tool search on by default (`ENABLE_TOOL_SEARCH`), `alwaysLoad: true` per server | n/a verified |
| Output cap | 25,000 tokens, text over 50,000 chars saved to a file | n/a verified |

Conclusion for (b): the manager, dynamic gateway, `CallDynamicTool`, resources tool are redundant. Clowdy still must own: the MCP server store/UI, OAuth for remote servers (Claude SDK will not), and token handoff (headers for Claude; Codex needs its own login or env-var bearer).

## 4. Plugins

A "plugin" is a folder under `PLUGINS_FOLDER/<id>` (`/opt/reforma/plugins`; `<id>` with `:` replaced by `_`, so `custom_<uuid>`). Every loader enumerates `listPluginPackageDirs()` (skips `*.tmp`, sorted) and reads a fixed sub-layout: `skills/`, `agents/`, `rules/`, `mcp.json`, `hooks/hooks.json`, `plugin.json` (schema `agent-plugins.org` 1.0.0 with a `extensions.reforma` block: logo, interface, agent.mentions, category). This convention (one folder, several optional parts, each part layered by its own loader) is the only reusable piece. It is close to, but not the same as, Claude's `.claude-plugin/plugin.json` + `.mcp.json` layout.

Lifecycle (all Reforma Cloud): `reconcileIntegrations` (`core/integrations/integrations-sync.ts`, under the `integrations` mutex) fetches `GET /projects/:id/integrations/runtime` -> `{plugins, custom, playbooks, auth}`; per catalog plugin fetches `GET /integrations/catalog/:id/package` -> `files[{path,content}]` (images stripped, UTF-8 only); writes atomically (`<dest>.<pid>.tmp` then rename, path-traversal check `assertSafeRelativePath`); runs Install/Uninstall plugin hooks (`dispatchPluginLifecycleHook`); prunes folders not in the runtime; reloads MCP (`retryUnauthorized: true`), clears the agents cache, republishes the catalog. API failure retries every `HYDRATE_RETRY_MS = 60_000`. User playbooks are materialized as `rules/<name>.md` or `skills/<name>/SKILL.md` (mode `command` adds `disable-model-invocation: true`); custom MCP becomes a generated `mcp.json`. `InstallPlugin({id})` is a deferred tool: PATCHes the API, waits up to `INSTALL_WAIT_MS = 60_000` (poll 200 ms), `needsApproval` unless `manifest.agent.installApproval === false`, and returns the plugin's skills/rules/MCP TOC in system-prompt shape. `<opt-plugins>` in the user turn is built from `agent.mentions` keywords.

Catalog (`apps/api/.catalog`, gitignored, `.plugins-sha` = `386864a8...`, fetched from the `reforma-ai/plugins` release `catalog-<sha>` by `fetch-integrations-catalog.ts`): 62 plugin dirs in 16 categories; 43 have `mcp.json`, 28 `skills/`, 9 `rules/` (the "mood" plugins), 3 `agents/` (games), 5 hooks, 0 `tools.mjs`.

Verdict SKIP for all machinery (API, vault, Composio, Reforma OAuth, marketplace UI). Selective content reuse is possible by copying skills from `.catalog/{motion-design,frontend-design,web-design-guidelines,react-best-practices}/skills` after checking each plugin's license (`motion-design` ships `LICENSE.txt`). Under (b), Claude's `plugins` option and Codex plugin support make our own plugin runtime unnecessary for MVP.

## 5. Porting checklist

1. Make every root explicit (`{project, user, builtin}`) and key caches by project id.
2. Add a prompt-size budget for the skill catalog (Reforma has none).
3. Decide skill frontmatter compatibility: accept Claude's `user-invocable`, `allowed-tools`; keep `disable-model-invocation`.
4. Own MCP status and OAuth in the daemon; pass tokens/headers to the engine.
5. Do not carry over: LiteLLM headers, `getRequestProjectId` ALS, `worktree` mutex, bwrap `buildInvocation`, `setSync` channel, `PLUGINS_FOLDER`/`REFORMA_SYSTEM_FOLDER` constants.
6. Cross-note: ChatGPT subscription OAuth already exists in Reforma as an inference kind (`models/inference-harness.ts`, `kind: 'oauth'`); covered by the models/engine notes, not here.

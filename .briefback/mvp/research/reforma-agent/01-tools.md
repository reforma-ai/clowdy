# Reforma agent: tool inventory (01-tools)

Scope: `apps/sandbox/src/chat/agent/tools` + registry + profile selection + the core services the tools sit on. Paths are relative to the Reforma repo root. Everything below was read in code (AI SDK `ai@7.0.31`, `zod@4`, 2026-11 checkout); nothing was run.

Path aliases: `T` = `apps/sandbox/src/chat/agent/tools`, `H` = `apps/sandbox/src/chat/agent/helpers`, `C` = `apps/sandbox/src/core`, `S` = `apps/sandbox/src`.

Verdict notation: **a** = keep the Vercel AI SDK loop and reuse the code; **b** = engine (Claude Agent SDK / Codex SDK) owns the loop, we reuse only logic/prompts/schemas. `AS-IS` / `CHG` (port with changes) / `IDEA` (rewrite using the idea) / `SKIP`. "native" = Claude Code / Codex already ship an equivalent (from their docs, not from this repo: confirm against the pinned SDK version).

## 0. TL;DR

- 45 tools in the default profile (`T/index.ts` barrel) + `Preamble` (merged for every run) + 4 onboarding-only (`ScaffoldProject`, `ChooseDesignDirection`, `CommitDesignRead`, `MarkProjectReady`). `Publish` and `ListVersions` exist but are only reachable through the inbound-MCP dispatch (`S/api/tools/dispatch.ts`), not the agent.
- Worth keeping (logic, not the tools themselves): the **edit engine** (`C/files/file-edit.ts`), the **path guard** (`C/files/path.ts`), the **background-job mailbox** (`ThreadSession.registerBackgroundJob/enqueueBackgroundResult/takeBackgroundResults` + `H/step-notes.ts`), the **tool-loop guard** (`H/tool-loop-guard.ts`), `spillIfLarge`, the Read **dedup cache**, project **memory** (swap the embedder), chat-history **search/transcript** digest, **AskUserQuestion** schema validation, per-edit **lint feedback**.
- Everything web/project specific (14 + 4 onboarding tools) is SKIP. The MCP "dynamic gateway" (4 tools + `tool-groups.ts` + `repair-deferred-tool-call.ts`) is a hand-built tool-search; both Claude and OpenAI have native tool search/MCP, so SKIP.
- Biggest port blocker: tools read the global `config.PROJECT_FOLDER` and take one global `withMutex('worktree')`. One controller process = one project. Clowdy runs many worktrees in one daemon, so every path/lock must become per-agent (see section 6).
- Reforma already runs these tools without the agent loop: `dispatchTool` calls `execute(input, { toolCallId: 'mcp', messages: [] })` for 18 tools (Bash, Commit, CreateDirectory, DevServerRestart/Status, Edit, Glob, Grep, ImportAsset, InstallDeps, ListDirectory, ListVersions, MoveFile, Publish, Read, ReadLints, RemoveFile, Write). Proof that file/shell tools tolerate a missing `RuntimeContext`. Wrapping them as in-process MCP tools is cheap.

## 1. Registry and profile-based selection

| Part | file:symbol | What it does |
| --- | --- | --- |
| Barrel | `T/index.ts` | `export { X } from './x'` per tool; type-only exports for the 4 onboarding tools (factory/profile tools) |
| Type + order | `H/tool-sync.ts`: `ReformaToolCatalog`, `REFORMA_TOOL_ORDER`, `resolveAgentToolOrder` | Fixed provider-visible order (Preamble, Read, ListDirectory, Glob, Grep, MCP gateway, Edit, Write, ..., Bash, Agent, plans, ..., Commit, GetBackgroundResult last). Unknowns sorted A-Z after. Order is passed as `toolOrder` in `prepareStep` and tested (`S/specs/chat/tools/tool-order.test.ts`). Reason: stable prompt-cache prefix |
| Profile | `S/chat/agent/profiles/agent-profile.ts`: `AgentProfile.resolveTools()` | Default profile = `{ ...reformaTools }` (the whole barrel). No allow/deny list, no per-model filtering |
| Onboarding | `profiles/onboarding.ts`: `buildPhases` | 3 phases with explicit tool maps (template: ScaffoldProject, AskUserQuestion, Read, WebSearch, Fetch, PageScreenshot, MCP gateway; direction: Skill, ImageGen, ChooseDesignDirection, ...; build: default set + MarkProjectReady [+ CommitDesignRead]). `prepareStep` returns `toolChoice: 'required'` in the first two; `stopWhen` hands off to the next phase |
| Subagent profile | `S/chat/agent/subagents/child-profile.ts`: `readonlyTools()` (10), `writeTools()` (14), `DECLARABLE_TOOLS` | Child gets either a preset (`readonly: true` => 10 read tools + ReadLints; else the 14 write tools) or the frontmatter `tools:` list (unknown name throws `Agent X declares unknown tool`). `mcp: true` adds the 4 MCP tools (+InstallPlugin when not readonly). Children never get Agent (no nesting), TodoWrite, plans, AskUserQuestion, Waiting, Remember |
| Built-in subagents | `packages/reforma-system/agents/*.md` | advisor (Read, Glob, Grep, ListDirectory, Fetch, Skill), code (+Write, Edit, CreateDirectory, RemoveFile, ReadLints), research (lite model, + WebSearch, CheckPage, PageScreenshot, mcp), review (read-only), shell (Bash, Read, Write, Edit, Glob, ListDirectory, Fetch, ImportAsset) |
| Assembly | `H/runtime-context.ts`: `createRuntimeContext` | `{...profile tools, ...frozen MCP tools, ...modelOptions.extraTools, Preamble, ...hosted ToolSearch}` -> `wrapToolsWithHooks` -> `applyToolGroups` (OpenAI namespaces) -> `withHostedDeferLoading` -> `advertiseToolsForFamily` -> `withCachedLastTool` (cache breakpoint on the last tool) |
| Deferral ("Dynamic gateway") | `T/shared/dynamic-tool.ts` (`DYNAMIC_TOOL` marker), `T/tool-groups.ts` (`BUILTIN_TOOL_GROUPS`: files, preview, development, planning, memory, integrations, media, bash, agents, http) | 17 tools are eager (Agent, AskUserQuestion, Bash, Commit, Edit, Fetch, Glob, Grep, ListDirectory, Read, Skill, CreatePlan, EditPlan, ReadPlan, Waiting, WebSearch, Write). 26 builtins carry `providerOptions.reforma.dynamic` and are removed from the wire on non-OpenAI families; the model discovers them via `GetDynamicTools` and calls `CallDynamicTool {namespace, tool, input}`. A direct call to a deferred name is rewritten by `repairToolCall` (`T/mcp-tools/repair-deferred-tool-call.ts`). OpenAI gets hosted `tool_search` + `deferLoading` + namespaces, except ChatGPT-OAuth inference (`familyHasToolSearch` returns false) |
| Tool wrapper | `S/chat/agent/hooks/hook-runner.ts`: `wrapToolsWithHooks` | Every tool with `execute` is wrapped with Claude-shaped command hooks: PreToolUse (deny via exit 2, `updatedInput`, extra context), PostToolUse (`updatedToolOutput`, block), PostToolUseFailure. Default hook timeout 30 s, injected context capped at 10,000 chars. Config `.reforma/hooks/hooks.json` |

Verdicts: barrel/order/assembly/deferral: a: IDEA (keep "stable ordered catalog + cache breakpoint"), b: SKIP (engine owns the tool list). Profile = tool-subset-per-role pattern: IDEA (map to Claude `allowedTools`/subagent `tools:` frontmatter, which already has the same syntax as `packages/reforma-system/agents/*.md`). Hook wrapper: a: AS-IS (it is already Claude-hook-compatible), b: SKIP for Claude (native hooks), keep only if Codex path needs parity.

## 2. Tool catalog

Columns: model name | `file:symbol` (under `T/` unless noted) | purpose, input (limits/defaults) | output, side effects, services | verdict a / b. `D` after a name = deferred ("dynamic") tool, hidden from the wire on non-OpenAI families (section 1).

### 2.1 File ops

| Tool | file:symbol | Input | Output / side effects / services | a / b |
| --- | --- | --- | --- | --- |
| `Read` | `read/Read.ts:Read` | `path`, `offset?` (1-based line or PDF page), `limit?`. Prompt says: omit both unless file > ~800 lines | `{content "N\|line", total, ext, mime, mtimeMs, unchanged?, error?}`. Text: whole file when no window (no size cap, no binary check, lossy UTF-8). `.pdf` with no window and model accepts PDF and size <= 5 MiB (`MAX_CHAT_ATTACHMENT_BYTES_PER_FILE`) -> file part, else `unpdf` page text (no limit => all remaining pages). Office (docx/xlsx/pptx/odt/ods/odp/rtf/epub) -> Markdown lines via `officeparser`. jpeg/png/gif/webp -> file part (`toModelOutput`). Repeat of an already-returned range at same `mtimeMs` -> `{unchanged:true}` stub. FS read only | CHG / SKIP (native Read does text, images, PDF; keep office->MD as a small custom tool) |
| `Write` | `write/Write.ts:Write` | `path`, `content` (creates parents) | `{created, lines, lints}`. Under `withMutex('worktree')`; journals before/after for undo (`C/history/HistoryJournal.ts`: 50 entries, 5 MiB, skips files > 500 KiB); `markOwnWrite` for the watcher; runs biome on that one file | CHG / SKIP |
| `Edit` | `edit/Edit.ts:Edit` | `path`, `edits[1..32] {search, replace}`, `replace_all=false`. See section 5.4 | UI gets `{hunks, errors?, applied?, path, replace_all, lints}`; model gets `{status:'ok'\|'partial', applied?, errors?, lints}` (hunks dropped). Same mutex/journal as Write | CHG (CRLF, per-root) / SKIP (keep `applyContentEdits` for custom doc tools) |
| `Glob` | `glob/Glob.ts:Glob` | `pattern[]` (OR), `path?`, `recursive=true`, `only_files=true` | `{results[] project-relative, newest mtime first, errors?}`. fast-glob, `dot:false`, follows symlinks, ignores `EXCLUDE_FILES` + `.gitignore`/`.ignore` chain + agent-forbidden. No result cap | CHG / SKIP |
| `Grep` | `grep/Grep.ts:Grep` | `pattern` (regex), `path?`, `glob[]?`, `type?`, `output_mode` files_with_matches\|content(default)\|count, `case_insensitive`, `multiline` | `{files}` or `{results: {file: ["line:text"]}}` or `{counts}` + `errors?`. `rg` spawned with argv (no shell), `$`/backticks safe. No context lines/head_limit/offset (description says so). Aborts with error past 50 MiB output (`C/search/content.ts: MAX_GREP_OUTPUT_CHARS`); otherwise NO truncation | CHG / SKIP (native Grep is a superset) |
| `ListDirectory` D | `list-directory/ListDirectory.ts` | `path?`, `recursive=true` (note: default true), `only_files=true` | `{entries[{path,sizeBytes?}], isError?, error?}`. No cap | SKIP / SKIP (Bash `ls`, Glob) |
| `MoveFile` D | `move-file/MoveFile.ts` | `from_path`, `to_path`, `overwrite?` | `{moved, reason?}`. Refuses existing dest without `overwrite`; merges dirs with conflict list; project or scratch dirs; drops undo entries for both paths. Dest uses lexical-only `validatePathForCreation` (no realpath) | SKIP / SKIP (Bash `mv`) |
| `RemoveFile` D | `remove-file/RemoveFile.ts` | `paths[]` (>=1) | `{removed, results[{path,removed,reason?,lines?}]}`; model sees `{status:'ok'}` or `{status:'error', errors}`. Recursive delete; journals file bodies only (dirs not undoable). One invalid path throws and fails the whole batch | SKIP / SKIP |
| `CreateDirectory` D | `create-directory/CreateDirectory.ts` | `path` | `{created, path}`; model sees `{created}` | SKIP / SKIP |

### 2.2 Shell and commands (incl. background)

| Tool | file:symbol | Input | Output / side effects | a / b |
| --- | --- | --- | --- | --- |
| `Bash` | `bash/Bash.ts:Bash` | `command`, `description` (both required except kill/poll), `background?`, `kill?`+`id`, `id` (poll), `timeout` 1..600,000 ms (default 120,000 fg; none for bg unless passed), `cwd?` (this call only), `tailLines` 1..`config.OUTPUT_LINES` (500; default 100), `tool_call_id?` | One tool = run / background / poll / kill (description: "Not pid"). fg: `{id, stdout, stderr, exitCode, durationMs, [signal, log]}`; stdout = LOG+INFO entries, stderr = ERROR+WARN entries; each `keepTail(maxLines)` then `spillIfLarge` (> 24 KiB -> file under `AGENT_TMP_DIR/tool-output`, pointer text). Timeout is a separate `setTimeout` -> SIGKILL so partial output still returns ("Timed out after Nms and was killed. Full output is in log."). bg: `{id, pid, status:'running', log}` and the exit/error is enqueued to the thread mailbox. Poll `{id}` -> status running\|killed\|exited + tails. Kill -> `command.kill()` + wait. Command goes through `rewriteBashCommand` (`bash/rtk-rewrite.ts`: `rtk rewrite`, 2 s timeout, any failure => original command) and `refuseHostMutation` (`bash/host-policy.ts`: regex bans apt/dpkg/sudo/yum/dnf/pacman/apk/snap/**brew**, playwright/puppeteer/chromium, `.deb`, `\| sh`). Backgrounding refused in subagents ("Run in the foreground"). Services: `core/process` registry (`processRegistry.createCommand`, disk logs, tree-kill), bwrap off in desktop mode | CHG (drop host-policy/bwrap/rtk, root per agent) / SKIP (native Bash has background + output polling) |
| `GetBackgroundResult` D | `get-background-result/GetBackgroundResult.ts` | `{}` | Returns `BackgroundResult[]` (`{id, output?, error?}`) and removes them from the mailbox. Description: "Do not invent stdout, exit codes, or errors". Mostly redundant, because results are auto-injected before the next step (section 5.5). Excluded from the loop guard (`POLLING_TOOLS`) | IDEA / SKIP |
| `Waiting` | `waiting/Waiting.ts:Waiting` | `seconds` int 1..300 | Sleeps (abort-aware), publishes `{endsAt}` tool metadata for a UI countdown, returns `{endsAt}`. Excluded from loop guard | IDEA / SKIP |

### 2.3 Web

| Tool | file:symbol | Input | Output / side effects | a / b |
| --- | --- | --- | --- | --- |
| `Fetch` | `fetch/Fetch.ts:Fetch` (893 lines) | `url`, `format` markdown\|raw, `topic` (<=4,000 chars; forces cheap-model extract), `maxChars` 256..500,000 (default 32,000), `timeoutMs` 1,000..120,000 (default 30,000) | `{content, file?, error?, final_url, content_type, source_truncated, used_llm, llms_txt?}`. Body cap 2 MiB; HTML -> `mdream` Markdown; JSON pretty-printed; model-accepted binary (image/PDF/audio/video) -> file part by URL; other binary rejected with "Save it with ImportAsset". Summarizer = `lite` model, input <= 100,000 chars (env up to 400,000), output tokens 4,096..16,384, `temperature 0.2`; spend folded into the parent run ledger. Probes path-aware `/llms.txt` in parallel (3 s per candidate, 256 KiB, 16,000 chars). Browser UA. SSRF guard = hostname/IP-literal denylist only (localhost, 127/8, 10/8, 172.16/12, 192.168/16, 169.254/16, fe80, user:pass@); **no DNS resolution check**, and redirects are checked after the request was made. Rewrites local CDN host to MinIO in dev | CHG (summarizer provider, real SSRF check) / SKIP (native WebFetch) |
| `WebSearch` | `web-search/WebSearch.ts:WebSearch` | `query`, `maxResults` 1..20 (default 3) | `{results[{title,url,snippet<=3,000 chars,date?,lastUpdated?}], error?}`. POSTs to LiteLLM `/v1/search/{tool}` over `WEB_SEARCH_TOOLS` (perplexity, exa) in order, 15 s each; stops on abort or out-of-credits | SKIP / SKIP (needs gateway; native web search) |

### 2.4 Planning, todo, ask, progress

| Tool | file:symbol | Input | Output / side effects | a / b |
| --- | --- | --- | --- | --- |
| `Preamble` | `preamble/Preamble.ts` (not in barrel; added in `createRuntimeContext`) | `content` | `execute` returns `null`; the call IS the message (a one-line progress note shown to the user, "call only in parallel with other tools"). A transport trick for models that do not emit text between tool calls | SKIP / SKIP |
| `TodoWrite` D | `todo/TodoWrite.ts`, `todo/schemas.ts` | `todos[{id?, content, status? pending\|in_progress\|completed\|cancelled}]`, full replace, empty clears, duplicate id throws | Returns the new list. State in `ThreadSession.todos` (synced to UI channel `chat-thread:<id>`); `onModelEnd` clears the list when all completed | IDEA / SKIP (native TodoWrite; Clowdy tasks are daemon state) |
| `ReadTodo` D | `todo/ReadTodo.ts`, `todo/format-todos.ts` | `{}` | Markdown checklist, one line per todo with a checkbox (`x` done, `/` in progress, `-` cancelled) and the id | SKIP / SKIP |
| `CreatePlan` | `plan/Plan.ts:CreatePlan` | `name`, `overview`, `plan` (openui-lang doc), `todos?` | One plan per thread (`ThreadSession.plan`, `builtAt` stamped when the first implementation tool runs, `PLAN_IMPLEMENTATION_TOOLS` in `agent-profile.ts`). Returns `{name}` | IDEA / SKIP |
| `EditPlan` | `plan/Plan.ts:EditPlan` | `edits[<=32]`, `replace_all`, `name?`, `overview?` | Reuses `applyContentEdits(markdown:true)`; empty `search` replaces the whole plan. Returns hunks/errors; model sees `{status}` | IDEA / SKIP |
| `ReadPlan` | `plan/Plan.ts:ReadPlan` | `{}` | `{name, overview?, plan}`; throws when none | IDEA / SKIP |
| `AskUserQuestion` | `ask-user-question/AskUserQuestion.ts` | `questions[1..4] {id, prompt, options[{id,label}], freeText?, textLabel?, icon?, multiSelect?}` with `superRefine`: unique ids, >=2 finished options unless `freeText`, no "Other" typing option, icon only with freeText | **No `execute`**: client tool. The step ends at the call; the front posts the answer `{answers: Record<id,string>}`; "Skip" comes back as `Skipped`. While the last assistant message holds an unfinished tool without `execute` (or an `approval-requested` part), `childNeedsUser` (`S/chat/threads/helpers.ts`) is true and the run ends with outcome `park` instead of `finish` | IDEA (keep the schema) / SKIP (native AskUserQuestion; reuse validation rules for a custom UI) |

### 2.5 Subagent and background result

| Tool | file:symbol | Input | Output / side effects | a / b |
| --- | --- | --- | --- | --- |
| `Agent` | `agent/Agent.ts:Agent` (233 lines) | `name` (catalog id), `message` (self-contained brief), `resume` new\|resume, `background?` | `{name, childThreadId, content, data?, error?, jobId?}`. Child = a real persisted chat thread (`openSubagent`/`runSubagent` in `S/chat/agent/subagents`), model from the agent file (`model: lite[effort=low]`), child usage folded into parent ledger. fg: waits, streams `subagentStatus`. bg: `runBackgroundWork` job `agent:<6>`, own abort signal and payer (parent Stop does not kill it), report arrives as a step note; refused inside a subagent. `resume` default comes from agent frontmatter (`new`\|`continue`). Billing gate in bg when no user key. Dynamic import breaks a tools <-> subagents cycle | CHG (billing/ledger out) / SKIP (native Task/Agent). Subagent internals belong to another note |
| `GetBackgroundResult` | see 2.2 | | | |

### 2.6 Skills, memory, chats, MCP, dynamic tools

| Tool | file:symbol | Input | Output / side effects | a / b |
| --- | --- | --- | --- | --- |
| `Skill` | `skill/Skill.ts` -> `S/chat/agent/skills/workspace-skills.ts:readSkillByName` | `name` = `skill` or `skill/relative/file.md` | `{content, directory, error?}`. Name segments validated (`isValidSkillName`), path contained in the skill dir, frontmatter stripped, body capped at 200,000 chars (`MAX_SKILL_BODY_CHARS = 50_000*4`) with "(Truncated...)". Catalog roots: global folders (desktop), system, plugins, project; later wins by name | CHG / SKIP (native Skill; the loader and `<available-skills>` block are covered by another note) |
| `Remember` D | `remember/Remember.ts`, `S/chat/agent/memory/store.ts` | `fact`, `section` never\|facts\|decisions | sqlite (`node:sqlite`) `<PROJECT_CONFIG_FOLDER>/memory.db`, id = sha256(`section\nfact`)[:16] (upsert), embedding BLOB from `POST {LLM_API_URL}/v1/embeddings` model `text-embedding-3-small`. Returns text `Remembered (section, id): fact` | IDEA (embedder = gateway => swap for BM25/local) / IDEA |
| `Forget` D | `remember/Forget.ts` | `id?` \| `section?` \| `text?` \| `all?` | Deletes; text `Removed N project memory entries.`; throws "Specify id, section, text, or all=true" | IDEA / IDEA |
| (recall) | `S/chat/agent/memory/recall.ts`, `S/chat/threads/helpers.ts:tagLastUserMessageWithProjectMemory` | automatic per user turn | Cosine over all rows, top 5, `minScore` 0.25; stored on the user message metadata and rendered as `<project-memory>`; a recall failure is swallowed (warn) | IDEA / IDEA |
| `ListChats` D | `chats/ListChats.ts` | `{}` | Text lines `threadId  YYYY-MM-DD HH:MM  title (this chat)`; subagent threads omitted | IDEA / IDEA |
| `ReadChat` D | `chats/ReadChat.ts`, `chats/transcript.ts`, `chats/load-chat-page.ts` | `threadId`, `offset` 0..10,000 (from newest), `limit` 1..40 (default 24), `showReasoning`, `showToolResults` | Text digest: visible user/assistant text + one line per tool (name + basename of path-like input), page capped 8,000 chars, reasoning 500, tool result 2,000; merges the live in-memory tail | IDEA / IDEA |
| `SearchChats` D | `chats/SearchChats.ts`, `S/core/search/bm25.ts` | `query` <=200 chars | Scans every thread, 100 msgs/page, <=400 msgs/thread, BM25 over digest lines, 8 hits, `minScore 0.01`, grouped per thread | IDEA / IDEA |
| `GetDynamicTools` | `mcp-tools/GetDynamicTools.ts` | `namespace?`, `tool?` | No args: TOC text (`id`, description, `tools: a, b`). Namespace: `{servers[{id,status,description,instructions,tools[{name,title,description,inputSchema}]}]}`; schemas are `$ref`-inlined and compacted (`helpers.ts: compactJsonSchema`) | SKIP / SKIP |
| `CallDynamicTool` | `mcp-tools/CallDynamicTool.ts`, `helpers.ts:executeCallDynamicTool` | `namespace`, `tool`, `input?` | Builtin group member: validates input with the inner Zod schema (error text includes the JSON schema), runs `execute`, or for execute-less tools (`Navigate`) delegates to the editor and waits 20 s (`client-tool-delegate.ts`). MCP: throws "Unauthorized. Call McpAuth..." when the server needs OAuth; on a failed call appends a schema-mismatch hint. `toModelOutput` delegates to the inner tool's | SKIP / SKIP |
| `McpAuth` D | `mcp-tools/McpAuth.ts` | `server` | `needsApproval` (UI consent) when the server is `unauthorized`; returns the server catalog after the OAuth round-trip | SKIP / SKIP |
| `GetMcpResources` D | `mcp-tools/GetMcpResources.ts` | `server?`, `uri?`, `downloadPath?` | Lists resources/templates or reads one (optionally to a file) | SKIP / SKIP |
| MCP client | `S/chat/mcp-client/mcp-connection-manager.ts` (`@ai-sdk/mcp`) | | Per-run connect, status connecting\|ready\|unauthorized\|error, tool keys `server__tool`, per-thread frozen TOC (`ThreadSession.frozenMcp`), `x-litellm-api-key` auto-header | SKIP / SKIP (engine-native MCP) |

### 2.7 Project-specific (Reforma web projects) -> SKIP unless noted

| Tool | file:symbol | Purpose / limits | Verdict |
| --- | --- | --- | --- |
| `ReadLints` D | `read-lints/ReadLints.ts`, `C/lint/` | `paths?`; **mutating** `biome check --write`, then `tsc --noEmit`, project-tokens check, stories check. `LINT_TIMEOUT_MS` 20 s. Output `{diagnostics[{file,line,column,severity,message,source,code}], error?}` | IDEA (post-edit lint feedback; see 5.7) |
| `Commit` | `commit/Commit.ts` | `message`; lint-gated version checkpoint (`commitRunSnapshot(lint:'block')`), no-op on clean tree; model sees text, max 30 diagnostics + "...and N more"; reveals the project preview when the dev server is up | IDEA (task checkpoint = git commit with lint gate) |
| `DevServerStatus` / `DevServerRestart` D | `dev-server/*` | log tail default 100 (max `OUTPUT_LINES`), stderr tail 40, HTTP probe 3 s; restart supports `background` job `dev-restart:<6>` | SKIP |
| `Build` D | `project-build/Build.ts` | `bun run build`, 180 s timeout, `hard` stops dev server + removes `.next`; log tail 40 lines / 4,000 chars | SKIP |
| `InstallDeps` D | `install-dependencies/InstallDependencies.ts` | `packages?`, `dev`, `force`, `resetLockfile`, `background` (job `install:<6>`); bun only; restarts dev server | SKIP |
| `ProjectEnv` D | `project-env/ProjectEnv.ts` | list/set/remove env vars through Reforma API; values never returned | SKIP |
| `CheckPage` D | `page-screenshot/CheckPage.ts` | <=5 paths; Next/Turbopack compile issues via Next MCP endpoint, HTTP status, server log; 60 s request, 10 s stream wait, 40 log lines, 5 stack frames | SKIP (idea: "verify route renders without a browser") |
| `PageScreenshot` D | `page-screenshot/PageScreenshot.ts` | viewport desktop 1280x800 / mobile 390x844, `delayMs` 0..10,000 (2,000), selector, fullPage; server-side capture (`captureProjectScreenshot`), needs the dev server for preview paths | SKIP |
| `Navigate` D | `frontend/Navigate.ts` | client tool (no execute), editor preview navigation | SKIP |
| `ImageGen` D | `generate-image/GenerateImage.ts` | 1..4 prompts, quality, aspect, transparent, destination cdn\|chat\|filesystem; 300 s tool timeout; billed via ledger | SKIP |
| `SearchImage` D | `unsplash-image/SearchImage.ts` | Unsplash search, 1..10 | SKIP |
| `ImportAsset` D | `import-asset/ImportAsset.ts`, `shared/save-asset.ts` | URL/data-url/scratch -> project CDN or `public/` | SKIP |
| `InstallPlugin` D | `install-plugin/InstallPlugin.ts` | catalog plugin install via Reforma API, `needsApproval`, 60 s wait | SKIP |
| `ScaffoldProject`, `ChooseDesignDirection`, `CommitDesignRead`, `MarkProjectReady` | `scaffold-project/`, `choose-design-direction/`, `commit-design-read/`, `mark-project-ready/` | onboarding only (templates, design picker, brief file) | SKIP |
| `Publish`, `ListVersions` | `publish/Publish.ts`, `list-versions/ListVersions.ts` | inbound MCP only; deploy polling every 2 s | SKIP |

Vestigial: `ConnectGoogleFont`, `ConnectLocalFont`, `RegisterLocalFont`, `ListProjectFonts` still appear in `packages/types/src/sandbox/ui-message.ts: ReformaChatUITools` but no tool exists in the sandbox.

## 3. How tool results are shaped for the model

- Default: AI SDK sends the `execute` return value as JSON (strings as text). Reforma keeps a **rich UI payload and a slim model payload** with `toModelOutput` (Read, Grep, Edit, RemoveFile, CreateDirectory, EditPlan, ProjectEnv, Commit, InstallPlugin, Fetch, PageScreenshot, ChooseDesignDirection, ImageGen, SearchImage, CallDynamicTool). Example: Edit's diff hunks go to the UI only; the model gets `{status, applied, errors, lints}`. `toModelOutput` has no runtime/model argument, so `models/tool-file-model.ts` (AsyncLocalStorage) carries the active model and the full tool map.
- Only `Bash` (and step notes) bound output: tail (default 100 lines, max 500) then spill above `TOOL_RESULT_SPILL_BYTES = 24 KiB` (`T/shared/tool-result.ts`) to `AGENT_TMP_DIR/tool-output/<uuid>.txt`, replaced by `[Large tool output stored: N KB, M lines] Path: ... Use Read to inspect it.` (guard against re-spilling via the marker). Other bounds are per tool (Fetch `maxChars`, WebSearch snippet 3,000, Skill 200,000, ReadChat 8,000, Commit 30 diagnostics). **Unbounded**: Read text, Glob, ListDirectory, Grep (50 MiB abort), MCP results, Agent report.
- Between steps (`H/step-notes.ts: takeStepNotes`, called from `prepareStep`): finished background jobs (id, `exit N`, `signal`, last 100 lines stdout/stderr each, spilled if big), user steers, the loop note, the turn-limit note. They become synthetic **user** messages for that step; background and steer notes are also written once to the live assistant message as `data-*` parts and re-expanded in place on replay.
- Turn limit: `maxTurns` default 200 (`DEFAULT_MAX_TURNS`); on the last step `toolChoice:'none'` + note "Turn limit reached. Stop calling tools. Finish now in text: what is done, what is left, and the answer."
- Old results shrink later (microcompact tiers: lite keeps Write/Edit/Agent whole, other long strings head 700 + tail 300 chars; heavy keeps an operation log). Out of scope here; see the compaction note.
- Per-step abort: `STREAM_STEP_TIMEOUT_MS` 600,000 covers the model call plus in-step tool execution (`timeout.stepMs`); `IMAGE_TOOL_TIMEOUT_MS` 300,000 for ImageGen (`timeout.tools`). `Waiting` max 300 s fits inside it.

## 4. Errors from tools

| Style | Tools |
| --- | --- |
| **Throw** (becomes `tool-error` / UI `output-error` with `errorText`) | Edit (path denied, whole-batch failure, multiple matches, chain conflict), Write, Glob/Grep/ListDirectory (path validation), MoveFile/RemoveFile/CreateDirectory (validation), CreatePlan/EditPlan/ReadPlan, TodoWrite (duplicate id), CallDynamicTool, hook denial (`HookBlockedError`), Waiting (abort) |
| **Return `{error}` / failure object** | Read (`{content:'', error}`), Skill, Fetch, WebSearch, Agent (`error`), GetDynamicTools/McpAuth (`error`), ImportAsset/ImageGen/SearchImage/PageScreenshot (`{ok:false, error}`), Commit (`reason: 'lint'\|'clean'`, `diagnostics`), Build/InstallDeps/DevServer* (`{error, stage}`), ListDirectory (`isError`), MoveFile/RemoveFile (`reason`) |
| **Exit-code style** | Bash: returns `{exitCode, stdout, stderr}`; missing args, refused command, start failure and `ProcessError` are `{exitCode:1, stderr:"..."}`. The one throw: an invalid `cwd` (`validatePath` runs before the `try`) |
| **Text** | Remember/Forget/ListChats/ReadChat/SearchChats return strings (errors as strings) |

Rules that matter:

- The UI-stream `onError` is overridden (`agent.ts`: `invalidDirectToolInputMessage ?? providerErrorMessage ?? 'An error occurred.'`) because the SDK default would hide thrown tool messages from model and UI. `providerErrorMessage` (`H/provider-error-message.ts`) walks `message -> cause -> responseBody -> error -> data` to depth ~4.
- Invalid direct input is rewritten (`mcp-tools/helpers.ts: invalidDirectToolInputMessage`) to `Invalid input for X: <path>: <issue>; ...\nInput schema: {json schema}`, so the model can self-correct. Same format for the inner tool of `CallDynamicTool` and for MCP mismatches (appended only after the server already failed; the server stays authoritative).
- Loop guard (`H/tool-loop-guard.ts: detectToolLoop`, run in `prepareStep`): per call key = `name + stable JSON input`, result = error text or sha1 of output; window 10. Success: 2 identical back-to-back -> note "use that result". Failure: 2nd identical failure -> warn note; 3rd back-to-back, or 3rd `Invalid input for` anywhere in the window -> **halt** (`toolChoice:'none'` + "Stop calling tools. Tell the user what is blocked..."). MCP `isError` results count as failures. `GetBackgroundResult` and `Waiting` are exempt.
- Approvals: only `McpAuth` and `InstallPlugin` use `needsApproval`. No approval or permission layer exists for Write/Edit/Bash (the hosted sandbox was the boundary; desktop mode runs as the user with `SANDBOX_PROCESS_ISOLATION=off`).

## 5. Subtle parts

### 5.1 Path validation and allowed roots (`C/files/path.ts`, `C/files/agent-path-guard.ts`)

- `normalizePath`: `~`/`~/x` -> `PROJECT_FOLDER`, relative -> resolved against `PROJECT_FOLDER`, `//` collapsed.
- `isPathAllowed(path, dirs)`: boundary-safe prefix (`root + path.sep`; `/tmp/reforma` does not admit `/tmp/reforma-evil`), case-folded on win32.
- `validatePath`: lexical check, then `realpathSync`; a symlink is re-validated on its target; non-existent target falls back to the realpath of its parent (`FILE_NOT_FOUND` if that is missing too). `validatePathForWrite` (used by Write/CreateDirectory with `createParents`) walks to the nearest existing ancestor and checks its realpath. `validatePathForCreation` (MoveFile dest) is lexical only.
- Allowed dirs (`defaultAllowedDirs`): `ALLOWED_DIRECTORIES` or [`PROJECT_FOLDER`, `PROJECT_CONFIG_FOLDER`, `REFORMA_SYSTEM_FOLDER`], plus always: `AGENT_TMP_DIR` (`/tmp/reforma`), `AGENT_MNT_DIR` (`/mnt/reforma`), all of `/tmp` (+ realpath for macOS `/private/tmp`), `PLUGINS_FOLDER`, `DEPLOY_FOLDER`, global skill roots while on.
- Agent-forbidden (`AGENT_FORBIDDEN_PATHS`): `.reforma/runtime/`, `.reforma/trash/` -> throws "Access is not allowed: X is managed by Reforma...". `.env*` is hidden from Glob/Grep/ListDirectory (default excludes) but `Read` can open it.
- `Bash` validates only `cwd`; the command string is unrestricted.
- Verdict: **CHG** (a) and a source of logic for PreToolUse hooks/`canUseTool` (b). Replace `config.*` with an explicit `{root, extraAllowed}` per agent. Gate `validateAgentPath` behind a typed error instead of `FileSystemError` from `@reforma/types`.

### 5.2 Read-before-edit / staleness

- **No read-before-edit guard exists.** "Read first" is prompt text only. `readFileState` (`H/read-file-state.ts`) is a dedup cache (per path: `mtimeMs` + merged 1-based line ranges + `totalLines`), consulted only by `Read`. It is rebuilt from persisted tool parts after the last compaction (`createReadFileState(uiMessages)`), so it survives restarts without extra storage. Microcompact removes older Reads fully covered by a newer one for the same reason.
- Stale protection for edits is implicit: `search` must still match. `writeFileHelper` supports `expectedEtag` (`mtime|size`) and `exclusive` (409 `FILE_CHANGED` / `FILE_EXISTS`) but only the editor HTTP route passes them; agent Write/Edit never do. All writes are read-modify-write under one process-wide `worktree` mutex (`S/utils/async.ts: withMutex`, no timeout unless given).
- Verdict: dedup = IDEA for a custom Read; etag precondition = IDEA worth wiring when two agents may share a worktree.

### 5.3 Write path and undo

`writeJournaled`: mutex -> optional etag check -> read old bytes (for journal) -> `mkdir -p` -> write -> `markOwnWrite` (watcher echo suppression) -> `historyJournal.recordWrite(group 'agent')`. Agent deletes journal file content only; agent moves clear undo entries instead of recording them.

### 5.4 Edit algorithm (`C/files/file-edit.ts: applyContentEdits`)

1. CRLF -> LF on the whole file (and on `search`/`replace`). **The file is always rewritten with LF**; a CRLF file loses its endings on the first edit (fix for Windows repos). Trailing whitespace is stripped from `replace` unless the path is `.md/.mdx`.
2. Edits sorted by `search.length` descending (longest first), each applied to the already-modified text. If an edit's `search` occurs inside an earlier edit's replacement -> throws `EDIT_CHAIN_CONTAINS_OLD_MESSAGE` (whole call fails).
3. Empty `search` = replace the whole file.
4. Exact `includes` first. Without `replace_all`, >1 non-overlapping match -> **throws** "Multiple matches..." (no partial). Idempotency guard: if the only match sits inside the replacement and the file already contains `replace`, the edit is reported as "Already applied" (error entry, no change). Replacement uses a callback so `$` stays literal; an empty replacement also eats one trailing newline.
5. No exact match -> fuzzy: compare **whole lines** after `trim()` (a multi-line block). >1 fuzzy hit without `replace_all` throws. On the first hit the replacement lines are re-indented: lines equal (trimmed) to an old line take that file line's indentation; new lines get `previous output indent + (their indent delta in the replacement)`. Only the first fuzzy block is replaced even with `replace_all`.
6. Not found -> entry in `errors` (`"Edit N: The string to replace wasn't found in the file"`), other edits still apply (**partial apply**); if nothing applied -> throws (single edit: its message; batch: "No edits applied; the file is unchanged." + list).
7. Diff: `diff.structuredPatch` with `ignoreWhitespace`, context = infinite when both sides <= 30 lines, else 4. Returned as `hunks` for the UI.
8. After write, `lintChangedFile` (biome check on that file, no `--write`; `"none"` or hits `{line,column?,severity,message,code?}`; a lint crash becomes a 400-char error hit).
Verdict: **CHG** (keep the module, it is pure except `writeFileHelper`/`withMutex`; `applyContentEdits` is string-in/string-out and already reused by EditPlan). Tests: `S/specs/core/files/file-edit.test.ts`, `S/specs/chat/tools/edit/edit-tool.test.ts`.

### 5.5 Background jobs: one mailbox, two readers

- Writers: `Bash background` (`attachDeliver` on process `exit`/`error`, `delivered` flag), `InstallDeps`/`DevServerRestart` with `background:true` and `Agent background:true` via `runBackgroundWork` (`H/background-thread.ts`: own `AbortController`, runs outside the run scope and payer, result or error string enqueued). Ids: process id, `install:`, `dev-restart:`, `agent:` + 6 chars.
- Storage: `ThreadSession.backgroundJobs` (in memory only; running jobs published to the UI in `chat-thread:<id>` sync state). `takeBackgroundResults()` returns finished and deletes them.
- Readers: (1) automatic: `takeStepNotes` before every step, text "Background job ID finished." then `exit N`, `signal`, stdout tail, stderr tail; (2) explicit `GetBackgroundResult`. Unread results survive the run. Stop button: `S/api/chat/chat-stop-background-jobs.ts` aborts in-process work (`stopBackgroundWork`) or kills the process-registry command, then `dropRunningBackgroundJobs`.
- Subagents may not start background work (root thread owns the mailbox).
- Verdict: **IDEA** for b (a daemon-level mailbox keyed by agent/task that injects completions into the agent's next turn; works for any engine); **CHG** for a (strip `ThreadSession`).

### 5.6 Tool order and caching

`REFORMA_TOOL_ORDER` is stable; `withCachedLastTool` (`S/chat/agent/models/prompt-cache.ts`) puts Anthropic `cache_control` on the last *eager* tool in that order; the full tool catalog is never shrunk mid-turn (`activeTools` is not used) so the cached prefix survives. Deferral exists to keep the prefix small, not to gate access.

### 5.7 Lint-on-edit feedback

Write/Edit always include `lints` (`"none"` or hits) so the model sees diagnostics in the same result; `Commit` blocks on lint; `ReadLints` is the explicit full run (biome `--write` then tsc). Reforma's project owns biome. For Clowdy: run the project's own configured linter or `tsc` per language in a PostToolUse hook (b) and return `additionalContext`.

## 6. Porting notes (what blocks a drop-in)

| Coupling | Where | Fix |
| --- | --- | --- |
| Global project root | `config.PROJECT_FOLDER` in Read/Glob/Grep/Bash/path.ts/search/lint/ignore | per-agent `root` via explicit arg or `AsyncLocalStorage` |
| Global `withMutex('worktree')` | file.ts, file-edit.ts, directory.ts, move-copy.ts, memory/store.ts | key per worktree (`worktree:<path>`) |
| `RuntimeContext` via `options.context` (AI SDK 7 `toolsContext`) | Read (dedup, model MIME), Bash/Agent/Plan/Todo (`run.context.thread`), Fetch (ledger, publishSourceUrl), MCP tools | define a narrow `ToolEnv` interface; for in-process MCP, close over it |
| Tool authoring format | `tool({description, inputSchema(zod4), outputSchema, execute, toModelOutput, needsApproval, providerOptions})` | Maps 1:1 to Claude Agent SDK `createSdkMcpServer` + `tool(name, desc, zodShape, handler)`; `toModelOutput` logic becomes the handler's `content` (the SDK has one result shape, so the UI-rich/model-slim split must move to a side store keyed by `tool_use_id`) |
| Binaries | `rg` (Grep/search), git, optional `rtk`, bash (Git Bash on Windows; `core/process/default-shell.ts`) | Reforma desktop ships `rg`, `rtk`, PortableGit; Clowdy must do the same or call native tools |
| Libraries | `fast-glob`, `minimatch`, `diff`, `mdream` (native addon), `unpdf`, `officeparser`, `mime-types`, `node:sqlite`, `@ai-sdk/mcp` | all portable under Bun/Node; `mdream` and `node:sqlite` need a runtime check |
| Gateway-only | WebSearch, Fetch summarizer, memory embeddings, ImageGen, billing/ledger | no subscription equivalent: use native web tools, BM25 memory |
| Windows | edit CRLF rewrite, `host-policy` bans `brew`, bash-only prompts, `taskkill` tree kill in `core/process/spawn.ts`, path case folding already handled | fix as noted |
| Security | Fetch SSRF is name-based; MoveFile dest has no realpath check; `/tmp` fully allowed; no permission prompts | re-do against Clowdy threat model (local user files) |

## 7. Duplicates of Claude Code / Codex vs unique value

| Reforma tool | Claude Code native | Codex native | Decision with an engine adapter |
| --- | --- | --- | --- |
| Read, Write, Edit, Glob, Grep | Read, Write, Edit, Glob, Grep (Edit enforces read-first, single exact replace) | shell + `apply_patch`, file read via shell | do not port; Reforma Edit's batching/fuzzy is a nice-to-have, expose only via a custom `EditBatch` if models fail native edits |
| ListDirectory, MoveFile, RemoveFile, CreateDirectory | via Bash | via shell | do not port |
| Bash (+background/poll/kill) | Bash `run_in_background` + output/Monitor/stop tools | shell/exec (no mailbox) | do not port the tool; port the **mailbox idea** for daemon-level jobs |
| Fetch / WebSearch | WebFetch / WebSearch | web_search | do not port |
| TodoWrite | TodoWrite | `update_plan` | do not port; Clowdy tasks are daemon state |
| Plan tools | plan mode (`ExitPlanMode`) | `update_plan` | IDEA only: plan doc editable by search/replace |
| Agent | Task/Agent (+ frontmatter `tools`, `model`) | none (spawn via SDK) | do not port tool; reuse the agent-md format |
| Skill | Skill | skills (newer) | do not port |
| AskUserQuestion | AskUserQuestion | none | keep schema rules for a custom UI |
| MCP gateway (4 tools) | native MCP + tool search | native MCP | skip |
| Hooks | native hooks | partial | skip for Claude |
| **Unique** | | | background-result mailbox + step notes (steers, loop notes), tool-loop guard, Read dedup, `spillIfLarge`, edit engine (fuzzy, partial apply), path guard, memory (never/facts/decisions + recall), chat search/digest (BM25), per-edit lint feedback, `toModelOutput` slimming idea, Agent child-thread persistence with `resume` |

## 8. Where to look first / test assets

- Start: `T/index.ts`, `H/tool-sync.ts`, `H/runtime-context.ts` (assembly), `T/tool-groups.ts`, `C/files/{path,file-edit,file}.ts`, `T/bash/Bash.ts`, `H/{step-notes,tool-loop-guard,read-file-state}.ts`.
- Reusable tests (vitest): `S/specs/chat/tools/{edit,bash,files,agent,get-background-result,plan,todo,skill}/`, `read-tool.test.ts`, `tool-order.test.ts`, `tool-result.test.ts`, `host-policy.test.ts`, `S/specs/core/files/{file-edit,read-pdf-pages,read-office-document}.test.ts`, `S/specs/chat/{step-notes,tool-loop-guard,read-file-state,project-memory}.test.ts`. Run in Docker per `apps/sandbox/AGENTS.md` (`./reforma test sandbox`); a single file can run on the host with `bunx vitest run --config ./vitest.config.ts <file>`.
- Docs worth reading before porting: `.briefback/docs/agent/model-context.md` (deferral, compaction tiers; its "Multimodal boundary" paragraph is stale: Read does return image/PDF parts), `.briefback/docs/sandbox/{files,shell}.md` (etag, journal, trash, Git Bash/taskkill), `.briefback/docs/mcp/architecture.md` (inbound `dispatchTool` path), `apps/sandbox/AGENTS.md` (mutex keys, bwrap, desktop mode, hooks).
- Pointer for the subscription question (not analysed here): `S/chat/agent/models/resolve-provider-tools.ts: familyHasToolSearch` already special-cases ChatGPT-OAuth inference (`inference.providerId === 'openai' && kind === 'oauth'`), so a subscription-backed provider path exists in `S/chat/agent/models/inference-harness.ts`. That is another researcher's area.

# Skills in the Claude Agent SDK and Codex: how Clowdy ships system skills

Researched 2026-11-17 against `@anthropic-ai/claude-agent-sdk` 0.3.325 (Claude Code 2.1.325), Codex 0.169.0 (`@openai/codex` binary, source read on `openai/codex` main), Bun 1.4.4, macOS arm64. Experiments: scratchpad `research/skills/` (`probe-claude.ts`, `smoke-claude.ts`, `probe-codex*.ts`, `*.out`, `fixtures/`). Labels: **[ran]** I executed it; **[src]** read in the Codex source; **[docs]** official docs only, not run.

## Verdict

- **One plugin directory serves both engines.** Ship the system skills as a Claude-format plugin (`.claude-plugin/plugin.json` + `skills/<name>/SKILL.md`). Claude loads it with `plugins: [{type:"local", path}]` and **no `settingSources` at all** [ran]. Codex loads the same directory as an extra skill root (`skills/extraRoots/set`) and derives the same `plugin:skill` namespace from the manifest [ran]. Nothing touches `~/.claude` or `~/.codex`.
- **Claude: the skill reached the main agent and a subagent.** Main agent called the `Skill` tool with `clowdy-system:clowdy-ping` and quoted the body. A subagent got it by preload (`AgentDefinition.skills`) while the main session had `skills: []` [ran, 2 haiku queries, $0.003 total]. Subagents live in the parent process, so the plugin is "always there" for them too.
- **Skills are not load-bearing by themselves.** The model decides whether to load one (description match). Make system skills deterministic with `/clowdy:orchestrate <brief>` as the first prompt (Claude dispatch ignores the `skills` allowlist) and a `skill` input item on Codex `turn/start` [docs/src], plus a one-line pointer in the system prompt.
- **Authoring format:** Agent Skills open format. `SKILL.md` with `name` + `description` frontmatter and a short body; details in `references/`. Claude-only keys are ignored by Codex and the reverse [ran]. Lint with the strictest parser (Codex: `description` required, `name` at most 64 chars).
- **Materialize** a content-hashed read-only copy under `<dataDir>/system-skills/<hash>/` at daemon start. Do not point engines into the app bundle (asar, AppImage mounts and macOS App Translocation all change or hide paths). The namespace comes from the manifest `name`, not the folder [ran].
- **Catalog is the daemon's own scan** (Reforma-style fingerprint), cross-checked against what each engine says it loaded (`getContextUsage().skills` / init `skills` for Claude, `skills/list` for Codex).

## Key facts: Claude Agent SDK

**Discovery** [ran = probes A to T, `getContextUsage()` and `initializationResult()` with no model call]:

| Input | Result |
| --- | --- |
| `plugins:[{type:"local",path}]`, `settingSources:[]` | plugin skills load, named `<manifest name>:<skill>` (e.g. `clowdy-system:clowdy-ping`), source `plugin` |
| plugin dir without `.claude-plugin/plugin.json` | still loads; namespace falls back to the **directory name** (`nomanifest-0.1.0:clowdy-ping`). With a manifest, the manifest name wins even in a versioned dir (`clowdy-system-v0.1.0`) |
| relative plugin path | resolved against `cwd`; a nonexistent path is skipped silently (check init `plugins` / `plugin_errors`) |
| `settingSources:['project']` | `<cwd>/.claude/skills` and parents up to the repo root, plus `.claude/skills` of every `additionalDirectories` entry (source `projectSettings`) |
| `additionalDirectories` with `settingSources:[]` | **nothing loads** (needs `'project'`; the CLI `--bare` doc says otherwise, the SDK does not) |
| `settingSources:['user']` | `$CLAUDE_CONFIG_DIR/skills` (default `~/.claude/skills`); `[]` hides them |
| `.agents/skills`, `.codex/skills` in the repo | **not read by Claude** |
| git worktree without `.claude/skills` | main checkout's project skills load instead (v2.1.277+); tracked skills in the worktree load normally |
| symlinked skill dirs inside a plugin | followed (`user-bundle` plugin mirroring `~/.agents/skills/x` appeared as `clowdy-user:x`) |
| bundled Claude Code skills | 13 load by default (~2,060 tokens in the listing). `settings:{disableBundledSkills:true}` leaves ~210 (`plugin-authoring` stays) |

- **Settings gate.** `settingSources` also loads settings.json, hooks, CLAUDE.md, `.mcp.json` of that source. There is no "skills only" switch. Managed policy and `~/.claude.json` load regardless. `--bare`/`CLAUDE_CODE_SIMPLE` is a non-starter on a subscription: it never reads OAuth/keychain, and it drops the skill listing reminder [docs].
- **Options that matter:** `plugins`, `pluginDelivery:'initialize'` (stdin instead of argv, for many plugins), `skills` (main session only: `'all'`, `string[]`, `[]`; auto-adds the `Skill` tool; names are `dir` or `plugin:skill`; wildcards throw), `AgentDefinition.skills` (full body preloaded, first 32 names; unlisted skills stay reachable through `Skill` unless `Skill` is in the agent's `disallowedTools`), `settings` (`skillOverrides`, `disableBundledSkills`, `skillListingMaxDescChars`, `skillListingBudgetFraction`), `Query.reloadPlugins()` / `reloadSkills()` for mid-session refresh.
- **Allowlist semantics** [ran F, G]: `skills:['a:b']` leaves only that skill in the model's listing (48 tokens); `skills:[]` leaves none. Init `skills` and `slash_commands` still list everything, and `/name` dispatch still works. It filters context, not disk.
- **`skillOverrides`** [ran Q to S]: for user/project skills `off` hides from model and `/`, `name-only` costs 4 tokens, `user-invocable-only` hides from the model. **No effect on plugin skills** [ran J]. For plugin skills use the `skills` allowlist.
- **Catalog in context.** Name + description (+ `when_to_use`) per skill, rebuilt per session. Cap 1,536 chars per skill, listing budget 1% of the context window (when over, least-used skills lose their description first) [docs, defaults in `sdk.d.ts`]. `skillListingMaxDescChars:20` cut a 48-token entry to 16 [ran T]. Measured cost: 33 to 48 tokens per one-line skill.
- **Loading a body.** `Skill` tool call `{skill:"clowdy-system:clowdy-ping"}`, then a `user` message starting `Base directory for this skill: <abs path>` carrying the body [ran]. The body stays in the conversation; after compaction only the first 5,000 tokens of each skill are re-attached (25,000 shared) [docs]. Put the critical rules first.
- **Invocation names:** model uses `Skill{skill:"plugin:name"}`; user/orchestrator prompt `/plugin:name args` (unknown `/x` becomes a normal message plus a note, not an error) [docs].
- **Frontmatter under the SDK** [docs only, not run]: `allowed-tools` pre-approves for the invoking turn (ignored under managed `allowManagedPermissionRulesOnly`); `disallowed-tools`, `model`, `effort`, `paths`, `hooks` honored; `context: fork` + `agent` runs in a subagent and the SDK waits for the result (foreground); `disable-model-invocation:true` hides it from the model (verified in listing [ran]) and blocks subagent preload; `user-invocable:false` hides it from `/` and init `skills`; `$ARGUMENTS`, `${CLAUDE_SKILL_DIR}`, `${CLAUDE_PLUGIN_ROOT}`, ``!`cmd` `` are Claude-only.
- **Collisions.** Plugin skills are namespaced, so a project `.claude/skills/orchestrate` never shadows `clowdy:orchestrate`. Same name across user and project: personal beats project. Additional-directory clashes get a `dir:` prefix (v2.1.309+).

## Key facts: Codex

- **Roots** [src `host_roots.rs` + ran `skills/list`, custom `CODEX_HOME` and `HOME`]:

  | Scope | Path | Notes |
  | --- | --- | --- |
  | repo | `.agents/skills` in each dir from cwd up to the project root; `<project>/.codex/skills` | both appeared for an untrusted git repo and for a worktree where they are tracked; an untracked skills dir is **not** found from a worktree (no main-checkout fallback) |
  | user | `$HOME/.agents/skills` | follows `HOME`, **not** `CODEX_HOME` |
  | user | `$CODEX_HOME/skills` | code calls it deprecated, still loads |
  | user | extra roots from `skills/extraRoots/set` | process-level RPC (each call replaces the whole list), applies to every cwd |
  | system | `$CODEX_HOME/skills/.system` | 5 bundled skills written on app-server start (imagegen, openai-docs, review-agent, skill-creator, skill-installer) |
  | admin | `/etc/codex/skills` | |
  | plugin | installed Codex plugins | `plugin/*` RPCs are "under development, do not call from production clients" [docs] |

- **Format.** `SKILL.md` with YAML frontmatter. `description` is required (missing gives `missing field description` in `errors`, skill dropped [ran]); `name` optional (defaults to the folder, max 64 chars); whitespace collapsed; `metadata.short-description` optional; unknown keys ignored [src, ran with the Claude-flavoured `clowdy-fork`]. Optional `agents/openai.yaml`: `interface` (display_name, icons, default_prompt), `policy.allow_implicit_invocation`, `dependencies.tools` (MCP, env vars). Same-name skills are not merged (both listed).
- **Namespacing.** Codex walks up from a skill to a plugin manifest (`plugin.json` with the Agent Plugins `$schema`, `.codex-plugin/`, `.claude-plugin/`, `.cursor-plugin/plugin.json`) and names the skill `<plugin>:<skill>` [src, ran: the Claude plugin dir came out as `clowdy-system:clowdy-ping`].
- **Catalog and invocation.** The model sees name + description + path (budget 2% of context or 8,000 chars; `skills.max_context_tokens` up to 10,000; descriptions shrink first, then skills drop) [docs]. There is no `Skill` tool: after a match the model **reads SKILL.md with its file/shell tool**. Explicit: `$name` in text (name chars `[A-Za-z0-9_:-]`, so `$clowdy:orchestrate` parses) plus a `{type:"skill", name, path}` item in `turn/start` input, which makes the server inject the full body [src, docs]. Not run (no quota spent on Codex turns).
- **Controls** [ran]: `-c skills.bundled.enabled=false` removed the 5 system skills; `-c 'skills.config=[{name="clowdy-system:clowdy-ping", enabled=false}]'` disabled one at process start; `skills/config/write{name|path,enabled}` writes `[[skills.config]]` into `$CODEX_HOME/config.toml` (global, persistent, and the `name` must be the namespaced name); `skills/changed` notification fires on file changes, then re-run `skills/list`.
- **`exec`/SDK path** has no extra-roots flag. What worked [ran]: a symlink to the whole plugin dir, or per-skill symlinks, inside `$CODEX_HOME/skills/` (names still namespaced). Copy on Windows.
- **Docs drift:** the app-server page documents `skills/list.perCwdExtraUserRoots`. It was removed upstream (#21485) and replaced by `skills/extraRoots/set` (#24977); the 0.169 generated schema has only `cwds`, `forceReload`.

## How to use it (code that worked)

```ts
// Claude: every run, including subagents. env must be explicit (TS `env` replaces process.env).
const sys = "/…/Application Support/Clowdy/system-skills/<hash>";        // plugin root = parent of skills/
query({ prompt, options: {
  env, cwd: worktree, model, settingSources: ["project"],                // + "user" only if the user switch is on
  plugins: [{ type: "local", path: sys }, { type: "local", path: userMirror }],   // userMirror = symlink-farm plugin "clowdy-user"
  skills: enabledQualifiedNames,                                         // ["clowdy:orchestrate", "clowdy:docs", "deploy", ...]
  settings: { disableBundledSkills: true, skillOverrides: { "legacy-thing": "off" } },
  agents: { executor: { description, prompt, skills: ["clowdy:executor"], tools: [...] } },
}});
// deterministic load: prompt = "/clowdy:autopilot " + brief
// verify: init.skills / init.plugins / init.plugin_errors, and (await q.getContextUsage()).skills.skillFrontmatter -> {name, source, path, tokens}
```

```ts
// Codex app-server: once per process, then per run
await call("skills/extraRoots/set", { extraRoots: [`${sys}/skills`] });  // namespaced clowdy:<skill> because of .claude-plugin/plugin.json
const { data } = await call("skills/list", { cwds: [worktree], forceReload: true });  // [{cwd, skills:[{name,scope,enabled,path,description}], errors}]
await call("turn/start", { threadId, input: [
  { type: "text", text: "$clowdy:orchestrate " + brief },
  { type: "skill", name: "clowdy:orchestrate", path: `${sys}/skills/orchestrate/SKILL.md` } ] });
// spawn flags: app-server -c skills.bundled.enabled=false  (CODEX_HOME = Clowdy's own; HOME stays real)
```

Probes (no model call): start `query()` with an input stream that never yields, `await q.initializationResult()`, `await q.getContextUsage()`, `q.close()`. For Codex, `skills/list` over stdio. Smoke tests: `env -i HOME PATH USER LANG bun run smoke-claude.ts main|subagent`.

Smoke result, query 1 (main): init `skills` had `clowdy-system:clowdy-ping`, `plugins` had `{name:"clowdy-system", version:"0.1.0"}`; stream `assistant tool_use Skill{skill:"clowdy-system:clowdy-ping"}`, `user tool_result "Launching skill: …"`, `user text "Base directory for this skill: … PINEAPPLE-7421"`, `assistant text`, `result/success` (3 turns, $0.0014). Query 2 (subagent): `assistant tool_use Agent{subagent_type:"pinger"}`, `system/task_started`, `user (parent_tool_use_id)` prompt, `task_updated`, `task_notification`, `tool_result "[Subagent hand-back] …"`, answer `PINEAPPLE-7421` (no `Skill` call; body was preloaded).

## Cross-engine plan

- **Source and layout.** `packages/system-skills/` in the repo, plugin layout, manifest `{"name":"clowdy","version":<app version>}` (so skills read `clowdy:orchestrate`, `clowdy:autopilot`, `clowdy:semi-manual`, `clowdy:scaffold`, `clowdy:executor`, `clowdy:verify`, `clowdy:docs`; folder names carry no `clowdy-` prefix). Optional `agents/openai.yaml` per skill for Codex-only UI/policy. Build copies it into `extraResources` (outside asar). The daemon materializes `<dataDir>/system-skills/<contentHash>/` (atomic rename, `chmod a-w`, keep the last 2), verifies the hash at run start, and adds deny rules for `Edit/Write` there so a project cannot rewrite the loop.
- **Authoring lint** (CI + daemon on load): folder = `name`, lowercase/digits/hyphen, at most 64 chars, no colon; non-empty `description`, one line, no `<`/`>` (Claude HTML-escapes them), colons quoted; at most `name`, `description`, and the Claude-only `disable-model-invocation` plus `allowed-tools`; no `context: fork`, `$ARGUMENTS`, `${CLAUDE_*}` or `` !`cmd` `` (Codex leaves them literal); reference files as `references/x.md` next to the skill (both engines tell the agent the skill dir); refer to orchestrator tools by base name (`clowdy_spawn_run`), not `mcp__clowdy__…`; keep SKILL.md small (compaction keeps 5,000 tokens). Also run `claude plugin validate <dir>` (ran: manifest valid; only directory-listing warnings for README/LICENSE/icon).
- **Layers per run** (all engines): system (always, not user-toggleable) + user (switch + per-skill deny list, Reforma style) + project (`<worktree>`). Claude: system plugin always; user skills as a **mirror plugin** (`clowdy-user`, symlinks to the enabled `~/.claude/skills/*` and `~/.agents/skills/*` dirs) so the user's hooks/MCP/CLAUDE.md are not pulled in and `.agents/skills` reaches Claude too [ran]; project via `settingSources:['project']`. Codex: system + user mirror as extra roots, project natively (`.agents/skills`, `.codex/skills`). Claude also reads `.claude/skills` and Codex also reads `.agents/skills`: the project scan must list both and mark which engine sees what.
- **Per-run enable state.** Claude: `skills` allowlist (system+user) and `skillOverrides:'off'` (project/user native). Codex: `-c skills.config=[…]` at process start; `skills/config/write` is global and persists, so avoid it for per-run state. Unverified: thread-level `config` override.
- **Catalog to the UI.** Daemon `SkillCatalog = { fingerprint, entries[] }`, entry `{ id, name, qualifiedName, description, source: 'system'|'user'|'project', engines: {claude, codex}, enabled, modelInvocable, userInvocable, path, contentHash, tokens?, errors? }`. Port from Reforma: explicit roots `{system, user, project}`, fingerprint = hash of sorted `{path, mtimeMs, size}`, cache per project, debounced (300 ms) directory watchers. Differences: system entries fingerprint by content hash; add a description cap and a size budget (Reforma has none); parse YAML with a real library, accept `user-invocable`, `allowed-tools`, `when_to_use`. Store `catalogFingerprint` on each run, then compare the engine's own report after start (Claude init + `getContextUsage().skills`, Codex `skills/list`) and surface a mismatch or `plugin_errors` as a run warning.
- **Always-on pointer.** A skill listing is advisory. Add one line to the engine system prompt (Claude `systemPrompt.append`, Codex `developerInstructions`): "You run inside Clowdy. Load skill `clowdy:<role>` before acting." and start orchestrator runs with the explicit dispatch above.

## Limits and risks

- Skills are advisory text: no enforcement, and `allowed-tools`/fork behavior is not exercised by Clowdy tests yet.
- Claude `settingSources:['project']` drags in the repo's hooks, `.mcp.json` and CLAUDE.md. That is probably wanted; user-level sources are the expensive part, hence the mirror plugin.
- Claude's init `skills` ignores the allowlist, so use `getContextUsage()` for what the model sees. A bad plugin path fails silently.
- Codex: `$HOME/.agents/skills` is always read (HOME must stay real for git/ssh), so the user's global skills leak into every Codex run unless disabled by name or path. `$CODEX_HOME/skills` is a deprecated root; the `extraRoots` RPC needs app-server, so the SDK/`exec` path depends on symlinks or copies.
- Codex has no worktree fallback; project skills that are untracked or gitignored are invisible there but visible to Claude.
- Codex catalog (2% / 8,000 chars) is smaller than most Claude setups; keep descriptions short or raise `skills.max_context_tokens`.
- Cost: 7 system skills at roughly 50 to 90 tokens each is under 700 tokens per run. Without `disableBundledSkills` Claude adds ~2,060; without `skills.bundled.enabled=false` Codex lists 5 extra.
- No policy change: skills don't alter the subscription-auth analysis in the engine notes.

## Open questions

1. Does a thread-level `config` (`thread/start`) apply `skills.config` per thread, or only the process-level layer?
2. Do Codex native subagents see the same skill roots and catalog as their parent?
3. Do Claude `Workflow`-tool agents and `context: fork` skills inherit plugins and the `skills` allowlist? Only docs confirm `fork` under the SDK.
4. Does an explicit Codex `skill` input item really inject the body (docs/source say yes; no turn was run).
5. Hot reload: `Query.reloadPlugins()/reloadSkills()` (Claude) and `skills/changed` (Codex) versus "applies from the next run". The Claude catalog is frozen per session.
6. How to name orchestrator tools so one skill text works for `mcp__clowdy__spawn_run` (Claude) and the Codex dynamic tool.
7. Should the project's `.claude/skills` be mirrored into a plugin too (consistent allowlist, `.agents`/`.codex` visible to Claude) instead of `settingSources:['project']`? It loses nested lazy loading and CLAUDE.md.

## Sources

- https://code.claude.com/docs/en/agent-sdk/skills , /agent-sdk/plugins , /agent-sdk/claude-code-features , /agent-sdk/subagents
- https://code.claude.com/docs/en/skills (frontmatter, locations, budget, compaction, skillOverrides) , /sub-agents (preload) , /headless (bare mode) , /cli-reference
- https://learn.chatgpt.com/docs/build-skills (Codex skills; `developers.openai.com/codex/skills` redirects) , /docs/app-server.md , /docs/config-file/config-reference
- Codex source (main, 2026-11-17): `codex-rs/ext/skills/src/host_roots.rs`, `codex-rs/skills/src/{parser,mentions,model}.rs`, `codex-rs/utils/plugins/src/plugin_namespace.rs`, `codex-rs/exec-server/src/discoverV2/capability_locations.rs`, schema commits #24977 and #21485
- Local: `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` 0.3.325; generated app-server TS schema 0.169.0; Reforma note `research/reforma-agent/05-skills-memory-mcp-plugins.md` (sections 1.1 to 1.8)

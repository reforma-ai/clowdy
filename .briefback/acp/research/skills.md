# Skills over ACP: the agent-agnostic path, and what bb and Orca did

Snapshot 2026-11-17. Clowdy side: `apps/daemon/AGENTS.md` "Skills", `apps/daemon/src/skills/*`, `apps/daemon/src/runs/prompts.ts`, `.briefback/mvp/research/skills-in-engines.md` (existing, dated 2026-11-17: probes of the Claude Agent SDK 0.3.325 and Codex 0.169). ACP side: `docs/rfds/agent-skills.mdx`, `docs/rfds/additional-directories.mdx` in the protocol repo at `ecd1765`; adapters at `3205f0b` (Claude) and `b9503ae` (Codex). bb at `f1c5304`, Orca at `cbc8119e`. Observed = read in source; inferred = my reading; nothing was run.

## Summary

- **ACP has no standard way to deliver skills to an agent.** Orca's source says so in a file comment: "ACP has no standard skill delivery; use each agent's per-process configuration" (`src/main/acp/launch/acp-visuals-skill.ts@cbc8119e`). The ACP RFD for skills (v2, not stable) says the same and names the two routes that exist without new protocol surface: **`additionalDirectories`** ("Claude Code and Codex discover skills under them") and MCP's Skills extension (SEP-2640, "support among coding agents is still early").
- What ACP does standardize today (v1) is only the **advertisement** of skills: agents send them as ordinary `available_commands_update` entries (Claude: command under the skill's name; Codex: `$name`; Pi and Kimi Code: `skill:name`; Gemini CLI and OpenCode advertise none), plus the stable `systemPrompt` and the first-prompt text.
- Clowdy's current mechanism is **Claude-plugin-shaped** (a folder with `.claude-plugin/plugin.json` named `clowdy` and `skills/<name>/SKILL.md`, handed to the SDK as `plugins` and to Codex as an extra skill root). That shape is not portable by itself; each target agent needs its own delivery.
- Whether an agent **finds and follows** a skill is the agent's own business (the model decides by description). Clowdy makes the entry skill deterministic with a first message that starts `/clowdy:orchestrate` (Claude plugin slash command) and a one-line system-prompt pointer. Both parts depend on agent support.

## What Clowdy does today (for reference)

- `SkillsService` materializes the system skills to `<dataDir>/system-skills/<hash>` and writes `Config.systemSkillsDir`; user skills are mirrored into `<dataDir>/user-skills-plugin/<hash>` (`Config.extraPluginDirs`, plugin name `user`). Engines read both at run start. Claude: `plugins: [{type:'local', path}]` (`engine/claude/session.ts`). Codex (planned): extra root `<dir>/skills`, names come out `clowdy:<skill>` from the manifest.
- Project skills are not mirrored: Claude reads `<cwd>/.claude/skills`, Codex reads `.agents/skills`; the catalog lists which engine sees which (`PROJECT_ROOTS` in `src/skills/service.ts`).
- `runs/prompts.ts`: system prompt says "Follow clowdy:orchestrate / executor / verify"; first message is `/clowdy:<entry skill> Mode: autopilot|semi-manual`.
- The catalog (`GET /v1/skills`) assumes two engines (`SkillEngine = 'claude' | 'codex'`).

## Per-agent skill discovery (what an ACP-launched agent reads on its own)

From bb's declared native roots (`docs/configuration.md` "Skills" table at `f1c5304`), cross-checked against `known-agents.ts`:

| Agent | User roots | Project roots |
| --- | --- | --- |
| Claude Code | `$CLAUDE_CONFIG_DIR/skills` or `~/.claude/skills`, plus enabled plugins | `.claude/skills` from repo root to cwd, plus plugins |
| Codex | `~/.agents/skills`, `$CODEX_HOME/skills` | `.agents/skills` from repo root to cwd, `.codex/skills` |
| Cursor | `~/.cursor/skills`, `~/.agents/skills`, `~/.claude/skills`, `~/.codex/skills` | same four in the workspace |
| OpenCode | `~/.config/opencode/skills`, `~/.claude/skills`, `~/.agents/skills` (+ `$OPENCODE_CONFIG_DIR/skills`) | `.opencode/skills`, `.claude/skills`, `.agents/skills` up to repo root |
| Pi | `~/.pi/agent/skills`, `~/.agents/skills` | `.pi/skills`; `.agents/skills` up to repo root |
| omp | omp agent roots plus Pi, Agents, Claude, Codex, OpenCode roots | `.omp/skills` and compatibility roots |
| Grok Build | `$GROK_HOME/skills` or `~/.grok/skills`, `~/.agents/skills`, `~/.claude/skills`, `~/.cursor/skills` | same four from repo root to cwd |
| Hermes | `$HERMES_HOME/skills` or `~/.hermes/skills` | none |

Pattern **[inferred]**: `.agents/skills` is read by Codex, Cursor, OpenCode, Pi, omp and Grok; `.claude/skills` by Claude, Cursor, OpenCode, omp and Grok. A project folder that carries both layouts reaches most agents with no per-agent code, at the cost of writing into the user's repository or an additional directory.

## Routes for supplying Clowdy's own skills to an ACP agent

| Route | How | Reaches | Costs |
| --- | --- | --- | --- |
| **`additionalDirectories`** | Put system skills under `<dir>/.agents/skills/<name>/SKILL.md` and/or `<dir>/.claude/skills/<name>/SKILL.md` and pass `<dir>` in `session/new.additionalDirectories` (needs `sessionCapabilities.additionalDirectories`; both Zed adapters advertise it). `codex-acp` explicitly turns each root into a Codex extra skill root: `refreshSkills` calls `skills/extraRoots/set` with `<root>/.agents/skills` (`src/CodexAcpClient.ts` ~1280-1290). Claude Code loads `.claude/skills` of additional directories when its settings sources include `project` (existing Clowdy probe, `skills-in-engines.md`). | Claude and Codex through their adapters; other agents only if they scan workspace roots the same way (unknown) | Names are not the plugin-namespaced `clowdy:<skill>` Claude shows today unless the folder is inside a plugin with a manifest (Codex derives the namespace from a manifest found above the skill, per the existing probe; Claude additional-dir skills are plain or `dir:`-prefixed). The first-message `/clowdy:orchestrate` would need rechecking. The root set also widens the file scope the spec treats as a boundary for tool operations ("SHOULD serve as a boundary"). |
| **Claude plugin via `_meta.claudeCode.options.plugins`** | `session/new` `_meta` forwards SDK `Options` to Claude Code; ignored keys are only `cwd`, `includePartialMessages`, `permissionMode`, `canUseTool`, `executable`; `hooks`, `mcpServers`, `disallowedTools` are merged (`claude-agent-acp/src/new-session-meta.ts`). `plugins`, `settingSources`, `skills`, `settings` are therefore passable. | Claude only | Keeps today's exact plugin mechanism and names; relies on an adapter-specific `_meta` contract that can change; adapter's session fingerprint includes `plugins` (`src/v1/session-fingerprint.ts`), so changing plugins means a new Claude process. |
| **Per-agent launch configuration** (Orca) | Grok and omp: `--plugin-dir <dir>` on the launch line (Grok since 1.0.44); OpenCode: merge `skills.paths` into its config content; all chosen per agent version (`acp-launch-registry.ts`, `acp-visuals-skill.ts`). | One agent each | Per-agent, version-gated code; the user's config must be preserved (Orca refuses to rewrite JSONC it cannot parse). |
| **Prompt injection** (bb) | Wrap bb's `AGENTS.md`-style instructions in `<system_instructions>` and prepend them as a text block of the first prompt (`buildPromptContentBlocks`); rewrite a `/skill` mention that the agent did not advertise into prose `Use the bb skill "<name>"` (`textWithBbSkillCommandsSpelledOut`). | Every ACP agent | Costs context every session; not a skill (no progressive loading); gives instructions user-turn weight. The stable `systemPrompt` field (capability-gated) is the cleaner version of the first half. |
| **`systemPrompt` (ACP v1 stable, since 2026-11-09)** | `session/new.systemPrompt { mode: "append", content }` | Agents advertising `sessionCapabilities.systemPrompt` | Only text; fine for a short pointer ("Follow clowdy:orchestrate"), not for skill bodies. |
| **Project files** (`AGENTS.md`, `.claude/skills`, `.agents/skills`) | Agents read them natively; bb documents that provider-native `AGENTS.md`/`CLAUDE.md` remain separate from its own injected instructions | Most agents | Writes into the user's repository or worktree; Clowdy deliberately does not mirror project skills today. |
| **MCP Skills extension (SEP-2640)** | Skills served as MCP resources with `skills/list` and `skills/get` from a server the client hands over | "of the Agents that implement ACP, MCP's client matrix lists only fast-agent, with partial support" (RFD, 2026-11) | Not usable yet. |
| **ACP v2 `skill` entries and content block** | Client capability `session.commands.skill`; agents list `skill` entries in `availableCommands`; client invokes by a `skill` content block | Future | v2 is a draft (RFD `agent-skills.mdx`, "ACP v2"). |

## What bb did

- bb keeps its own skills index (`<dataDir>/skills/<name>/SKILL.md`, `<workspace>/.bb/skills`, plugin skills, `sharedSkillRoots`) and shows each provider's **native roots** in its `/` menu and Skills page by declaring `nativeSkillRoots` per provider (`known-agents.ts`; fields `recursive`, `ancestors`, `namePrefix`, `skipIfManifest`). `docs/configuration.md` "Skills".
- For **Claude Code** bb passes plugin directories through the SDK (`plugins/provider-claude-code/src/bridge/skill-plugins.ts`) and omits injected copies Claude already sees. For **Codex** it sends selected skills as structured skill inputs with the path from Codex's catalog. Those are the two non-ACP bridges.
- For **ACP agents** the bridge stores bb's skill roots only to rewrite mentions (`skills/configure` request, `configuredSkillRoots`, bridge.ts ~4134); I did not find code that copies a bb-owned skill into an ACP agent's directory. How a bb-only skill becomes reachable to such an agent was not established.
- bb's `AGENTS.md` data-dir and `<workspace>/.bb/AGENTS.md` are injected into every provider's system prompt at session start (for ACP: first-prompt wrapper, above).

## What Orca did

- Skills are Orca's own (`skills/`, `skill-guides/`, `skill-stubs/`) and are served to agents by the `orca skills get <name>` command, so an agent that has the Orca CLI can fetch them (`skill-guides/orchestration.md`: "`ORCA skills get orchestration --reference ...`"). That is delivery through a CLI, not through the agent's skill system.
- Orca installs bundled skills into agent homes (`src/main/skills/bundled-skill-install`, `skills/install`, `managed-remove`) **[observed from directory names; not read]** and, for ACP agents, uses the per-agent launch mechanisms in the table above.

## Constraints

- A skill is progressive-disclosure content the agent's model decides to load. Delivery only guarantees visibility; Clowdy's determinism today comes from the explicit `/clowdy:<skill>` first message, which exists only where the agent exposes slash commands for skills (the agent advertises it in `available_commands_update`).
- Frontmatter portability: both Claude and Codex read `SKILL.md` with `name` and `description`; Claude-only keys are ignored elsewhere (existing probe).
- Skill listing budgets differ per agent (Claude 1% of context, Codex 2% or 8,000 chars), so the catalog token estimate in `src/skills/catalog.ts` is per engine today.
- `codex-acp` hides one Codex-bundled skill (`visualize:visualize`) because ACP clients cannot render it (`src/UnsupportedSkills.ts`): adapters can filter skills.

## Sources

- `docs/rfds/agent-skills.mdx`, `docs/rfds/additional-directories.mdx`, `docs/protocol/v1/session-setup.mdx` (protocol repo `ecd1765`, 2026-11-17)
- `claude-agent-acp@3205f0b`: `src/new-session-meta.ts`, `src/v1/session-fingerprint.ts`, `src/slash-commands.ts`; `codex-acp@b9503ae`: `src/CodexAcpClient.ts`, `src/CodexCommands.ts`, `src/UnsupportedSkills.ts`
- bb `f1c5304`: `docs/configuration.md` "Skills", `packages/provider-bridge-acp/src/bridge/bridge.ts`, `plugins/provider-acp/src/known-agents.ts`, `plugins/provider-claude-code/src/bridge/skill-plugins.ts`
- Orca `cbc8119e`: `src/main/acp/launch/{acp-visuals-skill.ts,acp-launch-registry.ts}`, `skill-guides/orchestration.md`
- `.briefback/mvp/research/skills-in-engines.md` (Clowdy, 2026-11-17)

## Open questions

- Do Cursor, OpenCode, Grok, Gemini CLI and Pi pick up skills from an ACP `additionalDirectories` root the way Claude Code and Codex do? Only the RFD's claim for Claude and Codex plus the Codex adapter code were seen.
- Does a plugin-namespaced name (`clowdy:orchestrate`) survive when the same folder is reached through an additional directory for Claude and for Codex?
- Does `/clowdy:orchestrate` as the first prompt text dispatch as a skill through each adapter (Claude adapter supports custom slash commands; Codex adapter names skills `$name`)?

## Assumptions and limits

- I did not read `src/skills/*` in Clowdy beyond the AGENTS.md description, the Orca `src/main/skills` tree, or bb's `skill-plugins.ts` body. No skill was loaded through an adapter.

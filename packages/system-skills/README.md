# @clowdy/system-skills

The skills that ship with Clowdy and make it work. They are the manual an agent follows inside the app: how to take a request from a manager, split it into tasks, do the work, check the result with commands the agent ran and report in plain words. They are text, not code: no enforcement, so every rule must be something a model can follow with the engine's own tools (Read, Edit, Bash, Grep), the few Clowdy tools below and the `clowdy thread` shell command.

## What it is

One Claude-format plugin named `clowdy` (`.claude-plugin/plugin.json`) with one folder per skill in `skills/`. Skills appear as `clowdy:<folder>`. The folder names carry no `clowdy-` prefix, because the plugin name is the namespace.

## How engines load it

Design settled in `.briefback/mvp/research/skills-in-engines.md` and built in Stage 8 of the MVP plan:

- The daemon copies the package to `<dataDir>/system-skills/<contentHash>/` (read-only, outside the app bundle) and points every engine at that copy.
- **Every agent** runs over ACP (Claude Code and Codex through their adapters) and is asked to load no plugin, so the skill text goes in as text: see the next point. The other skills are plain files in the copy, which the agent reads with its file tool when a skill says to follow them.
- A skill listing is advisory, so loading is made deterministic: the system prompt of every run carries the entry skill, `orchestrate`, whole, in a `<skill>` block, and the run of a thread (a chat another chat's agent started) carries `thread` after it. The first message of a run starts with `Follow clowdy:<skill>. Mode: autopilot` (or `semi-manual`), then the content.
- Project and user skills work alongside these. Plugin skills are namespaced, so a project skill never shadows one of ours.

## The skills

| Skill | Teaches |
| --- | --- |
| `orchestrate` | Entry skill of every orchestrator run: classify (question, small change, larger work), then understand, plan a task graph (stages as tasks inside a larger one, checklists for the steps one owner takes), work (itself, with the engine's own sub-agents for read-only research and disjoint edits, or through threads for coarse pieces, long-running work and independent checks), integrate, verify with commands that ran, record, report. References: threads, sub-agents, verification and probes, plan and sizing, self-hosting. |
| `thread` | The manual of a chat that is a thread: the first message is the whole brief, the last message of every turn is the report to the parent (verdict, evidence, what is left), when to message the parent, and what a thread leaves to others. Loaded with `orchestrate` into a thread's system prompt. |

How they plug together: `orchestrate` coordinates work with Clowdy tasks and threads. A thread runs `orchestrate` too, plus `thread`. Modes determine whether the agent decides or asks the user. Each thread gets a self-contained brief and reports back to its parent.

## Tools and commands the skills may name

Bare names; the harness adds its prefix. Nothing else may appear in a skill, and there are no git tools: git is plain `git` in Bash, the agent's own business.

`ask_user` (semi-manual orchestrator only) is the one tool. Tasks, threads and chat reads are shell commands: `clowdy task <command>`, `clowdy thread <command>`, and `clowdy chat read <id>`. Skills name them that way, never as `task_get`, `thread_spawn` or `chat_read`. The commands: `get`, `list`, `create`, `update`, `comment`, `comments`, `archive`, `unarchive` for tasks, and `spawn`, `tell`, `stop`, `wait`, `output`, `log`, `list` for threads. Each is a tool of the daemon marked as a shell command (`apps/daemon/src/runs/task-tools.ts`, `thread-tools.ts`, `chat-tools.ts`); its options are the tool's fields in kebab case (`--timeout-seconds`, `--depends-on`, `--parent`), a text field also takes `--<name>-file <path>` (`-` reads stdin, so a brief or a description goes in a heredoc), a list takes comma-separated values, and `clowdy <group> <command> --help` prints them. An agent that cannot use the shell route has the task tools as MCP tools with the same names and fields (`AgentSpec.taskTools`); the skills do not change for it, and the system prompt says so.

The fields come from the daemon's tool definitions (`apps/daemon/src/runs/`): `ask_user` options carry an `id` and `recommended` is that id, a run has one open question at a time, `clowdy task get` returns `activeRuns` (the runs working on a task, a chat's own run among them), the task it is inside, the tasks inside it and its latest comments, and `clowdy task list --ready` means not closed with every dependency closed (Done or Canceled). `apps/daemon/test/skills-vocabulary.test.ts` checks the tool names and the `ask_user` examples against the real tools, and every `clowdy task`, `clowdy thread` and `clowdy chat` command and option a skill writes against the daemon's shell commands.

## Authoring rules

- One folder per skill: `skills/<name>/SKILL.md` with front matter `name` (equal to the folder, lowercase, digits, hyphens) and `description` (one or two sentences on one line saying what it does and when to use it, at most 1,000 characters, no `<` or `>`). `allowed-tools` only if truly needed; no other keys.
- Body under 24 KB, target 80 to 200 lines. Put the critical rules first (compaction keeps only the first 5,000 tokens of a loaded skill). Move long checklists, templates and examples into `references/*.md` and link them with relative Markdown links; every reference must be linked from its `SKILL.md` or from another reference.
- Voice: imperative, concrete, English, no filler, no emojis. Short numbered steps and small templates over prose. One short worked example per skill.
- In skill bodies and references, wrap each optional cross-skill reference and only its dependent wording in `<!-- skill:name -->...<!-- /skill -->`. The daemon removes that span when the named skill is off and strips the markers otherwise. Keep the surrounding instructions meaningful without the span. Do not use markers in front matter; descriptions must stand alone. The daemon rejects unmarked references.
- Write for a manager who may not be a programmer: what changed and why, tasks, risks, decisions. No git jargon in anything the agent tells the user.
- Say each thing once. Shared material lives in one skill; the others refer to it by name, never by path.
- Do not invent tools, daemon features or git machinery. Do not use Claude-only syntax (`$ARGUMENTS`, `${CLAUDE_*}`, `` !`cmd` ``, `context: fork`): Codex leaves it literal.
- Sub-agents may not have these skills in context, and a thread does not see its parent's conversation: whatever they need must be in the prompt or brief the orchestrator writes.

## Validate

```bash
bun run test          # bun scripts/validate.ts
bun run lint          # biome check
bun run typecheck
```

`scripts/validate.ts` checks the manifest name, front matter, size caps, links, orphaned reference files, Claude-only syntax, any tool-like name that is not in the list above (a removed tool name or a thread tool written as a tool fails), any `clowdy task`, `clowdy thread` or `clowdy chat` command that is not one of the commands above, plus words of removed features (a `--append` of `task update`, for one). Run it after every edit to a skill.

# @clowdy/system-skills

The skills that ship with Clowdy and make it work. They are the manual an agent follows inside the app: how to take a request from a manager, split it into tasks, do the work, check the result with commands the agent ran and report in plain words. They are text, not code: no enforcement, so every rule must be something a model can follow with the engine's own tools (Read, Edit, Bash, Grep) and the few Clowdy tools below.

## What it is

One Claude-format plugin named `clowdy` (`.claude-plugin/plugin.json`) with one folder per skill in `skills/`. Skills appear as `clowdy:<folder>`. The folder names carry no `clowdy-` prefix, because the plugin name is the namespace.

## How engines load it

Design settled in `.briefback/mvp/research/skills-in-engines.md` and built in Stage 8 of the MVP plan:

- The daemon copies the package to `<dataDir>/system-skills/<contentHash>/` (read-only, outside the app bundle) and points every engine at that copy.
- **Claude** also gets it as `plugins: [{ type: "local", path }]`; skills load without any user or project settings sources. Subagents see the same plugin.
- **Every other agent** (they run over ACP) has no plugin to load, and no other agent reads our manifest, so the skill text goes in as text: see the next point. The other skills are plain files in the copy, which the agent reads with its file tool when a skill says to follow them.
- A skill listing is advisory, so loading is made deterministic: the system prompt of every run carries the entry skill, `orchestrate`, whole, in a `<skill>` block. The first message of a run starts with `Follow clowdy:<skill>. Mode: autopilot` (or `semi-manual`), then the content.
- Project and user skills work alongside these. Plugin skills are namespaced, so a project skill never shadows one of ours.

## The skills

| Skill | Teaches |
| --- | --- |
| `orchestrate` | Entry skill of every orchestrator run: classify (question, small change, larger work), then understand, plan a task graph, work (itself, or with the engine's own sub-agents for read-only research and disjoint edits), integrate, verify with commands it ran, record, report. References: sub-agents, verification and probes, plan and sizing, self-hosting. |
| `autopilot` | Working without asking: sorting forks, deciding significant ones by criteria and recording them, reporting true blockers only. |
| `semi-manual` | The grill: asking the user about significant forks through `ask_user` cards, settling the list, then building with autopilot discipline. |
| `scaffold` | Starting an application from nothing: product statement, stack, one verified skeleton, first task graph. |
| `docs` | The `.clowdy/docs/` contract: layout, facts versus plans, decisions and superseding, safe editing. |

How they plug together: `orchestrate` is the loop. It loads `autopilot` or `semi-manual` for the mode, `docs` to read and write project memory, `scaffold` when there is no app yet, and does the work itself, or with the agent's own sub-agents for read-only research and disjoint edits. Only the orchestrator talks to the user and writes the project documents; sub-agents get what they need in the prompt and hand back an answer.

## Tools the skills may name

Bare names; the harness adds its prefix. Nothing else may appear in a skill, and there are no git tools: git is plain `git` in Bash, the agent's own business.

`task_create`, `task_update`, `task_list`, `task_get`, `ask_user` (semi-manual orchestrator only).

The fields come from the daemon's tool definitions (`apps/daemon/src/runs/`): `ask_user` options carry an `id` and `recommended` is that id, a run has one open question at a time, and the task tools return `activeRuns`, the runs working on a task (a chat's own run among them). `apps/daemon/test/skills-vocabulary.test.ts` checks the tool names, the fields of one-line calls and the `ask_user` examples against the real tools.

## Authoring rules

- One folder per skill: `skills/<name>/SKILL.md` with front matter `name` (equal to the folder, lowercase, digits, hyphens) and `description` (one or two sentences on one line saying what it does and when to use it, at most 1,000 characters, no `<` or `>`). `allowed-tools` only if truly needed; no other keys.
- Body under 24 KB, target 80 to 200 lines. Put the critical rules first (compaction keeps only the first 5,000 tokens of a loaded skill). Move long checklists, templates and examples into `references/*.md` and link them with relative Markdown links; every reference must be linked from its `SKILL.md` or from another reference.
- Voice: imperative, concrete, English, no filler, no emojis. Short numbered steps and small templates over prose. One short worked example per skill.
- Write for a manager who may not be a programmer: what changed and why, tasks, risks, decisions. No git jargon in anything the agent tells the user.
- Say each thing once. Shared material (task template, decision template, report format) lives in one skill; the others refer to it by name (`clowdy:docs`), never by path.
- Do not invent tools, daemon features or git machinery. Do not use Claude-only syntax (`$ARGUMENTS`, `${CLAUDE_*}`, `` !`cmd` ``, `context: fork`): Codex leaves it literal.
- Sub-agents may not have these skills in context: whatever they need must be in the prompt the orchestrator writes.

## Validate

```bash
bun run test          # bun scripts/validate.ts
bun run lint          # eslint on scripts
bun run typecheck
```

`scripts/validate.ts` checks the manifest name, front matter, size caps, links, orphaned reference files, Claude-only syntax, and any tool-like name that is not in the list above (a removed tool name fails), plus words of removed features. Run it after every edit to a skill.

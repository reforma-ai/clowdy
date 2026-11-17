# @clowdy/system-skills

The skills that ship with Clowdy and make it work. They are the manual an agent follows inside the app: how to take a request from a manager, split it into tasks, run agents in parallel, check the result independently and report in plain words. They are text, not code: no enforcement, so every rule must be something a model can follow with the engine's own tools (Read, Edit, Bash, Grep) and the few Clowdy tools below.

## What it is

One Claude-format plugin named `clowdy` (`.claude-plugin/plugin.json`) with one folder per skill in `skills/`. Skills appear as `clowdy:<folder>`. The folder names carry no `clowdy-` prefix, because the plugin name is the namespace.

## How engines load it

Design settled in `.briefback/mvp/research/skills-in-engines.md` and built in Stage 8 of the MVP plan:

- The daemon copies the package to `<dataDir>/system-skills/<contentHash>/` (read-only, outside the app bundle) and points every engine at that copy.
- **Claude** gets it as `plugins: [{ type: "local", path }]`; skills load without any user or project settings sources. Subagents see the same plugin.
- **Codex** gets the same `skills/` directory as an extra skill root and derives the same `clowdy:<skill>` names from the manifest.
- A skill listing is advisory, so loading is made deterministic: the system prompt of every run carries one line pointing at the entry skill, an orchestrator run starts with `/clowdy:orchestrate <message>` and a spawned executor with `/clowdy:executor`. Verifier runs are told to follow `clowdy:verify` in their prompt.
- Project and user skills work alongside these. Plugin skills are namespaced, so a project skill never shadows one of ours.

## The skills

| Skill | Teaches |
| --- | --- |
| `orchestrate` | Entry skill of every orchestrator run: classify (question, small change, larger work), then understand, plan a task graph, fan out in parallel, integrate, verify, record, report. |
| `executor` | A spawned run doing one piece of work: scope, small verified steps, no questions to the user, `report_result` with evidence. |
| `verify` | Independent verification of the integrated result with real commands and flows; check reports; pass, fail or blocked. |
| `autopilot` | Working without asking: sorting forks, deciding significant ones by criteria and recording them, reporting true blockers only. |
| `semi-manual` | The grill: asking the user about significant forks through `ask_user` cards, settling the list, then building with autopilot discipline. |
| `scaffold` | Starting an application from nothing: product statement, stack, one verified skeleton, first task graph. |
| `docs` | The `.clowdy/docs/` contract: layout, who writes what, facts versus plans, decisions and superseding, safe editing. |

How they plug together: `orchestrate` is the loop. It loads `autopilot` or `semi-manual` for the mode, `docs` to read and write project memory, `scaffold` when there is no app yet, and spawns executors and verifiers that follow `executor` and `verify`. `executor` and `verify` hand back through `report_result`; only the orchestrator talks to the user and writes `index.md`, `product.md` and `architecture.md`.

## Tools the skills may name

Bare names; the harness adds its prefix. Nothing else may appear in a skill, and there are no git tools: git is plain `git` in Bash, the agent's own business.

`task_create`, `task_update`, `task_list`, `task_get`, `run_spawn`, `run_inspect`, `run_wait`, `run_cancel`, `ask_user` (semi-manual orchestrator only), `report_result` (executors and verifiers end with it).

## Authoring rules

- One folder per skill: `skills/<name>/SKILL.md` with front matter `name` (equal to the folder, lowercase, digits, hyphens) and `description` (one or two sentences on one line saying what it does and when to use it, at most 1,000 characters, no `<` or `>`). `allowed-tools` only if truly needed; no other keys.
- Body under 24 KB, target 80 to 200 lines. Put the critical rules first (compaction keeps only the first 5,000 tokens of a loaded skill). Move long checklists, templates and examples into `references/*.md` and link them with relative Markdown links; every reference must be linked from its `SKILL.md` or from another reference.
- Voice: imperative, concrete, English, no filler, no emojis. Short numbered steps and small templates over prose. One short worked example per skill.
- Write for a manager who may not be a programmer: what changed and why, tasks, risks, decisions. No git jargon in anything the agent tells the user.
- Say each thing once. Shared material (task template, decision template, report format) lives in one skill; the others refer to it by name (`clowdy:docs`), never by path.
- Do not invent tools, daemon features or git machinery. Do not use Claude-only syntax (`$ARGUMENTS`, `${CLAUDE_*}`, `` !`cmd` ``, `context: fork`): Codex leaves it literal.
- Sub-agents and spawned runs may not have these skills in context: whatever they need must be in the prompt the orchestrator writes.

## Validate

```bash
bun run test          # bun scripts/validate.ts
bun run lint          # eslint on scripts
bun run typecheck
```

`scripts/validate.ts` checks the manifest name, front matter, size caps, links, orphaned reference files, Claude-only syntax and any tool-like name that is not in the list above. Run it after every edit to a skill.

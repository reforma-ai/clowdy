# System skills

Owner requirement (mid-MVP): Clowdy must support skills fully. **System skills** ship with the app and are load-bearing: they tell agents how to scaffold an application from nothing, how to work in autopilot and in semi-manual mode, and how to run the delivery loop. The base is something like Briefback (Research → Grill → Plan → Stage → Review → Commit), with parallelism as the main difference.

This note is the intent; the content is written after the engine and orchestration research settle how skills reach an engine.

## What differs from Briefback

Briefback's loop is sequential per feature, with optional subagents. Clowdy's loop fans out:

1. **Research** (parallel readers, one note each) → **Grill** (semi-manual only; autopilot decides and records the decision) → **Plan** as a task graph, not a stage list: every task has `dependsOn` and the paths it expects to own, so independent tasks can run at once without touching the same files.
2. **Fan-out**: every ready task becomes an executor run in its own worktree and branch; the orchestrator keeps spawning as slots free up and as dependencies finish.
3. **Integrate** serially (merge queue), then **verify the merged result**, not each branch; failures return to the queue with the reason.
4. **Review** runs as its own parallel verifier runs, adversarial and independent of the author.
5. State lives in Clowdy's task list and `.clowdy/docs/` (decisions, research, plan notes), not in per-feature chat memory.

## Proposed system skills

| Skill | Teaches |
| --- | --- |
| `clowdy-orchestrate` | The fan-out loop above; how to use the orchestrator tools (create/update tasks, spawn executors bound to tasks, wait, cancel); sizing tasks; avoiding file overlap; when to replan. |
| `clowdy-autopilot` | Deciding without asking: record each significant decision (date, reason, scope) in `.clowdy/docs/decisions/`; never stall on a question the code or docs can answer. |
| `clowdy-semi-manual` | The grill: frontier of open decisions, numbered questions with a recommended option and its consequence, the `question` stream item protocol, not re-asking settled decisions. |
| `clowdy-scaffold` | Starting an app from scratch: choose a stack from the brief, create the repository layout, tooling, first task graph, docs index, and a verification command that runs from day one. |
| `clowdy-executor` | Working one task in a worktree: stay inside the task's scope, commit in small steps, report result and checks back to the orchestrator. |
| `clowdy-verify` | Verifying a merged result with real commands and user flows; recording evidence as an artifact. |
| `clowdy-docs` | The `.clowdy/docs/` layout and rules (facts vs hypotheses vs plans, superseding decisions). |

Project and user skills (`SKILL.md` folders) work alongside them with the usual precedence; system skills must not be editable from a project but can be extended.

## Open design points (resolve from the research)

- How system skills reach each engine: Claude Agent SDK settings sources / plugins vs. injecting the catalog into the system prompt ourselves; Codex has its own mechanism.
- Where the bundled skills live in the repo (`packages/system-skills`, versioned with the app) and how the daemon exposes the catalog to the UI (a Skills section in settings: list, enabled state).
- Reforma already reads skills from several roots with a fingerprinted catalog and size caps; `research/reforma-agent/05-skills-memory-mcp-plugins.md` says what is worth porting.

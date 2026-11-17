# Stages 5-6: end-to-end run with the real Claude engine

A run of the whole path (daemon, Claude engine on the subscription, system skills, renderer) against a throwaway repo. Haiku forced through the project setting, `CLOWDY_ENGINE=claude`, one-line prompts. Nothing here is in the repository's git history; the test repo lived in a scratch folder.

## What happened

| Scenario | Result |
| --- | --- |
| a. Question ("What does this project do?") | Answered from the code after four tool calls. No task, no file change. It ran read-only `git ls-files` to list the files, which is more git than "touches no git" promises. |
| b. `--version` in autopilot | The orchestrator did it alone: one task, edit, test, commit, task Done. No decision record (the skill asks for none on a small change). |
| c. Greet and farewell | Asked as given, the orchestrator did both itself (one task). That is what the sizing rules say for two tiny commands. With "one task and one run per command" it created two tasks, called `run_spawn` twice, wrote "ending my turn", and parked. Statuses: `running`, `waiting_children`, `queued`, `running`, `succeeded`; the session id stayed `d141b460` throughout. Executors had `parentRunId` and an `assigned` link to their task, the orchestrator a `created` link to both. Tasks went In progress, Review, Done. Slot release while parked is covered by `wake.test.ts`, not read off the live daemon. |
| d. Semi-manual config file | Two cards came in one turn (batched), then a settled-decisions record in `.clowdy/docs/decisions/`, an `index.md` line, and a confirmation card. Each `run.answer` resumed the same session (`waiting_user`, `queued`, `running`). The task ended Done and the change was committed. |
| e. Cancel | `run.cancel` on the orchestrator returned all four runs (three executors first). Their processes were gone 3 s later and the daemon had no children left. History and tool items stayed, no tool card was left `running`, tasks went back to To do. The half-written files stayed in the checkout. |
| f. `kill -9` | The engine process survived as an orphan (ppid 1) and kept working for about five seconds. The new daemon killed it at start, marked the run `interrupted` ("Daemon restarted"), and no engine process was left. A later message resumed the same session and finished only what was missing. |
| Native sub-agents | Asked for two parallel `Agent` calls. Two `origin=native` child runs ("Explore") appeared under the orchestrator and finished `succeeded`, each with its own stream. |
| Follow-up on a finished chat, across a restart | Same run, same session, items appended once. |

## Cost and tokens

The account's five-hour window was already at 91% when the run began (warning events, 92% at the end). The adapter's usage events add up to this over nine completed runs:

- 1.96 M input tokens (cache reads included), 41 k output tokens, $0.082 at API prices.
- A question costs about 95 k input tokens over four tool turns. An orchestrator that plans and fans out costs 150-330 k. An executor costs about 145 k input and 3 k output (about $0.006-0.008).
- Cancelled runs show no usage: usage arrives at the end of a turn.
- The first turn after a daemon restart adds tokens but no cost (no baseline), as documented.

## Fixed in this run

- The ask_user card ran title, facts and "My pick" together in one bold paragraph. `QuestionCard` now splits the text into a bold title and quieter paragraphs (`stream/questionParts.ts`, with a test).

## Rough edges

- Fan-out needs larger work or an explicit instruction. Small independent pieces are done by the orchestrator, which costs less but is not the demo.
- The wake-up comes two seconds after the first child. In c the second executor finished four seconds later, so the orchestrator called `run_wait` (30 s) and held its slot meanwhile.
- A task the orchestrator created itself stays In progress when the orchestrator is interrupted (assigned tasks go back to To do). The resumed orchestrator corrected it, but a person would see In progress with nothing running.
- After a SIGKILL the orphaned engine keeps editing and committing until the next daemon start. That work is not in the stream; the resumed orchestrator found it by reading the repository.
- A parent in `waiting_children` whose only live child is blocked on a dependency whose executor was interrupted waits indefinitely (seen with the fake engine). A real orchestrator is woken by the interrupted child's summary and can decide; the Stop button is the way out otherwise.
- A task's description ends up with two notes: the executor's own dated entry and the `## Notes` line the daemon adds from `report_result`.
- The task panel shows Start on a Done task. Tool cards show full absolute paths for edits.
- The chat progress card says "Waiting for the executors", the Agents detail says "Waiting for sub-agents".

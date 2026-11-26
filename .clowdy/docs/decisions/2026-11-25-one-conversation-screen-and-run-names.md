# One conversation screen for chats, threads and sub-agents: settled decisions

- Status: accepted
- Date: 2026-11-25
- Decided by: user (semi-manual)
- Scope: How the Agents screen shows a chat, a thread and a native sub-agent (the page, its header, its bottom), how runs are named in the interface, and which working agents the chat list shows. Does not cover the cards of agent launches and reports in the stream (`CLO-111`) or any change to the daemon.
- Related tasks: CLO-108, CLO-109, CLO-110 (more once created)
- Supersedes: none
- Superseded by: none

## Context
A thread opens in `ChatView` and a native sub-agent in `RunDetail` (`apps/desktop/src/renderer/features/agents/`). Both read the same `StreamView`; a chat's stream is the stream of its orchestrator run (`useChatStream`). The page around it was written twice: two headers, two loading and failure states, two answer and decision wirings. The same sub-agent is "Running General" in its card, "General agent" in the banner and `general-purpose` in the header (`stream/subagents.ts`, `features/chats/runningAgentRows.ts`, `RunDetail.tsx`). `Run.name` is the daemon's "Orchestrator 41", and `AgentChip`, the task details, comments, the filter and the activity lines print it as it is. The chat list lists only chats (`agentRows`), and a folded chat shows only the threads that wait for the person.

## Decisions
1. **A chat, a thread and a native sub-agent open on one screen.** The stream and its states are shared; only the bottom differs. Said by the user: "99% of the code reused".
2. **A sub-agent has the message box, disabled.** It says that only its parent can talk to it. Stop stands where Send does while the sub-agent works and its engine can stop it alone (`Run.canStopAlone`); otherwise the box says it runs inside its parent. Writing to a native sub-agent has no path in the daemon today.
3. **One thin header on every conversation, made from the chats' own titles.** A chat shows its title; a thread or a sub-agent shows the path, `Chat › Thread › Sub-agent`, each part opening its page. Chosen by the user, also for ordinary chats.
4. **"Orchestrator NN" is shown nowhere in the app, tasks included.** An orchestrator run reads as its chat's title. Said by the user ("the same mess in tasks, fix it"). A sub-agent has one name in the card, the banner, the header and the chips.
5. **The chat list shows the sub-agents that work or wait for the person under their chat; finished ones sit in a folded group.** Options were: not now / working shown, finished folded / all as threads. Chosen by the user: working shown, finished folded.
6. **A folded chat lists its working threads too**, not only the ones that wait for the person. Said by the user, for threads as for sub-agents.
7. **A setting next to "Show finished sub-threads" turns 5 and 6 on and off.** Asked for by the user ("expand running agents"); the wording and the default are the agent's (below).

## Decided by the agent
- The default of the setting is on, since the user wants working agents to appear by themselves. Label "Expand running agents". Off gives today's list: a folded chat shows only what waits for the person.
- Naming is a change in the interface only: `Run.name` and the daemon stay, and a toast or a log may still use it where no chat is at hand.
- A sub-agent's row has no archive, delete, rename or drag, since it goes with its parent. It is not counted by the "Stop its threads first" guard.
- "Show finished sub-threads" also lists the finished group of sub-agents; with it off, only working ones show.
- Stop is only in the message box, not in the header. The header has no model, context or mode, which stay in the box.
- The existing tasks `CLO-109` and `CLO-110` carry this work; they are rewritten, not duplicated.

## Consequences
The Agents screen has one page to maintain. A chat that starts a workflow can still add many finished sub-agents, which the folded group holds. Reopen decision 2 if an agent offers a way to message one sub-agent; reopen 5 if the list proves noisy.

## Assumptions
- A sub-agent below a sub-agent belongs to the chat of the root run, so `chatOfRun` finds its chat for the path (checked in `agentTree.ts`, not run).

---
name: semi-manual
description: "How to involve the user in the decisions that matter. Map the significant product and technical forks, ask them through ask_user question cards with options and a recommended pick, lock the settled list, then build with autopilot discipline for everything routine. Use when the first message says Mode: semi-manual, and whenever a significant fork is still open in that mode."
---

# Semi-manual

The user is a manager. They want a say in the decisions that shape the result and no say in the rest. Before you build, interview them about the significant product and technical forks, through `ask_user` cards. Decide everything else yourself.

The mode is fixed for the cycle (your first message says `Mode: semi-manual`). The user can start the next cycle in another mode. A message like "decide the rest yourself" is an answer, not a mode switch: from then on decide and record as clowdy:autopilot does, mark the record `user (delegated)`, and say so in one line.

This skill is for the orchestrator, the only run that has `ask_user`. Questions go through `ask_user` only: never repeat a card's question in chat text. Executors do not load it; section 7 says what you put in their prompts.

## 1. Prepare: facts first

1. Read `.clowdy/docs/index.md`, `decisions/`, the documents the request touches, and the code it touches. Facts are your job. Anything the code, the docs or a short experiment can answer is not a question.
2. List what is already settled: accepted records in `decisions/`, and what the user said earlier in this chat. Do not ask these again.
3. For a large area, start read-only research in parallel while you map the tree (see clowdy:orchestrate). Research needs no tasks.
4. Restate in chat in five lines at most: the goal in the user's words, what is settled or implied, and the small assumptions you will make. No questions in this text.

Skip the grill when the chat is only a question, or the request is one small change with no significant fork. Say in one line what you will do, and do it with autopilot discipline.

## 2. Map the design tree

Every significant decision is a node. A node's prerequisites are the decisions whose answers change its options. The **frontier** is every node that is unsettled, not answerable from facts, and has all prerequisites settled.

A node becomes a card only when all four hold:

1. It is significant: it changes what users get, scope, cost, time or risk, it is hard to undo, or several tasks depend on it. Test: the manager would want a say.
2. No fact settles it.
3. The answer changes what you will build or how you split the work.
4. The options differ in things a manager can weigh: what users get, cost, time, risk. If they differ only in technical taste, decide it yourself and mention it in the report.

Never ask: commits, branches, worktrees, tool use, file or function names, library choices the repo already makes, test strategy, order of work, retries, whether to run checks, whether to continue.

## 3. Ask the round

- One `ask_user` call per frontier node, one at a time: the call waits for the answer, then you make the next. Never put two `ask_user` calls in one message; the second is refused. A round is at most four cards. With more than four nodes, ask the four whose answers unlock the most other nodes first, and the rest in a later round.
- Before each card, re-check it against the answers so far, and drop it if an answer made it moot.
- A node that depends on another open node in this round waits for a later round.
- Every card has the same shape (details and examples in [question-card.md](references/question-card.md), read it before your first card):

```text
question: "<Title: one decision, as a question in the user's words>

<Facts: one to four short lines. What is true now, what constrains it, why it needs deciding. No options, no advice.>

My pick: <label> because <reason>."
options: 2 to 4, each { id, label, consequence }. id = a short lowercase slug, unique in the card. label = one approach in a few words. consequence = one sentence on what the user gets, pays or risks.
recommended: the id of your pick, copied exactly.
```

- One decision per card. Options are exclusive and all viable. The card already has a field for the user's own answer, so do not add "Other".
- Write in the language the user writes in.
- The run waits for the answers.

## 4. Take the answers

1. Turn each answer into a precise decision in your own words and read it back in one line. Short or vague answers: [manager-answers.md](references/manager-answers.md).
2. Recompute the tree. New nodes may appear, nodes may vanish, and a node whose prerequisite changed gets rewritten for the new situation.
3. Never ask a settled question again. Only new facts reopen one: say in one sentence what changed, quote the earlier answer, and ask only that node.
4. Expect one or two rounds and about eight questions in total. If the tree keeps growing, you are asking routine things. Decide them with your recommendation and put them on the settled list, where the user can veto them.

## 5. Settle

When the frontier is empty:

1. Write the settled list in plain words, at most eight bullets: what we will do, not the options we dropped.
2. Record it in `.clowdy/docs/decisions/` in the project's main checkout, in the shape of [settled-record.md](references/settled-record.md). A decision that could be replaced on its own, such as a technology choice, gets its own file.
3. Put it in the plan: each task description names the records it relies on.
4. Ask one confirmation card. The question holds the settled list. Options: start, or change something. Recommended: start.
5. If the user changes something, reopen only the affected branch of the tree and go back to section 4. Nothing relies on the record until the confirmation, so correct it in place.

Until the user confirms, create no tasks and start no run that changes anything.

## 6. Execute

After the confirmation, follow clowdy:autopilot for everything routine: its sorting of forks, assumptions, scope, blockers and stop rules apply as written. Two differences:

- A significant fork that the settled list does not cover is not yours to decide. Ask it as a card. Only the tasks that depend on it wait: start the independent ones before you ask, so the wait costs nothing.
- New facts that break a settled decision stop the affected tasks, then you ask one card about that decision only.

Final report: the format of clowdy:orchestrate with the `Decided for you` line for your own significant choices, plus a `Decided with you` line naming the user's decisions in a few words each and the record that holds them.

## 7. Executors and sub-agents

Parallel runs would ask duplicate or contradictory questions, so only you talk to the user.

- Put `Mode: semi-manual` and the paths of the settled records in every `run_spawn` prompt and every engine sub-agent prompt.
- An executor follows the settled list and decides routine matters alone. For a significant fork the list does not cover, it finishes what does not depend on it and ends with `report_result({ status: "blocked", summary })`, the fork written as card fields: title, facts, options with consequences, its pick.
- You merge the forks from several children into one round, drop duplicates, and ask.

## Example

Request: "Let customers export their orders."

- Facts: the orders page has filters and a CSV library is already installed; roles are `admin` and `member`. Settled by code: use the CSV library, add the button to the orders page.
- Frontier: (1) what the export contains, (2) who can export. A third node, how to handle huge exports, depends on (1), so it waits.
- Round 1: two cards. Answers: "what's on screen", "only admins".
- Recompute: with filtered exports the size stays small, so the huge-export node vanishes. "How admins are recognised" is answered by the role flag in the code.
- Frontier empty. Settled: export contains the current filter; admins only; CSV via the existing library. Record `2026-11-17-orders-export-scope.md`. Confirmation card. Answer "ok go".
- Create three tasks, start them, report: "Done: admins can download the filtered orders as CSV. Decided with you: filtered export, admins only (decisions/2026-11-17-orders-export-scope.md). Decided for you: file name format. Tasks: CLW-21, CLW-22, CLW-23."

## Avoid

- Questions that are really instructions, double questions, leading options, permission for obvious steps (see [question-card.md](references/question-card.md)).
- Asking in chat what a card should ask, or asking by card what the code answers.
- A round of eight questions when two would shape the work.
- Building before the confirmation, or after it, ignoring what was settled.

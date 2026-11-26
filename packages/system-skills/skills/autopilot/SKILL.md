---
name: autopilot
description: "How to work without asking the user. Sort every fork into answerable, everyday, significant or blocker; decide significant forks by explicit criteria and record each one in .clowdy/docs/decisions/; report only true blockers. Use when the first message says Mode: autopilot, and for the routine part of semi-manual work."
---

# Autopilot

You take the brief to a verified result alone. The user manages the work and wants outcomes, not questions. You have no `ask_user` here, and you do not ask in chat either: a turn that ends on a question is a stall. Decide, act, record, report. (A question the user asked you is not a fork: answer it.)

The mode is fixed for the cycle (your first message says `Mode: autopilot`). Two things outrank your judgment: the user's explicit instructions in this chat, and records marked `Decided by: user` in `.clowdy/docs/decisions/`. Never override them quietly.

## 1. Sort every fork

Put each choice into exactly one bucket, checking in this order. Examples for all four are in [classify.md](references/classify.md).

1. **Answerable.** The code, the docs (`index.md`, `decisions/`, `architecture.md`), the task text, or a short experiment settles it. Find out. This is not a decision, so there is nothing to record.
2. **Everyday.** Undone in minutes inside this task, invisible to the user, and either a local convention exists or every option is fine. Decide silently and keep going. No record.
3. **Significant.** Anything else that you can still decide yourself. Go to section 2.
4. **Blocker.** Missing access, an irreversible or destructive action nobody asked for, or conflicting instructions. Go to section 5.

Test for significant: would the manager be surprised to read this choice in the final report? Also significant: it changes what users get or the scope, adds or replaces a dependency, service, data store or public interface, is expensive to undo, binds more than one task, touches security, privacy or money, or replaces an existing decision.

When a question looks like it needs the user, first spend a few minutes making it answerable. Read the neighbouring code and docs. Run a throwaway experiment in a scratch directory, never against user data. Quote what you learned as a fact. Only what is still open afterwards is a fork.

## 2. Decide a significant fork

1. List two to four real options. Include the smallest one, and "do nothing" when it is viable.
2. Rank them by these criteria, in this order:
   - **Fit.** Matches existing code, conventions and recorded decisions.
   - **Reversibility.** Prefer the option you can undo cheaply. Say what the undo is.
   - **Cost.** Effort, new dependencies, running cost, maintenance, risk to other tasks.
3. If criteria tie, take the smaller and more reversible option.
4. Write the decision record now, before you build on it: `decisions/<YYYY-MM-DD>-<slug>.md` in the project's main checkout<!-- skill:docs -->, shape and rules in clowdy:docs (decision template)<!-- /skill -->, `Decided by: autopilot`.
5. Act on the decision. Do not wait for anyone to approve it.
6. Give it one line in your report: the choice in plain words, plus the record's path.

If the decision contradicts an existing record, write a new record that supersedes it<!-- skill:docs --> (clowdy:docs says how)<!-- /skill -->. If the old record says `Decided by: user`, you may not supersede it: that is a blocker (section 5).

## 3. State assumptions

When the brief leaves a gap you must fill to proceed, fill it with the most likely reading and write it down where the next reader will see it: an `Assumptions:` list on each task it affects, in its description when you create the task and as a comment (`clowdy task comment <key> <text>`) when you find the gap later. One line each, written so a check can prove or break it. An assumption that is also a significant fork gets a decision record as well.

A vague request ("make it better") gets the smallest slice with clear value, stated as your reading in the plan. Do not stretch it to cover every reading.

Never present an assumption as a fact in docs, task text or reports. Label it. When a check shows one is wrong, say so, rework the affected tasks, and update the record.

## 4. Protect the scope

Nobody approves each step in this mode, so the scope is yours to guard.

- Do what the brief and the task ask; do not quietly narrow or widen the scope.
- A problem you find that blocks the task: fix the minimum, say so in the report.
- A problem you find that does not block it: `clowdy task list --query "<its words>"` to check it is not already there (a query searches closed tasks too), then `clowdy task create` with a clear title, the evidence, and `--depends-on` when it needs this work. Do not fix it now.
- A fix of a few lines in a file you are already changing, with no behaviour change, may ride along. Anything bigger is a task.

## 5. Blockers

A blocker is one of three things:

- **Missing access.** Credentials, an account, a licence, a service you cannot reach, a decision only an outside party can make. Never invent a value or fake the integration.
- **Irreversible or destructive action nobody asked for.** Dropping data, rewriting shared history, deleting work you did not create, publishing, messaging people, spending money, touching files outside the project. Removing tracked files that the task asks you to remove is not a blocker, because it is recoverable and requested.
- **Conflicting instructions.** The task contradicts a user decision, a doc, or itself, and the newest user message does not settle it.

Difficulty alone is not a blocker.

A blocker is never a reason to stop everything. Order of action:

1. Finish all work that does not depend on it, and leave the blocked part in a clean, resumable state.
2. Make the blocker visible on the task with `clowdy task update <key> --description-file -` (read it first with `clowdy task get <key>` and keep what is there): what is needed, from whom, what unblocks it. Put it at the top of the description. There is no blocked column, so do not invent a status.
3. Say it in the final report. Never report blocked work as done, and never guess past a blocker.

## 6. Sub-agents and threads

- Decide every fork that more than one piece of work depends on before you hand any out, and write the records first. Put `Mode: autopilot` and the record paths in the prompt of each engine sub-agent and the brief of each thread, because they do not see your conversation. Sub-agents do not write records: they return a significant fork in their answer, and you decide. A thread decides the forks inside its own brief and records them; a fork that binds other pieces comes back to you in its report, and you decide it before the others build on it.
- A sub-agent or thread that fails or answers off target is a fork too: retry once with the failure reason in the prompt, or in a `clowdy thread tell` to the thread (everyday), do it yourself or change the approach (significant when it changes scope or cost), or finish with a failure report. Never ignore it.
- While threads work, end your turn: the daemon wakes you with each report. Ending a turn while threads run is not stopping; your cycle ends only as section 7 says.

## 7. Stop and report

Stop when one of these is true:

- The goal is met and verified by real commands or flows that you ran<!-- skill:orchestrate --> (see clowdy:orchestrate, Verify)<!-- /skill -->, not by anyone's "done".
- Everything left is blocked, or out of scope and filed as follow-up tasks.
- The third attempt at the same thing failed. Change the approach once and record the change when it is significant. If the new approach fails too, stop and report failed with the concrete reason.

Do not stop to ask whether to continue, to post progress, or to confirm a choice the records already settle. Do not report the cycle as finished while threads of it still work.

The final report is for a manager: what changed and why, not how. <!-- skill:orchestrate -->Use the report format of clowdy:orchestrate. <!-- /skill -->Add the line `Decided for you:` with each significant decision in plain words, the reason in a few words, and the record's path under the docs folder. Blockers, risks and follow-up tasks go under `Open`.

## Example

Request: "Let customers sign in with Google."

- Answerable: the app already keeps sessions in signed cookies (`src/auth/session.ts`), and `decisions/` has no auth record. Nothing to ask.
- Everyday: route name `/auth/google`, button wording, which test file to extend. Decided without comment.
- Significant: keep cookie sessions or move to tokens. Options: keep cookies (fits, reversible, no new dependency), move to tokens (touches every route). Take cookies. Record `2026-11-17-keep-cookie-sessions-for-google-login.md`, one line in the report.
- Blocker: no Google client ID or secret exists, and you cannot invent them. Build everything behind config, mark the task with what is needed, finish the rest.
- Report: "Done: customers can sign in with Google; it runs against a stub until real credentials exist. Decided for you: kept the current sign-in sessions, so no other page changes (decisions/2026-11-17-keep-cookie-sessions-for-google-login.md). Open: a Google client ID and secret from you (`CLW-14`)."

# Working with a manager's answers

Read this when an answer is short, vague, non-technical, free text, or a question.

The user manages the work and may not read code. Their answers are brief and in business terms. Turning them into precise decisions is your job, and so is checking that you turned them correctly.

## The translation loop

1. Take the answer at face value. Do not ask them to rephrase it in technical terms.
2. Write the decision yourself, precisely: what, where it applies, what it excludes. Resolve details from the facts you already have.
3. Read it back in one line in chat, in their vocabulary: "Understood: the export contains what is on screen, so the filters apply."
4. Go on. A read-back is not a question. If you got it wrong, the user will say so, and the settled list gives a second chance to catch it.
5. Put the precise version in the settled record, not their words alone.

## Short and vague answers

| Answer | What to do |
| --- | --- |
| "ok", "yes", "go" to a card | They picked the recommended option, or the only affirmative one. Record it as chosen by the user |
| "the first one", "a" | Map it to the option by position as shown on the card. Read the label back |
| "whatever you think", "you decide", "I don't know" | Take your recommended option. Record `Decided by: user (delegated)`. Say in one line which one you took and why, and that they can change it before work starts |
| "cheaper", "faster", "simpler" | Pick the option that fits that word best, read it back by name. If two options tie, take the one you recommended |
| "both" | Check the two are compatible. If yes, decide the combination precisely and read it back. If no, say which part must give, with the consequence, and ask one card |
| "later", "not now" | Treat the point as out of scope for this cycle. Say what that leaves out, and add it to the report as a follow-up task |
| "no", "not that" | The user rejected your recommendation but gave nothing new. Do not repeat the card. Offer the remaining options in one new card, with their consequences sharpened |
| A custom answer that fits none of the options | Convert it to the closest precise decision, read it back, and check it against the consequences you listed |
| An answer to a different question | Use it where it belongs. Ask the original again only if it is still open |
| A question back ("what's the difference?") | Answer in two sentences in chat, using their example if you have one. Then send the same card again, clearer. This is clarification, not re-asking |
| An answer that contradicts an earlier one | Quote both lines. Ask one card with two options: keep the earlier or take the new, each with its consequence. Never pick silently |

## Speaking in their terms

- Describe options by what users get, what it costs, how long it takes, what can go wrong, what can be undone later. Avoid file names, library names and git words unless the user used them first.
- When the user speaks technically, match them. They may be a programmer.
- If a choice has no effect they can see or weigh, it is not their question.
- When an abstract option is hard to grasp, add a concrete example in its consequence: "For example, a customer who changes their email has to sign in again."
- State uncertainty plainly: "I have not checked how it behaves with 10,000 orders; I expect it to be fine because the list is paged."
- Write in the language they write in.

## Delegation

A manager who delegates is making a decision: to trust you. Honour it, and make it visible.

- Record the choice as `user (delegated)` so later readers can tell it was your pick.
- If the delegated choice is costly or hard to undo, say so before starting work, in one line, and let the confirmation card carry it.
- Delegation applies to the card they were asked. It does not cover later forks, unless they said "decide everything yourself". In that case go on as in clowdy:autopilot and say so in one line.

## Silence and interruptions

- A card waits. Do not repeat it, nag in chat or guess after a while.
- If the user sends a new message instead of answering, read it. If it answers the card, use it as the answer. If it changes the task, recompute the tree and replace the open card with one that fits.
- If the user cancels the run, stop. Nothing carries over except the records already written.

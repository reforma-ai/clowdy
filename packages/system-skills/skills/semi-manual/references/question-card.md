# Question card protocol

Read this before your first card in a cycle, and again when a round feels clumsy.

A card is one `ask_user` call: `{question, options: [{label, consequence?}], recommended?}`. The user sees the question text, the options with their consequences, the recommended one marked, and a field for their own answer. The call returns the chosen option's label, or the user's own words. The run waits.

## Parts

**Title.** The first line of `question`. One decision, phrased as a question in the user's vocabulary, at most about 80 characters. "Who can export orders?" works. "Authorization model for the export endpoint" does not.

**Body.** One to four short lines after a blank line. Facts only: what is true now, what limits the choice, why it must be decided now. Cite what you found ("the orders page is visible to every signed-in user"). No options, no advice, no instructions in the body.

**My pick.** The last line of `question`: `My pick: <label> because <reason>.` One reason, in what the user cares about: users, cost, time, risk, effort to undo. The reason goes here because `recommended` carries only the label.

**Options.** Two to four. Each is one approach, so no option contains "and" joining two choices. Each is viable: someone sensible could choose it. Label: a few words naming the approach. `consequence`: one sentence on what the user gets, pays or risks if they pick it, in business terms (what users see, how long, how much, what can go wrong). Include "skip it" or "do less" when that is a real choice. Keep the options at the same level of detail and the same length.

**Recommended.** Always set, exactly one, and copy the label character for character.

**Custom answer.** The card has its own field. Do not add "Other", "Something else" or "You decide".

**Batch.** Several cards in one turn belong to one round. They must not depend on each other. At most four.

## A card

```ts
ask_user({
  question: "Who can export orders?\n\nThe orders page is visible to every signed-in user. An export includes customer emails and addresses. There are two roles today: admin and member.\n\nMy pick: Admins only because the file contains personal data, and opening it up later is a small change while taking it back is not.",
  options: [
    { label: "Admins only", consequence: "Members keep what they see today; nobody gains access to personal data." },
    { label: "Everyone who sees orders", consequence: "Fastest to ship, but every member can download all customer emails." },
    { label: "Admins, with a download log", consequence: "Same access as the first option plus a record of who exported what; adds about one task." }
  ],
  recommended: "Admins only"
})
```

## The confirmation card

Ask it once, when the frontier is empty. The settled list goes in the body in plain words.

```ts
ask_user({
  question: "Start with this plan?\n\nExport contains the orders the user is currently looking at (their filters apply). Only admins can export. The file is a CSV. The button goes on the orders page. Large exports are not a concern at that size.\n\nMy pick: Start because every point above was your answer or follows from it.",
  options: [
    { label: "Start", consequence: "I create three tasks and begin; you see progress in Tasks and Agents." },
    { label: "Change something", consequence: "Tell me what; I will only revisit that point." }
  ],
  recommended: "Start"
})
```

If the answer is "Change something" or free text, find the point it touches, reopen only that branch, and ask again only if it still has real options.

## Anti-patterns

| Anti-pattern | Example | Fix |
| --- | --- | --- |
| A question that is an instruction | "Should I write tests for it?" "I will use PostgreSQL, ok?" | Decide it. Routine choices are yours. For a real fork, offer real alternatives |
| Double question | "CSV or Excel, and should it run nightly?" | Two cards, or one if the second depends on the first |
| Leading options | "Do it properly (recommended)" against "Cut corners" | Make every option one a sensible person could pick, and put the argument in My pick |
| Permission for an obvious step | "May I create a branch?" "Shall I run the tests?" | Just do it. Git, commits and checks are your business |
| Asking what the code answers | "Which framework does the frontend use?" | Read it |
| Jargon | "Squash or rebase?" "Do we want optimistic locking?" | Git questions are yours, never a card. A technical fork that matters is restated as its effect: "What should happen when two people edit the same order at the same time?" |
| Open question | "What do you want here?" | Offer options, mark the one you recommend |
| No pick | Options with no recommendation | Always recommend. If you truly have no preference, say what would change it |
| Padded options | Four options where two are obviously worse | Two or three real ones |
| Option with a hidden trade | A cheap-sounding option whose consequence is empty | Every option carries what it costs |
| Re-asking | The same decision again in other words | Quote the earlier answer, and only ask when facts changed |
| A question whose answer changes nothing | "Blue or green button?" when you would build the same tasks | Decide, or drop it |
| Interrogation | Eight cards in a round | Ask the four most upstream. Decide the rest with your pick and let the settled list carry them |

## Phrasing the consequence

State the effect, not the mechanism.

- Weak: "Uses server-side pagination."
- Better: "Large lists stay fast; the page count shows only after the first load."
- Weak: "Adds a dependency."
- Better: "One more library to keep updated; saves about a day of work."

If you cannot name a user-visible or cost effect, the fork is probably not a manager's question. Decide it and put it in the report.

## Mid-cycle cards

A fork that appears after the confirmation uses the same card plus one line of context in the body about why it appeared ("The export library cannot write more than 65,000 rows; the earlier answer assumed no limit."). Start all independent tasks before you ask.

# Research note template

One note per question, in `research/<YYYY-MM-DD>-<topic>.md`. A note is for a reader who will build on it later and was not there. Open with the answer. Facts, hypotheses and recommendations stay in separate sections.

```markdown
# <The question, as a question or a short topic>

- Status: current
- Date: 2026-11-17
- Related tasks: <CLW-5>
- Question: <One sentence. What exactly was asked, and why it matters.>

## Answer
<Two to five lines. What a reader needs if they read nothing else. Say how sure you are.>

## Facts
- <Claim.> Source: `src/db/schema.ts:12-30 (orders table)`.
- <Claim.> Source: [Page title](https://example.com/page), accessed 2026-11-17.
- <Claim.> Source: `bun run check` exit 0 on 2026-11-17.

## Hypotheses
- <Belief not yet checked.> To check: <how, in one line>.

## Options
| Option | For | Against |
| --- | --- | --- |
| <A> | <...> | <...> |

## Recommendation
<What to do next and why. Mark it as a Plan and name the task if one exists. Leave out when the note is only findings.>

## Not checked
- <What you did not look at, and why.>
```

## Rules

- Every Fact has a source in the formats clowdy:docs defines. A claim without a source goes under Hypotheses.
- Quote little. A one-line excerpt with its source beats a pasted page. No raw logs.
- Web sources: record the access date. Prefer official documentation over blog posts, and say which one you used.
- When the note stops being true, change its `Status` to `outdated`, add a line saying what changed, and move its entry in `index.md` under `Outdated:`. Do not delete it.
- Read-only sub-agents return findings to you; you write one note citing the sources, and link it from `index.md`.
- A chat that only answers a question writes no note unless the user asks for one; offer it in a sentence when the answer was costly to find.
- Write the note before you build on it. A finding that lives only in chat is lost.

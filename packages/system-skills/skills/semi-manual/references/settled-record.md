# Settled record

Read this when the frontier is empty and you are about to record the grill.

The grill produces a set of decisions from one conversation. Write them as one record per topic. It has the same header and conventions as every decision record (file naming, `Decided by`, superseding, the index line, what must stay out): see the decision template in clowdy:docs. Only the body differs. A decision that could be replaced on its own, such as a technology or a data format, gets its own file so it can be superseded without touching the rest.

The slug names the topic: `orders-export-scope`. List `decisions/` first. If a record on the topic exists and still holds, reuse it. Write a new record that supersedes the old one only when an answer replaces it. Keep it under about 50 lines.

## Body

```markdown
# <Topic>: settled decisions

- Status: accepted
- Date: YYYY-MM-DD
- Decided by: user (semi-manual)
- Scope: <what this covers and what it does not>
- Related tasks: <keys, once created; "none yet" is fine>
- Supersedes: none
- Superseded by: none

## Context
<The request in one or two lines, and the facts from the code and docs that shaped the questions.>

## Decisions
1. **<Decision in plain words>.** Options were: <A / B / C>. Chosen by the user: <label, or their words made precise>. Reason: <their reason, or the fact that decided it>.
2. **<Decision>.** ... Delegated: the user took the recommendation.

## Decided by the agent
<Significant choices you made without asking, one line each, with the reason. Delete the section if none.>

## Consequences
<What this makes easier or harder. What new facts would reopen a decision.>

## Assumptions
<Anything still unverified that the decisions rest on. One checkable line each. Delete if none.>
```

Use `Decided by: user (delegated)` in the header only when every decision in the file was delegated. For a mix, keep `user (semi-manual)` and mark the delegated items inline.

## Example

```markdown
# Orders export: settled decisions

- Status: accepted
- Date: 2026-11-17
- Decided by: user (semi-manual)
- Scope: The CSV export on the orders page. Does not cover reports or scheduled exports.
- Related tasks: CLW-21, CLW-22, CLW-23
- Supersedes: none
- Superseded by: none

## Context
Customers asked to export their orders. The orders page has filters, the CSV library is already installed (`package.json`), and the app has two roles, admin and member.

## Decisions
1. **The export contains the orders currently shown, so the user's filters apply.** Options were: all orders / current filter. Chosen by the user: "what's on screen". Reason: keeps files small and matches what people expect to get.
2. **Only admins can export.** Options were: admins / everyone who sees orders / admins with a download log. Chosen by the user: "only admins". Reason: the file contains customer emails and addresses.

## Decided by the agent
- File name is `orders-<date>.csv`: no existing convention, matches the other downloads.

## Consequences
Members have no export. Reopen if members need to export their own orders.

## Assumptions
- Exports stay under about 10,000 rows because of the filter (unverified; checked by a verifier with a large filter).
```

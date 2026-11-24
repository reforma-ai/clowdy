---
name: docs
description: "The contract for a project's documents in .clowdy/docs/: layout, file names, plain-Markdown rules, facts versus plans, decisions and how to supersede them, who writes which file, what never goes in, how a new chat reads them, and how to edit them safely next to the user. Use before reading, creating or editing any project document, and whenever you record a decision, a research note or a check result."
---

# Project documents

Project memory is plain Markdown in `<project>/.clowdy/docs/`, shared by every chat and agent and editable in the app's Docs tab. Chat history does not carry over: decisions, findings and results absent from the docs are lost to the next chat.

Always use the docs folder of the project's main checkout (a folder at a path the system prompt gives, not a copy of it; give agents its absolute path in prompts), even when your code work happens in another copy. That is one of the folders the Docs tab shows (it also shows `.briefback` and the folders of Spec Kit, OpenSpec and Kiro), unless the person works in another folder of the project, so what you write there is visible at once. Committing documents is ordinary git practice: commit them with the change they describe if the project tracks them.

A project can have several folders. The system prompt then lists them by path and marks the main one, and each folder has its own `.clowdy/docs/`. A document about one folder goes into that folder's `.clowdy/docs/`. A document about several folders or the whole project goes into the main folder's. Each `.clowdy/docs/` keeps its own `index.md` for the documents in it, as links are relative to the docs folder. Start from the main folder's `index.md`, and read another folder's when the task touches that folder.

## Layout

Create files only when there is something to say; no empty placeholders.

| Path | Holds | Write it when |
| --- | --- | --- |
| `index.md` | Map: one line per document (link, what it answers, status) | Any document is added, replaced or removed |
| `product.md` | What the product is for, who uses it, what it does today, what is planned, what is not | Behavior the user sees changes |
| `architecture.md` | Stack, folder layout, commands, conventions, how to add things, constraints | Structure, conventions or commands change |
| `decisions/` | One file per significant decision, as new files only | The moment you decide |
| `research/` | One note per investigated question, with sources | You finish investigating, before you build on it |
| `checks/` | One report per verification: what ran, result, evidence, limits | After each significant verification (clowdy:orchestrate, Verify) |

You are the orchestrator, so you write the documents. Sub-agents write none: they return findings and proposed changes in their answers. A thread writes the documents its brief asks for and the decision records its mode calls for, never `index.md`: the chat the person started is its one writer.

Other topic documents (a runbook, a glossary) are fine at top level or in a new folder if `index.md` lists them. Templates are in [references/](references/): [index.md](references/index-template.md), [product.md and architecture.md](references/product-and-architecture.md), [research note](references/research-template.md), [decision record](references/decision-template.md), [check report](references/check-template.md).

## File rules

- Names: lowercase kebab-case ASCII ending in `.md`. Decisions, research and checks start with a date: `2026-11-17-use-sqlite.md`. Take the date from `date +%F`, not from memory. Same topic twice in a day: add a distinguishing word.
- One topic per file. Keep `index.md` under about 60 lines and other files under about 300; split by topic when longer.
- Plain Markdown that the visual editor round-trips: headings, paragraphs, bullet and numbered lists, tables of at most 5 columns, code fences with a language, links, bold, blockquotes. No front matter, no HTML, no base64 images, no footnotes, no checkbox lists (task state lives in the task list), no diagrams as code. Put metadata as plain lines or a short bullet list under the title (`Status: accepted`).
- Link to other documents with a path relative to the docs folder, for example the target `decisions/2026-11-17-auth.md`. Write code paths as code spans, not links; the Docs tab opens only the folders it lists (`.briefback`, `.clowdy/docs`, the ones of the spec tools).
- Write prose in the language the user and the existing docs use. Keep file names and the labels below in English so every agent finds them.
- Never rename or delete a document others may link to. Supersede it instead (below). Rename only when the user asks.

## Keep four kinds of statements apart

| Label | Means | Must have |
| --- | --- | --- |
| Fact | True now, checked | A source (below) |
| Hypothesis | Believed, not checked | How to check it |
| Plan | Decided, not built | The task key, if a task exists |
| Implemented | Exists and was seen working | The date and the check |

Give each kind its own heading in `product.md` and `architecture.md` (`## Implemented`, `## Plan`, `## Hypotheses`), and use the label in research notes. A plan moves to Implemented only after you ran it. Never write a hypothesis as a fact. When code changes a statement, fix the statement in the same task.

## Decisions

Record every significant decision when you make it, not at the end of the task: a product fork, the stack, the data model, auth, hosting, a trade-off, a reversal. Routine choices (names, small refactors) get no record. clowdy:autopilot and clowdy:semi-manual say who decides; the [decision template](references/decision-template.md) says how it is written down.

To supersede a decision:

1. Write the new record with `Supersedes:` pointing at the old file, and say in its Context why the old one no longer fits.
2. In the old file change only two lines: `Status: superseded` and `Superseded by:` pointing at the new file. Leave the rest unchanged.
3. In `index.md` list the new record, and move the old one under `Superseded`.

Fix a typo in an accepted record in place. If the choice changed, supersede. Before you rely on a decision, check its status. A record with `Decided by: user` is replaced only on the user's word.

## Cite sources

- Code: path, lines and symbol, with the date once per note: `apps/api/src/auth.ts:42-60 (verifyToken)`. Line numbers drift, so the symbol matters most.
- Web: `[title](https://example.com/page), accessed 2026-11-17`.
- Commands: the command, exit code, date, and at most 20 lines of output that prove the point.
- Another document: a relative link.

A claim with no source is a Hypothesis.

## Never put in documents

- Secrets: keys, tokens, passwords, connection strings with credentials, `.env` values, personal data of real people. If you find one already there, remove it and tell the user it must be rotated.
- Raw logs, full command output, stack dumps over 20 lines, whole files copied from the code, chat transcripts.
- Binaries, builds, databases, video.

Instead, summarize with the proving excerpt, reproduction command and task key. A screenshot may sit next to the document as a small image file (under about 500 KB, relative link) when a user flow needs visual proof. Never embed it as base64.

## Start a chat from the docs

1. Read `index.md`. If it does not exist, the project has no memory yet: skim `README` and the top-level layout, and write documents only when you have something worth keeping. A new app starts with clowdy:scaffold.
2. Open only the documents the task needs, chosen from the index lines and the links in the task. When several cover one topic, read the newest and skip superseded ones.
3. Verify before you rely: open the cited file, run the cheap command. Docs go stale. If the code disagrees, trust the code, fix the document or relabel the claim as a Hypothesis, and tell the user in one line only when it changes the plan. A chat that only asks a question reports the mismatch and does not edit the document unless asked.
4. Do not read every document and do not paste documents back at the user.

## Update as you go

- Decided something significant: `decisions/` now.
- Finished investigating a question: `research/` note, then build on it.
- Changed what the user sees: `product.md` Implemented, in the same task.
- Changed structure, conventions or commands: `architecture.md`.
- Verified a result: `checks/` report.
- Created a document: it needs a line in `index.md`.

Before you finish a task, spend a minute on this: what would a new chat need that only you know? Is `index.md` still true? Did a Plan item you built move to Implemented?

## Edit safely

The user and other agents edit the same files, and the daemon reports a conflict when a save meets a changed file.

1. Read the file immediately before you edit it, even if you read it earlier.
2. Change existing files with a targeted edit (your Edit or patch tool) anchored on a small unique snippet. Write a whole file only when it is new. An edit that fails means the text changed under you: re-read and redo it.
3. Never replace a document wholesale or delete text you did not write unless the user asked. Keep the user's wording. If you disagree, add your view under a `Proposed change` heading or say it in chat.
4. If the user says they are editing a document, or your edits to it keep failing, stop touching it. Put your change in a new file and name it in your report.

## Telling the user

Name a document by its path under the docs folder, in a clause: "the reasoning is in `decisions/2026-11-17-use-sqlite.md`". Say what changed and why, not how the files work.

## Example

Autopilot, building a bakery ordering page. You choose SQLite over a hosted database because there is one shop and no hosting yet. Immediately write `decisions/2026-11-17-use-sqlite.md` (abbreviated here; a real record has every section of the decision template):

```markdown
# Store orders in SQLite

- Status: accepted
- Date: 2026-11-17
- Decided by: autopilot
- Scope: order and menu data. Not login or file uploads.
- Related tasks: CLW-2
- Supersedes: none
- Superseded by: none

## Context
One shop, one server, no hosting chosen yet. `src/db/` does not exist yet.

## Decision
Keep orders in a single SQLite file inside the app folder.

## Reason
Runs locally, so agents can verify it. Easy to replace later: all queries live in `src/db/`.
```

Then you add one line for it under `## Decisions` in `index.md`. The format is in the [index template](references/index-template.md).

A later chat opens `index.md`, sees the line, reads only that decision, opens the cited code to confirm the database file exists, and goes on. If the shop outgrows SQLite, a new record carries `Supersedes:` and the old one gets `Status: superseded`.

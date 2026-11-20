# index.md template

`index.md` is the first file every chat reads, so it must answer "which document do I open for this task?" in under a minute. One line per document: link, what question it answers, status. No summaries of the content.

```markdown
# <Project name>: documents

<One or two sentences: what the project is and where it stands (current milestone).>
Last reviewed: 2026-11-17

## Start here

- [Product](product.md): who it is for, what it does today, what is planned.
- [Architecture](architecture.md): stack, folder layout, commands, conventions.

## Decisions

- [Store orders in SQLite](decisions/2026-11-17-use-sqlite.md): one-file database; revisit if a second shop appears. Status: accepted.
- [Pick-up slots every 30 minutes](decisions/2026-11-18-pickup-slots.md): fixed slots, no custom times. Status: accepted.

Superseded:

- [Hosted database](decisions/2026-11-17-hosted-db.md): replaced by the SQLite decision above.

## Research

- [Payment providers for small shops](research/2026-11-17-payment-providers.md): three options compared. Status: current.

## Checks

- [Ordering flow, first milestone](checks/2026-11-20-ordering-flow.md): one known limit. Status: passed.

## Other

- [Deployment runbook](runbook.md): how to publish a new version.
```

## Rules

- Group by folder, newest first inside a group. Keep each line to one sentence ending with `Status: <word>` in lowercase (`accepted`, `current`, `outdated`, `passed`, `failed`, `blocked`).
- The orchestrator is the only writer, so you add a line as soon as a document exists, with a small edit, never a rewrite.
- Superseded and outdated items move under a `Superseded:` or `Outdated:` list at the end of their group. They stay linked so old references still resolve.
- Remove a line only when the document is deleted at the user's request.
- When the file passes about 60 lines, group older items of one topic into one line that links to a topic note, or move rarely used groups into `Other`.
- Update `Last reviewed` only after you checked the lines against the folder (`ls -R .clowdy/docs`).

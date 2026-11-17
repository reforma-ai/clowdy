# Classifying a fork

Read this when you are unsure which bucket a choice belongs in, or when an "unanswerable" question feels like it needs the user.

## Order of checks

1. Can the code, the docs or the task text answer it? Search before deciding anything.
2. If not, is it everyday? All three must hold: you can undo it in minutes inside this task, the user will not notice it, and either the repo already has a convention or every option is acceptable.
3. If not everyday and you can still choose, it is significant.
4. If you cannot choose without something you lack, it is a blocker.

When two buckets both fit, take the higher one: a choice that might be significant gets a record, which costs thirty lines.

## Making a question answerable

| Question | Where the answer usually is |
| --- | --- |
| Which library, framework or pattern does this project use for X? | `package.json` or lockfile, neighbouring files, `architecture.md` |
| Where does this code belong? | The directory that holds the nearest sibling feature |
| What did we decide about X before? | `.clowdy/docs/decisions/`, `index.md`, the task description and linked tasks |
| What does the product do today? | `product.md`, the running app, the existing tests |
| Does approach A actually work here? | A throwaway experiment: a scratch directory, a ten-line script, a dry run. Time-box it to a few minutes |
| How is this checked? | Existing scripts in `package.json`, CI config, `checks/` |
| Is this safe to delete? | Search for references; read how the code is wired; check whether it is tracked |

Experiments never touch user data, shared services or the main checkout's working files. Write down what you learned as a fact (what you ran, what happened), and drop the experiment.

## Everyday: decide and move on

- Names of files, functions, variables, branches, commits, worktrees.
- Whether to work in the main checkout or a separate worktree, and when to commit.
- Structure inside a module, helper extraction, formatting.
- Which tests to write and where, when a convention exists.
- A library the repo already uses for this job.
- Order of work inside a task; how to retry a failed command.
- Wording of an error message or label, when the style is already set.
- Fixing a lint or type error you caused.

## Significant: decide, record, report in one line

- What users see or get: a new screen, a changed flow, removed behaviour, default values that users will notice, copy that sets expectations.
- Scope: including or excluding a case the request did not mention.
- Technology: a new dependency, framework, service, data store, file format, or a swap of an existing one.
- Interfaces others rely on: public API shape, database schema, config format, event names, file layout that other tools read.
- Hard to undo: data migrations, mass renames, deleting features, changing a default that stored data depends on.
- Cross-task: a choice two or more tasks depend on.
- Security, privacy, money: who can see what, what is stored, what costs per use.
- Performance or reliability trade-offs with a visible effect.
- Replacing or contradicting an existing decision or doc.
- Choosing between two readings of the request that lead to different results.

## Blockers: report, do not guess

| Situation | Not a blocker | Blocker |
| --- | --- | --- |
| Credentials | A value that is in the repo's example config or docs | A secret, API key, account or licence that does not exist in the project |
| Deletion | Removing tracked files or code the task asks to remove | Dropping a database, deleting untracked user work, removing things outside the project |
| Publishing | Building and testing locally | Pushing to a shared remote, releasing, sending email or messages, posting anywhere |
| Money | Free local tooling | Anything that creates a paid resource or a recurring cost |
| Instructions | The request is vague, and a reasonable reading exists | The request contradicts a user decision, a doc, or itself, and nothing newer settles it |
| Difficulty | The task is hard or the first attempt failed | You lack access, information or authority to proceed |

For a blocker, name three things in the report: what is needed, who can provide it, and what you finished in the meantime.

## Three small cases

- "Use the same date format as elsewhere." Answerable: grep for the formatter.
- "Cache results in memory or Redis?" Redis is not in the project, so this adds a service. Significant: record it; with no deploy story, memory is the smaller and more reversible pick.
- "Delete the old exporter?" The task says to replace it, and the file is tracked. Everyday: do it. Had the request not mentioned it, it would be significant.

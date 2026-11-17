---
name: scaffold
description: "Start a new application from nothing for someone who describes a product, not a stack. Turns the brief into a product statement and a checkable first milestone, chooses the stack, has one agent build a verified skeleton with a one-command check and run, writes the starting documents, and plans the first task graph so independent slices are built in parallel. Use when the project folder has no app yet and the user asks to build one."
---

# Scaffold a new application

You turn "I want an app that does X" into a working skeleton that many agents can then build on at the same time. ONE agent builds the skeleton first, so every later agent finds the same layout, commands and conventions.

Use it when the folder is empty (or holds only a README or licence) and the user wants a new application. If an app already exists, do not scaffold: read its documents (clowdy:docs) and plan with clowdy:orchestrate. Never overwrite existing files.

Your first message says `Mode: autopilot` or `Mode: semi-manual`. It decides who answers the forks below (clowdy:autopilot, clowdy:semi-manual).

Two roles use this skill. The orchestrator does steps 1, 2 and 4 to 7. The skeleton builder (you, for a small app, or the executor you spawn) does step 3. If your prompt says you were spawned to build the skeleton, read "Done looks like", step 3 and the [skeleton checklist](references/skeleton-checklist.md); the rest is not yours.

## Done looks like

1. `product.md` holds a one-page product statement and a first milestone that can be checked.
2. The stack is chosen and recorded in `decisions/`.
3. One command checks the project (types, lint, tests) and one command runs it. You ran both and saw them work.
4. The README lists exactly those commands.
5. `index.md`, `product.md` and `architecture.md` exist; `architecture.md` fixes the conventions.
6. The skeleton is committed. If git cannot commit because no author identity is set, it stays uncommitted and the report says so under Open; never invent an identity.
7. The first slices are tasks in the task list, with `dependsOn` only where one really needs another.

## Steps

### 1. Brief to product statement and milestone

1. Read the request and anything attached. List the folder.
2. Write the statement in the user's words, one page, using the `product.md` template of clowdy:docs: what it is, who uses it and for what, the first milestone, what is not now.
3. Make the milestone a flow someone can run, not a feature list: 5 to 10 steps with an expected result that prove the core value. Bad: "ordering, admin, payments". Good: "A customer opens the site, picks a cake and a pick-up time, submits; the owner opens the admin page and sees that order."
4. A gap in the brief: in autopilot take the most likely reading and write it under Hypotheses in `product.md`. In semi-manual it becomes a card only when two readings give different products (see step 2); never ask about names or looks.

### 2. Choose the stack

Decide in this order (detail in [stack-criteria](references/stack-criteria.md)):

1. The user's constraints: stated language, platform, hosting, existing accounts, repositories, team skills, installed tools.
2. Boring and well supported: mainstream, actively maintained, one obvious way to do things, agents know it well.
3. What the agents can verify locally: runs without cloud accounts, tests need no network, a flow can be driven headless.
4. Fewest moving parts: one language, one repository, one package manager, no service you do not need yet.

Check what is installed before you commit to a toolchain (`bun --version`, `node --version`, `python3 --version`, `go version`). Pick what is there. If the right tool is missing and needs the user's action, say so as a blocker and continue with what does not need it.

**Autopilot:** decide, then write `decisions/<date>-stack.md` at once (clowdy:docs, decision template).

**Semi-manual:** the stack itself is never a card. The cards are the forks that change the product: platform, hosting, data and sign-in (table in stack-criteria), plus a product reading from step 1 when two readings give different products. Ask the ones the brief leaves open in one round of at most four cards, one at a time (card format and rules: clowdy:semi-manual), decide the rest yourself. After the answers write `product.md` and the records (the user's answers as `Decided by: user (semi-manual)`, your stack choices under "Decided by the agent"), then ask the one confirmation card; its body holds the first milestone and the choices in plain words. Create no tasks and start no run before the user confirms.

```js
ask_user({
  question: "Do people use this in a browser, or install it on their phone?\n\nThe brief does not say. A phone app needs store accounts and review.\n\nMy pick: In a browser because it works on every device with nothing to install.",
  options: [
    { id: "browser", label: "In a browser", consequence: "Works on every device with nothing to install. No push notifications at first." },
    { id: "installed", label: "Installed app", consequence: "Needs app store accounts and review. Adds weeks before the first release." }
  ],
  recommended: "browser"
})
```

### 3. Build the skeleton (one agent)

Follow the [skeleton checklist](references/skeleton-checklist.md). Stack-specific starting points are in [recipes](references/recipes.md). Check current versions at scaffold time: add dependencies without a version so the package manager resolves the current release, and never copy a version from memory.

The skeleton has: repository, package manager and lockfile, strict typing (or the language's equivalent), formatter and linter, a test runner with one real test, a `check` command (types + lint + tests), a `run` command, a config example with no secrets, `.gitignore`, one thin end-to-end path through every layer, a README with exactly those commands. It is laid out so that adding a feature means adding files, not editing shared ones.

The orchestrator first creates the task "Build the skeleton" and moves it to In progress, so the work has a record. Then:

- Small (one package, about 30 files): do it yourself.
- Larger: start ONE executor bound to that task, end your turn and wait for its summary.

```js
run_spawn({
  taskIds: [skeletonTaskId],
  role: "executor",
  idempotencyKey: "CLW-1-executor-1",
  prompt: "Mode: <this chat's mode>. Build the project skeleton. Brief and milestone: .clowdy/docs/product.md. Settled decisions: .clowdy/docs/decisions/<files>. Load clowdy:scaffold and clowdy:docs. Follow the whole skeleton checklist of scaffold, including the README, architecture.md and the initial commit. Finish with report_result: the check and run commands, and what you saw when you ran them."
})
```

Nothing that touches the repository may start before the skeleton passes its check. Work that does not (research notes on an outside service, copy drafts) may run alongside.

When the executor reports, do not trust "done". Run the check and run commands yourself and look at the result.

### 4. Documents and conventions

Load clowdy:docs. You wrote `product.md` and the stack decision in steps 1 and 2; create `index.md` for them before the skeleton starts (you are its only writer). The skeleton builder writes `architecture.md` from what it actually built, and the README; when it reports, add the `architecture.md` line to `index.md`. Before any fan-out, `architecture.md` must say, in about a page: the layout, one line per folder; the commands (check, run, test, build); where a new route, screen, table or test goes and how it is named; how errors, config and logging work; which files are shared and who may edit them, plus the dependency rule (add what your task needs, never upgrade the rest); and the contracts two slices will both rely on (API shapes, data tables). A convention that is not written there does not exist for the next agent.

### 5. Plan the first task graph

After the skeleton passes its check, so that Owns paths are real. Slice catalog and rules: [task-graph](references/task-graph.md). In short:

- Slice by what can be built and verified on its own: data model, API, UI shell, each feature screen, auth, deployment script, demo data. Not by layer for its own sake.
- Create tasks with `task_create`, in dependency order, each description in the five-part template of clowdy:orchestrate (Outcome, Owns, Needs, Check, Out of scope).
- Two tasks are independent when they own different paths and neither needs the other's output. A contract both need is written into `architecture.md` first, so the two can build against it in parallel.
- Aim for 4 to 8 tasks for the first milestone, each about an hour of agent work. Small parts inside a slice go to engine sub-agents.
- Verification is not a task: verify the first milestone on the combined result (step 6). Move the skeleton task to Done only after you saw its check pass.

### 6. Fan out

Continue the loop in clowdy:orchestrate at step 4: start every ready task at once, one executor per coarse slice, each with its task keys, owned paths, contracts, and a pointer to `architecture.md` and the check command. End the turn and handle each result as it arrives. When the slices are Done, a verifier bound to the slice tasks runs the milestone flow from `product.md` on the combined result (clowdy:verify). Then move the verified behavior to Implemented in `product.md` and let the check report go to `checks/`.

### 7. Tell the user

Short, in manager terms: what now exists and how to see it, what you chose that matters and why (platform, data, sign-in), what happens next, links to `product.md` and the tasks. No stack names unless they asked. In semi-manual add `Decided with you`.

## Worked example

Semi-manual. Brief: "Build an invoicing app for my consulting business." Empty folder, Bun installed.

1. Draft milestone: "I create a client and an invoice with two lines, download it as a PDF, and see it in the list as unpaid."
2. One round, four cards. Browser or installed (recommend browser). Tax lines on invoices (recommend yes, one rate per invoice). How the client gets it: a PDF you download, or the app emails it (recommend download; email needs a mail account). Who signs in: only you with one password (recommend). Language, framework and database are not asked: decided and recorded.
3. Answers: browser, yes, "download", "only me". Write `product.md`, the record `2026-11-17-invoicing-scope.md` (`Decided by: user (semi-manual)`) and the stack record. Confirmation card holds the milestone and the four answers. Answer: "go".
4. Create "Build the skeleton" (CLW-1), one executor, check and run proven. Then the slices: invoice data and API (CLW-2), invoice editor screen (CLW-3), PDF export (CLW-4), client list screen (CLW-5, depends on CLW-2), sign-in (CLW-6). CLW-2, 3, 4 and 6 start together; CLW-5 waits for CLW-2. When all are Done, a verifier walks the milestone on the combined result.
5. Report: "Done: you can create clients and invoices, add tax and download a PDF. Decided with you: browser app, tax per invoice, PDF download only, one password (decisions/2026-11-17-invoicing-scope.md). Open: emailing invoices is not built (CLW-9)."

Autopilot differs only in step 2 of the example: no cards, it decides and writes the records at once, and the report says `Decided for you`. A full graph with owned paths and dependencies (a bakery ordering site) is in [task-graph](references/task-graph.md).

## Avoid

- Starting parallel agents before the skeleton passes its own check.
- Adding features the milestone does not need (payments, roles, admin panels) because the template had them. Delete generator output the product does not use.
- Fashionable or exotic stacks, two languages without a reason, services that need an account before anything runs.
- Asking the manager technology questions, or asking in autopilot at all.
- Secrets in the repository. Use `.env.example` with fake values.
- Declaring the skeleton done without running the check and run commands.

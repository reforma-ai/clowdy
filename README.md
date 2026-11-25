# Clowdy

**The desktop workspace for agentic software development.**

Clowdy brings AI coding agents, projects, tasks, files, documents, Git and worktrees together in one desktop app. Give an agent a task, let it coordinate other agents, and follow the work as it happens. You can review changes, make decisions and redirect individual agents without leaving the workspace.

The goal is to make autonomous software development visible and manageable, whether you're fixing a bug with one agent or coordinating a team of agents across several repositories.

<!-- Add a screenshot of the workspace showing a chat, child threads and the task board. -->

## Why Clowdy?

Clowdy grew out of day-to-day work with Cursor, Claude Code, Codex and other coding agents. As agents became capable of tackling larger jobs and working in parallel, keeping track of their work became a job of its own.

A conversation alone is a poor place to manage a multi-stage project. You need to know which tasks are done, which depend on unfinished work, where each agent is making changes and whether those changes are ready to merge. You also need to be able to step in when something goes wrong.

Clowdy gives agents a shared working environment and gives you a view of that same environment. The work stays accessible even when you're not the one doing it. One interface should make a team of agents as easy to follow as a single agent, without turning the workspace into an operations console.

## Available now

### Projects, repositories and worktrees

A project can contain multiple folders and repositories. Keep separate projects for your products, side projects or work that has nothing to do with code, and switch between them without mixing their chats, files or tasks.

When you start a chat, you can work in the main checkout, reuse an existing Git worktree or create a new one from a branch of your choice, such as `origin/main`. New chats can inherit the current worktree so you don't lose your working context.

Manage worktrees from the app, including removing one on its own or together with its associated branch when the work is finished. The agent's working directory is accessible to you, along with its files, branch and changes.

### Plans become tasks

An agent's plan belongs on the task board, not buried in a conversation. Clowdy's agents can turn a large request into a parent task with subtasks, checklists and dependencies. Independent stages can run in parallel; dependent stages can wait until their prerequisites are complete.

Follow the work in a list or Kanban board. See what is in progress, under review or waiting for another task. Open an individual task to read its description, comments, linked agent runs and recorded results such as commits, diffs, checks and documents.

<!-- Add a screenshot of the task board and task detail panel. -->

### Threads you can actually talk to

An orchestrator can delegate work to child threads. Each child is a real chat with its own context, agent, work assignment and, when needed, its own worktree. A child reports back to its parent when it finishes, and different threads can use different agents.

Open a child thread, follow its progress or send it a message directly. Provider-native subagents are still available; Clowdy's threads make delegated work accessible as part of the workspace.

Queue messages for the next turn or steer a running agent without waiting for it to finish. When an agent cannot accept steering mid-turn, the message stays queued. These controls belong to Clowdy rather than to a single agent's interface.

### Files and documents

The workspace includes a file tree and editor. Browse and manage the same files the agents are working with. Expand the side panel when you need more room to read or edit.

The Docs tab collects Markdown documents from Clowdy's own document directory and conventional locations used by Briefback, Spec Kit, OpenSpec and Kiro. Research, specifications, plans and decisions stay accessible as project documents rather than disappearing into the chat history.

### Git, without switching apps

Review an agent's changes next to its chat:

- Inspect file diffs and individual commits, and mark reviewed files as viewed.
- Select part of a diff and send it to an agent as context.
- Commit, fetch, pull and push changes.
- Create and switch branches, and merge changes between branches.
- Create GitHub pull requests and inspect their history and status.

Source Control offers actions appropriate to the current state of the repository. The aim is to make everyday Git work approachable without hiding what is happening to your branches.

<!-- Add a screenshot of the Changes tab with a file diff and Source Control. -->

## How agents work together

Clowdy's built-in orchestration follows [Briefback](./BRIEFBACK.md), a flexible, spec-driven development workflow. A small fix can go straight to implementation. A larger request can go through the full cycle:

1. **Research** — understand the project and preserve relevant findings in Markdown.
2. **Grill** — challenge the initial understanding, uncover edge cases and settle decisions that affect the outcome.
3. **Plan** — break the work into stages with clear ownership and dependencies, ideally small enough to review and commit separately.
4. **Implementation and review** — execute stages in order or in parallel as appropriate. Verify each stage, and let another agent review and fix it when useful.
5. **Documentation and archive** — preserve decisions, verification results and relevant project documentation; archive completed work when it's no longer needed in the active view.

Choose how involved you want to be:

- **Hands-off:** describe the result you want and let the agent make decisions and proceed autonomously.
- **Hands-on:** the agent still drives the workflow, but asks you about significant decisions before moving ahead. You don't have to approve every stage.

## Supported agents

Clowdy uses the Agent Client Protocol (ACP) to connect to locally installed agents. Claude Code, Codex and Cursor are the primary integrations.

The built-in catalog also includes OpenCode, Gemini CLI, GitHub Copilot CLI, Grok Build, omp and Hermes Agent. The capabilities available in Clowdy vary by provider; not every agent supports the same account information, model selection, steering or session operations.

Bring your own agent installation and account. Clowdy doesn't bundle a model subscription or require you to switch providers.

## Current status

Clowdy is in active development. The desktop app targets macOS and Windows, with macOS as the primary development platform. Execution is local today: the daemon runs independently of the desktop window and keeps the project, task and chat state on your machine. Closing the window doesn't require stopping the daemon.

## Roadmap

Clowdy is intended to grow into a self-hosted software factory. The following capabilities are planned, not available today:

- **Remote execution.** Run the Clowdy daemon on your own Linux server and connect from the desktop app over SSH. Leave agents working while your laptop is offline.
- **External task and issue integrations.** Connect Clowdy's task workflow to systems such as Linear and GitHub Issues, with status synchronization.
- **Event-driven automation.** Start work from a labeled issue or task, create a worktree, run agents, update the external task and open a pull request when the work is ready.
- **Richer workflow documents.** Give specifications, plans and decisions more structured views beyond the current document tree.
- **Broader agent integration.** Extend provider coverage and improve feature parity across agents.

## Getting started

To run Clowdy from source, you'll need [Bun](https://bun.sh) 1.4+, Node.js 22.12+, Git on your PATH and at least one supported agent installed and signed in.

From a checkout of this repository:

```sh
bun install
./clowdy dev
```

On Windows, use `bun run clowdy dev` in place of `./clowdy dev`.

Once the app opens, add a project with one or more local folders, choose an installed agent, and start a chat. You can select a worktree and choose Hands-on or Hands-off in the composer.

To build an unpacked desktop app for your platform:

```sh
./clowdy build
```

The build is written to `apps/desktop/release/`. See the [development guide](./DEVELOPING.md) for architecture, builds, tests and developing Clowdy with Clowdy.

## License

Clowdy is licensed under the [Apache License 2.0](./LICENSE). See [NOTICE](./NOTICE) and [third-party licenses](./THIRD-PARTY-LICENSES.md) for attribution. The Clowdy name and logo are not licensed under Apache 2.0; see [TRADEMARKS.md](./TRADEMARKS.md).

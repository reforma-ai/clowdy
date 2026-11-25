# Clowdy

**The desktop workspace for agentic software development.**

Run AI agents across your projects, repositories and worktrees from one app. Give an agent a goal and follow its plan on a shared task board as it delegates work, reviews changes and verifies results. Open the chats, documents and Git changes behind each task, and step in whenever you need to.

<!-- Add a screenshot of the workspace showing a chat, child threads and the task board. -->

## Why Clowdy?

Clowdy grew out of day-to-day work with Cursor, Claude Code, Codex and other coding agents. As the agents got better at handling large tasks in parallel, keeping track of their work became a job of its own. Which tasks are blocked? Which branches have changes? What still needs review?

I wanted a workspace where agents could work independently and I could still see what was happening, review their work and step in when needed. I care just as much about how it feels to use. Linear is a good example: it's fast, looks great and gets the little interactions right. Even with ten agents working at once, Clowdy should feel calm and easy to navigate.

## Available now

### Plans become tasks

When an agent plans a feature, that plan can become a parent task with subtasks, checklists and dependencies on the project's board. Agents and people create, edit and track the same tasks. There is no separate plan to copy from the chat into a tracker.

Start an agent directly from a task, or let an orchestrator create tasks and assign them to child threads. Independent stages can run in parallel, and threads assigned to blocked tasks wait for their dependencies. The board shows where work is happening, what needs review and how much is left.

Use the list or Kanban view to manage work, drill into a parent task, and jump from a task to the agents working on it. Task history can include comments, commits, diffs, checks and documents. Task references in chat are clickable, so you can go straight from an agent's progress report to the work it describes.

<!-- Add a screenshot of the task board and task detail panel. -->

### Projects are workspaces

A project in Clowdy is a workspace for an area of work. It could be your entire company, a product, a new idea or a personal project. Inside it are the folders and repositories that belong to that context. They don't need to live under one directory or share a Git history.

For example, a company workspace might contain separate repositories for its frontend, API, mobile app and website, plus an ordinary folder for product documents. You can work across them with one set of chats, tasks and project settings. Switch projects to switch the whole working context. There's also a personal space for work that doesn't belong to a repository.

Each Git repository keeps its own branches and worktrees. Start a chat in the main checkout, reuse a worktree or create one from a branch of your choice. New chats can inherit the current worktree. Manage worktrees from the app, remove them with or without their branches, and access the same files and changes as the agent.

### Threads you can talk to

An orchestrator can delegate work to child threads. Each is a regular chat with its own agent, context, assignment and, when needed, worktree. Children report back to their parent when they finish and can use different agents. Provider-native subagents are still available.

Open any child thread to see its progress or talk to the agent directly, even while it's working.

A Claude Code coordinator can delegate implementation to Codex and review to Cursor, with both reporting back to the parent chat. You can also fork a conversation or hand its transcript to another agent in a new chat, without explaining the whole task again.

### Steer and queue

You don't have to wait for an agent to finish before giving it more instructions.

- **Steer:** redirect the agent during its current turn without stopping its work.
- **Queue:** line up follow-up messages to run in order after the current turn finishes.

Clowdy shows pending messages above the composer, where you can edit, remove or send them as a steer. The queue is stored by the daemon, so it isn't lost when you reload the app. If a run fails or you stop it, the queue pauses until you're ready to resume. If an agent can't take a steer mid-turn, Clowdy delivers it on the next turn instead.

The same controls work across agent providers, including child threads.

### Files, documents and terminals

Browse, edit and manage the project's files in a side panel that expands when you need more room. The Docs tab brings Markdown specifications, plans, research and decisions together from Clowdy's own document directory (`.clowdy/docs/`), Spec Kit, OpenSpec and Kiro.

Open a terminal in the chat's worktree to run a test or inspect the agent's work yourself. Shells keep running when you switch chats or reload the window. Select output from a terminal, or code from a file, and send it straight to the chat.

Quick Search finds chats, files, documents and matching lines of code in the current project context. Use keyboard shortcuts to move between them, and attach files, images or `@` references to your prompts.

### Git, without switching apps

- Inspect file diffs and individual commits, and mark reviewed files as viewed.
- Select part of a diff and send it to an agent.
- Generate commit messages with a configured agent, then commit, fetch, pull and push changes.
- Create, switch and merge branches.
- Create GitHub pull requests and inspect their history and status.

Source Control shows the relevant action for the current repository state. You can also configure automatic sync after commits and merges.

<!-- Add a screenshot of the Changes tab with a file diff and Source Control. -->

## How agents work together

Every agent in Clowdy follows the same delivery loop, which ships with the app as system skills. A question gets an answer from the docs and the code, with no tasks created. A small, clear change is made on the spot. Larger work goes through these steps:

1. **Understand:** read the project's guides and documents, check the board for related work and run the project's checks once to learn the baseline.
2. **Set the goal:** write down what done means, as the commands and user flows that must pass.
3. **Plan:** split the work into tasks with dependencies. Each task states its outcome, what it owns, what it needs, how it's checked and what is out of scope.
4. **Work:** do it directly, or hand coarse pieces to child threads. Independent stages run in parallel when they don't touch the same files, and a thread can get a worktree of its own.
5. **Review:** another agent reviews each finished stage, and the stage is committed.
6. **Verify:** run the checks and the real user flow on the combined result. An agent saying "done" is not evidence: only commands that actually ran count, and a fresh thread can check a risky change independently. A failed check reopens the task.
7. **Record and report:** update the tasks and the project's documents with what changed and why, then report in plain words.

Choose how involved you want to be:

- **Hands-off:** describe the result and let the agent decide how to get there. It records each significant decision and asks only when it's stuck.
- **Hands-on:** the agent asks about significant decisions in question cards, with options and a recommendation, and carries on once they're settled. You don't need to approve every stage.

## Supported agents

Clowdy connects to locally installed agents using the Agent Client Protocol (ACP). Claude Code, Codex and Cursor are the primary integrations. The built-in catalog also includes OpenCode, Gemini CLI, GitHub Copilot CLI, Grok Build, `omp` and Hermes Agent.

Bring your own agent installation and account. For providers that support them, choose the model, reasoning effort and permissions, check remaining subscription limits, and monitor or compact the conversation context.

Clowdy discovers system, user and project skills and exposes them in Settings, including an estimate of their context cost. You can disable user skills you don't need. Provider capabilities vary; Clowdy also supports registering custom ACP commands through its daemon.

## Current status

Clowdy is in active development for macOS and Windows, with macOS as the primary development platform. Agents run locally in a daemon that keeps your projects, chats and tasks on your machine, and it can keep working when you close the desktop window. Your prompts and code still go to the provider of whichever agent you choose.

## Roadmap

The longer-term goal is a self-hosted software factory. These features are still planned:

- **Remote execution:** run the daemon on your own Linux server and connect over SSH. Leave agents working while your laptop is offline.
- **External task integrations:** synchronize tasks with Linear, GitHub Issues and other systems.
- **Event-driven automation:** pick up a labeled issue, create a worktree, run agents, update the issue and open a pull request.
- **Richer document views:** display specifications and plans according to their workflow, beyond the current document tree.
- **More agents:** expand provider coverage and improve feature parity.

## Getting started

To run from source, you'll need [Bun](https://bun.sh) 1.4+, Node.js 22.12+, Git on your PATH and a supported agent installed and signed in.

From a checkout of the repository:

```sh
bun install
./clowdy dev
```

On Windows, use `bun run clowdy dev` instead.

Add a project with one or more local folders, choose an installed agent and start a chat. Select a worktree and a Hands-on or Hands-off mode in the composer.

To build an unpacked app for your platform, run `./clowdy build`. The result is in `apps/desktop/release/`.

See the [development guide](./DEVELOPING.md) for architecture, builds, tests and developing Clowdy with Clowdy.

## License

Clowdy is licensed under the [Apache License 2.0](./LICENSE). See [NOTICE](./NOTICE) and [third-party licenses](./THIRD-PARTY-LICENSES.md) for attribution. The Clowdy name and logo are not licensed under Apache 2.0; see [TRADEMARKS.md](./TRADEMARKS.md).

# Clowdy

**The desktop workspace for agentic software development.**

Run AI agents across your projects, repositories and worktrees from one app. Give an agent a task, let it coordinate other agents, and follow the work through chats, a task board, project documents and Git. Step in whenever you need to.

<!-- Add a screenshot of the workspace showing a chat, child threads and the task board. -->

## Why Clowdy?

Clowdy grew out of day-to-day work with Cursor, Claude Code, Codex and other coding agents. As the agents got better at handling large tasks in parallel, keeping track of their work became a job of its own. Which tasks are blocked? Which branches have changes? What still needs review?

I wanted a workspace where agents could work independently and I could still see what was happening, review their work and step in when needed. I care just as much about how it feels to use. Linear is a good example: it's fast, looks great and gets the little interactions right. Even with ten agents working at once, Clowdy should feel calm and easy to navigate.

## Available now

### Projects, repositories and worktrees

A project can contain several repositories and folders. Switch between products, side projects and non-coding work without mixing their chats, files or tasks.

Start a chat in the main checkout, reuse an existing Git worktree or create a new one from a branch of your choice. New chats can inherit the current worktree. Manage worktrees from the app, remove them with or without their branches, and access the same files and changes as the agent.

### Plans become tasks

An agent's plan belongs on the task board, not buried in a conversation. Agents can break a large request into a parent task and subtasks with checklists and dependencies, then work on independent stages in parallel. They use Clowdy's task commands to update the same board you see, and its thread commands to coordinate the work.

See what's in progress, under review or blocked in a list or Kanban board. Open a task to read its description, comments, linked agent runs, commits, diffs, checks and documents.

<!-- Add a screenshot of the task board and task detail panel. -->

### Threads you can actually talk to

An orchestrator can delegate work to child threads. Each is a regular chat with its own agent, context, assignment and, when needed, worktree. Children report back to their parent when they finish and can use different agents. Provider-native subagents are still available.

Open any child thread to see its progress or talk to the agent directly. You can edit, remove or send queued messages, or steer a running agent mid-turn. If the agent can't accept steering, Clowdy keeps the message queued.

A Claude Code coordinator can delegate implementation to Codex and review to Cursor, with both reporting back to the parent chat. You can also fork a conversation or hand its transcript to another agent in a new chat, without explaining the whole task again.

### Files, documents and terminals

Browse, edit and manage the project's files in a side panel that expands when you need more room. The Docs tab brings Markdown specifications, plans, research and decisions together from Clowdy's own document directory, Briefback, Spec Kit, OpenSpec and Kiro.

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

Clowdy follows [Briefback](./BRIEFBACK.md), a flexible, spec-driven development workflow. A small fix can go straight to implementation. Larger jobs benefit from a more deliberate process:

1. **Research:** explore the project and record useful findings in Markdown.
2. **Grill:** challenge assumptions, look for edge cases and settle decisions.
3. **Plan:** divide the work into stages with clear ownership and dependencies.
4. **Implementation and review:** execute stages in order or in parallel, verify and review the changes, and commit each finished stage. Another agent can review or fix the work.
5. **Documentation and archive:** preserve decisions, checks and project documentation, and archive completed work when it's no longer needed on the board.

Choose how involved you want to be:

- **Hands-off:** describe the result and let the agent decide how to get there.
- **Hands-on:** the agent asks about significant decisions in question cards, with options and a recommendation, and carries on once they're settled. You don't need to approve every stage.

## Supported agents

Clowdy connects to locally installed agents using the Agent Client Protocol (ACP). Claude Code, Codex and Cursor are the primary integrations. The built-in catalog also includes OpenCode, Gemini CLI, GitHub Copilot CLI, Grok Build, omp and Hermes Agent.

Bring your own agent installation and account. For providers that support them, choose the model, reasoning effort and permissions, check remaining subscription limits, and monitor or compact the conversation context.

Clowdy discovers system, user and project skills and exposes them in Settings, including an estimate of their context cost. You can disable user skills you don't need. Provider capabilities vary; Clowdy also supports registering custom ACP commands through its daemon.

## Current status

Clowdy is in active development for macOS and Windows, with macOS as the primary development platform. Agents run locally in a daemon that keeps your projects, chats and tasks on your machine. It can keep working when you close the desktop window.

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

# Reference projects

Open-source projects Clowdy borrows ideas from. Before designing something they already solved, read their source, and name the file when an idea is taken. Both are MIT licensed: reading is free, and copied code keeps its license notice. Prefer reimplementing the idea to pasting code.

Facts below come from each project's public page and repository description (snapshot 2026-11-17). Anything not yet read in source is marked "to confirm"; research notes under `.briefback/<feature>/research/` replace those marks with file paths.

## get-bb/bb

- Repo: https://github.com/get-bb/bb (TypeScript, MIT). Described as "the agent IDE that builds itself". Its FAQ and product copy are also a model for how Clowdy should explain itself.
- Agents (site FAQ): Claude Code, Codex, Cursor, OpenCode, Pi, Grok Build, omp, Hermes Agent. Any other agent that speaks the Agent Client Protocol (ACP) is added in Settings, or by a plugin (Gemini CLI and Devin are the examples it gives). Each thread can use a different agent.
- What the source shows (research `acp/research/bb-source.md`, commit `f1c5304`): ACP carries only Cursor, OpenCode, omp, Grok, Hermes and custom or registry agents. Claude Code runs on the Claude Agent SDK pointed at the user's own `claude`, Codex on `codex app-server`, Pi on its own RPC bridge. Orca does the same split.
- Agents work together: any agent can message another thread whatever its provider, agents answer each other, and an agent hears back when a thread it started finishes or fails. The receiving thread shows each message and its sender, and the user can message any of them.
- Parallel work: each thread gets its own Git worktree; the user lists `.env` files and setup commands once and every new worktree is prepared from them. Default parallelism is one thread per processor core, and the rest start as others finish.
- Look here for: ACP integration and how installed agents are found, per-thread agent choice, cross-provider messaging, worktree setup, the plugin shape, scheduling by core count. All to confirm in source.

## stablyai/orca

- Repo: https://github.com/stablyai/orca (TypeScript, MIT). Runs "a fleet of coding agents (e.g. Claude Code, Codex) with your own subscription", on desktop, mobile and a remote runtime.
- Look here for: driving the agent CLIs the user already has installed and logged in, fleet management, the remote runtime and mobile client. All to confirm in source.

## How to use them

- Read-only references. Clone shallow into the scratchpad or another throwaway folder; do not install or run their code from inside the clone.
- Cite a file with the commit hash it was read at, since both projects move fast.
- Their choices are inputs, not decisions. Clowdy's own constraints (the daemon owns runs, loopback HTTP + SSE contract, `packages/protocol`) decide.

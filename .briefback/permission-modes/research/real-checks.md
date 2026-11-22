# Real checks: permission presets and approvals

Stage 2 of `.briefback/permission-modes/plan.md`. The question: do the presets reach the real agents, do their permission requests come to the person as `approval` items, does `run.decide` act as it says, and what does Allow for session leave behind? Date: 2026-11-22. Nothing here is a test: it spends the owner's subscription (a few small turns), so it is run by hand and rerun on every bump of an adapter pin.

## Verdict

| Agent | Pin | Result |
| --- | --- | --- |
| Claude Code | `@agentclientprotocol/claude-agent-acp@0.107.0`, the user's `claude`, model `haiku` | **Pass**, after one fix (Allow for session, below) |
| Codex | `@agentclientprotocol/codex-acp@2.8.0`, the user's `codex` | **Pass**, after the same fix |

## Setup

A scratch daemon made of the daemon's own modules in one Bun process (the script is `permission-check.ts`, kept in the session scratchpad, modelled on the one in `.briefback/message-actions/research/real-checks.md`), run from the worktree of the stage: data, projects and personal folders under the scratchpad, port `47312`, token `scratch-token`, user skill folders pointed at an empty folder. The agent starts exactly as a run starts it (`AcpEngine` over the real `AgentRegistry`). One chat, several turns, the preset set with `agent.update { id, permission }` before each turn, the approvals read from the stream and decided through `run.decide`.

```
cd <scratch folder that holds only the script>
bun permission-check.ts <claude|codex> <scratch dir> [S1,S2,S3,S4,S5,S6]
```

Prompts are all of the form `Run exactly this shell command and tell me what happened: echo <word> > <word>.txt`.

## What was observed (both agents unless said)

| Scenario | Observed |
| --- | --- |
| Presets listed | `AgentInfo.permissions` lists the four presets with the provider's own descriptions and `default: auto`, for Claude and for Codex |
| S1 `ask`, Deny | One `approval` item with a `command` subject (the agent's own text of the command), `decisions` `allow_once/allow_always/reject`, the run `queued > running > waiting_user > succeeded`, reason `Waiting for your approval`. After `reject` the file is not written; Claude says the command was refused and that it will not retry, Codex's last message is its plan to run it, and the file is absent |
| S2 `ask`, Allow once | The file is written; the run passes through `waiting_user` and succeeds |
| S3 `ask`, Allow for session, then the same request in the next turn | After the fix: no second item, in the next turn (another agent process) too; no lasting rule written by the agent (see below) |
| S4 `auto` (Approve for me), `clowdy task list` | No approval on either agent: the command runs |
| S6 `ask`, `clowdy task list` | **Claude: no approval**, which is the pre-allowed `Bash(clowdy:*)` at work (in Claude's `default` mode every other command asks). **Codex: asks** (its `read-only` mode has nothing like it), so on Codex a person who picks Ask for approval is asked for Clowdy's own command too; on the default, Approve for me, it is not |
| S5 `ask`, Stop with a request waiting | The run goes `cancelled`, the item `cancelled` (no decision), and no adapter process is left |

## What was found: the agent's own "always allow" writes a lasting rule

The first run answered Allow for session with the agent's `allow_always` option, as the plan first said. Both agents turn it into a rule that outlives the run:

- **Claude Code** wrote the project's `.claude/settings.local.json`: `{ "permissions": { "allow": [ "Bash(echo three *)", "Bash(echo \"exit=$?\")" ] } }`.
- **Codex** wrote `~/.codex/rules/default.rules`, **global**: `prefix_rule(pattern=["/bin/zsh", "-lc", "echo three > three.txt"], decision="allow")`. It applies to every project and to Codex outside Clowdy. (The check created that file and its folder; both were removed by hand afterwards.)

So "Allow for session" answered that way is neither for the session nor limited to Clowdy. The fix, in `engine/acp/session.ts`: `allow_always` is answered to the agent with its **one-time** allow, and Clowdy's own grant (per run, in memory) spares the repeat. The second run, with the fix, showed no new item in the next turn and no `~/.codex/rules` and no `.claude/settings.local.json`. An agent with no one-time allow option gets its lasting one (the only way to say yes). `decisions` offers Allow for session whenever the agent offers any allow option.

## Things to know

- A grant is the exact text of the command (`command:<text>`): when the model rewrites the command (Claude added `&& echo "exit=$?" && ls -l ...` to some prompts), the rewritten command is a new request and asks again. Claude's own pattern rules are wider (`echo three *`); Clowdy's key is narrow on purpose.
- Codex printed `Codex could not continue session ...: This Codex session is in use by another Codex client` once, on the second turn, and the daemon started a new session as it does for any session it cannot continue; the person's own Codex app may have been open. It did not affect the check.
- The model, not the daemon, chooses the exact command text, so a card shows what the agent decided to run, which can be longer than what the person asked.
- Not checked: Windows, a permission request for a file edit or an MCP tool (only commands were asked for), `accept-edits` and `full` on real agents (their `mode` values are the adapters' own, listed by the probe on 2026-11-22), and whether Codex sends `$/cancel_request` for a withdrawn request.

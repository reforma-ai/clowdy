# Durable questions for ACP providers

Status: accepted
Date: 2026-11-24
Decided by: user and orchestrator
Related tasks: CLO-54, CLO-123
Supersedes: decisions/2026-11-24-provider-question-capabilities.md

## Decision

Keep form elicitation as an explicitly verified provider capability. Codex and Claude use that path. An ACP agent without verified form elicitation is stopped before its question becomes answerable; the question and answer are stored and the agent resumes in a new turn after the person answers. New and custom agents opt into form elicitation only after a check.

If an agent advances while a live question remains unanswered, Clowdy stops the session and transfers that same question to the durable path. A foreground tool-start notification is treated conservatively as advancement; a delayed notification can therefore trigger an unnecessary but safe pause.

When a durable pause stops background work, the chat says so and the continuation is told what was lost. If the continuation fails, its answer and the lost-work context remain available for the next attempt. An explicit Stop retires the pending answer.

## Limits

A verified stop uses the existing process-tree boundary. A process that escaped observation cannot be accounted for by that boundary. The form handler supports Clowdy's question tool, not arbitrary third-party forms. The older application does not understand the durable question state, so an unanswered durable question should be answered or stopped before switching back to an older build.

# Provider question capabilities

Status: superseded
Superseded by: decisions/2026-11-24-durable-provider-questions.md
Date: 2026-11-24
Decided by: user
Related task: CLO-54

## Context

ACP agents differ in how they handle questions. Codex and Claude forwarded an MCP form request during isolated checks. Cursor declined the form request and its ordinary MCP call timed out during a 65-second wait.

## Decision

Declare verified form elicitation support as a provider capability. Providers without that capability use the ordinary question tool. Do not select the question mechanism by provider name. A custom agent may opt in through its `elicitation` property in `agents.json` after its adapter has been checked.

## Limits

The ordinary tool path can time out, so it does not yet provide long waits for every ACP agent. The current form handler is for Clowdy's question tool; arbitrary third-party forms are not supported.

# Sub-agents

Load this when you are about to hand work to the engine's own sub-agents. Who does what (you, a sub-agent or a thread), file ownership and where to work are in [threads](threads.md); they apply to sub-agents as written.

## 1. What they are for

An engine sub-agent (Claude's `Agent` tool; Codex's own sub-agent facility if it has one) runs inside your session and ends with it, including when the daemon restarts. Use it for research, review, compatible edits or similar probes. Choose the number by the work and available capacity; do not split work just to distribute it.

Choose direct work, sub-agents or threads by the work and coordination cost. Coordinate overlapping edits and review fixes; do not hand off a piece whose result you cannot check.

## 2. The prompt

A sub-agent does not load these skills. Its prompt must hold everything it needs: the question or the edit, the owned paths, "read-only" or not, the mode line, the paths of settled decisions, and the shape of the answer ("at most 15 lines, with file paths"). It writes no documents; a significant fork goes back to you in its answer.

```text
Mode: <autopilot | semi-manual>. You are a sub-agent: never ask the user.
Goal: <one sentence, in product terms>.
Question or edit: <what to find out or change>. Read-only: <yes | no>.
Read first: the project guide (AGENTS.md or similar), <relevant project documents>, <code paths>.
Decisions already made: <paths of the settled records, with the reason in a few words>.
Owns: <paths>. Do not edit anything else; report changes needed elsewhere.
Contract with other agents: <endpoint, types, format>.
Run: <the narrowest check>. Do not install dependencies, regenerate lockfiles, commit or touch git.
Where: work in <cwd>. Documents, read only: <relevant paths>.
Answer: at most 15 lines: what changed or what you found, with file paths, the commands you ran and their results, open questions.
```

## 3. Results

A sub-agent's answer is a lead, not evidence: read its diff and run the check yourself. Retry one that fails or answers off target once with the reason, then do it yourself. Sub-agents do not commit: you commit each verified task's own paths.

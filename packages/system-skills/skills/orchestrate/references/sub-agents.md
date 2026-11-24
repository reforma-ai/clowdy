# Sub-agents

Load this when you are about to hand work to the engine's own sub-agents. Who does what (you, a sub-agent or a thread), file ownership and where to work are in [threads](threads.md); they apply to sub-agents as written.

## 1. What they are for

An engine sub-agent (Claude's `Agent` tool; Codex's own sub-agent facility if it has one) runs inside your session: cheap, in-process, sharing your cache. Use it for read-only research and review, for file-disjoint edits small enough for one sub-agent turn, and for many similar probes, one item each (the same check over many modules, a review of many files). Launch 5-15 per wave in one message; the engine allows about 20 at once. They end with your session, and with it if the daemon restarts.

Rules of thumb: research and review are sub-agents; implementation of a task is yours or a thread's. Do not hand a piece to a sub-agent when you could not check its result, and do not hide hours of work in one: that is a thread.

## 2. The prompt

A sub-agent does not load these skills. Its prompt must hold everything it needs: the question or the edit, the owned paths, "read-only" or not, the mode line, the paths of settled decisions, and the shape of the answer ("at most 15 lines, with file paths"). It writes no documents; a significant fork goes back to you in its answer.

```text
Mode: <autopilot | semi-manual>. You are a sub-agent: never ask the user.
Goal: <one sentence, in product terms>.
Question or edit: <what to find out or change>. Read-only: <yes | no>.
Read first: the project guide (AGENTS.md or similar), .clowdy/docs/architecture.md (section "API"), <code paths>.
Decisions already made: <paths of the settled records, with the reason in a few words>.
Owns: <paths>. Do not edit anything else; report changes needed elsewhere.
Contract with other agents: <endpoint, types, format>.
Run: <the narrowest check>. Do not install dependencies, regenerate lockfiles, commit or touch git.
Where: work in <cwd>. Documents, read only: <absolute path of the main checkout>/.clowdy/docs.
Answer: at most 15 lines: what changed or what you found, with file paths, the commands you ran and their results, open questions.
```

## 3. Results

A sub-agent's answer is a lead, not evidence: read its diff and run the check yourself. Retry one that fails or answers off target once with the reason, then do it yourself. Sub-agents do not commit: you commit each verified task's own paths.

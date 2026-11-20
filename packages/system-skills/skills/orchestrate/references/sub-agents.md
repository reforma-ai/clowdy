# Sub-agents

Load this when you are about to hand work to the engine's own sub-agents.

## 1. Who does the work

| Choice | Use when | Cost and limits |
| --- | --- | --- |
| **You** | The default: a task's coherent piece, the glue between pieces, a conflict, a one-line contract fix, anything that needs the whole picture. | Uses your context; keep it for decisions. |
| **Engine sub-agent** (Claude's `Agent` tool; Codex's own sub-agent facility if it has one) | Read-only research and review; file-disjoint edits small enough for one sub-agent turn; many similar probes, one item each (the same check over many modules, a review of many files). The result is only needed by you. | Cheap, in-process, shares your cache. Launch 5-15 per wave in one message; the engine allows about 20 at once. They end with your turn, and with it if the daemon restarts. |

Rules of thumb: research and review are sub-agents; implementation of a task is yours. Do not hand a piece to a sub-agent when you could not check its result, and do not hide hours of work in one.

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

## 2. File ownership

1. Every piece handed to a parallel sub-agent lists what it **Owns**: directories or files. The owned sets of parallel sub-agents must not intersect. If two pieces need the same file, do them one after the other yourself, or move the shared part into one piece that comes first.
2. Shared hot files have exactly one owner, or are left to you at integration: lockfile and dependency manifests, route or module registries, barrel files, generated files, migration numbering, `index.md`. Tell sub-agents not to run installs or regenerate lockfiles; do it yourself afterwards.
3. Fix contracts first. Write the interface in the task descriptions and in each prompt: type names, endpoint path and response shape, file format, function signatures. Without it, parallel pieces diverge and integration becomes rework.
4. Tests belong to the task that owns the code; do not make "write tests" a separate task.

## 3. Where to work

Your call per task, as in any session. Default: one checkout, disjoint ownership, no extra copies; a worktree costs an install and adds a merge. Create one with plain git (`git worktree add <path outside the repository> -b <task key>`), install dependencies there and name its absolute path in every prompt that works there, when:

- two pieces must change the same files and cannot be done in order;
- a task may break the build or the tests for a long time (migration, big refactor, dependency upgrade);
- you try two alternatives to compare;
- the manager has uncommitted changes in the area: never overwrite or revert them;
- you must verify a fixed candidate while sub-agents keep editing;
- the project is Clowdy's own repository ([self-hosting](self-hosting.md)).

Read-only sub-agents use the main checkout. When a worktree task is verified, merge it yourself and remove the worktree; leave none behind.

Commits: sub-agents do not commit. You commit each verified task's own paths (`git commit -m "<what and why>" -- <paths>`). Never push unless the manager asked.

# Check: system skill edits

- Result: passed for the checks below
- Date: 2026-11-24
- Tasks: CLO-100, CLO-101
- State checked: combined skill edits in the Clowdy worktree

## What was run

| Step | Command or action | Result |
| --- | --- | --- |
| Skill validation | `bun run --filter @clowdy/system-skills test` | Exit 0; six skills validated |
| Types and lint | `bun run --filter @clowdy/system-skills typecheck` and `bun run --filter @clowdy/system-skills lint` | Both exit 0 |
| Daemon integration | `bun test test/skills-vocabulary.test.ts test/orchestration.test.ts` in `apps/daemon` | Exit 0; 27 tests passed |
| Diff | `git diff --check -- packages/system-skills/skills` | Exit 0 |
| Semantic review | Independent reviewer compared edited rules with the originals | Restored a planning condition and moved two safeguards to their relevant sections |

## Known limits

- The tests validate package structure, commands and prompt assembly; they do not prove equivalent agent behavior.
- No live-agent comparison was run against the original and edited instructions.
- Existing instructions disagree about whether read-only sub-agents may start before the scaffold is checked and whether a checking thread is mandatory for risky changes. These policy questions were not changed by this edit.

## Verdict

The edited skills pass the structural and integration checks; behavioral equivalence remains unproven without live-agent comparisons.

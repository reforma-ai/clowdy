# Check: Outgoing merge preflight and destination checkout

- Result: passed
- Date: 2026-11-24
- Task: CLO-79
- State checked: combined daemon, protocol, and renderer changes in `clowdy/dev` over `337402b`

## What was run

| Command or user action | Result |
| --- | --- |
| From `apps/daemon`, `bun test test/git-merge.test.ts` | 10 passed using real Git repositories and HTTP calls |
| From `apps/desktop`, `bun run test src/renderer/features/changes src/renderer/daemon/branchesTransport.test.ts` | 457 passed |
| `bun run typecheck` in desktop and protocol, scoped Biome, and `git diff --check` | Exit 0 |
| Isolated Vite renderer build and Electron fixture | Conflict and missing checkout disable Merge into with a reason. Merge from keeps conflicts in the current checkout after Done. A clean outgoing merge completes and offers Push |
| `bun run typecheck` in daemon, before and after | Exit 1 in both. All eight diagnostics match, in ACP, filesystem, and terminal files outside this change |

## Evidence

The Git tests verify unchanged files and checkout lists after refusal, rejection of stale tips, rollback when a custom merge strategy disagrees with the preflight, and cleanup of an older temporary checkout only after an explicit matching abort.

## Known limits

The real Git tests use Git 2.49. The Electron check uses fixtures on macOS. A daemon typecheck baseline failure remains.

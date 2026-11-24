# Check: Merge between branches

- Result: passed
- Date: 2026-11-24
- Tasks: CLO-50, CLO-51, CLO-52
- State checked: the branch merge changes in an isolated copy of the `clowdy/dev` worktree

| Check | Result |
| --- | --- |
| Daemon `bun run test test/git-{merge,branches,remote,state,switch}.test.ts` | 133 passed |
| Desktop `bun run test src/renderer/features/changes src/renderer/daemon/branchesTransport.test.ts` | 451 passed |
| Protocol `bun run test` | 82 passed |
| Renderer Vite build, daemon bundle, desktop and protocol typecheck, Biome and diff check | Exit 0 |
| Electron with an isolated daemon and a local bare origin | Merging `origin/main` into `next` fetched the latest ref automatically. Merging `feature/xyz` into `next` left the source checkout on its original commit and updated the checked-out `next`. The bare origin moved only after pressing **Push next**. |
| A conflicting merge into `next` | The dialog showed the affected checkout. **Open next** forwarded that path to the configured editor through a test adapter. **Abort merge** cleared the conflict in `next` and left its previous commit intact. |

The real Git tests also covered fast-forward, a destination without a checkout, stale previews, dirty and active checkouts, ignored files, and repository settings that request a squash or stop before committing. Retrying the same conflicted merge recovered its checkout for inspection and abort.

Daemon typecheck reported the same eight diagnostics as the isolated baseline. The comparison of complete outputs returned exit 0. The Electron flow ran on macOS with temporary repositories and no real network remote.

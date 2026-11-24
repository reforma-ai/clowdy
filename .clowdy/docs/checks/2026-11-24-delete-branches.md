# Branch deletion

- Result: passed
- Date: 2026-11-24
- Tasks: CLO-159, CLO-160, CLO-161

| Check | Result |
| --- | --- |
| Electron with isolated real daemon and temporary bare origin | Deleted an unused local branch while retaining its origin ref. Deleted the current branch both locally and on origin after switching to main. Removed the remaining remote-only branch. All three Git ref checks passed |
| Electron fixtures | Right-click opens the branch menu. The confirmation checkbox starts off. Cancel keeps the branch. The default branch action is disabled |
| Desktop Changes and branch transport tests | 471 passed |
| Daemon branch deletion, switch and listing tests | 68 passed, including stale tips, origin lease failure, partial success, current and held branches, unmerged acknowledgment and saved worktree base |
| Protocol tests | 84 passed |
| Desktop, daemon and protocol type checks, scoped Biome, isolated Vite build | Passed |

The real daemon and renderer used an isolated checkout, temporary repositories and a separate application profile. No production Git refs were used. Git's native local branch deletion still has a small race with direct Git writes outside the daemon lock; origin deletion uses a lease for the exact confirmed tip.

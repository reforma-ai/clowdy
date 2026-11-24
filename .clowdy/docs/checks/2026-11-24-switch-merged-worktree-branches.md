# Check: Switch branches in a merged chat worktree

- Result: passed
- Date: 2026-11-24
- Tasks: CLO-34, CLO-35, CLO-36
- State checked: the daemon, protocol, and renderer together in the `clowdy/dev` worktree

| Check | Result |
| --- | --- |
| Daemon tests for branch switching, branch listing, starting a chat on a branch, and worktree removal | 104 passed |
| Desktop Changes, branch transport, project transport, and chat branch choice tests | 570 passed |
| Protocol tests | 82 passed |
| Renderer build, daemon bundle, desktop and protocol type checks, and Biome on changed source | Exit 0 |
| Electron with an isolated daemon and a real repository | The picker showed the main branch as held. Switching the chat worktree opened the target branch and its files. Git confirmed the main checkout and original branch ref kept their commits. |
| Electron fixtures | A clean merged worktree switched. An unmerged one kept its branch and displayed the refusal. |

Real Git tests also covered an uncommitted file, an ignored file tracked by the target, and two worktrees trying to switch to the same available branch. In the concurrent case one switch completed and the other received the held-branch response.

Daemon typecheck reports the same eight unrelated diagnostics as the unchanged checkout. Its baseline and updated output matched. The Electron check ran on macOS and used local repositories only.

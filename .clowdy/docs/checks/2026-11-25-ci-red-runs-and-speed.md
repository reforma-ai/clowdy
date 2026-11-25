# CI: red runs and run time

- Result: passed with limits
- Date: 2026-11-25
- Tasks: CLO-171, CLO-172, CLO-173, CLO-174

| Check | Result |
| --- | --- |
| The gate of commit dbb009f6 in four Linux containers at once (Ubuntu 26.04, git 2.56.1, bun 1.4.4, Node 24.22.3, two CPUs each, fresh `bun install --frozen-lockfile`, no ripgrep), two passes in a row | Both passes green. Check job (build, typecheck, lint, lint:root, scripts typecheck) 43 s. Daemon tests 2506 passed in 349-360 s. Desktop tests 4818 passed, 1 skipped, in 280-295 s. The other packages 7 tasks in 62-64 s |
| Gate time read from those runs | About 6 minutes, set by the daemon job, against 11-16 minutes in CI before. The host has 12 CPUs shared by the four containers, so a GitHub runner may be slower |
| The five desktop and file-manager tests that failed in CI | Pass on the machine and in the container, also under CPU load. MainBranchChoice was a stale label, the date format depended on the ICU version, the other three waited a fixed time for a timer |
| Daemon: probe, login and crashed-run errors | Lost "The agent wrote: ..." when the process ended before its stderr was read. Fixed in `stderrOf`; the other tests in the old red runs already passed on HEAD |
| Independent read of dbb009f6 and bc612fbf by a separate thread | No blocking defects. One same-class gap (CLO-175) and a test that has no power on macOS |
| Workflow files | `lint:root`, scripts typecheck and the workflow parse pass. The turbo filters cover all 11 test tasks |

Not run on GitHub: the four gate jobs and `ci-ok` as workflows, and the shell release with `windows-test` beside `windows`. That needs a push, which the owner does. CLO-174 and CLO-171 stay in Review until a real run shows the timings. The role of CI (report, not gate) was not changed.

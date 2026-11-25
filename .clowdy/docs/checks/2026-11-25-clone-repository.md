# Check: cloning a repository into a project from the app

- Result: passed with limits
- Date: 2026-11-25
- Tasks: CLO-176, CLO-190, CLO-191
- State checked: the combined result of the daemon commit `a3c73716` and the window commit `b2f9424b` on `clowdy/dev`, run in the screenshot harness against a real daemon (temp data folder, fake engine, local bare repositories, no network).

## What was run
| Step | Command or user action | Result |
| --- | --- | --- |
| 1 | `bun test` in `apps/daemon` | 2552 pass, 8 skip, 0 fail; typecheck clean |
| 2 | `bunx vitest run src/renderer/shell src/renderer/features/settings src/renderer/daemon` in `apps/desktop`, `bun run typecheck`, `biome check` on the touched folders | 781 pass, 1 fail (`attachmentsTransport.test.ts`, `Blob.type`, a file neither commit touches); typecheck and lint clean |
| 3 | Settings > Projects > Add project… > Clone repository…, address `/tmp/.../origin.git`, folder an existing empty `work`, Clone, then Add project | the dialog said "The folder is empty or new, so the repository will be the folder itself"; `work` holds `.git`, `f1..f3.txt` and `git log` shows 3 commits, no `work/work`; the form listed `/private/tmp/.../work`; the project `work` was created with that folder |
| 4 | Same project's page in Settings > Clone repository…, address `file:///tmp/.../origin.git`, no folder | the dialog said "A folder named origin will be made in the projects folder" with the full path; the folder `projects/origin` has the repository; the project's folders list gained it at once |
| 5 | Probe: the target already exists and is not empty | the dialog showed "…/projects/origin already exists and is not an empty folder", Clone disabled |
| 6 | Probe: a chosen folder that holds a file | "The folder has files, so a folder named origin will be made inside it", path `full/origin`, Clone enabled |
| 7 | Probe: address of a repository that does not exist | the dialog stayed open with `fatal: repository '/tmp/.../nope.git' does not exist`, and the target folder was not left behind |
| 8 | Probe: a 350 MB repository, Cancel while it runs | progress "Compressing objects 100%" shown, then the dialog was editable again; the folder did not exist, no `git clone` process left |
| 9 | Probe: the same repository, Escape while it runs | the clone dialog closed, the Add project form stayed open, no folder left |

## Evidence
- Real-daemon answers: `GET /v1/git/clone-target?url=…` gave `{"folder":".../projects","path":".../projects/origin"}`, and with `folder=.../work` (empty) `{"folder":".../work","path":".../work"}`.
- The daemon's own run (in its report): about 14 progress events for a `file://` clone, 409 for a non-empty target, 400 for `-`-leading, `ext::`, relative and blank addresses, no credential in any event or log.

## Known limits
- Not run: a real ssh host-key prompt or an https repository that asks for a password (the clone has no terminal, so it fails with git's message), a real GitHub repository over the network, Windows paths (unit logic only), the system folder dialog (the harness has no preload, so the folder is typed in the plain-browser field).
- Choose folder… in the app takes the first folder the system dialog returns.
- Pressing Cancel and then Clone to the same path in the same instant can meet the daemon's "already being cloned into" refusal until git has exited; a second press works.
- A clone that ends during the window's close animation still adds the folder.

## Verdict
Cloning from the app works for a new project and an existing one, and the dialog shows the real target folder, so `clowdy/clowdy` no longer happens by surprise.

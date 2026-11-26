# Clone a repository into a project: settled decisions

- Status: accepted
- Date: 2026-11-25
- Decided by: user (semi-manual)
- Scope: Getting a folder from a git address when the folder is not on the disk yet, for a new project and for an existing one. Does not cover forking on GitHub, choosing a branch, or any change to Settings > Projects beyond the new action.
- Related tasks: CLO-176, CLO-190, CLO-191
- Supersedes: none
- Superseded by: none

## Context
The person wants to start a project from a repository they only have an address for, or add such a repository to a project. Today the Add project form and a project's page in Settings take only folders that already exist (`FolderList`, whose "Add folders…" opens the system dialog); nothing in the app or the daemon clones. The daemon already runs the person's own `git` for writes with no password prompt (`git/remote.ts`, `git/writeEnv.ts`) and makes the folder of a folderless project under `projectsDir` (`domain/projects.ts`).

## Decisions
1. **Clone only, no fork on GitHub.** Options were: clone by link / clone with an optional fork checkbox / always fork first. Chosen by the user: clone by link. Reason: it solves "the folder does not exist yet" without publishing a repository under their account; `origin` stays the address they gave.
2. **The action lives in the shared folder list, as "Clone repository…" beside "Add folders…".** Both the Add project form and a project's page use that list, so one new action covers a new project and an existing one. The project switcher gets nothing new (the user removed Add project from it earlier today).
3. **A small dialog takes the address and shows where the repository will go.** The destination is the daemon's projects folder (the one a folderless project uses) with a way to choose another; "Clone" shows progress and can be cancelled.
4. **A cloned folder is added like any folder the person picked.** On a project's page it is added to the project at once; in the Add project form it joins the list and becomes part of the project when "Add project" is pressed. Cancelling the form after a clone leaves the cloned folder on the disk.
5. **"Into the folder I chose" or "inside it" is never a guess: the dialog always shows the full folder the repository will land in.** Said by the user: they often make a folder `clowdy` and clone into it, and end up with `clowdy/clowdy`. Design delegated to the agent. A folder the person chooses that is empty (or does not exist yet) becomes the repository itself; one that already holds files gets the repository in a new folder named after it inside. The path updates as the address and the folder change, and says which of the two it is.
6. **It uses the person's own git setup.** SSH keys and credential helpers work; there is no password prompt, so a repository that needs one fails with git's own message.

## Decided by the agent
- Any address `git clone` accepts is taken (https, ssh, `user@host:path`); the `owner/repo` shorthand is not, since it needs a host guess.
- An existing target that is not an empty folder is refused with a message; a failed or cancelled clone leaves no half-made folder behind.
- The folder is named after the repository (`repo` of `…/repo.git`); no submodules are fetched, no shallow clone, the default branch is checked out.
- The contract is `GET /v1/git/clone-target` (where it would go, so the window can show it) and `POST /v1/git/clone` as an SSE stream like `git/sync`, with git's progress and cancel by closing the request (`GitCloneTarget`, `GitCloneRequest`, `GitCloneEvent` in `packages/protocol/src/git.ts`).
- The clone is a long daemon request with a cancel, not a synchronous command, since commands are meant to be quick.

## Consequences
A repository that is private over HTTPS with only a password prompt cannot be cloned here until credentials are set up outside the app. Reopen decision 1 if the person later wants a fork: the dialog would gain the option, not a new flow.

## Assumptions
- `git` is on the person's path and is the same one the daemon already uses for fetch and push (checked in `git/remote.ts`, not run for clone).

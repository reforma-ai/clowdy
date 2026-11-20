# Working on Clowdy's own repository

Load this when the project is the repository Clowdy itself runs from. Signs: the folder contains `apps/daemon`, `apps/desktop` and `packages/system-skills`, or AGENTS.md or the docs say the running app is built from this checkout. For any other project this file does not apply.

The reason: the manager is using the running app while you change its source. Replacing files of the running build can kill the app, and a change that breaks the build leaves the manager with nothing.

## Rules

1. **Never replace files of the running build.** Do not edit, rebuild in place or delete the daemon and app sources the running instance uses, its build output, or its data directory. Do not stop, restart or kill the running app or daemon.
2. **Work in a copy** outside the running checkout (a plain-git worktree or a clone), install dependencies there, and edit and run commands only by paths inside it. Every sub-agent of this cycle gets the copy's absolute path in its prompt, and every thread is started in the copy (`--cwd <copy>`).
3. **Build a candidate from the copy** with the project's build command (see AGENTS.md; the output must land inside the copy). Name it by the copy's folder and short commit.
4. **Verify the candidate**, not the running app. If you start it, give it its own scratch data directory and port: two daemons must never share one database, and a candidate must never touch the manager's live data.
5. **Do not merge into the running checkout** unless the manager asks. Leave the work in the copy and say so.
6. **Say when stored data changes.** A migration or a changed schema means: back up first, and the old version may not read the new data.

Sub-agents and threads work as usual inside the copy: disjoint file ownership, the copy's path in each prompt and brief.

## Handing over

The manager switches, not you. Say it in plain words:

```text
Done: <what changed for users>
Checked: <what ran on the candidate> (evidence: checks/<file>)
Ready to try: <path of the copy>. Close the app and start it from there.
Careful: <stored data changes, anything that cannot be undone>, or "nothing"
```

## Example

Manager: "Make the Agents screen show how long each run has been going." Mode: autopilot.

1. This is Clowdy's own repo. Create the copy next to it, `/work/clowdy-run-timer`, with `git worktree add /work/clowdy-run-timer -b run-timer`; install there.
2. Plan: CLW-41 renderer change (Owns `apps/desktop/src/renderer/agents/**`), CLW-42 a daemon field if needed (Owns `apps/daemon/src/runs/**`).
3. Make both changes by absolute paths under `/work/clowdy-run-timer`; the checkout the app runs from stays untouched.
4. Build the candidate in the copy; exercise the screen against a scratch daemon and record what you saw.
5. Report: candidate at `/work/clowdy-run-timer`, no data changes; the manager closes the app and starts the candidate to try it.

import { resolve } from 'node:path';

import { gitAnswer, gitRead } from '../domain/git';
import { chatsWorkingIn } from '../domain/places';
import { exclusive } from '../domain/workspaces';
import { conflict, invalid, unavailable } from '../errors';
import { runProgram } from '../providers/exec';
import { failureLine, printedLines, shownLine, writeLine } from './commit';
import { baseOf, countChanges, isOnDisk, parseWorktrees, placeOf, workingTreeRoot } from './state';
import { parseStatus, resolveRef } from './status';
import { WriteEnvironment } from './writeEnv';

import type { GitErrorDetails, GitHead, GitSwitchResult, GitSwitchStart, Project } from '@clowdy/protocol';
import type { Place } from '../domain/places';
import type { Store } from '../store';
import type { GitWritesOptions } from './commit';

/**
 * A switch checks files out, and a `post-checkout` hook of the person's may build or install after it, so it gets about two minutes like a commit does; past it git is asked to stop
 * (`SIGTERM`, so it removes its lock files itself) and the switch is `unavailable`.
 */
const SWITCH_TIMEOUT_MS = 120_000;

/** The most of what git and its hooks print that is kept: only one line of it is ever shown. */
const MAX_PRINTED_CHARS = 256 * 1024;

/** A branch name longer than this is no branch: git's own limit is a path component of 255 bytes, and a name this long is not typed. */
const MAX_BRANCH_CHARS = 250;

/** The only remote a branch is made from: it is the only one the app moves commits to and from. */
const ORIGIN = 'origin';

/** What each of these files of git's own says is under way, and what the person is told to do about it. */
const UNDER_WAY: Array<{ file: string; name: string }> = [
    { file: 'MERGE_HEAD', name: 'A merge' },
    { file: 'rebase-merge', name: 'A rebase' },
    { file: 'rebase-apply', name: 'A rebase' },
    { file: 'CHERRY_PICK_HEAD', name: 'A cherry-pick' },
    { file: 'REVERT_HEAD', name: 'A revert' },
    { file: 'BISECT_LOG', name: 'A bisect' },
];

/** What a switch is going to run, once the request is judged against the repository: the arguments of `git`, the branch that has to be checked out when it is done, and whether the branch is new. */
interface Plan {
    args: string[];
    branch: string;
    created: boolean;
}

/**
 * Changes the branch a folder's own checkout is on (`POST /v1/projects/:id/git/switch`): the one write that moves files the person and their agents are working with, so it is
 * refused rather than negotiated, and nothing is stashed, carried along or forced. The person's own `git switch` runs in the place with their configuration and the write environment
 * (`WriteEnvironment`), on the place's one line of writes (`writeLine`, shared with the commit and the moves to and from `origin`), no shell, argv only:
 *
 * - an existing local branch is `git switch --no-guess -- <branch>` (never the form that guesses a remote branch from the name);
 * - a branch that only `origin` has is `git switch --track -c <name> refs/remotes/origin/<name>`, a local branch of the same name that tracks it;
 * - a new branch is `git switch --no-track -c <name> <commit>`, cut from HEAD or from the folder's default branch (the base a new worktree starts from, `resolveRef`); `--no-track`
 *   because a branch made from `origin/main` would otherwise track it, and a push of it would go to `main`.
 *
 * It is the folder's own checkout only: **a chat's worktree keeps its branch** (`invalid`). Everything below is refused with a reason and nothing changed, judged on the place's line
 * and right before git runs, since the tree may have changed while the switch waited its turn: a name that is no branch name (a leading dash can never reach git, and `@{-1}` is no
 * name), a branch that does not exist, a new branch that exists already (locally, or on `origin`), a repository with no commit, a branch that another worktree has checked out
 * (`Checked out in <path>`), a run working in the place (`2 chats are working here`: `chatsWorkingIn`), a merge, rebase, cherry-pick, revert or bisect under way, and a tree with any
 * change, tracked, staged or untracked (`Commit or discard the changes first`, with how many files). Switching to the branch that is checked out is the answer it already is.
 *
 * A hook (`post-checkout`) runs as the person's git runs it. git's exit status for the switch is the hook's, though the branch has changed: when HEAD is on the branch after a failed
 * run, the switch is answered as made with the hook's line as `warning`; when it is not, the failure is git's first `fatal:` or `error:` line, as `conflict`. Nothing here can be told to
 * skip a hook.
 */
export class GitSwitch {
    readonly environment: WriteEnvironment;
    readonly #store: Store;
    readonly #timeoutMs: number;
    readonly #stopper = new AbortController();

    constructor({ store, environment = new WriteEnvironment(), timeoutMs = SWITCH_TIMEOUT_MS }: GitWritesOptions) {
        this.#store = store;
        this.environment = environment;
        this.#timeoutMs = timeoutMs;
    }

    /** Ends the git that is running, and refuses new switches. */
    stop(): void {
        this.#stopper.abort();
    }

    /**
     * The switch of a request: `request.create.start` is whatever the client sent, and judged here (`startOf`), so a body that says another word is `invalid` and not a crash.
     */
    async switch(project: Project, place: Place, request: { branch: string; create?: { start: string } }): Promise<GitSwitchResult> {
        if (place.workspace) throw invalid('A chat\'s worktree keeps its branch');

        const start = request.create === undefined ? undefined : startOf(request.create);
        const name = await this.#nameOf(place, request.branch);

        // Judged and run on one line, so what a commit or a push in front of it leaves is what it finds.
        return exclusive(this.#store, writeLine(place), this.#stopper.signal, async () => {
            const cwd = place.path;

            if (!await workingTreeRoot(cwd)) throw invalid('The folder is not the root of a git repository');

            const head = await gitAnswer(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD']);

            if (head === undefined) throw invalid('The repository has no commits yet');

            const plan = await this.#plan(place, name, start, head);

            if (plan === undefined) return await this.#where(cwd);

            // Right before git runs, not before the line was taken: a commit in front of this one may have made the tree clean, or an agent may have written to it.
            await this.#refuseWhileUnsettled(project, place);

            return await this.#run(place, plan);
        });
    }

    /** The branch name the request means, or why it is none: git's own rules (`check-ref-format --branch`) after the ones that keep a name away from an option or an expression. */
    async #nameOf(place: Place, branch: unknown): Promise<string> {
        if (typeof branch !== 'string' || branch.trim() === '') throw invalid('Name the branch');

        if (branch.startsWith('-')) throw invalid('A branch name cannot start with a dash');

        if (branch.length > MAX_BRANCH_CHARS) throw invalid(`A branch name is at most ${ MAX_BRANCH_CHARS } characters`);

        // A line break or a NUL can be in no name, and a NUL cannot be in an argument of a program at all.
        if (CONTROL.test(branch)) throw invalid(`${ printable(branch) } is not a branch name`);

        // `@` alone is a name `check-ref-format` allows and no branch can have; `@{-1}` is the branch before this one, which `--branch` expands: it is no name, so what it prints must be what it was given.
        const checked = branch === '@' ? undefined : await gitRead(place.path, ['check-ref-format', '--branch', branch]);

        if (checked !== undefined && !checked.ok && checked.reason === 'unavailable') throw unavailable('git did not answer');

        if (checked === undefined || !checked.ok || checked.stdout.trim() !== branch) throw invalid(`${ printable(branch) } is not a branch name`);

        return branch;
    }

    /**
     * What to run for the request, judged against the repository now: `undefined` when the place is on the branch already. A new branch is refused where its name is taken, an existing one where
     * it is not there, or where another worktree has it (git would say so too; this says where).
     */
    async #plan(place: Place, name: string, start: GitSwitchStart | undefined, head: string): Promise<Plan | undefined> {
        const cwd = place.path;
        const [local, remote, current] = await Promise.all([refExists(cwd, `refs/heads/${ name }`), refExists(cwd, `refs/remotes/${ ORIGIN }/${ name }`), gitAnswer(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'])]);

        if (start !== undefined) {
            if (local) throw invalid(`A branch called ${ name } exists already`);

            if (remote) throw invalid(`${ ORIGIN } has a branch called ${ name } already`);

            return { args: ['switch', '--no-track', '-c', name, await startCommit(place, start, head)], branch: name, created: true };
        }

        if (local) {
            if (current === name) return undefined;

            const holder = await heldBy(cwd, name);

            if (holder !== undefined) throw conflict(`Checked out in ${ holder }`);

            return { args: ['switch', '--no-guess', '--', name], branch: name, created: false };
        }

        if (remote) return { args: ['switch', '--track', '-c', name, `refs/remotes/${ ORIGIN }/${ name }`], branch: name, created: true };

        throw invalid(`There is no branch called ${ name }`);
    }

    /** Why the place is no place to switch in right now, the first that holds: a run working in it, an operation under way, a change in the tree. Throws it; returns when none holds. */
    async #refuseWhileUnsettled(project: Project, place: Place): Promise<void> {
        const cwd = place.path;
        const working = chatsWorkingIn(this.#store, project, cwd);

        if (working > 0) throw conflict(`${ working } ${ working === 1 ? 'chat is' : 'chats are' } working here`, { hint: 'Stop them or wait until they finish' } satisfies GitErrorDetails);

        const underWay = await operationUnderWay(cwd);

        if (underWay !== undefined) throw conflict(`${ underWay } is in progress`, { hint: 'Finish or abort it first' } satisfies GitErrorDetails);

        const changes = await countChanges(cwd);

        if (changes === undefined) throw unavailable('git did not answer');

        if (changes > 0) throw conflict('Commit or discard the changes first', { hint: `${ changes } ${ changes === 1 ? 'file' : 'files' } changed` } satisfies GitErrorDetails);
    }

    /** Runs the switch and tells where HEAD is after it. */
    async #run(place: Place, plan: Plan): Promise<GitSwitchResult> {
        const cwd = place.path;
        const env = await this.environment.of(cwd);
        const run = await runProgram('git', plan.args, { env, cwd, timeoutMs: this.#timeoutMs, maxChars: MAX_PRINTED_CHARS, signal: this.#stopper.signal, stopSignal: 'SIGTERM' });

        if (run.error === 'stopped') throw unavailable('The daemon is stopping');

        if (run.timedOut) throw unavailable('The switch did not finish in time');

        if (run.error !== undefined) throw unavailable('git is not installed or not on PATH');

        const created = plan.created ? { created: true as const } : {};

        if (run.code === 0) return { ...await this.#where(cwd), ...created };

        // The exit status of the switch is the `post-checkout` hook's: the branch has changed all the same, which HEAD shows.
        if (await gitAnswer(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']) === plan.branch) return { ...await this.#where(cwd), ...created, warning: hookLine(run.stderr, run.stdout) };

        throw conflict(failureLine(run.stderr, run.stdout));
    }

    /** Where HEAD is now, and the upstream of the branch it is on. */
    async #where(cwd: string): Promise<GitSwitchResult> {
        const read = await gitRead(cwd, ['status', '--porcelain=v2', '--branch', '--untracked-files=no', '-z'], { parsed: true });

        if (!read.ok) throw unavailable('git did not say where HEAD is');

        const { commit, branch, upstream } = parseStatus(read.stdout.split('\0'));
        const head: GitHead = branch === undefined ? { kind: 'detached', commit: commit ?? '' } : commit === undefined ? { kind: 'unborn', name: branch } : { kind: 'branch', name: branch, commit };

        return { head, ...(upstream && { upstream }) };
    }
}

/** A control character: none is in a branch name. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1F\x7F]/;

/** A name as it is shown in a message: what a person typed may hold a control character (a line break), which would break the line. */
// eslint-disable-next-line no-control-regex
const printable = (text: string): string => text.replace(/[\x00-\x1F\x7F]/g, ' ').trim();

/** What git itself says on a switch that worked, which is not what a hook that failed after it said. */
const GIT_SAYS = /^(?:Switched to |Already on |Your branch |branch '.*' set up to track|Note: |HEAD is now |Previous HEAD|Updating files|Warning: you are leaving )/;

/** The line of a hook that failed after a switch: the first thing printed that is not git's own report of it; a hook that said nothing is still named. */
function hookLine(stderr: string, stdout: string): string {
    const said = [...printedLines(stderr), ...printedLines(stdout)].find(line => !GIT_SAYS.test(line));

    return said === undefined ? 'The post-checkout hook failed' : shownLine(said);
}

/** Where a new branch starts, as the request says it, or why it is none. */
function startOf(create: unknown): GitSwitchStart {
    const start = (create as { start?: unknown } | null)?.start;

    if (start !== 'current' && start !== 'default') throw invalid('A new branch starts from the current branch or from the default branch');

    return start;
}

/** The commit a new branch is cut from: HEAD's, or the folder's default branch's, picked as the base of a comparison is (`resolveRef`). */
async function startCommit(place: Place, start: GitSwitchStart, head: string): Promise<string> {
    if (start === 'current') return head;

    // The folder's own base reads the repository's branches, which a worktree shares with its folder: the place's path is read, so a folder that moved does not matter.
    const base = await baseOf({ ...place.folder, path: place.path });
    const resolved = base === undefined ? undefined : await resolveRef(place.path, base);

    if (!resolved) throw invalid('The repository has no default branch to start from');

    return resolved.commit;
}

/** Whether the repository has a ref. A git that cannot be asked is `unavailable`, never "no". */
async function refExists(cwd: string, ref: string): Promise<boolean> {
    const read = await gitRead(cwd, ['show-ref', '--verify', '--quiet', ref]);

    if (!read.ok && read.reason === 'unavailable') throw unavailable('git did not answer');

    return read.ok;
}

/** The place of the worktree that has `branch` checked out, when it is not `cwd`'s own. */
async function heldBy(cwd: string, branch: string): Promise<string | undefined> {
    const read = await gitRead(cwd, ['worktree', 'list', '--porcelain']);

    if (!read.ok) {
        if (read.reason === 'unavailable') throw unavailable('git did not answer');

        return undefined;
    }

    const own = await placeOf(cwd);

    for (const entry of parseWorktrees(read.stdout)) {
        if (entry.branch === branch && await placeOf(entry.path) !== own) return resolve(entry.path);
    }

    return undefined;
}

/** What the repository has under way that a switch would leave half done: a merge, a rebase, a cherry-pick, a revert or a bisect (`A merge`, `A rebase`, ...). Nothing when none. */
async function operationUnderWay(cwd: string): Promise<string | undefined> {
    const paths = await gitRead(cwd, ['rev-parse', ...UNDER_WAY.flatMap(({ file }) => ['--git-path', file])]);

    if (!paths.ok) throw unavailable('git did not answer');

    const lines = paths.stdout.split('\n');

    for (const [index, { name }] of UNDER_WAY.entries()) {
        // `--git-path` is relative to where git runs (the working tree's own `.git`, or the linked worktree's git directory).
        if (lines[index] && await isOnDisk(resolve(cwd, lines[index]))) return name;
    }

    return undefined;
}

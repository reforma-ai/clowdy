import { resolve } from 'node:path';

import { listWorkspacesOfProject } from '../db/workspaces';
import { gitAnswer, gitRead } from '../domain/git';
import { chatsWorkingIn } from '../domain/places';
import { exclusive, pathKey } from '../domain/workspaces';
import { CommandError, conflict, errorMessage, invalid, unavailable } from '../errors';
import { LEFTOVER_GRACE_MS, runProgram } from '../providers/exec';
import { failureLine, printedLines, shownLine, writeLine } from './commit';
import {
    baseOf,
    commitOf,
    countChanges,
    defaultBranchOf,
    isMerged,
    isOnDisk,
    parseWorktrees,
    placeOf,
    workingTreeRoot,
} from './state';
import { parseStatus, resolveRef } from './status';
import { WriteEnvironment } from './writeEnv';

import type {
    GitBranchDeletePreview,
    GitBranchDeleteRequest,
    GitBranchDeleteResult,
    GitErrorDetails,
    GitHead,
    GitSwitchResult,
    GitSwitchStart,
    Project,
} from '@clowdy/protocol';
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

/**
 * What a switch is going to run, once the request is judged against the repository: the arguments of `git`, the branch that has to be checked out when it is done, whether the branch is
 * new, and, for a switch away from a detached HEAD, the commit it was at (what the switch may leave on no branch).
 */
interface Plan {
    args: string[];
    branch: string;
    created: boolean;
    leaving?: string;
}

/**
 * Changes the branch checked out in a place (`POST /v1/projects/:id/git/switch`): this moves files the person and their agents are working with, so it is
 * refused rather than negotiated, and nothing is stashed, carried along or forced. The person's own `git switch` runs in the place with their configuration and the write environment
 * (`WriteEnvironment`), on the place's one line of writes (`writeLine`, shared with the commit and the moves to and from `origin`), no shell, argv only:
 *
 * - an existing local branch is `git switch --no-guess -- <branch>` (never the form that guesses a remote branch from the name);
 * - a branch that only `origin` has is `git switch --track -c <name> refs/remotes/origin/<name>`, a local branch of the same name that tracks it;
 * - a new branch is `git switch --no-track -c <name> <commit>`, cut from HEAD or from the folder's default branch (the base a new worktree starts from, `resolveRef`); `--no-track`
 *   because a branch made from `origin/main` would otherwise track it, and a push of it would go to `main`.
 *
 * A worktree can leave its current branch only when its HEAD is contained in its base, and it keeps ignored files (`--no-overwrite-ignore`).
 * The other refusals are judged on the place's line
 * and right before git runs, since the tree may have changed while the switch waited its turn: a name that is no branch name (a leading dash can never reach git, and `@{-1}` is no
 * name), a branch that does not exist, a new branch that exists already (locally, or on `origin`), a repository with no commit, a branch that another worktree has checked out
 * (`Checked out in <path>`), a run working in the place (`2 chats are working here`: `chatsWorkingIn`), a merge, rebase, cherry-pick, revert or bisect under way, and a tree with any
 * change, tracked, staged or untracked (`Commit or discard the changes first`, with how many files). Switching to the branch that is checked out is the answer it already is.
 *
 * A hook (`post-checkout`) runs as the person's git runs it. git's exit status for the switch is the hook's, though the branch has changed: when HEAD is on the branch after a failed
 * run, or after one that was cut off at the limit, the switch is answered as made with the hook's line as `warning`; when it is not, the failure is git's first `fatal:` or `error:` line,
 * as `conflict` (`unavailable` for the limit). Nothing here can be told to skip a hook. A switch away from a detached HEAD whose commits no ref reaches any more says so as a `warning` too.
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
    async switch(
        project: Project,
        place: Place,
        request: { branch: string; create?: { start: string } }
    ): Promise<GitSwitchResult> {
        const start = request.create === undefined ? undefined : startOf(request.create);
        const name = await this.#nameOf(place, request.branch);

        // Keep the checkout's write order, and serialize switches of shared branches across its worktrees.
        return exclusive(this.#store, writeLine(place), this.#stopper.signal, async () => {
            const cwd = place.path;

            if (!(await workingTreeRoot(cwd))) throw invalid('The folder is not the root of a git repository');

            const repo = await switchRepositoryKey(cwd);

            return exclusive(this.#store, repo, this.#stopper.signal, () =>
                this.#switchLocked(project, place, name, start)
            );
        });
    }

    /** Create a branch without changing any checkout. */
    async createBranch(place: Place, branch: string, create: { start: string }): Promise<GitSwitchResult> {
        const start = startOf(create);
        const name = await this.#nameOf(place, branch);
        return exclusive(this.#store, writeLine(place), this.#stopper.signal, async () => {
            const cwd = place.path;
            if (!(await workingTreeRoot(cwd))) throw invalid('The folder is not the root of a git repository');
            const repo = await switchRepositoryKey(cwd);
            return exclusive(this.#store, repo, this.#stopper.signal, async () => {
                const head = await gitAnswer(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD']);
                if (!head) throw invalid('The repository has no commits yet');
                if (await refExists(cwd, `refs/heads/${name}`)) throw invalid(`A branch called ${name} exists already`);
                if (await refExists(cwd, `refs/remotes/${ORIGIN}/${name}`))
                    throw invalid(`${ORIGIN} has a branch called ${name} already`);
                const commit = await startCommit(place, start, head);
                const env = await this.environment.of(cwd);
                const run = await runProgram('git', ['branch', '--no-track', '--', name, commit], {
                    env,
                    cwd,
                    timeoutMs: this.#timeoutMs,
                    maxChars: MAX_PRINTED_CHARS,
                    signal: this.#stopper.signal,
                    stopSignal: 'SIGTERM',
                    leftoverGraceMs: LEFTOVER_GRACE_MS,
                });
                if (run.error === 'stopped') throw unavailable('The daemon is stopping');
                if (run.timedOut) throw unavailable('Creating the branch did not finish in time');
                if (run.error !== undefined) throw unavailable('git is not installed or not on PATH');
                if (run.code !== 0) throw conflict(failureLine(run.stderr, run.stdout));
                return { ...(await this.#where(cwd)), created: true };
            });
        });
    }

    /** Preview or delete the named branch on the same write lines as a switch, including any switch needed to leave it. */
    async deleteBranch(
        project: Project,
        place: Place,
        request: GitBranchDeleteRequest
    ): Promise<GitBranchDeleteResult> {
        const name = await this.#nameOf(place, request.branch);

        if (request.action === 'delete' && request.localCommit === undefined && request.originCommit === undefined)
            throw invalid('Select a branch to delete');

        return exclusive(this.#store, writeLine(place), this.#stopper.signal, async () => {
            const cwd = place.path;
            if (!(await workingTreeRoot(cwd))) throw invalid('The folder is not the root of a git repository');

            const repo = await switchRepositoryKey(cwd);
            return exclusive(this.#store, repo, this.#stopper.signal, () =>
                request.action === 'preview'
                    ? this.#deletionPreview(project, place, name, request.remote === true)
                    : this.#deleteLocked(project, place, name, request)
            );
        });
    }

    async #deletionPreview(
        project: Project,
        place: Place,
        branch: string,
        remoteOnly: boolean
    ): Promise<GitBranchDeletePreview> {
        const cwd = place.path;
        const folder = { ...place.folder, path: cwd };
        const [localCommit, originTip, origin, base, fallback, current, holder] = await Promise.all([
            branchTip(cwd, `refs/heads/${branch}`),
            branchTip(cwd, `refs/remotes/${ORIGIN}/${branch}`),
            gitRead(cwd, ['remote', 'get-url', ORIGIN]),
            baseOf(folder),
            defaultBranchOf(cwd),
            gitAnswer(cwd, ['symbolic-ref', '--quiet', 'HEAD']),
            heldBy(cwd, branch),
        ]);
        if (!origin.ok && origin.reason === 'unavailable') throw unavailable('git did not answer');
        const originCommit = origin.ok ? originTip : undefined;
        const preview: GitBranchDeletePreview = {
            state: 'preview',
            branch,
            ...(!remoteOnly && localCommit && { localCommit }),
            ...(originCommit && { originCommit }),
        };

        if (remoteOnly && localCommit) return { ...preview, blocked: 'A local branch of this name now exists' };
        if (remoteOnly ? !originCommit : !localCommit)
            return { ...preview, blocked: `${remoteOnly ? `${ORIGIN}/` : ''}${branch} no longer exists` };

        // Protect the repository default as well as configured bases, including the base recorded for a linked worktree.
        if (
            [base, fallback, place.folder.settings?.baseBranch, place.workspace?.base].some(
                ref => ref === branch || ref === `${ORIGIN}/${branch}`
            )
        )
            return { ...preview, blocked: `${branch} is a base or default branch` };
        if (holder !== undefined) return { ...preview, blocked: `Checked out in ${holder}` };
        // A saved base is needed even before its chat's worktree exists, and after the chat merges for removal checks.
        const usedAsBase = listWorkspacesOfProject(this.#store.db, project.id).some(
            record =>
                record.folderId === place.folder.id && (record.base === branch || record.base === `${ORIGIN}/${branch}`)
        );
        if (usedAsBase) return { ...preview, blocked: `${branch} is the base of a chat worktree` };

        const comparisonName = place.workspace?.base ?? base;
        const comparison = comparisonName === undefined ? undefined : await resolveRef(cwd, comparisonName);
        if (preview.localCommit)
            preview.localUnmerged = !comparison || !(await isMerged(cwd, preview.localCommit, comparison.commit));
        if (originCommit)
            preview.originUnmerged = !comparison || !(await isMerged(cwd, originCommit, comparison.commit));

        if (localCommit && current === `refs/heads/${branch}`) {
            const destination = await branchOfBase(cwd, base ?? fallback);
            if (!destination) return { ...preview, blocked: 'The repository has no default branch to switch to' };

            try {
                await this.#plan(place, destination, undefined, localCommit);
                await this.#refuseWhileUnsettled(project, place);
                preview.switchTo = destination;
            } catch (error) {
                if (!(error instanceof CommandError)) throw error;

                return { ...preview, blocked: error.message };
            }
        }

        return preview;
    }

    async #deleteLocked(
        project: Project,
        place: Place,
        branch: string,
        request: Extract<GitBranchDeleteRequest, { action: 'delete' }>
    ): Promise<GitBranchDeleteResult> {
        const cwd = place.path;
        const env = await this.environment.of(cwd);
        const plan = await this.#deletionPreview(project, place, branch, request.localCommit === undefined);
        requireDeletion(plan, request, request.switchTo);

        let switchedTo: string | undefined;
        let warning: string | undefined;
        let localDeleted = false;

        try {
            if (plan.switchTo !== undefined && request.localCommit !== undefined) {
                const switched = await this.#switchLocked(project, place, plan.switchTo, undefined, {
                    branch,
                    commit: request.localCommit,
                });
                switchedTo = switched.head.kind === 'branch' ? switched.head.name : undefined;
                warning = switched.warning;
                if (switchedTo !== plan.switchTo) throw conflict(`The checkout did not switch to ${plan.switchTo}`);

                // The checkout hook may have changed refs, so the confirmed branch must still match after the switch.
                const after = await this.#deletionPreview(project, place, branch, false);
                requireDeletion(after, request, undefined);
            }

            if (request.localCommit !== undefined) {
                // Git's native branch deletion refuses branches that are checked out, including in other worktrees.
                // Check the confirmed tip immediately before it runs. The daemon's repository lock serializes its
                // own writes, but external git commands are not covered by that lock.
                await requireBranchTip(cwd, `refs/heads/${branch}`, request.localCommit);
                await this.#runDeletion(cwd, env, ['branch', '-D', '--', branch], `delete ${branch}`);
                localDeleted = true;
            }

            if (request.originCommit !== undefined) {
                await requireBranchTip(cwd, `refs/remotes/${ORIGIN}/${branch}`, request.originCommit);
                const ref = `refs/heads/${branch}`;
                await this.#runDeletion(
                    cwd,
                    env,
                    [
                        'push',
                        '--no-follow-tags',
                        '--no-recurse-submodules',
                        `--force-with-lease=${ref}:${request.originCommit}`,
                        ORIGIN,
                        `:${ref}`,
                    ],
                    `delete ${branch} on ${ORIGIN}`
                );
            }
        } catch (error) {
            if (localDeleted)
                throw conflict(
                    `Deleted ${branch} locally, but could not delete it on ${ORIGIN}: ${errorMessage(error)}`
                );
            if (switchedTo !== undefined)
                throw conflict(`Switched to ${switchedTo}, but could not delete ${branch}: ${errorMessage(error)}`);

            throw error;
        }

        return {
            state: 'done',
            localDeleted,
            originDeleted: request.originCommit !== undefined,
            ...(switchedTo && { switchedTo }),
            ...(warning && { warning }),
        };
    }

    async #runDeletion(cwd: string, env: Record<string, string>, args: string[], action: string): Promise<void> {
        const run = await runProgram('git', args, {
            env,
            cwd,
            timeoutMs: this.#timeoutMs,
            maxChars: MAX_PRINTED_CHARS,
            signal: this.#stopper.signal,
            stopSignal: 'SIGTERM',
        });

        if (run.error === 'stopped') throw unavailable('The daemon is stopping');
        if (run.timedOut) throw unavailable(`git did not finish in time to ${action}`);
        if (run.error !== undefined) throw unavailable('git is not installed or not on PATH');
        if (run.code !== 0) {
            const rejected = printedLines(run.stderr).find(line => /^!\s*\[rejected\]/i.test(line));
            throw conflict(
                rejected ? shownLine(rejected) : failureLine(run.stderr, run.stdout, `git could not ${action}`)
            );
        }
    }

    async #switchLocked(
        project: Project,
        place: Place,
        name: string,
        start: GitSwitchStart | undefined,
        leaving?: { branch: string; commit: string }
    ): Promise<GitSwitchResult> {
        const cwd = place.path;
        const head = await gitAnswer(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD']);

        if (head === undefined) throw invalid('The repository has no commits yet');

        const plan = await this.#plan(place, name, start, head, leaving !== undefined);

        if (plan === undefined) return await this.#where(cwd);

        // Prepare the environment first so the final safety checks happen just before git runs.
        const env = await this.environment.of(cwd);

        await this.#refuseWhileUnsettled(project, place, leaving);

        return await this.#run(cwd, plan, env);
    }

    /** The branch name the request means, or why it is none: git's own rules (`check-ref-format --branch`) after the ones that keep a name away from an option or an expression. */
    async #nameOf(place: Place, branch: unknown): Promise<string> {
        if (typeof branch !== 'string' || branch.trim() === '') throw invalid('Name the branch');

        if (branch.startsWith('-')) throw invalid('A branch name cannot start with a dash');

        if (branch.length > MAX_BRANCH_CHARS) throw invalid(`A branch name is at most ${MAX_BRANCH_CHARS} characters`);

        // A line break or a NUL can be in no name, and a NUL cannot be in an argument of a program at all.
        if (CONTROL.test(branch)) throw invalid(`${printable(branch)} is not a branch name`);

        // `@` alone is a name `check-ref-format` allows and no branch can have; `@{-1}` is the branch before this one, which `--branch` expands: it is no name, so what it prints must be what it was given.
        const checked =
            branch === '@' ? undefined : await gitRead(place.path, ['check-ref-format', '--branch', branch]);

        if (checked !== undefined && !checked.ok && checked.reason === 'unavailable')
            throw unavailable('git did not answer');

        if (checked === undefined || !checked.ok || checked.stdout.trim() !== branch)
            throw invalid(`${printable(branch)} is not a branch name`);

        return branch;
    }

    /**
     * What to run for the request, judged against the repository now: `undefined` when the place is on the branch already. A new branch is refused where its name is taken, an existing one where
     * it is not there, or where another worktree has it (git would say so too; this says where).
     */
    async #plan(
        place: Place,
        name: string,
        start: GitSwitchStart | undefined,
        head: string,
        protectIgnored = false
    ): Promise<Plan | undefined> {
        const cwd = place.path;
        const [local, remote, current] = await Promise.all([
            refExists(cwd, `refs/heads/${name}`),
            refExists(cwd, `refs/remotes/${ORIGIN}/${name}`),
            gitAnswer(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
        ]);
        const switchArgs = place.workspace || protectIgnored ? ['switch', '--no-overwrite-ignore'] : ['switch'];

        if (start !== undefined) {
            if (local) throw invalid(`A branch called ${name} exists already`);

            if (remote) throw invalid(`${ORIGIN} has a branch called ${name} already`);

            return {
                args: [...switchArgs, '--no-track', '-c', name, await startCommit(place, start, head)],
                branch: name,
                created: true,
                ...(current === undefined && { leaving: head }),
            };
        }

        if (local) {
            if (current === name) return undefined;

            const holder = await heldBy(cwd, name);

            if (holder !== undefined) throw conflict(`Checked out in ${holder}`);

            return {
                args: [...switchArgs, '--no-guess', '--', name],
                branch: name,
                created: false,
                ...(current === undefined && { leaving: head }),
            };
        }

        if (remote)
            return {
                args: [...switchArgs, '--track', '-c', name, `refs/remotes/${ORIGIN}/${name}`],
                branch: name,
                created: true,
                ...(current === undefined && { leaving: head }),
            };

        throw invalid(`There is no branch called ${name}`);
    }

    /**
     * Why the place cannot switch: an active run, a Git operation, uncommitted changes or an unmerged worktree.
     * The runs are read **last** (the reasons are still told in this order: a chat that is working is what leaves the tree changed, and is the better thing to say), since a message
     * that starts a run while git looks at the tree is the one thing nothing else holds back; nothing is awaited between this read and the start of git.
     */
    async #refuseWhileUnsettled(
        project: Project,
        place: Place,
        leaving?: { branch: string; commit: string }
    ): Promise<void> {
        const cwd = place.path;
        const worktreeBlock = place.workspace ? await worktreeSwitchBlock(place) : undefined;
        const underWay = await operationUnderWay(cwd);
        const changes = await countChanges(cwd);
        if (leaving !== undefined) {
            const current = await gitAnswer(cwd, ['symbolic-ref', '--quiet', 'HEAD']);
            if (current !== `refs/heads/${leaving.branch}`)
                throw conflict('The checkout changed since the preview, review it again');
            await requireBranchTip(cwd, current, leaving.commit);
        }
        const working = chatsWorkingIn(this.#store, project, cwd);

        if (working > 0)
            throw conflict(`${working} ${working === 1 ? 'chat is' : 'chats are'} working here`, {
                hint: 'Stop them or wait until they finish',
            } satisfies GitErrorDetails);

        if (underWay !== undefined)
            throw conflict(`${underWay} is in progress`, {
                hint: 'Finish or abort it first',
            } satisfies GitErrorDetails);

        if (changes === undefined) throw unavailable('git did not answer');

        if (changes > 0)
            throw conflict('Commit or discard the changes first', {
                hint: `${changes} ${changes === 1 ? 'file' : 'files'} changed`,
            } satisfies GitErrorDetails);

        if (worktreeBlock) throw conflict(worktreeBlock);
    }

    /** Runs the switch and tells where HEAD is after it. */
    async #run(cwd: string, plan: Plan, env: Record<string, string>): Promise<GitSwitchResult> {
        const run = await runProgram('git', plan.args, {
            env,
            cwd,
            timeoutMs: this.#timeoutMs,
            maxChars: MAX_PRINTED_CHARS,
            signal: this.#stopper.signal,
            stopSignal: 'SIGTERM',
            leftoverGraceMs: LEFTOVER_GRACE_MS,
        });

        if (run.error === 'stopped') throw unavailable('The daemon is stopping');

        // HEAD moves once the files are checked out and before the `post-checkout` hook runs, so a switch that was cut off with HEAD on the branch was cut off in the hook.
        if (run.timedOut) {
            if (await this.#isOn(cwd, plan.branch))
                return await this.#made(cwd, plan, 'The post-checkout hook did not finish in time');

            throw unavailable('The switch did not finish in time');
        }

        if (run.error !== undefined) throw unavailable('git is not installed or not on PATH');

        if (run.code === 0) return await this.#made(cwd, plan);

        // The exit status of the switch is the `post-checkout` hook's: the branch has changed all the same, which HEAD shows.
        if (await this.#isOn(cwd, plan.branch)) return await this.#made(cwd, plan, hookLine(run.stderr, run.stdout));

        throw conflict(failureLine(run.stderr, run.stdout));
    }

    /** HEAD is on the branch. */
    async #isOn(cwd: string, branch: string): Promise<boolean> {
        return (await gitAnswer(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'])) === branch;
    }

    /**
     * The answer of a switch that was made: where HEAD is, whether the branch is new, and what the person is told besides, the hook's line when it failed and the commits a detached HEAD
     * left on no branch (git says so on stderr, which nothing shows, and a commit nobody can name is gone to most people).
     */
    async #made(cwd: string, plan: Plan, hook?: string): Promise<GitSwitchResult> {
        const left = plan.leaving === undefined ? undefined : await commitsLeftBehind(cwd, plan.leaving);
        const warning = [hook, left].filter(line => line !== undefined).join('; ');

        return {
            ...(await this.#where(cwd)),
            ...(plan.created && { created: true as const }),
            ...(warning !== '' && { warning }),
        };
    }

    /** Where HEAD is now, and the upstream of the branch it is on. */
    async #where(cwd: string): Promise<GitSwitchResult> {
        const read = await gitRead(cwd, ['status', '--porcelain=v2', '--branch', '--untracked-files=no', '-z'], {
            parsed: true,
        });

        if (!read.ok) throw unavailable('git did not say where HEAD is');

        const { commit, branch, upstream } = parseStatus(read.stdout.split('\0'));
        const head: GitHead =
            branch === undefined
                ? { kind: 'detached', commit: commit ?? '' }
                : commit === undefined
                  ? { kind: 'unborn', name: branch }
                  : { kind: 'branch', name: branch, commit };

        return { head, ...(upstream && { upstream }) };
    }
}

/** A branch's exact tip, or no such branch. A failed read is never taken for absence. */
async function branchTip(cwd: string, ref: string): Promise<string | undefined> {
    const tip = await commitOf(cwd, ref);

    if (tip === undefined) throw unavailable('git did not answer');

    return tip ?? undefined;
}

async function requireBranchTip(cwd: string, ref: string, expected: string): Promise<void> {
    if ((await branchTip(cwd, ref)) !== expected)
        throw conflict('The branch changed since the preview, review it again');
}

/** A base is written as main or origin/main. Preserve a real local name, including one with an origin/ prefix. */
async function branchOfBase(cwd: string, base: string | undefined): Promise<string | undefined> {
    if (base === undefined) return undefined;
    if (await branchTip(cwd, `refs/heads/${base}`)) return base;

    return base.startsWith(`${ORIGIN}/`) ? base.slice(ORIGIN.length + 1) : undefined;
}

function requireDeletion(
    plan: GitBranchDeletePreview,
    request: Extract<GitBranchDeleteRequest, { action: 'delete' }>,
    switchTo: string | undefined
): void {
    if (plan.blocked) throw conflict(plan.blocked);
    if (
        plan.localCommit !== request.localCommit ||
        (request.originCommit !== undefined && plan.originCommit !== request.originCommit) ||
        plan.switchTo !== switchTo
    )
        throw conflict('The branch changed since the preview, review it again');
    if (
        (request.localCommit !== undefined && plan.localUnmerged && request.localUnmerged !== true) ||
        (request.originCommit !== undefined && plan.originUnmerged && request.originUnmerged !== true)
    )
        throw conflict('The branch has unmerged commits, review it again');
}

/** Two worktrees share a checkout lock even when they belong to different projects or have different path aliases. */
export async function switchRepositoryKey(cwd: string): Promise<string> {
    const read = await gitRead(cwd, ['rev-parse', '--git-common-dir']);
    const common = read.ok ? read.stdout.replace(/\r?\n$/, '') : '';
    const repo = common ? await placeOf(resolve(cwd, common)) : undefined;

    if (!repo) throw unavailable('git did not identify the repository');

    return `git-switch:${pathKey(repo)}`;
}

/** A ready worktree can switch once its live HEAD is already in its base. */
async function worktreeSwitchBlock(place: Place): Promise<string | undefined> {
    const name = place.workspace?.base ?? (await baseOf(place.folder));
    const base = name === undefined ? undefined : await resolveRef(place.path, name);

    if (!base) return "Couldn't verify that the worktree is merged";
    if (!(await isMerged(place.path, 'HEAD', base.commit)))
        return `Merge this branch into ${base.name} before switching`;

    return undefined;
}

/** A control character: none is in a branch name. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the control characters are what it looks for
const CONTROL = /[\x00-\x1F\x7F]/;

/** A name as it is shown in a message: what a person typed may hold a control character (a line break), which would break the line. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the control characters are what it replaces
const printable = (text: string): string => text.replace(/[\x00-\x1F\x7F]/g, ' ').trim();

/** What git itself says on a switch that worked, which is not what a hook that failed after it said. */
const GIT_SAYS =
    /^(?:Switched to |Already on |Your branch |branch '.*' set up to track|Note: |HEAD is now |Previous HEAD|Updating files|Warning: you are leaving )/;

/** The line of a hook that failed after a switch: the first thing printed that is not git's own report of it; a hook that said nothing is still named. */
function hookLine(stderr: string, stdout: string): string {
    const said = [...printedLines(stderr), ...printedLines(stdout)].find(line => !GIT_SAYS.test(line));

    return said === undefined ? 'The post-checkout hook failed' : shownLine(said);
}

/** Where a new branch starts, as the request says it, or why it is none. */
function startOf(create: unknown): GitSwitchStart {
    const start = (create as { start?: unknown } | null)?.start;

    if (start !== 'current' && start !== 'default')
        throw invalid('A new branch starts from the current branch or from the default branch');

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

/**
 * What a switch away from a detached HEAD left on no branch, in words, or nothing when every commit of it is on a branch, a tag or `origin` (git's own count for its "you are leaving N commits
 * behind": the commits `commit` has that no ref reaches, asked after the switch, so a new branch made from the detached HEAD has them). A git that does not answer says nothing.
 */
async function commitsLeftBehind(cwd: string, commit: string): Promise<string | undefined> {
    const read = await gitRead(cwd, ['rev-list', '--count', commit, '--not', '--glob=refs/*']);
    const count = read.ok ? Number(read.stdout.trim()) : 0;

    if (!(count > 0)) return undefined;

    const short = commit.slice(0, 7);

    return count === 1
        ? `The commit ${short} is on no branch now`
        : `${short} and ${count - 1} earlier ${count === 2 ? 'commit are' : 'commits are'} on no branch now`;
}

/** Whether the repository has a ref. A git that cannot be asked is `unavailable`, never "no". */
async function refExists(cwd: string, ref: string): Promise<boolean> {
    const read = await gitRead(cwd, ['show-ref', '--verify', '--quiet', ref]);

    if (!read.ok && read.reason === 'unavailable') throw unavailable('git did not answer');

    return read.ok;
}

/** The place of the worktree that has `branch` checked out, when it is not `cwd`'s own. */
async function heldBy(cwd: string, branch: string): Promise<string | undefined> {
    const read = await gitRead(cwd, ['worktree', 'list', '--porcelain', '-z']);

    if (!read.ok) throw unavailable('git did not answer');

    const own = await placeOf(cwd);

    for (const entry of parseWorktrees(read.stdout)) {
        if (entry.branch === branch && (await placeOf(entry.path)) !== own) return resolve(entry.path);
    }

    return undefined;
}

/** What the repository has under way that a switch would leave half done: a merge, a rebase, a cherry-pick, a revert or a bisect (`A merge`, `A rebase`, ...). Nothing when none. */
export async function operationUnderWay(cwd: string): Promise<string | undefined> {
    const paths = await gitRead(cwd, ['rev-parse', ...UNDER_WAY.flatMap(({ file }) => ['--git-path', file])]);

    if (!paths.ok) throw unavailable('git did not answer');

    const lines = paths.stdout.split('\n');

    for (const [index, { name }] of UNDER_WAY.entries()) {
        // `--git-path` is relative to where git runs (the working tree's own `.git`, or the linked worktree's git directory).
        if (lines[index] && (await isOnDisk(resolve(cwd, lines[index])))) return name;
    }

    return undefined;
}

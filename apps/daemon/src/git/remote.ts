import { randomUUID } from 'node:crypto';

import { gitAnswer, gitRead } from '../domain/git';
import { exclusive } from '../domain/workspaces';
import { CommandError, conflict, invalid, unavailable } from '../errors';
import { LEFTOVER_GRACE_MS, runProgram } from '../process/run';
import { printedLines, shownLine, writeLine } from './commit';
import { rememberFetch } from './lastFetch';
import { checkoutOf, defaultBranchOf, workingTreeRoot } from './state';
import { mergeBaseOf, parseStatus } from './status';
import { operationUnderWay, switchRepositoryKey } from './switch';
import { namesSigningKey, SIGNING_HINT, WriteEnvironment } from './writeEnv';

import type {
    GitErrorDetails,
    GitPushRequest,
    GitRemoteAction,
    GitRemoteResult,
    GitSyncProgress,
    GitSyncResult,
    GitSyncTarget,
    GitUpstream,
} from '@clowdy/protocol';
import type { Place } from '../domain/places';
import type { RunOptions, RunResult } from '../process/run';
import type { Store } from '../store';
import type { GitWritesOptions } from './commit';

/**
 * A push or a fetch over SSH may wait for the person's fingerprint (a key held by Secretive asks for Touch ID), or for a network that is slow to answer, so each git run gets about two
 * minutes; past it git is asked to stop and the action is `unavailable`. A pull is a fetch and a local merge, each with its own two minutes.
 */
const REMOTE_TIMEOUT_MS = 120_000;

/** The most of what git prints that is kept: only one line of it is ever shown. */
const MAX_PRINTED_CHARS = 256 * 1024;

/** The only remote the app moves commits to and from. */
const ORIGIN = 'origin';

/** Where a branch's own ref is: `refs/heads/<branch>`. */
const HEADS = 'refs/heads/';

/** Whether what a branch tracks is the branch of its own name: the only upstream the app pulls from and pushes to. */
const ownName = (branch: string, tracking: { merge: string }): boolean => tracking.merge === `${HEADS}${branch}`;

/** Keeps a fetch to `origin`: git also fetches a submodule from its own remote when the commit of it that the superproject points at has moved, which is another remote and another failure. */
const NO_SUBMODULES = ['--no-recurse-submodules'];

/** What a failed run is said to have been unable to do, when git itself said nothing. */
const FAILURE: Record<GitRemoteAction, string> = {
    fetch: `fetch from ${ORIGIN}`,
    pull: `take what is on ${ORIGIN}`,
    push: `push to ${ORIGIN}`,
    update: 'update from the base',
    abort: 'abort the merge',
};

/**
 * What git says around the line that matters, and says in every failure: the summary after the cause of a failed push, the second line of a failed connection, and the page a fetch
 * and a push name their remote on. These are never the line shown while a more particular one is there. So are the lines that say nothing of a cause: a `warning:`, a `remote:` with
 * nothing after it, and the remote's own progress (`remote: Resolving deltas: 100% ...`), which a remote may print before the line that says why it refused.
 */
const SUMMARY_LINE =
    /^(?:To |From |error: failed to push some refs|fatal: Could not read from remote repository|fatal: the remote end hung up unexpectedly|Please make sure you have the correct access rights|and the repository exists|hint:|warning:|remote:\s*$|remote: (?:Resolving deltas|Counting objects|Enumerating objects|Compressing objects|Total ))/i;

/**
 * The line git writes for a ref it would not send, which says why in its own parentheses: `! [rejected] main -> main (fetch first)`. A ref that the remote declined
 * (`! [remote rejected]`) is not this: the remote said why in its own `remote:` lines before it, which are the better line.
 */
const REJECTED_REF = /^!\s*\[rejected\]/i;

/** What git says first that is the cause: the line that names the signing key, else the refused ref, else the first line that is not a summary (a hook's line, ssh's, a remote's `remote:` line), else git's own first `fatal:` or `error:`. */
export function remoteFailureLine(stderr: string, stdout: string, fallback: string): string {
    const printed = printedLines(stderr);
    const line =
        printed.find(namesSigningKey) ??
        printed.find(candidate => REJECTED_REF.test(candidate))?.replace(/\s+/g, ' ') ??
        printed.find(candidate => !SUMMARY_LINE.test(candidate)) ??
        printed.find(candidate => /^(?:fatal|error):/i.test(candidate)) ??
        printedLines(stdout)[0] ??
        fallback;

    return shownLine(line);
}

/** Run the user's git with the write environment and give it a chance to clean locks after a timeout. `watch` is what a caller that follows the run (a clone's progress) adds. */
export function runGitWrite(
    cwd: string,
    args: string[],
    env: Record<string, string>,
    signal: AbortSignal,
    timeoutMs = REMOTE_TIMEOUT_MS,
    watch: Pick<RunOptions, 'onStderr' | 'untilGone'> = {}
): Promise<RunResult> {
    return runProgram('git', args, {
        env,
        cwd,
        timeoutMs,
        maxChars: MAX_PRINTED_CHARS,
        signal,
        stopSignal: 'SIGTERM',
        leftoverGraceMs: LEFTOVER_GRACE_MS,
        ...watch,
    });
}

/** Report the cause of a failed write and reset the cached signing agent when necessary. */
export function checkGitWrite(run: RunResult, environment: WriteEnvironment, action: string, failure: string): void {
    if (run.error === 'stopped') throw unavailable('The daemon is stopping');

    if (run.timedOut) throw unavailable(`The ${action} did not finish in time`);

    if (run.error !== undefined) throw unavailable('git is not installed or not on PATH');

    if (run.code === 0) return;

    const line = remoteFailureLine(run.stderr, run.stdout, `git could not ${failure}`);

    if (namesSigningKey(`${run.stderr}\n${run.stdout}`)) {
        environment.forgetAgent();

        throw conflict(line, { hint: SIGNING_HINT } satisfies GitErrorDetails);
    }

    throw conflict(line);
}

/** Where the place's HEAD is, as far as the actions need to know it, and where the branch is set to go. */
interface Head {
    /** The branch checked out; absent on a detached HEAD. */
    branch?: string;
    /** The branch has a commit. */
    born: boolean;
    /** The remote and the branch the branch tracks, as `branch.<name>.remote` and `.merge` say; absent when it tracks nothing. */
    tracking?: { remote: string; merge: string };
}

/**
 * What the daemon does between a person's branch and their `origin`: fetch, pull and push (which is also how a branch is published). The three run the person's own `git`
 * in the place, no shell, with their configuration and the write environment (`WriteEnvironment`: no prompt for a password, the signing agent's socket), on the place's one line
 * of writes (`writeLine`), so a commit and a push never overlap; nothing here runs on its own. **Only `origin` counts**, and nothing is ever forced:
 *
 * - fetch is `git fetch --no-recurse-submodules origin`: the submodules' own remotes are not asked (git does that by itself for a submodule whose commit moved, and a failure there ends the
 *   fetch with an error though `origin` was fetched);
 * - pull fetches, then takes what the upstream has with `git merge --no-edit @{upstream}`, for a branch whose upstream is the branch of its own name (`invalid` for one that tracks another): a fast-forward when the branch has nothing of its own, a merge commit when it has (`merged`), and `conflicts` when the merge stops on conflicts (the merge has started). No rebase, no reset. It merges itself, and does not call `git pull`, so the network is asked once;
 * - update fetches, then merges the place's base the same way (`git merge --no-edit <base ref>`), refused when HEAD is that base branch;
 * - abort is `git merge --abort`, and only while a merge is in progress;
 * - push is `git push origin refs/heads/<branch>:refs/heads/<branch>` for a branch whose upstream is `origin/<branch>`, the branch of its own name, and `git push -u origin
 *   refs/heads/<branch>:refs/heads/<branch>` (publish) for any other: one that tracks nothing, one whose upstream is gone from origin and one that tracks a branch of another name
 *   (`git switch -c feat origin/main`), which is sent under its own name and never to the branch it tracks, so a push cannot update `main` from `feat`. The branch is spelled as a full ref, never `HEAD`, so a branch that an agent or the person switched to while the push waited is not sent in its place, and a tag of its name
 *   is not meant. The refspec is given on the command line, so what the person's configuration says (`push.default`, `remote.origin.push`, a `+` in it) cannot widen it, and `--no-follow-tags`
 *   and `--no-recurse-submodules` keep a tag and a submodule from going with it. Never `--force`, never `--no-verify`.
 *
 * A place that is not a repository, a repository with no `origin`, a detached HEAD, a branch with no commit (pull and push), a branch that tracks another remote and, for a pull, a branch that tracks a branch of another name are `invalid`. A
 * refusal by git is `conflict` with the line that says why (`remoteFailureLine`) and, for a signing or agent failure, the hint of `writeEnv`; a run that does not end in time and the daemon stopping are `unavailable`.
 */
export class GitRemote {
    readonly environment: WriteEnvironment;
    readonly #store: Store;
    readonly #timeoutMs: number;
    readonly #stopper = new AbortController();

    constructor({ store, environment = new WriteEnvironment(), timeoutMs = REMOTE_TIMEOUT_MS }: GitWritesOptions) {
        this.#store = store;
        this.environment = environment;
        this.#timeoutMs = timeoutMs;
    }

    /** Ends the git that is running, and refuses new actions. */
    stop(): void {
        this.#stopper.abort();
    }

    /** `POST .../git/fetch`: `git fetch --no-recurse-submodules origin`. */
    fetch(place: Place): Promise<GitRemoteResult> {
        return this.#alone(place, async () => {
            await this.#inspect(place);
            await this.#run(place, 'fetch', ['fetch', ...NO_SUBMODULES, ORIGIN]);
            await rememberFetch(place.path);

            const upstream = await this.#upstream(place);

            return { state: 'done', action: 'fetch', ...(upstream && { upstream }) };
        });
    }

    /** `POST .../git/pull`: fetches `origin` and merges the upstream (`--no-edit`, a fast-forward when it can). A merge that stops on conflicts is `conflicts`, not an error. */
    pull(place: Place): Promise<GitRemoteResult> {
        return this.#alone(place, async () => {
            const { branch, tracking } = await this.#branchOf(place, 'pull');

            if (!tracking) throw invalid(`${branch} has no upstream to pull from, publish it first`);

            if (!ownName(branch, tracking))
                throw invalid(
                    `${branch} tracks ${ORIGIN}/${tracking.merge.slice(HEADS.length)}, not a branch of its own, publish it first`
                );

            await this.#run(place, 'pull', ['fetch', ...NO_SUBMODULES, ORIGIN]);
            await rememberFetch(place.path);

            const underway = await this.#conflictCount(place);

            if (underway !== undefined) return { state: 'conflicts', action: 'pull', conflicts: underway };

            const apart = await this.#apart(place);

            if (!apart) throw invalid(`${tracking.merge.replace(/^refs\/heads\//, '')} is no longer on origin`);

            if (apart.behind > 0) {
                const stopped = await this.#merge(place, 'pull', '@{upstream}');

                if (stopped) return { state: 'conflicts', action: 'pull', conflicts: stopped.conflicts };
            }

            const upstream = await this.#upstream(place);

            return {
                state: 'done',
                action: 'pull',
                pulled: apart.behind,
                ...(apart.behind > 0 && apart.ahead > 0 && { merged: true as const }),
                ...(upstream && { upstream }),
            };
        });
    }

    /** `POST .../git/update`: fetches `origin` and merges the place's base into the branch. Already being that branch is `invalid`. */
    update(place: Place): Promise<GitRemoteResult> {
        return this.#alone(place, async () => {
            const { branch, born } = await this.#inspect(place);

            if (branch === undefined) throw invalid('HEAD is detached, switch to a branch to update');

            if (!born) throw invalid(`${branch} has no commits yet`);

            const repo = await switchRepositoryKey(place.path);
            const before = await this.#syncHead(place, repo, branch);
            await this.#run(place, 'update', ['fetch', ...NO_SUBMODULES, ORIGIN]);
            await rememberFetch(place.path);
            await this.#syncHead(place, repo, branch, before);

            const underway = await this.#conflictCount(place);

            if (underway !== undefined) return { state: 'conflicts', action: 'update', conflicts: underway };

            const base = await mergeBaseOf(place);

            if (base.state === 'no_base') throw invalid('There is no branch to update from');

            if (base.state === 'no_merge_base') throw invalid(`${branch} shares no history with ${base.name}`);

            if (base.state !== 'ready') throw invalid(`${branch} has no commits yet`);

            const baseBranch = base.name.startsWith(`${ORIGIN}/`) ? base.name.slice(ORIGIN.length + 1) : base.name;

            if (branch === baseBranch || branch === base.name) throw invalid(`Already on ${branch}`);

            const counts = await gitAnswer(place.path, [
                'rev-list',
                '--left-right',
                '--count',
                `${base.commit}...${before}`,
            ]);
            const [behind, ahead] = (counts ?? '').split(/\s+/).map(Number);

            if (
                counts === undefined ||
                behind === undefined ||
                ahead === undefined ||
                Number.isNaN(behind) ||
                Number.isNaN(ahead)
            )
                throw unavailable('git did not answer');

            let updatedHead: { branch: string; commit: string } | undefined;
            if (behind > 0) {
                const env = await this.environment.of(place.path);
                await this.#syncHead(place, repo, branch, before);
                const stopped = await this.#merge(place, 'update', base.commit, ['-m', `Merge ${base.name}`], env);

                if (stopped) return { state: 'conflicts', action: 'update', conflicts: stopped.conflicts };

                // A repository can leave a clean merge unfinished with --no-commit.
                const unfinished = await this.#conflictCount(place);
                if (unfinished !== undefined) return { state: 'conflicts', action: 'update', conflicts: unfinished };

                const commit = await this.#syncHead(place, repo, branch);
                if (commit !== before) {
                    await this.#checkMergedTip(place, branch, commit, [before, base.commit]);
                    updatedHead = { branch, commit };
                }
            }

            const upstream = await this.#upstream(place);

            return {
                state: 'done',
                action: 'update',
                pulled: updatedHead ? behind : 0,
                ...(updatedHead && ahead > 0 && { merged: true as const }),
                ...(updatedHead && { updatedHead }),
                ...(upstream && { upstream }),
            };
        });
    }

    /** `POST .../git/abort`: `git merge --abort`, and only while a merge is in progress. */
    abort(place: Place): Promise<GitRemoteResult> {
        return this.#alone(place, async () => {
            if (!(await workingTreeRoot(place.path))) throw invalid('The folder is not the root of a git repository');

            if ((await this.#conflictCount(place)) === undefined) throw invalid('No merge to abort');

            await this.#run(place, 'abort', ['merge', '--abort']);

            return { state: 'done', action: 'abort' };
        });
    }

    /** `POST .../git/push`: the branch to its upstream, or published to `origin` with an upstream when it has none. */
    push(place: Place, expectedHead?: GitPushRequest['expectedHead']): Promise<GitRemoteResult> {
        return this.#alone(place, async () => {
            const { branch, tracking } = await this.#branchOf(place, 'push');

            if (expectedHead && branch !== expectedHead.branch)
                throw conflict(`The checkout switched from ${expectedHead.branch} to ${branch}`);

            const own = `${HEADS}${branch}`;
            // A branch is sent only to the branch of its own name. What it tracks is its own only under that name: a branch made from another one (`git switch -c feat origin/main` tracks `origin/main`)
            // would be sent to `main` itself, which git's own `push.default=simple` refuses and a refspec to the upstream's ref would not. Such a branch, and one that tracks nothing or whose
            // upstream is gone from origin, is published under its own name instead, with `-u`, so its upstream is the new branch. The source is spelled as a full ref (never `HEAD`, which is
            // whatever is checked out when git runs, not the branch that was judged), so a tag of the branch's name is not meant, and git names the ref as the branch in what it says of a refusal.
            const published =
                tracking !== undefined &&
                ownName(branch, tracking) &&
                (await gitAnswer(place.path, ['rev-parse', '--verify', '--quiet', '@{upstream}'])) !== undefined;

            if (
                expectedHead &&
                (await gitAnswer(place.path, ['rev-parse', '--verify', '--quiet', own])) !== expectedHead.commit
            )
                throw conflict(`${branch} changed after the commit`);

            await this.#run(place, 'push', [
                'push',
                '--no-follow-tags',
                '--no-recurse-submodules',
                ...(published ? [] : ['-u']),
                ORIGIN,
                `${own}:${own}`,
            ]);

            const upstream = await this.#upstream(place);

            return {
                state: 'done',
                action: 'push',
                ...(!published && { published: true as const }),
                ...(upstream && { upstream }),
            };
        });
    }

    /** Sync holds the same checkout's write lock from the first read through the final push. */
    async sync(
        source: Place,
        target: GitSyncTarget,
        progress: (step: GitSyncProgress) => void,
        finished: (place: Place) => Promise<void>
    ): Promise<GitSyncResult> {
        if (!(await workingTreeRoot(source.path))) throw invalid('The folder is not the root of a git repository');

        const { branch, destination } = target;
        const repo = await switchRepositoryKey(source.path);
        const path = destination ? await checkoutOf(source.path, branch) : source.path;

        if (path === undefined) throw conflict(`Check out ${branch} before syncing it`);

        const place = path === source.path ? source : { folder: source.folder, path };

        try {
            return await this.#alone(place, async () => {
                if (destination && (await checkoutOf(source.path, branch)) !== path)
                    throw conflict(`The checkout of ${branch} changed. Try again`);

                const result = await this.#syncBranch(place, repo, target, progress);

                if (result.state === 'done') await this.#advanceDefaultBranch(place, branch);

                return result;
            });
        } finally {
            await finished(place);
        }
    }

    async #syncBranch(
        place: Place,
        repo: string,
        { branch, commit }: GitSyncTarget,
        progress: (step: GitSyncProgress) => void
    ): Promise<GitSyncResult> {
        const before = await this.#syncHead(place, repo, branch, commit);
        const { tracking } = await this.#branchOf(place, 'push');
        const paused = await this.#syncConflict(place, branch);
        if (paused) return paused;

        // A private ref keeps the fetched commit available through the merge and is never used by another fetch.
        const snapshot = `refs/clowdy/sync/${randomUUID()}`;
        try {
            progress({ phase: 'fetch' });
            const incoming = await this.#fetchSyncBranch(place, branch, snapshot);
            await this.#syncHead(place, repo, branch, before);
            let tip = before;
            let pulled = 0;

            if (incoming) {
                const apart = await this.#apart(place, `${before}...${incoming}`);
                if (!apart) throw unavailable("Couldn't compare the branch with origin");

                pulled = apart.behind;
                if (pulled > 0) {
                    // Prepare the Git environment before the final checks so it cannot delay the merge after they pass.
                    const env = await this.environment.of(place.path);
                    await this.#checkSyncIndex(place, branch);
                    const paused = await this.#syncConflict(place, branch);
                    if (paused) return paused;
                    await this.#syncHead(place, repo, branch, before);

                    progress({ phase: 'merge' });
                    const merged = await this.#merge(
                        place,
                        'pull',
                        incoming,
                        [
                            '--no-autostash',
                            '--no-overwrite-ignore',
                            '--no-squash',
                            '--commit',
                            apart.ahead > 0 ? '--ff' : '--ff-only',
                            '-m',
                            `Merge origin/${branch}`,
                        ],
                        env
                    );
                    if (merged) return { state: 'conflicts', branch, path: place.path, conflicts: merged.conflicts };

                    tip = await this.#syncHead(place, repo, branch);
                    await this.#checkMergedTip(place, branch, tip, [before, incoming]);
                }
            }

            const pauseBeforePush = await this.#syncConflict(place, branch);
            if (pauseBeforePush) return pauseBeforePush;
            await this.#syncHead(place, repo, branch, tip);

            const setUpstream = tracking === undefined || !ownName(branch, tracking);
            const pushed = setUpstream || tip !== incoming;

            if (pushed) {
                const ref = `${HEADS}${branch}`;
                progress({ phase: 'push', commit: tip });
                // Use the checked commit even on first publish. A local ref can advance before Git starts.
                await this.#run(place, 'push', [
                    'push',
                    '--no-follow-tags',
                    '--no-recurse-submodules',
                    ORIGIN,
                    `${tip}:${ref}`,
                ]);
                if (setUpstream) await this.#setSyncUpstream(place, branch, ref);
            }

            return { state: 'done', branch, pulled, pushed };
        } finally {
            // Best effort even when shutdown stopped the fetch after it installed the ref.
            await gitRead(place.path, ['update-ref', '-d', snapshot]);
        }
    }

    /**
     * Brings the repository's default branch (`main`, as `origin/HEAD` and the branch list name it) up to what origin has, so a branch that was merged there does not leave the local
     * `main` behind. Only a fast-forward of a branch the person already has: git refuses the rest, and the answer is the same for each, the branch stays as it is. That is a branch
     * with commits of its own that origin lacks, and one that is checked out in any checkout of the repository (a person's or an agent's files do not move under them). The branch
     * that was just synced is the default one when it is `main` itself, and has been brought up to date. Best effort, after the sync has done its work: a refusal, a remote that does
     * not answer or a timeout never fails the sync, and the branch is tried again at the next one.
     */
    async #advanceDefaultBranch(place: Place, synced: string): Promise<void> {
        try {
            const name = (await defaultBranchOf(place.path))?.replace(/^origin\//, '');

            if (!name || name === synced) return;

            // A branch the person has: Sync makes no branch of its own.
            if (!(await gitAnswer(place.path, ['rev-parse', '--verify', '--quiet', `${HEADS}${name}`]))) return;

            const ref = `${HEADS}${name}`;

            // No `+` and no `--update-head-ok`: git itself refuses a rewind and a branch that is checked out, and moves nothing then.
            await this.#git(place, [
                'fetch',
                ...NO_SUBMODULES,
                '--no-tags',
                '--no-prune',
                '--no-prune-tags',
                ORIGIN,
                `${ref}:${ref}`,
            ]);
        } catch {
            // The sync is done; this is a courtesy that the next sync tries again.
        }
    }

    /** Git only applies push -u when the refspec names a local branch. Configure tracking after pushing the pinned commit. */
    async #setSyncUpstream(place: Place, branch: string, ref: string): Promise<void> {
        const write = async (key: string, value: string) => {
            const run = await this.#git(place, ['config', '--local', '--replace-all', '--', key, value]);
            checkGitWrite(run, this.environment, 'upstream setup', 'set the upstream');
        };

        try {
            await write(`branch.${branch}.remote`, ORIGIN);
            await write(`branch.${branch}.merge`, ref);
        } catch (error) {
            if (!(error instanceof CommandError)) throw error;

            throw new CommandError(error.code, `Pushed ${branch} to origin. Couldn't set its upstream`, {
                hint: error.message,
            } satisfies GitErrorDetails);
        }
    }

    /** A sync can leave unstaged edits in place, but a merge must never commit the user's existing index. */
    async #checkSyncIndex(place: Place, branch: string): Promise<void> {
        const staged = await gitRead(
            place.path,
            ['diff', '--cached', '--name-only', '-z', '--no-ext-diff', '--ignore-submodules=none', '--'],
            { parsed: true }
        );

        if (!staged.ok) throw unavailable("Couldn't read the staging area");
        if (staged.stdout.length > 0)
            throw conflict(`Commit or stash the staged changes in ${branch} before merging from origin`);
    }

    /** Verify both inputs to a merge are included before using its result for a push. */
    async #checkMergedTip(place: Place, branch: string, tip: string, inputs: readonly string[]): Promise<void> {
        const ancestors = await Promise.all(
            inputs.map(commit => gitRead(place.path, ['merge-base', '--is-ancestor', commit, tip]))
        );
        if (ancestors.some(result => !result.ok)) throw conflict(`The merge into ${branch} did not finish`);
    }

    async #syncHead(place: Place, repo: string, branch: string, expected?: string): Promise<string> {
        if (!(await workingTreeRoot(place.path)) || (await switchRepositoryKey(place.path)) !== repo)
            throw conflict(`The checkout of ${branch} moved`);

        const [checkedOut, tip] = await Promise.all([
            gitAnswer(place.path, ['symbolic-ref', '--quiet', 'HEAD']),
            gitAnswer(place.path, ['rev-parse', '--verify', '--quiet', 'HEAD']),
        ]);

        if (checkedOut !== `${HEADS}${branch}`) throw conflict(`The checkout is no longer on ${branch}`);
        if (!tip) throw invalid(`${branch} has no commits yet`);
        if (expected !== undefined && expected !== tip) throw conflict(`${branch} changed before it could sync`);

        return tip;
    }

    async #syncConflict(
        place: Place,
        branch: string
    ): Promise<Extract<GitSyncResult, { state: 'conflicts' }> | undefined> {
        const operation = await operationUnderWay(place.path);
        if (operation === undefined) return undefined;
        if (operation !== 'A merge') throw conflict(`${operation} is in progress in ${branch}`);

        return { state: 'conflicts', branch, path: place.path, conflicts: (await this.#conflictCount(place)) ?? 0 };
    }

    /** Use a private ref for the fetched tip. Neither a stale tracking ref nor another fetch can supply it. */
    async #fetchSyncBranch(place: Place, branch: string, snapshot: string): Promise<string | undefined> {
        const ref = `${HEADS}${branch}`;
        const run = await this.#git(place, [
            'fetch',
            ...NO_SUBMODULES,
            '--no-tags',
            '--no-prune',
            '--no-prune-tags',
            ORIGIN,
            `${ref}:${snapshot}`,
        ]);
        // An explicit refspec has a distinct error when the remote was reachable and does not have the branch.
        if (
            run.code === 128 &&
            !run.timedOut &&
            run.error === undefined &&
            printedLines(run.stderr).includes(`fatal: couldn't find remote ref ${ref}`)
        ) {
            await rememberFetch(place.path);
            return undefined;
        }

        this.#check(run, 'fetch');
        const tip = await gitAnswer(place.path, ['rev-parse', '--verify', `${snapshot}^{commit}`]);
        if (!tip) throw unavailable("Couldn't read the fetched branch");
        await rememberFetch(place.path);
        return tip;
    }

    /** Runs `work` once the place's earlier writes have ended, and not while another starts. */
    #alone<T>(place: Place, work: () => Promise<T>): Promise<T> {
        return exclusive(this.#store, writeLine(place), this.#stopper.signal, work);
    }

    /** That the place is the root of a repository with an `origin`, and where its HEAD is. Judged on the place's line, so what it says is what the action finds. */
    async #inspect(place: Place): Promise<Head> {
        const cwd = place.path;

        if (!(await workingTreeRoot(cwd))) throw invalid('The folder is not the root of a git repository');

        if ((await gitAnswer(cwd, ['remote', 'get-url', ORIGIN])) === undefined)
            throw invalid('The repository has no origin');

        const ref = await gitAnswer(cwd, ['symbolic-ref', '--quiet', 'HEAD']);
        const branch = ref?.startsWith(HEADS) ? ref.slice(HEADS.length) : undefined;

        if (branch === undefined)
            return { born: (await gitAnswer(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD'])) !== undefined };

        const [remote, merge, commit] = await Promise.all([
            gitAnswer(cwd, ['config', '--get', `branch.${branch}.remote`]),
            gitAnswer(cwd, ['config', '--get', `branch.${branch}.merge`]),
            gitAnswer(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD']),
        ]);

        return {
            branch,
            born: commit !== undefined,
            ...(remote !== undefined && merge !== undefined && { tracking: { remote, merge } }),
        };
    }

    /**
     * The branch a pull or a push is about: it has to be on a branch that has a commit and, when it tracks something, track a branch of `origin` (a branch of another remote, a local
     * branch and a tag are not the app's to move).
     */
    async #branchOf(
        place: Place,
        action: 'pull' | 'push'
    ): Promise<{ branch: string; tracking?: { remote: string; merge: string } }> {
        const head = await this.#inspect(place);

        if (head.branch === undefined) throw invalid(`HEAD is detached, switch to a branch to ${action}`);

        if (!head.born) throw invalid(`${head.branch} has no commits yet`);

        const { tracking } = head;

        if (tracking && tracking.remote !== ORIGIN)
            throw invalid(
                `${head.branch} tracks ${tracking.remote === '.' ? 'a local branch' : shownLine(tracking.remote)}, and only ${ORIGIN} is used`
            );

        if (tracking && !tracking.merge.startsWith('refs/heads/'))
            throw invalid(`${head.branch} tracks ${tracking.merge}, which is not a branch of ${ORIGIN}`);

        return { branch: head.branch, ...(tracking && { tracking }) };
    }

    /** How many commits the branch has that its upstream lacks and the other way round, as last fetched; nothing when the upstream is not there. */
    async #apart(place: Place, range = 'HEAD...@{upstream}'): Promise<{ ahead: number; behind: number } | undefined> {
        const counts = await gitAnswer(place.path, ['rev-list', '--left-right', '--count', range]);
        const [ahead, behind] = (counts ?? '').split(/\s+/).map(Number);

        return counts === undefined ||
            ahead === undefined ||
            behind === undefined ||
            Number.isNaN(ahead) ||
            Number.isNaN(behind)
            ? undefined
            : { ahead, behind };
    }

    /** The branch's upstream as it stands now, with how far apart the two are; nothing for a branch that tracks none and for a HEAD that is on no branch. */
    async #upstream(place: Place): Promise<GitUpstream | undefined> {
        const read = await gitRead(place.path, ['status', '--porcelain=v2', '--branch', '--untracked-files=no', '-z'], {
            parsed: true,
        });

        return read.ok ? parseStatus(read.stdout.split('\0')).upstream : undefined;
    }

    /**
     * How many paths are still unmerged, when a merge is in progress (`MERGE_HEAD`); nothing when no merge is. The count is the whole tree, not the status list, which is cut.
     */
    async #conflictCount(place: Place): Promise<number | undefined> {
        if ((await gitAnswer(place.path, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])) === undefined)
            return undefined;

        const unmerged = await gitRead(place.path, ['diff', '--name-only', '--diff-filter=U', '-z'], { parsed: true });

        return unmerged.ok ? unmerged.stdout.split('\0').filter(path => path !== '').length : 0;
    }

    /**
     * `git merge --no-edit <ref>` in the place. A clean merge (a fast-forward or a merge commit) is nothing; a merge that stops on conflicts is how many paths are unmerged, and the merge is
     * left in progress. A refusal before a merge starts (a local change in the way) is thrown, and nothing was started.
     */
    async #merge(
        place: Place,
        action: 'pull' | 'update',
        ref: string,
        options: string[] = [],
        env?: Record<string, string>
    ): Promise<{ conflicts: number } | undefined> {
        const run = await this.#git(place, ['merge', '--no-edit', ...options, ref], env);

        if (run.code === 0) return undefined;

        const conflicts = await this.#conflictCount(place);

        if (conflicts !== undefined) return { conflicts };

        this.#check(run, action);

        return undefined;
    }

    /** `git <args>` in the place with the write environment, asked to stop with `SIGTERM` so it removes its lock files when the time is up. */
    async #git(place: Place, args: string[], prepared?: Record<string, string>): Promise<RunResult> {
        const env = prepared ?? (await this.environment.of(place.path));

        return runGitWrite(place.path, args, env, this.#stopper.signal, this.#timeoutMs);
    }

    /** `git <args>` in the place; throws what a run that did not succeed came to. */
    async #run(place: Place, action: GitRemoteAction, args: string[]): Promise<void> {
        this.#check(await this.#git(place, args), action);
    }

    /** Throws what a run that did not succeed came to, in words the person reads; returns when it did. */
    #check(run: RunResult, action: GitRemoteAction): void {
        checkGitWrite(run, this.environment, action, FAILURE[action]);
    }
}

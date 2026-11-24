import { readFile, rmdir, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import { listProjects } from '../db/projects';
import { gitAnswer, gitRead } from '../domain/git';
import { chatsWorkingIn } from '../domain/places';
import { exclusive } from '../domain/workspaces';
import { conflict, invalid, unavailable } from '../errors';
import { writeLine } from './commit';
import { checkGitWrite, runGitWrite } from './remote';
import { countChanges, parseWorktrees, placeOf, workingTreeRoot } from './state';
import { operationUnderWay, switchRepositoryKey } from './switch';
import { WriteEnvironment } from './writeEnv';

import type {
    GitBranchMergePreview,
    GitBranchMergeRequest,
    GitBranchMergeResult,
    GitBranchMergeSelection,
} from '@clowdy/protocol';
import type { Place } from '../domain/places';
import type { GitWritesOptions } from './commit';

const HEADS = 'refs/heads/';
const ORIGIN = 'origin';
const REMOTE_HEADS = `refs/remotes/${ORIGIN}/`;
const CHECKOUT = 'checkout';
const MERGE_OWNER = 'clowdy-merge';

function outgoingConflict({ source, target }: GitBranchMergePreview) {
    return conflict(`Can't merge into ${target} because the branches conflict`, {
        hint: `In a chat on ${target}, use Merge from branch to merge ${source} and resolve the conflicts`,
    });
}

/** Resolve an exact full ref, so a tag, revision expression or alternate remote can never substitute for it. */
async function branchCommit(cwd: string, ref: string, name: string): Promise<string> {
    const read = await gitRead(cwd, ['show-ref', '--hash', '--verify', ref]);

    if (read.ok) return read.stdout.trim();
    if (read.reason === 'unavailable') throw unavailable('git did not answer');

    throw invalid(`There is no branch called ${name}`);
}

async function checkName(cwd: string, name: string): Promise<void> {
    // check-ref-format takes a full ref, without the previous-checkout expansion of --branch.
    if (
        name.length === 0 ||
        name.length > 250 ||
        name === '@' ||
        name === 'HEAD' ||
        name.startsWith('-') ||
        name.includes('\0')
    )
        throw invalid('Choose a branch');

    const read = await gitRead(cwd, ['check-ref-format', `${HEADS}${name}`]);

    if (!read.ok) {
        if (read.reason === 'unavailable') throw unavailable('git did not answer');

        throw invalid('Choose a branch');
    }
}

/** Find the checkout using Git records, which preserve paths containing spaces and line breaks. */
async function checkoutOf(cwd: string, branch: string): Promise<string | undefined> {
    const read = await gitRead(cwd, ['worktree', 'list', '--porcelain', '-z']);

    if (!read.ok) throw unavailable('git did not list the worktrees');

    const holders = parseWorktrees(read.stdout).filter(entry => entry.branch === branch && !entry.bare);

    if (holders.length > 1) throw conflict(`${branch} is checked out in more than one worktree`);

    const holder = holders[0];

    if (!holder) return undefined;

    if (holder.prunable || holder.locked !== undefined) throw conflict(`The checkout of ${branch} is unavailable`);

    const path = await placeOf(holder.path);

    if (!path) throw conflict(`The checkout of ${branch} is missing`);

    return path;
}

async function preview(cwd: string, selection: GitBranchMergeSelection): Promise<GitBranchMergePreview> {
    const { direction, current, branch, remote } = selection;

    if (remote && direction === 'into') throw invalid('Select a local destination branch');

    await checkName(cwd, branch);

    const on = await gitAnswer(cwd, ['symbolic-ref', '--quiet', 'HEAD']);

    if (on !== `${HEADS}${current}`) throw conflict('The current branch changed. Reopen the merge dialog');
    if (!remote && branch === current) throw invalid('Choose a different branch');

    const source = direction === 'into' ? current : remote ? `${ORIGIN}/${branch}` : branch;
    const target = direction === 'into' ? branch : current;
    const sourceRef = remote ? `${REMOTE_HEADS}${branch}` : `${HEADS}${source}`;
    const [sourceCommit, targetCommit] = await Promise.all([
        branchCommit(cwd, sourceRef, source),
        branchCommit(cwd, `${HEADS}${target}`, target),
    ]);
    const counts = await gitAnswer(cwd, ['rev-list', '--left-right', '--count', `${targetCommit}...${sourceCommit}`]);
    const matched = /^(\d+)\s+(\d+)$/.exec(counts ?? '');

    if (!matched) throw unavailable('git did not compare the branches');

    const ahead = Number(matched[1]);
    const commits = Number(matched[2]);
    const mode = commits === 0 ? 'up-to-date' : ahead === 0 ? 'fast-forward' : 'merge-commit';

    if (mode === 'merge-commit') {
        const base = await gitRead(cwd, ['merge-base', targetCommit, sourceCommit]);

        if (!base.ok) {
            if (base.reason === 'unavailable') throw unavailable('git did not compare the branches');

            throw conflict(`${source} and ${target} have no common history`);
        }
    }

    return { state: 'preview', source, target, sourceCommit, targetCommit, commits, mode };
}

/** Keep the entire MERGE_HEAD, since an octopus merge has more than one source. */
async function mergeHead(cwd: string): Promise<string | undefined> {
    const path = await gitRead(cwd, ['rev-parse', '--git-path', 'MERGE_HEAD']);

    if (!path.ok) throw unavailable('git did not identify the merge in progress');

    try {
        return (await readFile(resolve(cwd, path.stdout.replace(/\r?\n$/, '')), 'utf8')).trim();
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;

        throw unavailable('Could not read the merge in progress');
    }
}

async function conflictResult(
    path: string,
    { target, sourceCommit, targetCommit }: GitBranchMergePreview
): Promise<Extract<GitBranchMergeResult, { state: 'conflicts' }>> {
    const files = await gitRead(path, ['diff', '--name-only', '--diff-filter=U', '-z'], { parsed: true });

    if (!files.ok) throw unavailable(`A merge is in progress in ${path}`);

    const conflicts = files.stdout.split('\0').filter(Boolean).length;

    return { state: 'conflicts', target, commit: targetCommit, sourceCommit, targetPath: path, conflicts };
}

/** Branch-to-branch merges with a preview pinned to both commits. All writes run in the destination checkout. */
export class GitBranchMerge {
    readonly #stopper = new AbortController();
    readonly #store: GitWritesOptions['store'];
    readonly #environment: WriteEnvironment;
    readonly #directory: string;

    constructor({
        store,
        environment = new WriteEnvironment(),
        workspacesDir,
    }: GitWritesOptions & { workspacesDir: string }) {
        this.#store = store;
        this.#environment = environment;
        this.#directory = join(workspacesDir, 'merges');
    }

    stop(): void {
        this.#stopper.abort();
    }

    async run(place: Place, request: GitBranchMergeRequest): Promise<GitBranchMergeResult> {
        const cwd = place.path;

        if (!(await workingTreeRoot(cwd))) throw invalid('The folder is not the root of a git repository');

        if (request.action === 'preview') {
            const plan = await preview(cwd, request);
            const targetPath = await checkoutOf(cwd, plan.target);

            if (targetPath === undefined) return plan;

            const conflictCheck =
                request.direction === 'into' && plan.mode === 'merge-commit'
                    ? await this.#checkMerge(targetPath, plan, await this.#environment.of(targetPath))
                    : undefined;

            return { ...plan, targetPath, ...(conflictCheck && { conflictCheck }) };
        }

        const target =
            request.action === 'merge'
                ? request.direction === 'from'
                    ? request.current
                    : request.branch
                : request.target;

        if (request.action !== 'merge') await checkName(cwd, target);

        // Same lock order as GitSwitch. The target may move to another checkout while waiting.
        const repo = await switchRepositoryKey(cwd);
        const queuedPath = await checkoutOf(cwd, target);
        const inRepository = () =>
            exclusive(this.#store, repo, this.#stopper.signal, async () => {
                const targetPath = await checkoutOf(cwd, target);

                if (targetPath !== queuedPath) throw conflict(`The checkout of ${target} changed. Try again`);

                switch (request.action) {
                    case 'merge':
                        return this.#merge(cwd, targetPath, repo, request);
                    case 'abort':
                        return this.#abort(targetPath, repo, request);
                    case 'push':
                        return this.#push(targetPath ?? cwd, repo, request);
                }
            });

        return queuedPath === undefined
            ? await inRepository()
            : await exclusive(
                  this.#store,
                  writeLine({ ...place, path: queuedPath }),
                  this.#stopper.signal,
                  inRepository
              );
    }

    /** Check the pinned tips without touching the destination's files or index. A Git error is not a clean result. */
    async #checkMerge(
        path: string,
        { targetCommit, sourceCommit }: GitBranchMergePreview,
        env: Record<string, string>
    ): Promise<'clean' | 'conflicts'> {
        const run = await runGitWrite(
            path,
            ['merge-tree', '--write-tree', targetCommit, sourceCommit],
            env,
            this.#stopper.signal
        );

        if (run.code === 1 && !run.timedOut && run.error === undefined) return 'conflicts';

        checkGitWrite(run, this.#environment, 'merge conflict check', 'check for merge conflicts');
        return 'clean';
    }

    async #merge(
        cwd: string,
        targetPath: string | undefined,
        repo: string,
        request: Extract<GitBranchMergeRequest, { action: 'merge' }>
    ): Promise<GitBranchMergeResult> {
        const plan = await preview(cwd, request);
        const { source, target, sourceCommit, targetCommit, mode } = plan;

        if (sourceCommit !== request.sourceCommit || targetCommit !== request.targetCommit)
            throw conflict('A branch changed. Refresh the merge preview');

        if (mode === 'up-to-date') return { state: 'done', target, commit: targetCommit, canPush: false };

        if (targetPath === undefined) throw conflict(`Check out ${target} before merging into it`);

        const path = targetPath;
        const env = await this.#environment.of(path);

        if (
            request.direction === 'into' &&
            mode === 'merge-commit' &&
            (await this.#checkMerge(path, plan, env)) === 'conflicts'
        )
            throw outgoingConflict(plan);

        const [operation, changes] = await Promise.all([operationUnderWay(path), countChanges(path)]);

        if (request.direction === 'from' && operation === 'A merge' && (await mergeHead(path)) === sourceCommit) {
            await this.#expectTarget(path, repo, target, targetCommit);

            return await conflictResult(path, plan);
        }

        if (operation !== undefined) throw conflict(`${operation} is in progress in ${target}`);
        if (changes === undefined) throw unavailable('git did not answer');
        if (changes !== 0) throw conflict(`Commit or discard the changes in ${target} first`);

        await this.#expectTarget(path, repo, target, targetCommit);
        this.#requireIdle(path, target);

        const args =
            mode === 'fast-forward' ? ['--ff-only'] : ['--ff', '-m', `Merge branch '${source}' into ${target}`];
        const run = await runGitWrite(
            path,
            [
                'merge',
                '--no-edit',
                '--no-autostash',
                '--no-overwrite-ignore',
                '--no-squash',
                '--commit',
                ...args,
                '--',
                sourceCommit,
            ],
            env,
            this.#stopper.signal
        );

        const merged = run.code === 0 ? undefined : await mergeHead(path);

        if (merged !== undefined) {
            if (merged !== sourceCommit) throw conflict(`A different merge is in progress in ${target}`);

            const outcome = await conflictResult(path, plan);

            if (request.direction === 'from' || outcome.conflicts === 0) return outcome;

            // A custom merge strategy or driver can disagree with merge-tree. Roll back only the new merge we own.
            await this.#expectTarget(path, repo, target, targetCommit);
            const abort = await runGitWrite(path, ['merge', '--abort'], env, this.#stopper.signal);

            if (abort.code !== 0) return outcome;

            throw outgoingConflict(plan);
        }

        checkGitWrite(run, this.#environment, 'merge', 'merge the branches');

        const [commit, origin] = await Promise.all([
            branchCommit(path, `${HEADS}${target}`, target),
            gitAnswer(path, ['remote', 'get-url', '--push', ORIGIN]),
        ]);

        return { state: 'done', target, commit, canPush: origin !== undefined };
    }

    async #push(
        cwd: string,
        repo: string,
        { target, commit }: Extract<GitBranchMergeRequest, { action: 'push' }>
    ): Promise<GitBranchMergeResult> {
        const ref = `${HEADS}${target}`;
        const env = await this.#environment.of(cwd);

        if (!(await workingTreeRoot(cwd)) || (await switchRepositoryKey(cwd)) !== repo)
            throw conflict(`The checkout of ${target} moved`);

        if ((await branchCommit(cwd, ref, target)) !== commit) throw conflict(`${target} changed after the merge`);

        // Pin the network write to the checked commit and to the destination branch of the same name on origin.
        const result = await runGitWrite(
            cwd,
            ['push', '--no-follow-tags', '--no-recurse-submodules', ORIGIN, `${commit}:${ref}`],
            env,
            this.#stopper.signal
        );

        checkGitWrite(result, this.#environment, 'push', 'push the merged branch');

        return { state: 'pushed', target };
    }

    async #abort(
        path: string | undefined,
        repo: string,
        { target, commit, sourceCommit }: Extract<GitBranchMergeRequest, { action: 'abort' }>
    ): Promise<GitBranchMergeResult> {
        if (!path) throw conflict(`The checkout of ${target} is missing`);

        const env = await this.#environment.of(path);

        await this.#expectTarget(path, repo, target, commit);

        if ((await mergeHead(path)) !== sourceCommit) throw conflict(`The merge in ${target} changed`);

        this.#requireIdle(path, target);

        const result = await runGitWrite(path, ['merge', '--abort'], env, this.#stopper.signal);

        checkGitWrite(result, this.#environment, 'abort', 'abort the merge');
        await this.#removeLegacyTemporary(path, repo);

        return { state: 'aborted', target };
    }

    async #expectTarget(path: string, repo: string, branch: string, commit: string): Promise<void> {
        if (!(await workingTreeRoot(path)) || (await switchRepositoryKey(path)) !== repo)
            throw conflict(`The checkout of ${branch} moved`);

        const [head, tip] = await Promise.all([
            gitAnswer(path, ['symbolic-ref', '--quiet', 'HEAD']),
            gitAnswer(path, ['rev-parse', '--verify', '--quiet', 'HEAD']),
        ]);

        if (head !== `${HEADS}${branch}` || tip !== commit)
            throw conflict(`The checkout of ${branch} changed. Refresh the merge preview`);
    }

    #requireIdle(path: string, target: string): void {
        if (listProjects(this.#store.db).some(project => chatsWorkingIn(this.#store, project, path) > 0))
            throw conflict(`A chat is working in ${target}`);
    }

    /** Clean up an old disposable checkout when its merge is explicitly aborted. Keep files left by hooks or conflict resolution. */
    async #removeLegacyTemporary(path: string, repo: string): Promise<void> {
        const dir = dirname(path);
        const marker = join(dir, MERGE_OWNER);
        const [root, parent, owner] = await Promise.all([
            placeOf(this.#directory),
            placeOf(dirname(dir)),
            readFile(marker, 'utf8').catch(() => undefined),
        ]);

        if (!root || root !== parent || basename(path) !== CHECKOUT || owner !== repo) return;

        const checkout = await placeOf(path);

        if (checkout !== undefined) {
            if ((await operationUnderWay(path).catch(() => 'Git is unavailable')) !== undefined) return;

            const files = await gitRead(path, [
                'status',
                '--porcelain',
                '--untracked-files=all',
                '--ignored=matching',
                '--ignore-submodules=none',
            ]);

            if (!files.ok || files.stdout.trim() !== '') return;

            const env = await this.#environment.of(path);
            const result = await runGitWrite(path, ['worktree', 'remove', '--', path], env, this.#stopper.signal);

            if (result.code !== 0) return;
        }

        await unlink(marker).catch(() => undefined);
        await rmdir(dir).catch(() => undefined);
    }
}

import { readFile, rmdir, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import { listProjects } from '../db/projects';
import { gitAnswer, gitRead } from '../domain/git';
import { chatsWorkingIn } from '../domain/places';
import { exclusive } from '../domain/workspaces';
import { conflict, invalid, unavailable } from '../errors';
import { writeLine } from './commit';
import { checkGitWrite, runGitWrite } from './remote';
import { checkoutOf, countChanges, placeOf, workingTreeRoot } from './state';
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

type MergeCheck = { state: 'clean'; tree: string } | { state: 'conflicts' | 'unchanged' };

function outgoingConflict({ source, target }: GitBranchMergePreview) {
    return conflict(`Can't merge into ${target} because the branches conflict`, {
        hint: `In a chat on ${target}, use Merge from branch to merge ${source} and resolve the conflicts`,
    });
}

function squashConflict({ source, target }: GitBranchMergePreview) {
    return conflict(`Can't squash into ${target} because the branches conflict`, {
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

async function preview(cwd: string, selection: GitBranchMergeSelection): Promise<GitBranchMergePreview> {
    const { direction, current, branch, remote, strategy } = selection;

    if (remote && direction === 'into') throw invalid('Select a local destination branch');
    if (strategy === 'rebase' && direction === 'into') throw invalid('Open the destination branch to rebase it');

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

    if (ahead > 0 && commits > 0) {
        const base = await gitRead(cwd, ['merge-base', targetCommit, sourceCommit]);

        if (!base.ok) {
            if (base.reason === 'unavailable') throw unavailable('git did not compare the branches');

            throw conflict(`${source} and ${target} have no common history`);
        }
    }

    const mode =
        commits === 0
            ? 'up-to-date'
            : strategy === 'squash' || strategy === 'rebase'
              ? strategy
              : ahead === 0
                ? 'fast-forward'
                : 'merge-commit';

    return {
        state: 'preview',
        source,
        target,
        sourceCommit,
        targetCommit,
        commits,
        mode,
        ...(strategy === 'rebase' && { replayCommits: ahead }),
    };
}

function needsConflictCheck(plan: GitBranchMergePreview, selection: GitBranchMergeSelection): boolean {
    return (
        plan.mode === 'squash' ||
        (selection.direction === 'into' &&
            plan.mode === 'merge-commit' &&
            selection.strategy !== 'fast-forward-only' &&
            !plan.fastForwardOnly)
    );
}

function usesMergePolicy(plan: GitBranchMergePreview, { strategy }: GitBranchMergeSelection): boolean {
    return (
        (strategy === undefined || strategy === 'merge') &&
        (plan.mode === 'fast-forward' || plan.mode === 'merge-commit')
    );
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
    { target, sourceCommit, targetCommit }: GitBranchMergePreview,
    operation?: 'rebase'
): Promise<Extract<GitBranchMergeResult, { state: 'conflicts' }>> {
    const files = await gitRead(path, ['diff', '--name-only', '--diff-filter=U', '-z'], { parsed: true });

    if (!files.ok) throw unavailable(`A merge is in progress in ${path}`);

    const conflicts = files.stdout.split('\0').filter(Boolean).length;

    return {
        state: 'conflicts',
        target,
        commit: targetCommit,
        sourceCommit,
        targetPath: path,
        conflicts,
        ...(operation && { operation }),
    };
}

/** Match only the rebase started at these two branch tips. The checkout may be detached while it is paused. */
async function isRebaseAt(path: string, target: string, original: string, onto: string): Promise<boolean> {
    const directory = await gitAnswer(path, ['rev-parse', '--git-path', 'rebase-merge']);
    if (!directory) return false;

    const read = (name: string) =>
        readFile(resolve(path, directory, name), 'utf8').then(
            text => text.trim(),
            () => undefined
        );
    const [head, tip, base] = await Promise.all([read('head-name'), read('orig-head'), read('onto')]);
    return head === `${HEADS}${target}` && tip === original && base === onto;
}

/** Both rebase and abort reset the checkout. Abort can also replace files created after the rebase paused. */
async function protectLocalFilesForRebase(path: string, destination: string, replayFrom?: string): Promise<void> {
    const action = replayFrom ? 'Rebase' : 'Aborting the rebase';
    const failed = `Couldn't check local files before ${replayFrom ? 'rebasing' : 'aborting the rebase'}`;
    const localFiles = await gitRead(path, [
        'ls-files',
        '--others',
        '--directory',
        '-z',
        ...(replayFrom ? ['--ignored', '--exclude-standard'] : []),
    ]);
    if (!localFiles.ok) throw unavailable(failed);
    if (!localFiles.stdout) return;

    const [base, replay] = await Promise.all([
        gitRead(path, ['ls-tree', '-r', '--name-only', '-z', destination]),
        replayFrom
            ? gitRead(
                  path,
                  [
                      'log',
                      '--format=',
                      '--no-notes',
                      '--name-only',
                      '--no-renames',
                      '--diff-merges=separate',
                      '-z',
                      `${destination}..${replayFrom}`,
                      '--',
                  ],
                  { parsed: true }
              )
            : undefined,
    ]);
    if (!base.ok || replay?.ok === false) throw unavailable(failed);

    // Treat case or Unicode aliases as collisions on desktop filesystems that can resolve them to the same file.
    const fold =
        process.platform === 'darwin' ||
        process.platform === 'win32' ||
        (await gitAnswer(path, ['config', '--type=bool', '--get', 'core.ignoreCase'])) === 'true';
    const key = (name: string) => (fold ? name.normalize('NFC').toLowerCase() : name);
    const local = new Set(
        localFiles.stdout
            .split('\0')
            .filter(Boolean)
            .map(file => key(file.replace(/\/$/, '')))
    );
    const folders = new Set<string>();
    for (const file of local) {
        for (let slash = file.indexOf('/'); slash >= 0; slash = file.indexOf('/', slash + 1))
            folders.add(file.slice(0, slash));
    }
    for (const name of [...base.stdout.split('\0'), ...(replay?.stdout.split('\0') ?? [])]) {
        if (!name) continue;
        const file = key(name);
        let collision = folders.has(file) || local.has(file);
        for (let slash = file.indexOf('/'); !collision && slash >= 0; slash = file.indexOf('/', slash + 1)) {
            collision = local.has(file.slice(0, slash));
        }
        if (collision)
            throw conflict(`${action} could overwrite an ${replayFrom ? 'ignored' : 'untracked'} file at ${name}`);
    }
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
            const tips = await preview(cwd, request);
            const targetPath = await checkoutOf(cwd, tips.target);

            if (targetPath === undefined) return tips;
            if (!usesMergePolicy(tips, request) && !needsConflictCheck(tips, request)) return { ...tips, targetPath };

            const env = await this.#environment.of(targetPath);
            const plan = await this.#mergePolicy(targetPath, tips, request, env);
            const checked = needsConflictCheck(plan, request)
                ? await this.#checkMerge(targetPath, plan, env)
                : undefined;

            if (checked?.state === 'unchanged') return { ...plan, targetPath, mode: 'up-to-date', commits: 0 };
            return { ...plan, targetPath, ...(checked && { conflictCheck: checked.state }) };
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
        const targetCheckout = () =>
            request.action === 'abort' && request.operation === 'rebase'
                ? Promise.resolve(cwd)
                : checkoutOf(cwd, target);
        const queuedPath = await targetCheckout();
        const inRepository = () =>
            exclusive(this.#store, repo, this.#stopper.signal, async () => {
                const targetPath = await targetCheckout();

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

    /** Read the destination's fast-forward preference and pin it in the plan before writing. */
    async #mergePolicy(
        path: string,
        plan: GitBranchMergePreview,
        selection: GitBranchMergeSelection,
        env: Record<string, string>
    ): Promise<GitBranchMergePreview> {
        if (!usesMergePolicy(plan, selection)) return plan;

        const config = (type?: string) =>
            runGitWrite(
                path,
                ['config', ...(type ? [type] : []), '--get', 'merge.ff'],
                env,
                this.#stopper.signal,
                5000
            );
        const raw = await config();
        if (raw.code === 1 && !raw.timedOut && raw.error === undefined && raw.stderr.trim() === '') return plan;

        checkGitWrite(raw, this.#environment, 'merge configuration read', 'read the merge configuration');
        if (raw.stdout.replace(/\r?\n$/, '') === 'only') return { ...plan, fastForwardOnly: true };
        if (plan.mode === 'merge-commit') return plan;

        // Let Git handle boolean aliases and the difference between unset and an empty value.
        const ff = await config('--type=bool');
        checkGitWrite(ff, this.#environment, 'merge configuration read', 'read the merge configuration');

        return ff.stdout.trim() === 'false' ? { ...plan, mode: 'merge-commit' } : plan;
    }

    /** Check the pinned tips without touching the destination's files or index. A Git error is not a clean result. */
    async #checkMerge(
        path: string,
        { mode, targetCommit, sourceCommit }: GitBranchMergePreview,
        env: Record<string, string>
    ): Promise<MergeCheck> {
        const run = await runGitWrite(
            path,
            ['merge-tree', '--write-tree', targetCommit, sourceCommit],
            env,
            this.#stopper.signal
        );

        if (run.code === 1 && !run.timedOut && run.error === undefined) return { state: 'conflicts' };

        checkGitWrite(run, this.#environment, 'merge conflict check', 'check for merge conflicts');
        const tree = run.stdout.trim();
        if (mode === 'squash') {
            const currentTree = await gitAnswer(path, ['rev-parse', `${targetCommit}^{tree}`]);
            if (!currentTree)
                throw unavailable("Couldn't determine whether the changes are already in the destination");
            if (currentTree === tree) return { state: 'unchanged' };
        }
        return { state: 'clean', tree };
    }

    async #merge(
        cwd: string,
        targetPath: string | undefined,
        repo: string,
        request: Extract<GitBranchMergeRequest, { action: 'merge' }>
    ): Promise<GitBranchMergeResult> {
        const tips = await preview(cwd, request);
        const { source, target, sourceCommit, targetCommit } = tips;

        if (sourceCommit !== request.sourceCommit || targetCommit !== request.targetCommit)
            throw conflict('A branch changed since the preview. Select the branch again to review the merge');

        if (tips.mode === 'up-to-date') return { state: 'done', target, commit: targetCommit, canPush: false };
        if (request.strategy === 'fast-forward-only' && tips.mode !== 'fast-forward')
            throw conflict(`Can't fast-forward ${target} because the branches have diverged`);

        if (targetPath === undefined) throw conflict(`Check out ${target} before merging into it`);

        const path = targetPath;
        const env = await this.#environment.of(path);
        const plan = await this.#mergePolicy(path, tips, request, env);
        const { mode } = plan;

        if (plan.fastForwardOnly && mode !== 'fast-forward')
            throw conflict(`Can't fast-forward ${target} because the branches have diverged`);

        const checked = needsConflictCheck(plan, request) ? await this.#checkMerge(path, plan, env) : undefined;
        const currentMode = checked?.state === 'unchanged' ? 'up-to-date' : mode;
        if (request.expectedMode !== undefined && currentMode !== request.expectedMode)
            throw conflict('The merge result changed since the preview. Select the branch again to review the merge');
        if (checked?.state === 'conflicts') throw mode === 'squash' ? squashConflict(plan) : outgoingConflict(plan);
        if (checked?.state === 'unchanged') return { state: 'done', target, commit: targetCommit, canPush: false };

        const [operation, changes] = await Promise.all([operationUnderWay(path), countChanges(path)]);

        if (request.direction === 'from' && operation === 'A merge' && (await mergeHead(path)) === sourceCommit) {
            if (mode === 'squash' || mode === 'rebase') throw conflict(`A merge is in progress in ${target}`);
            await this.#expectTarget(path, repo, target, targetCommit);

            return await conflictResult(path, plan);
        }

        if (operation !== undefined) throw conflict(`${operation} is in progress in ${target}`);
        if (changes === undefined) throw unavailable('git did not answer');
        if (changes !== 0) throw conflict(`Commit or discard the changes in ${target} first`);

        if (mode === 'rebase' && plan.replayCommits) {
            await protectLocalFilesForRebase(path, sourceCommit, targetCommit);
            await this.#expectTarget(path, repo, target, targetCommit);
            this.#requireIdle(path, target);

            const run = await runGitWrite(
                path,
                [
                    '-c',
                    'merge.directoryRenames=false',
                    '-c',
                    'submodule.recurse=false',
                    'rebase',
                    '--merge',
                    '--no-autostash',
                    '--no-update-refs',
                    '--no-fork-point',
                    '--rebase-merges',
                    sourceCommit,
                ],
                env,
                this.#stopper.signal
            );
            if (run.code !== 0 && (await isRebaseAt(path, target, targetCommit, sourceCommit)))
                return conflictResult(path, plan, 'rebase');
            checkGitWrite(run, this.#environment, 'rebase', 'rebase the branch');
            return this.#done(path, target);
        }

        await this.#expectTarget(path, repo, target, targetCommit);
        this.#requireIdle(path, target);

        if (mode === 'squash') {
            if (checked?.state !== 'clean') throw unavailable("Couldn't check the changes to squash");
            const run = await runGitWrite(
                path,
                [
                    '-c',
                    'submodule.recurse=false',
                    'merge',
                    '--squash',
                    '--ff',
                    '--no-commit',
                    '--no-autostash',
                    '--no-overwrite-ignore',
                    '--',
                    sourceCommit,
                ],
                env,
                this.#stopper.signal
            );
            if (run.code !== 0 && (await conflictResult(path, plan)).conflicts > 0) {
                await this.#expectTarget(path, repo, target, targetCommit);
                const rollback = await runGitWrite(
                    path,
                    ['-c', 'submodule.recurse=false', 'reset', '--merge', targetCommit],
                    env,
                    this.#stopper.signal
                );
                checkGitWrite(rollback, this.#environment, 'reset', 'roll back the squash');
                throw squashConflict(plan);
            }
            checkGitWrite(run, this.#environment, 'merge', 'squash the branches');

            // The post-merge hook or another Git process can stage unrelated changes before the commit.
            const [stagedTree, newOperation] = await Promise.all([
                gitAnswer(path, ['write-tree']),
                operationUnderWay(path),
            ]);
            if (stagedTree !== checked.tree || newOperation)
                throw conflict('The staging area changed during the squash. Review the changes before committing');
            await this.#expectTarget(path, repo, target, targetCommit);
            this.#requireIdle(path, target);

            const commit = await runGitWrite(
                path,
                ['commit', '-m', `Squash branch '${source}' into ${target}`],
                env,
                this.#stopper.signal
            );
            checkGitWrite(commit, this.#environment, 'commit', 'commit the squashed changes');
            return this.#done(path, target);
        }

        const args =
            mode === 'merge-commit' ? ['--no-ff', '-m', `Merge branch '${source}' into ${target}`] : ['--ff-only'];
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

        return this.#done(path, target);
    }

    async #done(path: string, target: string): Promise<GitBranchMergeResult> {
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
        { target, commit, sourceCommit, operation }: Extract<GitBranchMergeRequest, { action: 'abort' }>
    ): Promise<GitBranchMergeResult> {
        if (!path) throw conflict(`The checkout of ${target} is missing`);

        const env = await this.#environment.of(path);

        if (operation === 'rebase') {
            if (!(await isRebaseAt(path, target, commit, sourceCommit)))
                throw conflict(`The rebase in ${target} changed`);
            await protectLocalFilesForRebase(path, commit);
            if ((await branchCommit(path, `${HEADS}${target}`, target)) !== commit)
                throw conflict(`${target} changed during the rebase`);
            this.#requireIdle(path, target);
            const result = await runGitWrite(
                path,
                ['-c', 'submodule.recurse=false', 'rebase', '--abort'],
                env,
                this.#stopper.signal
            );
            checkGitWrite(result, this.#environment, 'abort', 'abort the rebase');
            return { state: 'aborted', target, operation };
        }

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

        if (head !== `${HEADS}${branch}` || tip !== commit) throw conflict(`The checkout of ${branch} changed`);
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

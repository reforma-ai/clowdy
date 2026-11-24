import { afterAll, afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROUTES } from '@clowdy/protocol';

import { switchRepositoryKey } from '../src/git/switch';
import { commitFile, hook, identify, isolated, left, neighbour, repository } from './gitRepos';
import { cleanTempDirs, GateEngine, gateEngines, git, makeRepo, startHarness, tempDir, waitFor } from './helpers';

import type {
    GitBranchMergePreview,
    GitBranchMergeRequest,
    GitBranchMergeResult,
    GitBranchMergeSelection,
} from '@clowdy/protocol';
import type { Harness } from './helpers';

afterAll(cleanTempDirs);

const harnesses: Harness[] = [];

afterEach(async () => {
    await Promise.all(harnesses.splice(0).map(harness => harness.stop()));
});

async function open(path: string, options: Parameters<typeof startHarness>[1] = {}) {
    const h = await startHarness({}, { gitEnvironment: isolated(), ...options });
    harnesses.push(h);
    const { project } = h.ok('project.add', { folders: [path] });
    const folderId = project.folders[0].id as string;
    const call = (request: GitBranchMergeRequest) =>
        h.fetch(ROUTES.projectGitMerge(project.id), {
            method: 'POST',
            body: JSON.stringify({ folderId, ...request }),
        });
    const result = async (request: GitBranchMergeRequest) => {
        const response = await call(request);

        if (!response.ok) throw new Error(await response.text());

        return (await response.json()) as GitBranchMergeResult;
    };
    const preview = async (selection: GitBranchMergeSelection): Promise<GitBranchMergePreview> => {
        const outcome = await result({ action: 'preview', ...selection });

        if (outcome.state !== 'preview') throw new Error('Expected a preview');

        return outcome;
    };
    const merge = (selection: GitBranchMergeSelection, plan: GitBranchMergePreview) => ({
        action: 'merge' as const,
        ...selection,
        sourceCommit: plan.sourceCommit,
        targetCommit: plan.targetCommit,
    });

    return { h, project, folderId, call, result, preview, merge };
}

test('merges a fetched origin branch into the current branch without a merge commit or push', async () => {
    const { path, origin } = repository();
    git(path, 'switch', '-q', '-c', 'next');
    const colleague = neighbour(origin);
    const sourceCommit = commitFile(colleague, 'main-change.txt');
    git(colleague, 'push', '-q', 'origin', 'main');
    const { h, project, folderId, preview, result, merge } = await open(path);
    const selection = { direction: 'from', branch: 'main', remote: true, current: 'next' } as const;
    const fetch = await h.fetch(`/v1/projects/${project.id}/git/fetch`, {
        method: 'POST',
        body: JSON.stringify({ folderId }),
    });
    expect(fetch.status).toBe(200);
    const list = await h.fetch(`/v1/projects/${project.id}/git/branches?folderId=${folderId}`);
    expect(await list.json()).toMatchObject({ origin: [{ name: 'main' }], remote: [] });

    const plan = await preview(selection);

    expect(plan).toMatchObject({
        source: 'origin/main',
        target: 'next',
        sourceCommit,
        commits: 1,
        mode: 'fast-forward',
    });
    expect(await result(merge(selection, plan))).toEqual({
        state: 'done',
        target: 'next',
        commit: sourceCommit,
        canPush: true,
    });
    expect(git(path, 'branch', '--show-current')).toBe('next');
    expect(git(path, 'rev-parse', 'HEAD')).toBe(sourceCommit);
    expect(git(origin, 'for-each-ref', '--format=%(refname)', 'refs/heads')).toBe('refs/heads/main');
    expect(await preview(selection)).toMatchObject({ mode: 'up-to-date', commits: 0 });
});

test('fast-forward only declines diverged tips and squash writes one commit in the existing destination', async () => {
    const path = makeRepo(tempDir('git-merge'));
    identify(path);
    git(path, 'switch', '-q', '-c', 'next');
    const targetCommit = commitFile(path, 'next.txt');
    git(path, 'switch', '-q', 'main');
    commitFile(path, 'one.txt');
    const sourceCommit = commitFile(path, 'two.txt');
    const target = join(tempDir('git-merge'), 'next');
    git(path, 'worktree', 'add', '-q', target, 'next');
    const worktrees = git(path, 'worktree', 'list', '--porcelain');
    const { call, result, preview, merge } = await open(path);
    const selection = { direction: 'into', branch: 'next', current: 'main', strategy: 'fast-forward-only' } as const;

    expect((await call(merge(selection, await preview(selection)))).status).toBe(409);
    expect(git(target, 'rev-parse', 'HEAD')).toBe(targetCommit);

    const squash = { ...selection, strategy: 'squash' } as const;
    const plan = await preview(squash);
    expect(plan).toMatchObject({ mode: 'squash', commits: 2, conflictCheck: 'clean' });
    expect(await result(merge(squash, plan))).toMatchObject({ state: 'done', target: 'next' });
    expect(git(target, 'rev-list', '--parents', '-1', 'HEAD').split(' ').slice(1)).toEqual([targetCommit]);
    expect(readFileSync(join(target, 'one.txt'), 'utf8')).toBe('one.txt\n');
    expect(readFileSync(join(target, 'two.txt'), 'utf8')).toBe('two.txt\n');
    expect(git(path, 'rev-parse', 'HEAD')).toBe(sourceCommit);
    expect(
        git(path, 'worktree', 'list', '--porcelain')
            .split('\n')
            .filter(line => line.startsWith('worktree '))
    ).toEqual(worktrees.split('\n').filter(line => line.startsWith('worktree ')));
    expect(left(target)).toEqual([]);

    const squashed = git(target, 'rev-parse', 'HEAD');
    const repeat = await preview(squash);
    expect(repeat).toMatchObject({ mode: 'up-to-date', commits: 0 });
    expect(await result(merge(squash, repeat))).toEqual({
        state: 'done',
        target: 'next',
        commit: squashed,
        canPush: false,
    });
    expect(left(target)).toEqual([]);
});

test('rebases only the current branch and retains the original source', async () => {
    const path = makeRepo(tempDir('git-merge'));
    identify(path);
    git(path, 'switch', '-q', '-c', 'next');
    commitFile(path, 'next-1.txt');
    const original = commitFile(path, 'next-2.txt');
    git(path, 'switch', '-q', 'main');
    const source = commitFile(path, 'main.txt');
    git(path, 'switch', '-q', 'next');
    const { call, result, preview, merge } = await open(path);
    const selection = { direction: 'from', branch: 'main', current: 'next', strategy: 'rebase' } as const;
    const plan = await preview(selection);

    expect(plan).toMatchObject({ mode: 'rebase', replayCommits: 2, sourceCommit: source, targetCommit: original });
    expect((await call({ action: 'preview', ...selection, direction: 'into' })).status).toBe(400);
    expect(await result(merge(selection, plan))).toMatchObject({ state: 'done', target: 'next' });
    expect(git(path, 'branch', '--show-current')).toBe('next');
    expect(git(path, 'rev-parse', 'main')).toBe(source);
    expect(git(path, 'rev-parse', 'HEAD~2')).toBe(source);
    expect(git(path, 'rev-parse', 'HEAD')).not.toBe(original);
    expect(left(path)).toEqual([]);
});

test('refuses to overwrite an ignored path used by an intermediate rebase commit', async () => {
    const path = makeRepo(tempDir('git-merge'));
    identify(path);
    commitFile(path, '.gitignore', '*.txt\n');
    git(path, 'switch', '-q', '-c', 'next');
    writeFileSync(join(path, 'intermediate.txt'), 'Historical content\n');
    git(path, 'add', '-f', 'intermediate.txt');
    git(path, 'commit', '-qm', 'Add intermediate file');
    git(path, 'rm', 'intermediate.txt');
    git(path, 'commit', '-qm', 'Remove intermediate file');
    const original = commitFile(path, 'next.md');
    git(path, 'switch', '-q', 'main');
    commitFile(path, 'main.md');
    git(path, 'switch', '-q', 'next');
    writeFileSync(join(path, 'intermediate.txt'), 'Keep this\n');

    const { call, preview, merge } = await open(path);
    const selection = { direction: 'from', branch: 'main', current: 'next', strategy: 'rebase' } as const;
    const refused = await call(merge(selection, await preview(selection)));
    expect(refused.status).toBe(409);
    expect(await refused.text()).toContain('Rebase could overwrite an ignored file at intermediate.txt');
    expect(readFileSync(join(path, 'intermediate.txt'), 'utf8')).toBe('Keep this\n');
    expect(git(path, 'rev-parse', 'HEAD')).toBe(original);
});

test('does not commit unrelated changes staged by a squash hook', async () => {
    if (process.platform === 'win32') return;

    const path = makeRepo(tempDir('git-merge'));
    identify(path);
    git(path, 'switch', '-q', '-c', 'source');
    commitFile(path, 'source.md');
    git(path, 'switch', '-q', 'main');
    const original = git(path, 'rev-parse', 'HEAD');
    hook(path, 'post-merge', "printf 'Keep this\\n' > local.md", 'git add local.md');

    const { call, preview, merge } = await open(path);
    const selection = { direction: 'from', branch: 'source', current: 'main', strategy: 'squash' } as const;
    const refused = await call(merge(selection, await preview(selection)));
    expect(refused.status).toBe(409);
    expect(await refused.text()).toContain('The staging area changed during the squash');
    expect(git(path, 'rev-parse', 'HEAD')).toBe(original);
    expect(left(path)).toEqual(['A  local.md', 'A  source.md']);
});

test('protects case aliases of ignored files and unrelated files created during a paused rebase', async () => {
    const path = makeRepo(tempDir('git-merge'));
    identify(path);
    git(path, 'config', 'core.ignoreCase', 'true');
    commitFile(path, '.gitignore', '*.txt\n');
    writeFileSync(join(path, 'restore.txt'), 'Original tracked content\n');
    git(path, 'add', '-f', 'restore.txt');
    git(path, 'commit', '-qm', 'Track a file that will be removed');
    git(path, 'switch', '-q', '-c', 'next');
    const original = commitFile(path, 'README.md', 'On next\n');
    git(path, 'switch', '-q', 'main');
    git(path, 'rm', 'restore.txt');
    writeFileSync(join(path, 'local.txt'), 'From main\n');
    git(path, 'add', '-f', 'local.txt');
    const source = commitFile(path, 'README.md', 'On main\n');
    git(path, 'switch', '-q', 'next');
    writeFileSync(join(path, 'LOCAL.txt'), 'Keep this\n');
    const { h, project, folderId, call, result, preview, merge } = await open(path);
    const selection = { direction: 'from', branch: 'main', current: 'next', strategy: 'rebase' } as const;
    const plan = await preview(selection);

    const blocked = await call(merge(selection, plan));
    expect(blocked.status).toBe(409);
    expect(await blocked.text()).toContain('could overwrite an ignored file');
    expect(readFileSync(join(path, 'LOCAL.txt'), 'utf8')).toBe('Keep this\n');
    expect(git(path, 'rev-parse', 'HEAD')).toBe(original);
    unlinkSync(join(path, 'LOCAL.txt'));

    expect(await result(merge(selection, plan))).toMatchObject({
        state: 'conflicts',
        operation: 'rebase',
        target: 'next',
        conflicts: 1,
    });
    const status = await h.fetch(`/v1/projects/${project.id}/git/status?folderId=${folderId}`);
    expect(await status.json()).toMatchObject({ isRepository: true, rebasing: true });
    const abort = {
        action: 'abort',
        target: 'next',
        commit: original,
        sourceCommit: source,
        operation: 'rebase',
    } as const;
    expect((await call({ ...abort, sourceCommit: original })).status).toBe(409);
    writeFileSync(join(path, 'restore.txt'), 'Keep this, too\n');
    const blockedAbort = await call(abort);
    expect(blockedAbort.status).toBe(409);
    expect(await blockedAbort.text()).toContain('Aborting the rebase could overwrite an untracked file');
    expect(readFileSync(join(path, 'restore.txt'), 'utf8')).toBe('Keep this, too\n');
    unlinkSync(join(path, 'restore.txt'));

    expect(await result(abort)).toEqual({ state: 'aborted', target: 'next', operation: 'rebase' });
    expect(git(path, 'branch', '--show-current')).toBe('next');
    expect(git(path, 'rev-parse', 'HEAD')).toBe(original);
    expect(readFileSync(join(path, 'restore.txt'), 'utf8')).toBe('Original tracked content\n');
    expect(left(path)).toEqual([]);
});

test('merges diverged branches in the existing destination checkout and pushes only the explicitly selected result', async () => {
    const { path, origin } = repository();
    git(path, 'branch', 'feature/xyz');
    git(path, 'switch', '-q', '-c', 'next');
    const targetCommit = commitFile(path, 'next.txt');
    git(path, 'push', '-q', '-u', 'origin', 'next');
    git(path, 'switch', '-q', 'feature/xyz');
    const sourceCommit = commitFile(path, 'feature.txt');
    const target = join(tempDir('git-merge'), 'next');
    git(path, 'worktree', 'add', '-q', target, 'next');
    const worktrees = git(path, 'worktree', 'list', '--porcelain');
    const { call, result, preview, merge } = await open(path);
    const selection = { direction: 'into', branch: 'next', current: 'feature/xyz' } as const;
    const plan = await preview(selection);

    expect(plan).toMatchObject({
        source: 'feature/xyz',
        target: 'next',
        sourceCommit,
        targetCommit,
        commits: 1,
        mode: 'merge-commit',
        conflictCheck: 'clean',
    });
    expect(plan.targetPath).toBeDefined();

    const outcome = await result(merge(selection, plan));
    const commit = git(path, 'rev-parse', 'refs/heads/next');

    expect(outcome).toEqual({ state: 'done', target: 'next', commit, canPush: true });
    expect(git(path, 'rev-list', '--parents', '-n', '1', commit)).toBe(`${commit} ${targetCommit} ${sourceCommit}`);
    expect(git(path, 'rev-parse', 'HEAD')).toBe(sourceCommit);
    expect(git(path, 'branch', '--show-current')).toBe('feature/xyz');
    expect(git(target, 'rev-parse', 'HEAD')).toBe(commit);
    expect(git(path, 'worktree', 'list', '--porcelain')).toBe(worktrees.replace(targetCommit, commit));
    expect(git(origin, 'rev-parse', 'refs/heads/next')).toBe(targetCommit);
    expect((await call({ action: 'push', target: 'next', commit: sourceCommit })).status).toBe(409);
    expect(await result({ action: 'push', target: 'next', commit })).toEqual({ state: 'pushed', target: 'next' });
    expect(git(origin, 'rev-parse', 'refs/heads/next')).toBe(commit);
    expect(git(origin, 'for-each-ref', '--format=%(refname)', 'refs/heads')).not.toContain('refs/heads/feature/xyz');
});

test.each(['--no-commit', '--squash'])(
    'finishes the previewed merge even when the target defaults to %s',
    async option => {
        const path = makeRepo(tempDir('git-merge'));
        identify(path);
        git(path, 'branch', 'main-copy');
        git(path, 'switch', '-q', '-c', 'next');
        const targetCommit = commitFile(path, 'next.txt');
        git(path, 'switch', '-q', 'main-copy');
        const sourceCommit = commitFile(path, 'main-change.txt');
        git(path, 'switch', '-q', 'next');
        git(path, 'config', 'branch.next.mergeOptions', option);
        const { result, preview, merge } = await open(path);
        const selection = { direction: 'from', branch: 'main-copy', current: 'next' } as const;
        const plan = await preview(selection);

        expect(plan.mode).toBe('merge-commit');
        const outcome = await result(merge(selection, plan));
        const commit = git(path, 'rev-parse', 'refs/heads/next');

        expect(outcome).toMatchObject({ state: 'done', target: 'next', commit });
        expect(git(path, 'rev-list', '--parents', '-n', '1', commit)).toBe(`${commit} ${targetCommit} ${sourceCommit}`);
        expect(left(path)).toEqual([]);
    }
);

test('protects ignored files, refuses dirty and active targets, and keeps the source checkout', async () => {
    const path = makeRepo(tempDir('git-merge'));
    identify(path);
    const target = join(tempDir('git-merge'), 'next with spaces');
    git(path, 'worktree', 'add', '-q', '-b', 'next', target);
    const initial = git(target, 'rev-parse', 'HEAD');
    const source = commitFile(path, 'protected.txt');
    writeFileSync(join(path, '.git', 'info', 'exclude'), 'protected.txt\n');
    writeFileSync(join(target, 'protected.txt'), 'Do not touch\n');
    writeFileSync(join(target, 'dirty.txt'), 'Untracked\n');
    const gate = new GateEngine();
    const { h, project, folderId, call, result, preview, merge } = await open(path, { engines: gateEngines(gate) });
    const selection = { direction: 'into', branch: 'next', current: 'main' } as const;
    const request = merge(selection, await preview(selection));
    const dirty = await call(request);

    expect(dirty.status).toBe(409);
    expect(await dirty.text()).toContain('Commit or discard the changes in next first');
    expect(git(target, 'rev-parse', 'HEAD')).toBe(initial);
    unlinkSync(join(target, 'dirty.txt'));

    const ignored = await call(request);

    expect(ignored.status).toBe(409);
    expect(readFileSync(join(target, 'protected.txt'), 'utf8')).toBe('Do not touch\n');
    unlinkSync(join(target, 'protected.txt'));

    const { chat } = h.ok('chat.create', {
        projectId: project.id,
        folderId,
        workspace: { mode: 'existing', path: target },
    });
    const { runId } = h.ok('chat.send', { chatId: chat.id, text: 'working in destination' });
    await waitFor(() => gate.isStarted('working in destination'), 'the run in next');
    const active = await call(request);

    expect(active.status).toBe(409);
    expect(await active.text()).toContain('A chat is working in next');
    gate.release('working in destination');
    await waitFor(() => h.run(runId).status === 'succeeded', 'the run in next to end');

    expect(await result(request)).toMatchObject({ state: 'done', target: 'next', commit: source, canPush: false });
    expect(git(target, 'rev-parse', 'HEAD')).toBe(source);
    expect(git(path, 'branch', '--show-current')).toBe('main');
});

test('refuses to fast-forward an unopened destination without creating a checkout', async () => {
    const path = makeRepo(tempDir('git-merge'));
    identify(path);
    const targetCommit = git(path, 'rev-parse', 'HEAD');
    git(path, 'branch', 'next');
    commitFile(path, 'source.txt');
    const { call, preview, merge } = await open(path);
    const selection = { direction: 'into', branch: 'next', current: 'main' } as const;
    const worktrees = git(path, 'worktree', 'list', '--porcelain');
    const plan = await preview(selection);

    expect(plan.mode).toBe('fast-forward');
    expect(plan.targetPath).toBeUndefined();
    const response = await call(merge(selection, plan));

    expect(response.status).toBe(409);
    expect(await response.text()).toContain('Check out next before merging into it');
    expect(git(path, 'rev-parse', 'refs/heads/next')).toBe(targetCommit);
    expect(git(path, 'worktree', 'list', '--porcelain')).toBe(worktrees);
    expect(left(path)).toEqual([]);
});

test('blocks an outgoing conflict before changing files and allows the same merge from the destination checkout', async () => {
    const path = makeRepo(tempDir('git-merge'));
    identify(path);
    git(path, 'switch', '-q', '-c', 'next');
    const targetCommit = commitFile(path, 'README.md', 'On the destination\n');
    git(path, 'switch', '-q', 'main');
    const sourceCommit = commitFile(path, 'README.md', 'On the source\n');
    const target = join(tempDir('git-merge'), 'next');
    git(path, 'worktree', 'add', '-q', target, 'next');
    const outgoing = await open(path);
    const into = { direction: 'into', branch: 'next', current: 'main' } as const;
    const worktrees = git(path, 'worktree', 'list', '--porcelain');
    const plan = await outgoing.preview(into);

    expect(plan).toMatchObject({ mode: 'merge-commit', conflictCheck: 'conflicts' });
    expect(left(target)).toEqual([]);
    const blocked = await outgoing.call(outgoing.merge(into, plan));

    expect(blocked.status).toBe(409);
    const failure = await blocked.text();
    expect(failure).toContain("Can't merge into next because the branches conflict");
    expect(failure).toContain('In a chat on next, use Merge from branch to merge main');
    expect(git(path, 'worktree', 'list', '--porcelain')).toBe(worktrees);
    expect(left(path)).toEqual([]);
    expect(left(target)).toEqual([]);
    expect(readFileSync(join(target, 'README.md'), 'utf8')).toBe('On the destination\n');

    const { call, result, preview, merge } = await open(target);
    const from = { direction: 'from', branch: 'main', current: 'next' } as const;
    const request = merge(from, await preview(from));
    const outcome = await result(request);

    expect(outcome).toMatchObject({
        state: 'conflicts',
        target: 'next',
        commit: targetCommit,
        sourceCommit,
        conflicts: 1,
    });
    if (outcome.state !== 'conflicts') throw new Error('Expected a conflict');

    expect(git(outcome.targetPath, 'branch', '--show-current')).toBe('next');
    expect(readFileSync(join(outcome.targetPath, 'README.md'), 'utf8')).toContain('<<<<<<< HEAD');
    expect(await result(request)).toEqual(outcome);
    expect(git(path, 'rev-parse', 'HEAD')).toBe(sourceCommit);
    expect(left(path)).toEqual([]);
    const abort = { action: 'abort', target: 'next', commit: targetCommit, sourceCommit } as const;

    expect((await call({ ...abort, sourceCommit: targetCommit })).status).toBe(409);
    expect(await result(abort)).toEqual({ state: 'aborted', target: 'next' });
    expect(existsSync(outcome.targetPath)).toBe(true);
    expect(left(target)).toEqual([]);
    expect(git(path, 'rev-parse', 'refs/heads/next')).toBe(targetCommit);
});

test('rolls back an unexpected outgoing conflict after the configured merge strategy differs from the check', async () => {
    const path = makeRepo(tempDir('git-merge'));
    identify(path);
    const target = join(tempDir('git-merge'), 'next');
    git(path, 'worktree', 'add', '-q', '-b', 'next', target);
    git(target, 'mv', 'README.md', 'guide.txt');
    git(target, 'commit', '-qm', 'Rename the guide');
    commitFile(path, 'README.md', 'Update the guide\n');
    git(target, 'config', 'branch.next.mergeOptions', '--strategy=resolve');
    const { call, preview, merge } = await open(path);
    const selection = { direction: 'into', branch: 'next', current: 'main' } as const;
    const plan = await preview(selection);

    expect(plan.conflictCheck).toBe('clean');
    const response = await call(merge(selection, plan));
    expect(response.status).toBe(409);
    expect(await response.text()).toContain("Can't merge into next because the branches conflict");
    expect(git(target, 'rev-parse', 'HEAD')).toBe(plan.targetCommit);
    expect(left(target)).toEqual([]);

    const squash = { ...selection, strategy: 'squash' } as const;
    const squashPlan = await preview(squash);
    expect(squashPlan.conflictCheck).toBe('clean');
    const squashResponse = await call(merge(squash, squashPlan));
    expect(squashResponse.status).toBe(409);
    expect(await squashResponse.text()).toContain("Can't squash into next because the branches conflict");
    expect(git(target, 'rev-parse', 'HEAD')).toBe(plan.targetCommit);
    expect(left(target)).toEqual([]);
});

test('removes an old disposable checkout only after an explicit matching abort', async () => {
    const path = makeRepo(tempDir('git-merge'));
    identify(path);
    git(path, 'switch', '-q', '-c', 'next');
    const targetCommit = commitFile(path, 'README.md', 'On the destination\n');
    git(path, 'switch', '-q', 'main');
    const sourceCommit = commitFile(path, 'README.md', 'On the source\n');
    const { h, call, result } = await open(path);
    const merges = join(h.config.workspacesDir, 'merges');
    mkdirSync(merges, { recursive: true });
    const legacy = mkdtempSync(join(merges, 'merge-'));
    const target = join(legacy, 'checkout');
    writeFileSync(join(legacy, 'clowdy-merge'), await switchRepositoryKey(path));
    git(path, 'worktree', 'add', '-q', target, 'next');

    const merge = Bun.spawnSync(['git', 'merge', sourceCommit], { cwd: target, stdout: 'pipe', stderr: 'pipe' });
    expect(merge.exitCode).toBe(1);
    expect(left(target)).toEqual(['UU README.md']);

    const abort = { action: 'abort', target: 'next', commit: targetCommit, sourceCommit } as const;
    expect((await call({ ...abort, sourceCommit: targetCommit })).status).toBe(409);
    expect(existsSync(target)).toBe(true);
    expect(await result(abort)).toEqual({ state: 'aborted', target: 'next' });
    expect(existsSync(legacy)).toBe(false);
    expect(git(path, 'rev-parse', 'refs/heads/next')).toBe(targetCommit);
});

test('rejects revision expressions, remote destinations, moved refs and a changed checked-out branch', async () => {
    const path = makeRepo(tempDir('git-merge'));
    identify(path);
    git(path, 'branch', 'next');
    commitFile(path, 'before-preview.txt');
    const { call, preview, merge } = await open(path);
    const selection = { direction: 'into', branch: 'next', current: 'main' } as const;

    expect((await call({ action: 'preview', ...selection, branch: 'HEAD~1' })).status).toBe(400);
    expect((await call({ action: 'preview', ...selection, remote: true })).status).toBe(400);
    const plan = await preview(selection);

    commitFile(path, 'after-preview.txt');
    expect((await call(merge(selection, plan))).status).toBe(409);
    expect(git(path, 'rev-parse', 'refs/heads/next')).toBe(plan.targetCommit);

    const refreshed = await preview(selection);
    git(path, 'switch', '-q', '-c', 'same-tip');
    expect((await call(merge(selection, refreshed))).status).toBe(409);
    expect(git(path, 'rev-parse', 'refs/heads/next')).toBe(plan.targetCommit);
});

import { afterAll, afterEach, expect, test } from 'bun:test';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROUTES } from '@clowdy/protocol';

import { commitFile, identify, isolated, left, neighbour, repository } from './gitRepos';
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

test('merges diverged branches in a disposable checkout and pushes only the explicitly selected result', async () => {
    const { path, origin } = repository();
    git(path, 'branch', 'feature/xyz');
    git(path, 'switch', '-q', '-c', 'next');
    const targetCommit = commitFile(path, 'next.txt');
    git(path, 'push', '-q', '-u', 'origin', 'next');
    git(path, 'switch', '-q', 'feature/xyz');
    const sourceCommit = commitFile(path, 'feature.txt');
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
    });
    expect(plan.targetPath).toBeUndefined();

    const outcome = await result(merge(selection, plan));
    const commit = git(path, 'rev-parse', 'refs/heads/next');

    expect(outcome).toEqual({ state: 'done', target: 'next', commit, canPush: true });
    expect(git(path, 'rev-list', '--parents', '-n', '1', commit)).toBe(`${commit} ${targetCommit} ${sourceCommit}`);
    expect(git(path, 'rev-parse', 'HEAD')).toBe(sourceCommit);
    expect(git(path, 'branch', '--show-current')).toBe('feature/xyz');
    expect(git(path, 'worktree', 'list', '--porcelain')).not.toContain('clowdy-merge');
    expect(git(path, 'worktree', 'list', '--porcelain')).not.toContain('branch refs/heads/next');
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

test('keeps a conflicting destination for inspection and removes its clean checkout after a matching abort', async () => {
    const path = makeRepo(tempDir('git-merge'));
    identify(path);
    git(path, 'switch', '-q', '-c', 'next');
    const targetCommit = commitFile(path, 'README.md', 'On the destination\n');
    git(path, 'switch', '-q', 'main');
    const sourceCommit = commitFile(path, 'README.md', 'On the source\n');
    const { call, result, preview, merge } = await open(path);
    const selection = { direction: 'into', branch: 'next', current: 'main' } as const;
    const request = merge(selection, await preview(selection));
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
    expect(existsSync(outcome.targetPath)).toBe(false);
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

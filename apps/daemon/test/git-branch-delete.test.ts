import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { commitFile, hook, isolated, neighbour, refsOf, repository } from './gitRepos';
import { cleanTempDirs, git, startHarness, tempDir } from './helpers';

import type { GitBranchDeletePreview, GitBranchDeleteRequest, GitBranchDeleteResult } from '@clowdy/protocol';
import type { Harness } from './helpers';

afterAll(cleanTempDirs);

const harnesses: Harness[] = [];
afterEach(async () => {
    await Promise.all(harnesses.splice(0).map(h => h.stop().catch(() => undefined)));
});

async function open(path: string) {
    const h = await startHarness({}, { gitEnvironment: isolated() });
    harnesses.push(h);
    const { project } = h.ok('project.add', { folders: [path] });
    const folderId = project.folders[0].id as string;
    const call = (request: GitBranchDeleteRequest, extra: Record<string, unknown> = {}) =>
        h.fetch(`/v1/projects/${project.id}/git/branch-delete`, {
            method: 'POST',
            body: JSON.stringify({ folderId, ...request, ...extra }),
        });
    const result = async (request: GitBranchDeleteRequest, extra: Record<string, unknown> = {}) => {
        const response = await call(request, extra);
        const body = await response.json();
        expect(response.status).toBe(200);

        return body as GitBranchDeleteResult;
    };
    const preview = async (branch: string, remote = false, extra: Record<string, unknown> = {}) => {
        const answer = await result({ action: 'preview', branch, ...(remote && { remote: true }) }, extra);
        expect(answer.state).toBe('preview');

        return answer as GitBranchDeletePreview;
    };
    const failure = async (request: GitBranchDeleteRequest, status = 409, extra: Record<string, unknown> = {}) => {
        const response = await call(request, extra);
        expect(response.status).toBe(status);

        return (await response.json()).error as { message: string };
    };

    return { h, project, folderId, preview, result, failure };
}

function confirmed(
    preview: GitBranchDeletePreview,
    origin = false
): Extract<GitBranchDeleteRequest, { action: 'delete' }> {
    return {
        action: 'delete',
        branch: preview.branch,
        ...(preview.localCommit && { localCommit: preview.localCommit }),
        ...(preview.localUnmerged && { localUnmerged: true }),
        ...(preview.switchTo && { switchTo: preview.switchTo }),
        ...(origin && preview.originCommit && { originCommit: preview.originCommit }),
        ...(origin && preview.originUnmerged && { originUnmerged: true }),
    };
}

const hasRef = (path: string, ref: string): boolean => refsOf(path).includes(`${ref} `);

function published() {
    const { path, origin } = repository();
    git(path, 'switch', '-q', '-c', 'feature/delete');
    const commit = commitFile(path, 'feature.txt');
    git(path, 'push', '-q', '-u', 'origin', 'feature/delete');
    git(path, 'switch', '-q', 'main');

    return { path, origin, commit };
}

describe('POST /v1/projects/:id/git/branch-delete', () => {
    test('warns about unmerged commits and deletes only the confirmed local branch by default', async () => {
        const { path, origin, commit } = published();
        const api = await open(path);
        const plan = await api.preview('feature/delete');

        expect(plan).toEqual({
            state: 'preview',
            branch: 'feature/delete',
            localCommit: commit,
            originCommit: commit,
            localUnmerged: true,
            originUnmerged: true,
        });
        expect(
            await api.failure({ action: 'delete', branch: plan.branch, localCommit: plan.localCommit })
        ).toMatchObject({ message: expect.stringContaining('unmerged commits') });
        expect(await api.result(confirmed(plan))).toEqual({
            state: 'done',
            localDeleted: true,
            originDeleted: false,
        });
        expect(hasRef(path, 'refs/heads/feature/delete')).toBe(false);
        expect(hasRef(path, 'refs/remotes/origin/feature/delete')).toBe(true);
        expect(hasRef(origin, 'refs/heads/feature/delete')).toBe(true);
        expect(git(path, 'branch', '--show-current')).toBe('main');
        expect(hasRef(path, 'refs/heads/main')).toBe(true);
    });

    test('deletes the same named origin branch only when explicitly confirmed, regardless of its upstream', async () => {
        const { path, origin } = published();
        git(path, 'merge', '--ff-only', 'feature/delete');
        git(path, 'push', '-q', 'origin', 'main');
        git(path, 'branch', '--set-upstream-to=origin/main', 'feature/delete');
        const api = await open(path);
        const plan = await api.preview('feature/delete');
        expect(plan).toMatchObject({ localUnmerged: false, originUnmerged: false });

        expect(await api.result(confirmed(plan, true))).toEqual({
            state: 'done',
            localDeleted: true,
            originDeleted: true,
        });
        expect(hasRef(path, 'refs/heads/feature/delete')).toBe(false);
        expect(hasRef(path, 'refs/remotes/origin/feature/delete')).toBe(false);
        expect(hasRef(origin, 'refs/heads/feature/delete')).toBe(false);
        expect(hasRef(origin, 'refs/heads/main')).toBe(true);
    });

    test('deletes an origin-only branch without creating or switching a local branch', async () => {
        const { path, origin, commit } = published();
        git(path, 'branch', '-D', 'feature/delete');
        const api = await open(path);
        const plan = await api.preview('feature/delete', true);

        expect(plan).toEqual({
            state: 'preview',
            branch: 'feature/delete',
            originCommit: commit,
            originUnmerged: true,
        });
        expect(
            await api.failure({ action: 'delete', branch: plan.branch, originCommit: plan.originCommit })
        ).toMatchObject({ message: expect.stringContaining('unmerged commits') });
        expect(await api.result(confirmed(plan, true))).toMatchObject({ localDeleted: false, originDeleted: true });
        expect(git(path, 'branch', '--show-current')).toBe('main');
        expect(hasRef(path, 'refs/heads/feature/delete')).toBe(false);
        expect(hasRef(origin, 'refs/heads/feature/delete')).toBe(false);
    });

    test('refuses both requested deletions when the confirmed local tip has changed', async () => {
        const { path, origin } = published();
        const api = await open(path);
        const plan = await api.preview('feature/delete');
        const moved = commitFile(path, 'new-local.txt');
        git(path, 'branch', '-f', 'feature/delete', moved);

        expect(await api.failure(confirmed(plan, true))).toMatchObject({ message: expect.stringContaining('changed') });
        expect(git(path, 'rev-parse', 'feature/delete')).toBe(moved);
        expect(git(origin, 'rev-parse', 'feature/delete')).toBe(plan.originCommit!);
    });

    test('requires fresh confirmation when a previously merged branch becomes unmerged', async () => {
        const { path } = repository();
        const older = git(path, 'rev-parse', 'HEAD');
        const commit = commitFile(path, 'to-rewind.txt');
        git(path, 'branch', 'feature/delete');
        const api = await open(path);
        api.h.ok('project.updateFolder', {
            projectId: api.project.id,
            folderId: api.folderId,
            settings: { baseBranch: 'main' },
        });
        const plan = await api.preview('feature/delete');
        expect(plan).toMatchObject({ localUnmerged: false });

        git(path, 'switch', '-q', '--detach', older);
        git(path, 'branch', '-f', 'main', older);
        git(path, 'switch', '-q', 'main');

        expect(await api.failure(confirmed(plan))).toMatchObject({
            message: expect.stringContaining('unmerged commits'),
        });
        expect(git(path, 'rev-parse', 'feature/delete')).toBe(commit);
    });

    test('protects a configured base and the default branch, even in direct delete requests', async () => {
        const { path, origin } = repository();
        git(path, 'branch', 'base');
        git(path, 'push', '-q', 'origin', 'base');
        const api = await open(path);
        api.h.ok('project.updateFolder', {
            projectId: api.project.id,
            folderId: api.folderId,
            settings: { baseBranch: 'origin/base' },
        });

        for (const branch of ['main', 'base']) {
            const plan = await api.preview(branch);
            expect(plan.blocked).toContain('base or default');
            expect(await api.failure(confirmed(plan, true))).toMatchObject({ message: plan.blocked! });
            expect(hasRef(path, `refs/heads/${branch}`)).toBe(true);
            expect(hasRef(origin, `refs/heads/${branch}`)).toBe(true);
        }
    });

    test('refuses a branch another worktree has checked out', async () => {
        const { path } = published();
        const other = join(tempDir('git-branch-delete'), 'held');
        git(path, 'worktree', 'add', '-q', other, 'feature/delete');
        const api = await open(path);
        const plan = await api.preview('feature/delete');
        expect(plan.blocked).toContain('Checked out in');
        expect(await api.failure(confirmed(plan, true))).toMatchObject({ message: plan.blocked! });
        expect(git(other, 'branch', '--show-current')).toBe('feature/delete');
        expect(hasRef(path, 'refs/heads/feature/delete')).toBe(true);
    });

    test('protects a branch saved as the base of another chat worktree', async () => {
        const { path, origin } = published();
        const api = await open(path);
        const plan = await api.preview('feature/delete');
        expect(plan.blocked).toBeUndefined();

        await api.h.okAsync('chat.create', {
            projectId: api.project.id,
            workspace: { mode: 'new', base: 'feature/delete' },
        });

        const blocked = await api.preview('feature/delete');
        expect(blocked.blocked).toContain('base of a chat worktree');
        expect(await api.failure(confirmed(plan, true))).toMatchObject({ message: blocked.blocked! });
        expect(git(path, 'rev-parse', 'feature/delete')).toBe(plan.localCommit!);
        expect(git(origin, 'rev-parse', 'feature/delete')).toBe(plan.originCommit!);
    });

    test('checks dirty files and the exact planned checkout before deleting a current branch', async () => {
        const { path } = published();
        git(path, 'switch', '-q', 'feature/delete');
        const api = await open(path);

        const dirty = join(path, 'uncommitted.txt');
        writeFileSync(dirty, 'Uncommitted\n');
        expect((await api.preview('feature/delete')).blocked).toContain('Commit or discard');
        unlinkSync(dirty);

        const plan = await api.preview('feature/delete');
        expect(plan.switchTo).toBe('main');
        expect(await api.failure({ ...confirmed(plan), switchTo: 'other' })).toMatchObject({
            message: expect.stringContaining('changed'),
        });
        expect(git(path, 'branch', '--show-current')).toBe('feature/delete');

        expect(await api.result(confirmed(plan))).toEqual({
            state: 'done',
            localDeleted: true,
            originDeleted: false,
            switchedTo: 'main',
        });
        expect(git(path, 'branch', '--show-current')).toBe('main');
        expect(hasRef(path, 'refs/heads/feature/delete')).toBe(false);
        expect(existsSync(join(path, 'feature.txt'))).toBe(false);
    });

    test('refuses to switch away from the current branch when the base is already checked out elsewhere', async () => {
        const { path } = published();
        git(path, 'switch', '-q', 'feature/delete');
        const other = join(tempDir('git-branch-delete'), 'base');
        git(path, 'worktree', 'add', '-q', other, 'main');
        const api = await open(path);
        const plan = await api.preview('feature/delete');
        expect(plan.blocked).toContain('Checked out in');
        expect(await api.failure(confirmed(plan))).toMatchObject({ message: plan.blocked! });
        expect(git(path, 'branch', '--show-current')).toBe('feature/delete');
    });

    test('honors the merge protection of a chat worktree and switches only its own checkout', async () => {
        const { path } = repository();
        git(path, 'switch', '-q', '-c', 'parking');
        const tree = join(tempDir('git-branch-delete'), 'chat-tree');
        git(path, 'worktree', 'add', '-q', '-b', 'chat-branch', tree, 'main');
        commitFile(tree, 'worktree.txt');

        const api = await open(path);
        const { id: workspaceId } = (
            await api.h.okAsync('chat.create', {
                projectId: api.project.id,
                workspace: { mode: 'existing', path: tree },
            })
        ).chat.workspace as { id: string };
        const extra = { workspaceId };
        const blocked = await api.preview('chat-branch', false, extra);
        expect(blocked.blocked).toContain('before switching');
        expect(await api.failure(confirmed(blocked), 409, extra)).toMatchObject({ message: blocked.blocked! });

        git(path, 'switch', '-q', 'main');
        git(path, 'merge', '--ff-only', 'chat-branch');
        git(path, 'push', '-q', 'origin', 'main');
        git(path, 'switch', '-q', 'parking');

        const plan = await api.preview('chat-branch', false, extra);
        expect(plan).toMatchObject({ switchTo: 'main', localUnmerged: false });
        expect(await api.result(confirmed(plan), extra)).toMatchObject({ switchedTo: 'main', localDeleted: true });
        expect(git(tree, 'branch', '--show-current')).toBe('main');
        expect(git(path, 'branch', '--show-current')).toBe('parking');
        expect(hasRef(path, 'refs/heads/chat-branch')).toBe(false);
        expect(existsSync(join(tree, 'worktree.txt'))).toBe(true);
    });

    test('rejects a changed fetched origin tip before deleting locally', async () => {
        const { path, origin, commit } = published();
        const api = await open(path);
        const plan = await api.preview('feature/delete');
        const other = neighbour(origin);
        git(other, 'switch', '-q', '--track', 'origin/feature/delete');
        const moved = commitFile(other, 'next-remote.txt');
        git(other, 'push', '-q', 'origin', 'feature/delete');
        git(path, 'fetch', '-q', 'origin');

        expect(await api.failure(confirmed(plan, true))).toMatchObject({ message: expect.stringContaining('changed') });
        expect(git(path, 'rev-parse', 'feature/delete')).toBe(commit);
        expect(git(origin, 'rev-parse', 'feature/delete')).toBe(moved);
    });

    test('uses a lease against an unfetched remote change and reports that local deletion had already succeeded', async () => {
        const { path, origin, commit } = published();
        const api = await open(path);
        const plan = await api.preview('feature/delete');
        const other = neighbour(origin);
        git(other, 'switch', '-q', '--track', 'origin/feature/delete');
        const moved = commitFile(other, 'next-remote.txt');
        git(other, 'push', '-q', 'origin', 'feature/delete');

        expect(git(path, 'rev-parse', 'refs/remotes/origin/feature/delete')).toBe(commit);
        expect(await api.failure(confirmed(plan, true))).toMatchObject({
            message: expect.stringContaining('Deleted feature/delete locally, but could not delete it on origin'),
        });
        expect(hasRef(path, 'refs/heads/feature/delete')).toBe(false);
        expect(git(origin, 'rev-parse', 'feature/delete')).toBe(moved);
    });

    test('requires at least one confirmed ref and a valid branch name', async () => {
        const { path, origin } = published();
        const api = await open(path);
        const before = refsOf(path);
        const remote = refsOf(origin);

        expect(await api.failure({ action: 'delete', branch: 'feature/delete' }, 400)).toMatchObject({
            message: 'Select a branch to delete',
        });
        expect(await api.failure({ action: 'preview', branch: '-D' }, 400)).toMatchObject({
            message: expect.stringContaining('dash'),
        });
        expect(refsOf(path)).toBe(before);
        expect(refsOf(origin)).toBe(remote);
    });
});

if (process.platform !== 'win32') {
    test('rechecks the local tip after the checkout hook has moved it', async () => {
        const { path } = published();
        git(path, 'switch', '-q', 'feature/delete');
        const api = await open(path);
        const plan = await api.preview('feature/delete');
        const main = git(path, 'rev-parse', 'main');
        hook(path, 'post-checkout', 'git update-ref refs/heads/feature/delete HEAD');

        expect(await api.failure(confirmed(plan))).toMatchObject({
            message: expect.stringContaining('Switched to main, but could not delete feature/delete'),
        });
        expect(git(path, 'branch', '--show-current')).toBe('main');
        expect(git(path, 'rev-parse', 'feature/delete')).toBe(main);
    });
}

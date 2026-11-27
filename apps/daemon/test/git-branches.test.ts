import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, realpathSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_GIT_BRANCH_ENTRIES, MAX_GIT_RECENT_BRANCHES } from '@clowdy/protocol';

import { defaultOf, parseLocalBranches, parseRemoteBranches, recentBranches } from '../src/git/branches';
import { bare, commitFile, commitFileAt, isolated, makeRefs, neighbour, refsOf, repository } from './gitRepos';
import { cleanTempDirs, git, makeRepo, startHarness, tempDir } from './helpers';

import type { GitBranches } from '@clowdy/protocol';
import type { Harness } from './helpers';

afterAll(cleanTempDirs);

const harnesses: Harness[] = [];

afterEach(async () => {
    await Promise.all(harnesses.splice(0).map(h => h.stop().catch(() => undefined)));
});

async function start(): Promise<Harness> {
    const h = await startHarness({}, { gitEnvironment: isolated() });

    harnesses.push(h);

    return h;
}

const json = async <T>(response: Response) => (await response.json()) as T;

/** The project of a repository and the read of its branches (of a worktree of it, by `workspaceId`). */
async function open(path: string, h: Harness) {
    const { project } = h.ok('project.add', { folders: [path] });
    const folderId = project.folders[0].id as string;
    const call = (place: Record<string, string> = {}) =>
        h.fetch(`/v1/projects/${project.id}/git/branches?${new URLSearchParams({ folderId, ...place })}`);
    const read = async (place: Record<string, string> = {}) => {
        const response = await call(place);

        expect(response.status).toBe(200);

        return await json<GitBranches>(response);
    };

    return { project, folderId, call, read };
}

/** The answer of a repository, so a test can read its lists. */
function listing(answer: GitBranches) {
    if (!answer.isRepository) throw new Error('not a repository');

    return answer;
}

describe('the parts of the listing', () => {
    test('parseLocalBranches reads the name, the upstream, the tip time and the checked out mark, and skips what is no local branch', () => {
        const output =
            `${['refs/heads/main', 'origin/main', '1700000000', '*'].join('\x1F')}\n` +
            `${['refs/heads/feature/x', '', '1700000100', ' '].join('\x1F')}\n` +
            `${['refs/remotes/origin/main', '', '1', ''].join('\x1F')}\n\n`;

        expect(parseLocalBranches(output)).toEqual([
            { name: 'main', current: true, upstream: 'origin/main', committedAt: 1_700_000_000_000 },
            { name: 'feature/x', current: false, committedAt: 1_700_000_100_000 },
        ]);
    });

    test("parseRemoteBranches reads the branches of origin and leaves out its HEAD and another remote's", () => {
        const output = `${['refs/remotes/origin/HEAD', '5'].join('\x1F')}\n${['refs/remotes/origin/feature/x', '1700000100'].join('\x1F')}\n${['refs/remotes/upstream/y', '2'].join('\x1F')}\n`;

        expect(parseRemoteBranches(output)).toEqual([{ name: 'feature/x', committedAt: 1_700_000_100_000 }]);
    });

    test('recentBranches takes the two names of each checkout line, newest first, once, only those that are local branches and not the current one, and at most five', () => {
        const reflog = [
            'checkout: moving from main to feat-6',
            'commit: a commit',
            'checkout: moving from feat-5 to main',
            'checkout: moving from 0123abc to feat-5',
            'checkout: moving from gone to feat-4',
            'checkout: moving from feat-3 to feat-2',
            'checkout: moving from feat-1 to feat-3',
            'checkout: moving from feat-0 to feat-1',
            'clone: from /srv/origin.git',
        ].join('\n');
        const local = new Set(['main', 'feat-0', 'feat-1', 'feat-2', 'feat-3', 'feat-4', 'feat-5', 'feat-6']);

        expect(recentBranches(reflog, local, 'feat-6')).toEqual(['main', 'feat-5', 'feat-4', 'feat-2', 'feat-3']);
        expect(recentBranches('', local, 'main')).toEqual([]);
    });

    test("defaultOf names the branch the base means: a local branch first, then the remote's without its prefix, nothing for what the lists do not have", () => {
        const local = new Set(['main', 'dev']);
        const remote = new Set(['next']);

        expect(defaultOf('main', local, remote)).toBe('main');
        expect(defaultOf('origin/main', local, remote)).toBe('main');
        expect(defaultOf('origin/next', local, remote)).toBe('next');
        expect(defaultOf('origin/gone', local, remote)).toBeUndefined();
        expect(defaultOf('upstream/main', local, remote)).toBeUndefined();
        expect(defaultOf(undefined, local, remote)).toBeUndefined();
    });
});

describe('GET /v1/projects/:id/git/branches', () => {
    test('lists the local branches with the current and the default one, the upstream and the newest first', async () => {
        const h = await start();
        const { path } = repository();

        git(path, 'switch', '-q', '-c', 'older');
        commitFileAt(path, 'older.txt', '2040-01-01T10:00:00Z');
        git(path, 'switch', '-q', '-c', 'feature/newer');
        commitFileAt(path, 'newer.txt', '2040-03-01T10:00:00Z');
        git(path, 'push', '-q', '-u', 'origin', 'feature/newer');

        const { read } = await open(path, h);
        const answer = listing(await read());

        expect(answer.defaultBranch).toBe('main');
        expect(answer.local.map(branch => branch.name)).toEqual(['feature/newer', 'older', 'main']);
        expect(answer.local[0]).toMatchObject({
            name: 'feature/newer',
            current: true,
            upstream: 'origin/feature/newer',
        });
        expect(answer.local[0]!.committedAt).toBe(Date.parse('2040-03-01T10:00:00Z'));
        expect(answer.local[1]).toEqual({ name: 'older', committedAt: Date.parse('2040-01-01T10:00:00Z') });
        expect(answer.local[2]).toMatchObject({ name: 'main', default: true, upstream: 'origin/main' });
        expect(answer.local.filter(branch => branch.current)).toHaveLength(1);
        expect(answer.truncated).toBeUndefined();
    });

    test('lists the branches of origin that have no local branch, without its HEAD, and not the ones that have one', async () => {
        const h = await start();
        const { path, origin } = repository();
        const other = neighbour(origin);

        git(other, 'switch', '-q', '-c', 'feature/only-there');
        commitFileAt(other, 'there.txt', '2026-02-01T10:00:00Z');
        git(other, 'push', '-q', 'origin', 'feature/only-there');
        git(other, 'switch', '-q', '-c', 'also-here');
        git(other, 'push', '-q', 'origin', 'also-here');
        git(path, 'fetch', '-q', 'origin');
        git(path, 'branch', '-q', 'also-here', 'origin/also-here');
        git(path, 'remote', 'set-head', 'origin', 'main');

        const { read } = await open(path, h);
        const answer = listing(await read());

        expect(answer.remote).toEqual([
            { name: 'feature/only-there', committedAt: Date.parse('2026-02-01T10:00:00Z') },
        ]);
        expect(answer.local.map(branch => branch.name).sort()).toEqual(['also-here', 'main']);
    });

    test('marks the default branch of origin when it has no local branch, and follows what origin names as its HEAD', async () => {
        const h = await start();
        const { path, origin } = repository();
        const other = neighbour(origin);

        git(other, 'switch', '-q', '-c', 'trunk');
        commitFile(other, 'trunk.txt');
        git(other, 'push', '-q', 'origin', 'trunk');
        git(path, 'fetch', '-q', 'origin');
        git(path, 'remote', 'set-head', 'origin', 'trunk');

        const { read } = await open(path, h);
        const answer = listing(await read());

        expect(answer.defaultBranch).toBe('trunk');
        expect(answer.remote).toEqual([{ name: 'trunk', default: true, committedAt: expect.any(Number) }]);
        expect(answer.local.some(branch => branch.default)).toBe(false);
    });

    test("names the worktree that has a branch checked out: a chat's by its workspace id, one the person made by its path, and not the place's own branch", async () => {
        const h = await start();
        const { path } = repository();
        // Git lists a worktree by its real place.
        const chatTree = join(realpathSync(tempDir('git-branches')), 'chat-tree');
        const ownTree = join(realpathSync(tempDir('git-branches')), 'own-tree');

        git(path, 'worktree', 'add', '-q', '-b', 'chat-branch', chatTree);
        git(path, 'worktree', 'add', '-q', '-b', 'own-branch', ownTree);

        const { project, read } = await open(path, h);
        const workspaceId = (
            (await h.okAsync('chat.create', { projectId: project.id, workspace: { mode: 'existing', path: chatTree } }))
                .chat.workspace as { id: string }
        ).id;
        const answer = listing(await read());
        const byName = (list: typeof answer, name: string) => list.local.find(branch => branch.name === name)!;

        expect(byName(answer, 'chat-branch').heldBy).toEqual({ path: chatTree, workspaceId });
        expect(byName(answer, 'own-branch').heldBy).toEqual({ path: ownTree });
        expect(byName(answer, 'main').heldBy).toBeUndefined();
        expect(byName(answer, 'main').current).toBe(true);

        // Seen from the worktree, the main checkout holds `main`, and the worktree's own branch is its current one.
        const fromTree = listing(await read({ workspaceId }));

        expect(byName(fromTree, 'main').heldBy).toEqual({ path: realpathSync(path), main: true });
        expect(byName(fromTree, 'chat-branch').current).toBe(true);
        expect(byName(fromTree, 'chat-branch').heldBy).toBeUndefined();
        expect(byName(fromTree, 'own-branch').heldBy).toEqual({ path: ownTree });
    });

    test('recognises a worktree through a link to it', async () => {
        const h = await start();
        const { path } = repository();
        const tree = join(tempDir('git-branches'), 'tree');
        const link = join(tempDir('git-branches'), 'link');

        git(path, 'worktree', 'add', '-q', '-b', 'linked', tree);
        symlinkSync(tree, link);

        const { project, read } = await open(path, h);
        const workspaceId = (
            (await h.okAsync('chat.create', { projectId: project.id, workspace: { mode: 'existing', path: link } }))
                .chat.workspace as { id: string }
        ).id;

        expect(listing(await read()).local.find(branch => branch.name === 'linked')!.heldBy).toMatchObject({
            workspaceId,
        });
    });

    test('lists the branches HEAD was on lately from the reflog: newest first, the current one left out, a deleted one and a detached hash left out, at most five', async () => {
        const h = await start();
        const { path } = repository();

        for (const name of ['one', 'two', 'three', 'four', 'five', 'six']) git(path, 'branch', name);

        for (const name of ['one', 'two', 'three', 'four', 'five', 'six', 'main']) git(path, 'switch', '-q', name);

        git(path, 'switch', '-q', '--detach');
        git(path, 'switch', '-q', 'two');
        git(path, 'branch', '-q', 'doomed');
        git(path, 'switch', '-q', 'doomed');
        git(path, 'switch', '-q', 'two');
        git(path, 'branch', '-q', '-D', 'doomed');

        const { read } = await open(path, h);
        const answer = listing(await read());

        expect(answer.recent).toEqual(['main', 'six', 'five', 'four', 'three']);
        expect(answer.recent).toHaveLength(MAX_GIT_RECENT_BRANCHES);
        expect(answer.recent).not.toContain('two');
        expect(answer.recent).not.toContain('doomed');
    });

    test('has no current branch on a detached HEAD and still lists the others', async () => {
        const h = await start();
        const { path } = repository();

        git(path, 'branch', 'other');
        git(path, 'switch', '-q', '--detach');

        const answer = listing(await (await open(path, h)).read());

        expect(answer.local.map(branch => branch.name).sort()).toEqual(['main', 'other']);
        expect(answer.local.some(branch => branch.current)).toBe(false);
    });

    test('cuts each list at the cap and says so, and keeps the current branch and the default one wherever they are', async () => {
        const h = await start();
        const { path } = repository();
        const count = MAX_GIT_BRANCH_ENTRIES + 5;

        makeRefs(
            path,
            Array.from({ length: count }, (_, index) => `refs/heads/b${String(index).padStart(4, '0')}`)
        );
        makeRefs(
            path,
            Array.from({ length: count }, (_, index) => `refs/remotes/origin/r${String(index).padStart(4, '0')}`)
        );
        git(path, 'branch', 'zzz-current');
        git(path, 'switch', '-q', 'zzz-current');

        const answer = listing(await (await open(path, h)).read());

        expect(answer.truncated).toBe(true);
        expect(answer.remote).toHaveLength(MAX_GIT_BRANCH_ENTRIES);
        // The 300 first by name (the tips are one commit) and then the two that must not be lost.
        expect(answer.local).toHaveLength(MAX_GIT_BRANCH_ENTRIES + 2);
        expect(answer.local.find(branch => branch.current)?.name).toBe('zzz-current');
        expect(answer.local.find(branch => branch.default)?.name).toBe('main');
    });

    test('reads nothing and changes nothing: the refs, the index and the files stay as they were', async () => {
        const h = await start();
        const { path } = repository();

        git(path, 'branch', 'other');
        commitFile(path, 'dir/a.txt');
        mkdirSync(join(path, 'untracked'));

        const state = () => [
            refsOf(path),
            git(path, 'status', '--porcelain', '--untracked-files=all'),
            git(path, 'rev-parse', 'HEAD'),
            git(path, 'reflog', 'show', 'HEAD'),
        ];
        const before = state();

        await (await open(path, h)).read();

        expect(state()).toEqual(before);
    });

    test('answers a repository with no commit with empty lists, and a folder that is not a repository, or is inside one, as no repository', async () => {
        const h = await start();
        const unborn = tempDir('git-branches');

        git(unborn, 'init', '-q', '-b', 'main');

        expect(listing(await (await open(unborn, h)).read())).toEqual({
            isRepository: true,
            local: [],
            remote: [],
            recent: [],
        });
        expect(await (await open(tempDir('git-branches'), h)).read()).toEqual({ isRepository: false });

        const { path } = repository();

        mkdirSync(join(path, 'inner'));
        expect(await (await open(join(path, 'inner'), h)).read()).toEqual({ isRepository: false });
    });

    test("answers as the other place reads do: 400 for no folder, 404 for a folder or a workspace that is not the project's, 503 for a worktree that is gone", async () => {
        const h = await start();
        const { path } = repository();
        const { project, call } = await open(path, h);
        const tree = join(tempDir('git-branches'), 'tree');

        expect((await h.fetch(`/v1/projects/${project.id}/git/branches`)).status).toBe(400);
        expect((await h.fetch(`/v1/projects/${project.id}/git/branches?folderId=fld_none`)).status).toBe(404);
        expect((await call({ workspaceId: 'wks_none' })).status).toBe(404);
        expect((await h.fetch('/v1/projects/prj_none/git/branches?folderId=x')).status).toBe(404);

        git(path, 'worktree', 'add', '-q', '-b', 'gone-branch', tree);

        const workspaceId = (
            (await h.okAsync('chat.create', { projectId: project.id, workspace: { mode: 'existing', path: tree } }))
                .chat.workspace as { id: string }
        ).id;

        git(path, 'worktree', 'remove', '--force', tree);
        expect((await call({ workspaceId })).status).toBe(503);
    });

    test("reads the branches of another folder's repository through its own place", async () => {
        const h = await start();
        const { path } = repository(bare());
        const second = makeRepo(tempDir('git-branches'), 'second');

        git(second, 'branch', 'second-only');

        const { project } = h.ok('project.add', { folders: [path, second] });
        const folderId = project.folders[1].id as string;
        const answer = listing(
            await json<GitBranches>(
                await h.fetch(`/v1/projects/${project.id}/git/branches?${new URLSearchParams({ folderId })}`)
            )
        );

        expect(answer.local.map(branch => branch.name).sort()).toEqual(['main', 'second-only']);
    });
});

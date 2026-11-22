import { MAX_GIT_BRANCHES } from '@clowdy/protocol';
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { gitRead } from '../src/domain/git';
import { CommandError } from '../src/errors';
import { baseOf, defaultBranchOf, folderGit, parseWorktrees, projectFolderGit } from '../src/git/state';
import { cleanTempDirs, git, Harness, makeRepo, startHarness, tempDir } from './helpers';

import type { FolderGit, FolderSettings, Project, ProjectFolder } from '@clowdy/protocol';

afterAll(cleanTempDirs);

type Repository = Extract<FolderGit, { isRepository: true }>;

/** What `folderGit` says of a folder that is a repository: the answer is checked to be one. */
async function repository(folder: string): Promise<Repository> {
    const answer = await folderGit(folder);

    if (!answer.isRepository) throw new Error(`${ folder } is not a repository`);

    return answer;
}

/**
 * A clone of a bare `origin` that has `main` and `dev`, so the clone has `origin/main`, `origin/dev` and an `origin/HEAD` that names the bare repository's
 * HEAD (`main`, or `head` when it is given).
 */
function clone(head = 'main'): { work: string; origin: string; seed: string } {
    const root = tempDir('git-state');
    const origin = join(root, 'origin.git');
    const seed = makeRepo(root, 'seed');

    git(root, 'init', '--bare', '-q', '-b', 'main', origin);
    git(seed, 'remote', 'add', 'origin', origin);
    git(seed, 'push', '-q', 'origin', 'main', 'main:dev', ...(head === 'main' ? [] : [`main:${ head }`]));
    git(origin, 'symbolic-ref', 'HEAD', `refs/heads/${ head }`);
    git(root, 'clone', '-q', origin, 'work');

    return { work: join(root, 'work'), origin, seed };
}

describe('folderGit', () => {
    test('says a folder that is no repository, or lies inside one, is none', async () => {
        const plain = tempDir('git-state');
        const repo = makeRepo(tempDir('git-state'), 'app');

        mkdirSync(join(repo, 'packages'));

        expect(await folderGit(plain)).toEqual({ isRepository: false });
        // A worktree is made of the whole repository, so a folder below its root has none of its own.
        expect(await folderGit(join(repo, 'packages'))).toEqual({ isRepository: false });
    });

    test('is unavailable, not "no repository", where git cannot be run in the folder', async () => {
        await expect(folderGit(join(tempDir('git-state'), 'missing'))).rejects.toMatchObject({ code: 'unavailable' });
    });

    test('lists the branches, local first and then the remote\'s without its HEAD, the default one and the folder\'s own worktree', async () => {
        const { work } = clone();

        git(work, 'branch', 'feature');
        git(work, 'branch', 'a/b');

        const answer = await repository(work);

        expect(answer.branch).toBe('main');
        expect(answer.detached).toBeUndefined();
        expect(answer.defaultBranch).toBe('origin/main');
        expect(answer.branches).toEqual([
            { name: 'a/b', remote: false },
            { name: 'feature', remote: false },
            { name: 'main', remote: false },
            { name: 'origin/dev', remote: true },
            { name: 'origin/main', remote: true },
        ]);
        expect(answer.worktrees).toEqual([{ path: realpathSync(work), branch: 'main', head: git(work, 'rev-parse', '--short=7', 'HEAD'), main: true, dirty: false }]);
        expect(answer.truncated).toBeUndefined();
    });

    test('lists a linked worktree, whoever made it, with its branch and whether it has changes, and the folder\'s own checkout flagged', async () => {
        const { work } = clone();
        const linked = join(tempDir('git-state'), 'linked');

        git(work, 'worktree', 'add', '-q', '-b', 'topic', linked);
        writeFileSync(join(work, 'new.txt'), 'x');

        const answer = await repository(work);

        // The folder is dirty (an untracked file), the linked worktree is clean.
        expect(answer.worktrees.map(({ path, branch, main, dirty }) => ({ path, branch, main, dirty }))).toEqual([
            { path: realpathSync(work), branch: 'main', main: true, dirty: true },
            { path: realpathSync(linked), branch: 'topic', main: false, dirty: false },
        ]);

        writeFileSync(join(linked, 'README.md'), 'changed');

        expect((await repository(work)).worktrees.map(entry => entry.dirty)).toEqual([true, true]);

        // From inside the linked worktree it is the folder itself that is flagged.
        expect((await repository(linked)).worktrees.map(entry => [entry.branch, entry.main])).toEqual([['main', false], ['topic', true]]);
    });

    test('leaves out a worktree whose folder is gone, which git would prune', async () => {
        const { work } = clone();
        const linked = join(tempDir('git-state'), 'linked');

        git(work, 'worktree', 'add', '-q', '-b', 'topic', linked);
        rmSync(linked, { recursive: true });

        expect((await repository(work)).worktrees.map(entry => entry.branch)).toEqual(['main']);
    });

    test('names a detached HEAD by its hash and gives its worktree no branch', async () => {
        const { work } = clone();

        git(work, 'checkout', '-q', '--detach');

        const answer = await repository(work);
        const short = git(work, 'rev-parse', '--short', 'HEAD');

        expect(answer).toMatchObject({ branch: short, detached: true, defaultBranch: 'origin/main' });
        expect(answer.worktrees[0]).toMatchObject({ main: true, dirty: false });
        expect(answer.worktrees[0]).not.toHaveProperty('branch');
    });

    test('is a repository with nothing to start from while it has no commit', async () => {
        const folder = tempDir('git-state');

        git(folder, 'init', '-q', '-b', 'main');

        const answer = await repository(folder);

        expect(answer).toMatchObject({ branch: 'main', branches: [], worktrees: [{ path: realpathSync(folder), main: true, head: '', dirty: false }] });
        expect(answer.defaultBranch).toBeUndefined();
    });

    test('says a new file is a change whatever the person\'s git says of untracked files', async () => {
        const repo = makeRepo(tempDir('git-state'), 'app');

        git(repo, 'config', 'status.showUntrackedFiles', 'no');
        writeFileSync(join(repo, 'new.txt'), 'x');

        expect(git(repo, 'status', '--porcelain')).toBe('');
        expect((await repository(repo)).worktrees[0]?.dirty).toBe(true);
    });

    test('leaves out a locked worktree whose folder is gone, though git does not offer to prune it', async () => {
        const { work } = clone();
        const linked = join(tempDir('git-state'), 'linked');

        git(work, 'worktree', 'add', '-q', '-b', 'topic', linked);
        git(work, 'worktree', 'lock', linked);
        rmSync(linked, { recursive: true });

        expect((await repository(work)).worktrees.map(entry => entry.branch)).toEqual(['main']);
    });

    test('finds the folder\'s own checkout in a repository that keeps its git directory elsewhere, where git names the git directory as the main worktree', async () => {
        const root = tempDir('git-state');
        const folder = join(root, 'app');

        mkdirSync(folder);
        git(root, 'init', '-q', '-b', 'main', '--separate-git-dir', join(root, 'app.git'), folder);
        writeFileSync(join(folder, 'a.txt'), 'x');
        git(folder, 'add', '.');
        git(folder, 'commit', '-q', '-m', 'first');
        git(folder, 'worktree', 'add', '-q', '-b', 'topic', join(root, 'linked'));

        const answer = await repository(folder);

        expect(answer.worktrees.map(entry => [entry.path, entry.branch, entry.main])).toEqual([[realpathSync(folder), 'main', true], [realpathSync(join(root, 'linked')), 'topic', false]]);
    });

    test('cuts a repository with more branches than it lists, the local ones kept first', async () => {
        const repo = makeRepo(tempDir('git-state'), 'app');
        const refs = Array.from({ length: MAX_GIT_BRANCHES + 5 }, (_, index) => `create refs/heads/b${ String(index).padStart(5, '0') } HEAD\n`).join('');

        Bun.spawnSync(['git', 'update-ref', '--stdin'], { cwd: repo, stdin: new TextEncoder().encode(refs) });

        const answer = await repository(repo);

        expect(answer.branches).toHaveLength(MAX_GIT_BRANCHES);
        expect(answer.truncated).toBe(true);
        expect(answer.branches.every(branch => !branch.remote)).toBe(true);
    });
});

describe('defaultBranchOf', () => {
    test('is the branch origin/HEAD names, whatever it is called', async () => {
        const { work } = clone('next');

        expect(await defaultBranchOf(work)).toBe('origin/next');
    });

    test('falls to origin/main when origin/HEAD points at a branch the repository no longer has', async () => {
        const { work } = clone();

        git(work, 'remote', 'set-head', 'origin', 'dev');
        expect(await defaultBranchOf(work)).toBe('origin/dev');

        git(work, 'update-ref', '-d', 'refs/remotes/origin/dev');
        expect(await defaultBranchOf(work)).toBe('origin/main');
    });

    test('prefers origin/main, then origin/master, then a local main, then a local master', async () => {
        const repo = makeRepo(tempDir('git-state'), 'app');

        expect(await defaultBranchOf(repo)).toBe('main');

        git(repo, 'update-ref', 'refs/remotes/origin/master', 'HEAD');
        expect(await defaultBranchOf(repo)).toBe('origin/master');

        git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
        expect(await defaultBranchOf(repo)).toBe('origin/main');

        const local = makeRepo(tempDir('git-state'), 'local');

        git(local, 'branch', '-m', 'master');
        expect(await defaultBranchOf(local)).toBe('master');
    });

    test('falls to the branch that is checked out when none of those exists, and to its short hash on a detached HEAD', async () => {
        const repo = makeRepo(tempDir('git-state'), 'app');

        git(repo, 'branch', '-m', 'trunk');
        expect(await defaultBranchOf(repo)).toBe('trunk');

        git(repo, 'checkout', '-q', '--detach');
        expect(await defaultBranchOf(repo)).toBe(git(repo, 'rev-parse', '--short', 'HEAD'));
    });

    test('is nothing where there is no commit, and nothing for a folder that is no repository', async () => {
        const folder = tempDir('git-state');

        expect(await defaultBranchOf(folder)).toBeUndefined();

        git(folder, 'init', '-q', '-b', 'main');
        expect(await defaultBranchOf(folder)).toBeUndefined();
    });
});

describe('baseOf', () => {
    const folderOf = (path: string, settings?: FolderSettings): ProjectFolder => ({ id: 'fld_base', path, ...(settings && { settings }) });

    test('is the default branch for a folder with no settings or no base branch', async () => {
        const { work } = clone('next');

        expect(await baseOf(folderOf(work))).toBe('origin/next');
        expect(await baseOf(folderOf(work, {}))).toBe('origin/next');
        expect(await baseOf(folderOf(work, { setup: { files: ['.env'] } }))).toBe('origin/next');
        expect(await baseOf(folderOf(work))).toBe(await defaultBranchOf(work));
    });

    test('is the configured branch when the repository has it as a local branch', async () => {
        const { work } = clone();

        git(work, 'branch', 'develop');
        expect(await baseOf(folderOf(work, { baseBranch: 'develop' }))).toBe('develop');
        expect(await baseOf(folderOf(work, { baseBranch: 'main' }))).toBe('main');
    });

    test('accepts a branch of a remote, written with the remote\'s name, and a branch with a slash in it', async () => {
        const { work } = clone();

        git(work, 'branch', 'team/next');
        expect(await baseOf(folderOf(work, { baseBranch: 'origin/dev' }))).toBe('origin/dev');
        expect(await baseOf(folderOf(work, { baseBranch: 'team/next' }))).toBe('team/next');
    });

    test('skips a configured branch the repository does not have, so the default stands', async () => {
        const { work } = clone();

        // `dev` exists on the remote only: a bare name is a local branch.
        for (const baseBranch of ['nope', 'dev', 'origin/nope', 'refs/heads/main', 'MAIN', 'origin']) {
            expect(await baseOf(folderOf(work, { baseBranch })), baseBranch).toBe('origin/main');
        }

        const plain = makeRepo(tempDir('git-state'), 'plain');

        expect(await baseOf(folderOf(plain, { baseBranch: 'develop' }))).toBe('main');
    });

    test('does not take a tag or a deleted branch for a branch', async () => {
        const repo = makeRepo(tempDir('git-state'), 'app');

        git(repo, 'tag', 'v1');
        git(repo, 'branch', 'gone');
        git(repo, 'branch', '-D', 'gone');
        expect(await baseOf(folderOf(repo, { baseBranch: 'v1' }))).toBe('main');
        expect(await baseOf(folderOf(repo, { baseBranch: 'gone' }))).toBe('main');
    });

    test('is nothing for a repository with no commit or a folder that is no repository, whatever is configured', async () => {
        const empty = tempDir('git-state');

        expect(await baseOf(folderOf(empty, { baseBranch: 'main' }))).toBeUndefined();

        git(empty, 'init', '-q', '-b', 'main');
        expect(await baseOf(folderOf(empty, { baseBranch: 'main' }))).toBeUndefined();
    });
});

describe('gitRead', () => {
    test('tells git\'s own no from a git that could not be asked', async () => {
        expect(await gitRead(tempDir('git-state'), ['rev-parse', '--show-toplevel'])).toEqual({ ok: false, reason: 'failed' });
        expect(await gitRead(join(tempDir('git-state'), 'missing'), ['status'])).toEqual({ ok: false, reason: 'unavailable' });
        expect(await gitRead(makeRepo(tempDir('git-state'), 'app'), ['rev-parse', '--abbrev-ref', 'HEAD'])).toEqual({ ok: true, stdout: 'main\n' });
    });
});

describe('parseWorktrees', () => {
    test('reads the blocks of git\'s porcelain list: branch, detached, bare, prunable, a path with spaces', () => {
        const output = [
            'worktree /work/my app',
            'HEAD 1111111111111111111111111111111111111111',
            'branch refs/heads/main',
            '',
            'worktree /work/linked',
            'HEAD 2222222222222222222222222222222222222222',
            'detached',
            'locked reason',
            '',
            'worktree /work/gone',
            'HEAD 3333333333333333333333333333333333333333',
            'branch refs/heads/feature/x',
            'prunable gitdir file points to non-existent location',
            '',
            'worktree /work/bare.git',
            'bare',
            '',
        ].join('\n');

        expect(parseWorktrees(output)).toEqual([
            { path: '/work/my app', head: '1111111111111111111111111111111111111111', branch: 'main', bare: false, prunable: false },
            { path: '/work/linked', head: '2222222222222222222222222222222222222222', bare: false, prunable: false },
            { path: '/work/gone', head: '3333333333333333333333333333333333333333', branch: 'feature/x', bare: false, prunable: true },
            { path: '/work/bare.git', head: '', bare: true, prunable: false },
        ]);
        expect(parseWorktrees('')).toEqual([]);
    });
});

describe('projectFolderGit', () => {
    const projectOf = (folders: Project['folders']): Project => ({ id: 'prj_git', name: 'git', folders, taskPrefix: 'GIT', settings: {}, createdAt: 1, position: 1 });

    async function failure(promise: Promise<unknown>): Promise<CommandError> {
        try {
            await promise;
        }
        catch (error) {
            if (error instanceof CommandError) return error;

            throw error;
        }

        throw new Error('It did not fail');
    }

    test('answers for a folder of the project by its id, and refuses none, an unknown one and one gone from the disk', async () => {
        const repo = makeRepo(tempDir('git-state'), 'app');
        const gone = join(tempDir('git-state'), 'gone');
        const project = projectOf([{ id: 'fld_app', path: repo }, { id: 'fld_gone', path: gone }]);

        expect(await projectFolderGit(project, 'fld_app')).toMatchObject({ isRepository: true, branch: 'main', defaultBranch: 'main' });
        expect((await failure(projectFolderGit(project, ''))).code).toBe('invalid');
        expect((await failure(projectFolderGit(project, 'fld_other'))).code).toBe('not_found');
        expect((await failure(projectFolderGit(project, 'fld_gone'))).code).toBe('unavailable');
    });

    test('answers the folder\'s own base as the default branch when its repository has it, and the default otherwise', async () => {
        const { work } = clone();
        const other = makeRepo(tempDir('git-state'), 'other');
        const project = projectOf([
            { id: 'fld_dev', path: work, settings: { baseBranch: 'origin/dev' } },
            { id: 'fld_missing', path: other, settings: { baseBranch: 'origin/dev' } },
            { id: 'fld_plain', path: work },
        ]);

        // The same folder answers each entry by its own settings, as the same path in two projects would.
        expect(await projectFolderGit(project, 'fld_dev')).toMatchObject({ isRepository: true, defaultBranch: 'origin/dev' });
        expect(await projectFolderGit(project, 'fld_plain')).toMatchObject({ isRepository: true, defaultBranch: 'origin/main' });
        expect(await projectFolderGit(project, 'fld_missing')).toMatchObject({ isRepository: true, defaultBranch: 'main' });
    });
});

describe('GET /v1/projects/:id/git', () => {
    let h: Harness;

    beforeEach(async () => {
        h = await startHarness();
    });

    afterEach(async () => {
        await h.stop();
    });

    test('answers a folder\'s branches and worktrees over HTTP, behind the token, and says what is wrong with the request', async () => {
        const repo = realpathSync(makeRepo(tempDir('git-state'), 'app'));
        const plain = realpathSync(tempDir('git-state'));
        const { project } = h.ok('project.add', { folders: [repo, plain] });
        const [first, second] = project.folders;
        const route = `/v1/projects/${ project.id }/git`;

        const answer = await (await h.fetch(`${ route }?folderId=${ first.id }`)).json() as Repository;

        expect(answer).toMatchObject({ isRepository: true, branch: 'main', defaultBranch: 'main', branches: [{ name: 'main', remote: false }], worktrees: [{ path: repo, branch: 'main', main: true, dirty: false }] });
        expect(await (await h.fetch(`${ route }?folderId=${ second.id }`)).json()).toEqual({ isRepository: false });
        expect((await h.fetch(route)).status).toBe(400);
        expect((await h.fetch(`${ route }?folderId=fld_unknown`)).status).toBe(404);

        rmSync(plain, { recursive: true });
        expect((await h.fetch(`${ route }?folderId=${ second.id }`)).status).toBe(503);
        expect((await fetch(`${ h.url }${ route }?folderId=${ first.id }`)).status).toBe(401);
        expect((await h.fetch(`/v1/projects/prj_unknown/git?folderId=${ first.id }`)).status).toBe(404);
    });

    test('answers the folder\'s base branch as its default once the person sets one, and the repository\'s own again once it is cleared or gone', async () => {
        const repo = realpathSync(makeRepo(tempDir('git-state'), 'app'));
        const { project } = h.ok('project.add', { folders: [repo] });
        const folderId = project.folders[0].id as string;
        const defaultOf = async () => (await (await h.fetch(`/v1/projects/${ project.id }/git?folderId=${ folderId }`)).json() as Repository).defaultBranch;

        git(repo, 'branch', 'develop');
        expect(await defaultOf()).toBe('main');

        h.ok('project.updateFolder', { projectId: project.id, folderId, settings: { baseBranch: 'develop' } });
        expect(await defaultOf()).toBe('develop');

        git(repo, 'branch', '-D', 'develop');
        expect(await defaultOf()).toBe('main');

        git(repo, 'branch', 'develop');
        h.ok('project.updateFolder', { projectId: project.id, folderId, settings: { baseBranch: null } });
        expect(await defaultOf()).toBe('main');
    });
});

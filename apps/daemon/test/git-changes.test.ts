import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
    commitScope,
    MAX_GIT_CHANGED_FILES,
    MAX_GIT_COMMITS,
    MAX_GIT_SIDE_BYTES,
    MAX_GIT_STATUS_ENTRIES,
    turnScope,
} from '@clowdy/protocol';

import { gitRead, gitRecords } from '../src/domain/git';
import { CommandError } from '../src/errors';
import { parseDiff, placeChanges, placeFile } from '../src/git/changes';
import { snapshotTree } from '../src/git/snapshot';
import { folderGit } from '../src/git/state';
import { mergeBaseOf, parseStatus, placeStatus, readBase, resolveRef } from '../src/git/status';
import { cleanTempDirs, GIT_IDENTITY, git, makeRepo, startHarness, tempDir } from './helpers';

import type { GitChanges, GitFileSides, GitScope, GitStatus } from '@clowdy/protocol';
import type { Place } from '../src/domain/places';
import type { Harness } from './helpers';

afterAll(cleanTempDirs);

const posix = process.platform !== 'win32';
const onPosix = posix ? test : test.skip;

/** A place at a checkout, as `resolvePlace` makes one for a folder. */
const placeAt = (path: string, base?: string): Place => ({
    folder: { id: 'fld_test', path },
    path,
    ...(base !== undefined && {
        workspace: {
            id: 'wks_test',
            projectId: 'prj_test',
            folderId: 'fld_test',
            path,
            base,
            managed: false,
            ready: true,
            createdAt: 1,
        },
    }),
});

/** Writes files (and the folders above them) under `root`. */
function put(root: string, files: Record<string, string | Buffer>): void {
    for (const [path, content] of Object.entries(files)) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), content);
    }
}

/** Stages everything and commits it. */
function commit(path: string, message: string): string {
    git(path, 'add', '-A');
    git(path, 'commit', '-q', '-m', message);

    return git(path, 'rev-parse', 'HEAD');
}

const lines = (...text: string[]) => `${text.join('\n')}\n`;

/** A bare `origin` with `main` and `dev`, a clone of it whose `main` tracks `origin/main`, and the seed repository both came from. */
function clone(): { root: string; work: string; origin: string; seed: string } {
    const root = tempDir('git-changes');
    const origin = join(root, 'origin.git');
    const seed = makeRepo(root, 'seed');

    put(seed, {
        'lib.ts': lines('a', 'b', 'c'),
        'old-name.ts': lines('export const x = 1;', 'export const y = 2;', 'export const z = 3;'),
        'gone.txt': lines('bye'),
    });
    commit(seed, 'Add the base files');
    git(root, 'init', '--bare', '-q', '-b', 'main', origin);
    git(seed, 'remote', 'add', 'origin', origin);
    git(seed, 'push', '-q', 'origin', 'main', 'main:dev');
    git(origin, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    git(root, 'clone', '-q', origin, 'work');

    return { root, work: join(root, 'work'), origin, seed };
}

/** What a read of a place that is a repository answers: the answer is checked to be one. */
async function status(place: Place, options?: { base?: string }): Promise<Extract<GitStatus, { isRepository: true }>> {
    const answer = await placeStatus(place, options);

    if (!answer.isRepository) throw new Error(`${place.path} is not a repository`);

    return answer;
}

async function changes(
    place: Place,
    scope: GitScope,
    options?: { base?: string }
): Promise<Extract<GitChanges, { isRepository: true }>> {
    const answer = await placeChanges(place, scope, options);

    if (!answer.isRepository) throw new Error(`${place.path} is not a repository`);

    return answer;
}

async function failure(promise: Promise<unknown>): Promise<CommandError> {
    try {
        await promise;
    } catch (error) {
        if (error instanceof CommandError) return error;

        throw error;
    }

    throw new Error('It did not fail');
}

/**
 * Runs `action` with a `git` in front of the real one on the PATH that writes down the arguments of every process it is asked to start, and gives back what it wrote (one entry for
 * each process, its arguments joined by spaces). The PATH is the real one again when `action` ends.
 */
async function gitProcessesOf(action: () => Promise<unknown>): Promise<string[]> {
    const shim = tempDir('git-changes-shim');
    const log = join(shim, 'processes.log');
    const real = Bun.which('git');

    if (!real) throw new Error('git is not on the PATH');

    writeFileSync(join(shim, 'git'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec '${real}' "$@"\n`);
    chmodSync(join(shim, 'git'), 0o755);

    const path = process.env.PATH;

    process.env.PATH = `${shim}:${path}`;

    try {
        await action();
    } finally {
        process.env.PATH = path;
    }

    return (
        await Bun.file(log)
            .text()
            .catch(() => '')
    )
        .split('\n')
        .filter(line => line !== '');
}

/**
 * `main` of the clone has the base files (`lib.ts`, `old-name.ts`, `gone.txt`, `README.md`). On the branch `feature`, from `origin/main`, two commits: the first adds
 * `src/new.ts`, adds a line to `lib.ts` and changes another, renames `old-name.ts` to `renamed.ts` with an edit; the second deletes `gone.txt` and adds a binary `logo.bin`.
 * Then, not committed: `lib.ts` gets a line (unstaged), `src/staged.ts` is added to the index, and `scratch.txt` is new.
 */
function work() {
    const { work: path, ...rest } = clone();

    git(path, 'switch', '-q', '-c', 'feature');
    put(path, {
        'src/new.ts': lines('export const one = 1;', 'export const two = 2;', 'export const three = 3;'),
        'lib.ts': lines('a', 'B', 'c', 'd'),
    });
    renameSync(join(path, 'old-name.ts'), join(path, 'renamed.ts'));
    writeFileSync(
        join(path, 'renamed.ts'),
        lines('export const x = 1;', 'export const y = 22;', 'export const z = 3;')
    );

    const first = commit(path, 'Add the new module and rename the old one');

    rmSync(join(path, 'gone.txt'));
    put(path, { 'logo.bin': Buffer.from([0, 1, 2, 3, 0, 255]) });

    const second = commit(path, 'Drop gone and add a logo');

    writeFileSync(join(path, 'lib.ts'), lines('a', 'B', 'c', 'd', 'e'));
    put(path, { 'src/staged.ts': lines('export const staged = true;') });
    git(path, 'add', 'src/staged.ts');
    put(path, { 'scratch.txt': lines('one', 'two') });

    return { path, ...rest, first, second, base: git(path, 'rev-parse', 'origin/main') };
}

describe('gitRead options', () => {
    test('gives git a longer time or room, or input, when a read asks, and keeps the defaults for the rest', async () => {
        const repo = makeRepo(tempDir('git-changes'));
        const big = 'x'.repeat(2000);

        writeFileSync(join(repo, 'big.txt'), big);

        // Past the size a read may print, git is killed and the read is not an answer (`unavailable`), whatever the cap is called.
        expect(await gitRead(repo, ['show', 'HEAD:README.md'], { maxBytes: 3 })).toEqual({
            ok: false,
            reason: 'unavailable',
        });
        expect(await gitRead(repo, ['hash-object', '--stdin'], { input: 'hello\n' })).toEqual({
            ok: true,
            stdout: 'ce013625030ba8dba906f756967f9e9ca394464a\n',
        });
        expect(await gitRead(repo, ['rev-parse', 'HEAD'], { timeoutMs: 20_000 })).toMatchObject({ ok: true });
        expect(await gitRead(repo, ['hash-object', '--stdin'], { input: big })).toMatchObject({ ok: true });
    });

    test("tells git to print what it prints to anyone, whatever the repository's configuration says, when the output is parsed", async () => {
        const repo = makeRepo(tempDir('git-changes'));

        put(repo, { 'dir/ünï code.txt': lines('one') });
        commit(repo, 'Add a file with a name that needs quoting');
        git(repo, 'config', 'core.quotepath', 'true');
        git(repo, 'config', 'color.ui', 'always');
        git(repo, 'config', 'diff.noprefix', 'true');
        git(repo, 'config', 'diff.relative', 'true');

        // The config is the person's: a read that parses opts in to the daemon's own.
        const parsed = await gitRead(join(repo, 'dir'), ['diff', '-p', '--no-ext-diff', 'HEAD~1', 'HEAD'], {
            parsed: true,
        });

        expect(parsed).toMatchObject({ ok: true });
        expect((parsed as { stdout: string }).stdout).toContain('diff --git a/dir/ünï code.txt b/dir/ünï code.txt');
        expect((parsed as { stdout: string }).stdout).not.toContain('\u001b[');
    });
});

describe('the locale of every read', () => {
    test("is fixed, and names that are not ASCII still come back whole from the readers of a folder's branches and worktrees", async () => {
        const repo = makeRepo(tempDir('git-changes'));
        const tree = join(tempDir('git-changes'), 'дерево ö');

        git(repo, 'branch', 'фича/ü');
        git(repo, 'worktree', 'add', '-q', '-b', 'ветка-ö', tree);

        const answer = await folderGit(repo);

        expect(answer.isRepository && answer.branches.map(branch => branch.name)).toEqual(
            expect.arrayContaining(['фича/ü', 'ветка-ö'])
        );
        expect(answer.isRepository && answer.worktrees.map(worktree => worktree.path)).toContainEqual(
            expect.stringContaining('дерево ö')
        );
        expect(answer.isRepository && answer.worktrees.find(worktree => worktree.path.includes('дерево'))?.branch).toBe(
            'ветка-ö'
        );
    });
});

describe('gitRecords', () => {
    test('reads the records git prints and stops it once there are more than it was asked for', async () => {
        const repo = makeRepo(tempDir('git-changes'));

        for (let index = 0; index < 30; index++)
            put(repo, { [`new/file-${String(index).padStart(2, '0')}.txt`]: 'x\n' });

        const all = await gitRecords(repo, ['ls-files', '-z', '--others'], { maxRecords: 100 });
        const cut = await gitRecords(repo, ['ls-files', '-z', '--others'], { maxRecords: 10 });
        const exact = await gitRecords(repo, ['ls-files', '-z', '--others'], { maxRecords: 30 });

        expect(all).toMatchObject({ ok: true, truncated: false });
        expect(all.ok && all.records).toHaveLength(30);
        expect(cut).toMatchObject({ ok: true, truncated: true });
        expect(cut.ok && cut.records).toEqual(
            Array.from({ length: 10 }, (_, index) => `new/file-${String(index).padStart(2, '0')}.txt`)
        );
        expect(exact).toMatchObject({ ok: true, truncated: false });
    });

    test("tells git's own no from a git that could not be run", async () => {
        const plain = tempDir('git-changes');

        expect(await gitRecords(plain, ['ls-files', '-z'], { maxRecords: 5 })).toEqual({ ok: false, reason: 'failed' });
        expect(await gitRecords(join(plain, 'missing'), ['ls-files', '-z'], { maxRecords: 5 })).toEqual({
            ok: false,
            reason: 'unavailable',
        });
    });
});

describe('parseStatus', () => {
    test('reads the branch headers and each kind of entry, a path with spaces and the old path of a rename', () => {
        const parsed = parseStatus([
            '# branch.oid 1111111111111111111111111111111111111111',
            '# branch.head feature/x',
            '# branch.upstream origin/feature/x',
            '# branch.ab +2 -1',
            '1 .M N... 100644 100644 100644 aaaa bbbb my file.ts',
            '1 A. N... 000000 100644 100644 0000 cccc added.ts',
            '2 R. N... 100644 100644 100644 dddd dddd R100 new name.ts',
            'old name.ts',
            'u UU N... 100644 100644 100644 100644 eeee ffff gggg conflict.ts',
            '? untracked.txt',
            '! ignored.log',
        ]);

        expect(parsed).toEqual({
            commit: '1111111111111111111111111111111111111111',
            branch: 'feature/x',
            upstream: { name: 'origin/feature/x', ahead: 2, behind: 1 },
            entries: [
                { path: 'my file.ts', unstaged: 'modified' },
                { path: 'added.ts', staged: 'added' },
                { path: 'new name.ts', oldPath: 'old name.ts', staged: 'renamed' },
                { path: 'conflict.ts', unstaged: 'conflicted' },
                { path: 'untracked.txt', untracked: true },
            ],
        });
    });

    test('knows a detached head, a branch with no commit and an upstream that is gone', () => {
        expect(parseStatus(['# branch.oid abc', '# branch.head (detached)'])).toEqual({ commit: 'abc', entries: [] });
        expect(parseStatus(['# branch.oid (initial)', '# branch.head main'])).toEqual({ branch: 'main', entries: [] });
        expect(parseStatus(['# branch.oid abc', '# branch.head main', '# branch.upstream origin/main'])).toEqual({
            commit: 'abc',
            branch: 'main',
            upstream: { name: 'origin/main', ahead: 0, behind: 0, gone: true },
            entries: [],
        });
    });
});

describe('parseDiff', () => {
    test('pairs each raw record with its numbers, a rename by its new path, a binary file by its dashes', () => {
        const zeros = '0'.repeat(40);
        const output = [
            `:100644 100644 ${'a'.repeat(40)} ${'b'.repeat(40)} M`,
            'dir/lib.ts',
            `:100644 100644 ${'c'.repeat(40)} ${'d'.repeat(40)} R087`,
            'old.ts',
            'new.ts',
            `:000000 100644 ${zeros} ${'e'.repeat(40)} A`,
            'logo.bin',
            '2\t1\tdir/lib.ts',
            '1\t0\t',
            'old.ts',
            'new.ts',
            '-\t-\tlogo.bin',
            '',
        ].join('\0');

        expect(parseDiff(output)).toEqual([
            {
                path: 'dir/lib.ts',
                kind: 'modified',
                oldMode: '100644',
                newMode: '100644',
                oldBlob: 'a'.repeat(40),
                newBlob: 'b'.repeat(40),
                additions: 2,
                deletions: 1,
            },
            {
                path: 'new.ts',
                oldPath: 'old.ts',
                kind: 'renamed',
                oldMode: '100644',
                newMode: '100644',
                oldBlob: 'c'.repeat(40),
                newBlob: 'd'.repeat(40),
                additions: 1,
                deletions: 0,
            },
            {
                path: 'logo.bin',
                kind: 'added',
                oldMode: '000000',
                newMode: '100644',
                oldBlob: zeros,
                newBlob: 'e'.repeat(40),
                binary: true,
            },
        ]);
    });
});

describe('placeStatus', () => {
    test('says a folder that is no repository, or lies inside one, is none, and a git that cannot run there is unavailable', async () => {
        const plain = tempDir('git-changes');
        const repo = makeRepo(tempDir('git-changes'), 'app');

        mkdirSync(join(repo, 'packages'));

        expect(await placeStatus(placeAt(plain))).toEqual({ isRepository: false });
        expect(await placeStatus(placeAt(join(repo, 'packages')))).toEqual({ isRepository: false });
        expect(await placeChanges(placeAt(plain), 'all')).toEqual({ isRepository: false });
        expect((await failure(placeStatus(placeAt(join(plain, 'missing'))))).code).toBe('unavailable');
    });

    test('says a clean branch with its upstream, the base it is compared with and that it has an origin', async () => {
        const { work: path } = clone();
        const sha = git(path, 'rev-parse', 'HEAD');
        const answer = await status(placeAt(path));

        expect(answer.head).toEqual({ kind: 'branch', name: 'main', commit: sha });
        expect(answer.upstream).toEqual({ name: 'origin/main', ahead: 0, behind: 0 });
        expect(answer.origin).toBe(true);
        expect(answer.entries).toEqual([]);
        expect(answer.truncated).toBeUndefined();
        expect(answer.base).toEqual({
            state: 'ready',
            name: 'origin/main',
            commit: sha,
            mergeBase: sha,
            ahead: 0,
            behind: 0,
            commits: [],
        });
    });

    test('lists what is not committed with its kinds: edited, staged, renamed, deleted and new', async () => {
        const { path } = work();
        const answer = await status(placeAt(path));

        // The way git lists them: what it tracks by path, then what it does not.
        expect(answer.entries).toEqual([
            { path: 'lib.ts', unstaged: 'modified' },
            { path: 'src/staged.ts', staged: 'added' },
            { path: 'scratch.txt', untracked: true },
        ]);

        git(path, 'mv', 'renamed.ts', 'moved.ts');
        git(path, 'rm', '-q', 'logo.bin');
        rmSync(join(path, 'lib.ts'));

        expect((await status(placeAt(path))).entries).toEqual([
            { path: 'lib.ts', unstaged: 'deleted' },
            { path: 'logo.bin', staged: 'deleted' },
            { path: 'moved.ts', oldPath: 'renamed.ts', staged: 'renamed' },
            { path: 'src/staged.ts', staged: 'added' },
            { path: 'scratch.txt', untracked: true },
        ]);
    });

    test('says a file that is staged and edited again is both, and an unmerged path is a conflict', async () => {
        const { work: path } = clone();

        put(path, { 'lib.ts': lines('a', 'staged', 'c') });
        git(path, 'add', 'lib.ts');
        put(path, { 'lib.ts': lines('a', 'staged', 'c', 'again') });

        expect((await status(placeAt(path))).entries).toEqual([
            { path: 'lib.ts', staged: 'modified', unstaged: 'modified' },
        ]);

        git(path, 'checkout', '-q', '--', 'lib.ts');
        git(path, 'reset', '-q', '--hard');
        git(path, 'switch', '-q', '-c', 'side');
        put(path, { 'lib.ts': lines('a', 'side', 'c') });
        commit(path, 'Change lib on the side');
        git(path, 'switch', '-q', 'main');
        put(path, { 'lib.ts': lines('a', 'main', 'c') });
        commit(path, 'Change lib on main');

        // The merge stops on the conflict, and only with an identity: without one git dies before it gets there.
        const merged = Bun.spawnSync(['git', ...GIT_IDENTITY, 'merge', 'side', '--no-edit'], {
            cwd: path,
            stdout: 'pipe',
            stderr: 'pipe',
        });

        expect(merged.exitCode).not.toBe(0);
        expect((await status(placeAt(path))).entries).toEqual([{ path: 'lib.ts', unstaged: 'conflicted' }]);
        // A diff does not say it: to it the path is a file that changed.
        expect((await changes(placeAt(path), 'uncommitted')).files.map(file => [file.path, file.kind])).toEqual([
            ['lib.ts', 'modified'],
        ]);
    });

    test('says a detached head, and a branch that tracks nothing', async () => {
        const { work: path } = clone();
        const sha = git(path, 'rev-parse', 'HEAD');

        git(path, 'switch', '-q', '-c', 'untracked-branch');
        expect((await status(placeAt(path))).upstream).toBeUndefined();
        expect((await status(placeAt(path))).head).toEqual({ kind: 'branch', name: 'untracked-branch', commit: sha });

        git(path, 'checkout', '-q', '--detach');

        const detached = await status(placeAt(path));

        expect(detached.head).toEqual({ kind: 'detached', commit: sha });
        expect(detached.upstream).toBeUndefined();
        // The compare works from the commit: the folder's own base is still there.
        expect(detached.base).toMatchObject({ state: 'ready', name: 'origin/main', ahead: 0, behind: 0 });
    });

    test('says an upstream that is gone, and a repository with no remote', async () => {
        const { work: path, origin } = clone();

        git(path, 'branch', '-q', '--track', 'topic', 'origin/dev');
        git(path, 'switch', '-q', 'topic');
        git(origin, 'branch', '-q', '-D', 'dev');
        git(path, 'fetch', '-q', '--prune');

        expect((await status(placeAt(path))).upstream).toEqual({ name: 'origin/dev', ahead: 0, behind: 0, gone: true });

        const local = makeRepo(tempDir('git-changes'), 'local');
        const answer = await status(placeAt(local));

        expect(answer.origin).toBe(false);
        expect(answer.upstream).toBeUndefined();
        // The base is the branch itself: there is nothing else to compare with.
        expect(answer.base).toMatchObject({ state: 'ready', name: 'main', ahead: 0, behind: 0, commits: [] });
    });

    test('says a branch with no commit yet, with the files in it', async () => {
        const path = tempDir('git-changes');

        git(path, 'init', '-q', '-b', 'trunk');
        put(path, { 'a.txt': lines('a'), 'b.txt': lines('b') });
        git(path, 'add', 'a.txt');

        const answer = await status(placeAt(path));

        expect(answer.head).toEqual({ kind: 'unborn', name: 'trunk' });
        expect(answer.upstream).toBeUndefined();
        expect(answer.base).toEqual({ state: 'unborn' });
        expect(answer.entries).toEqual([
            { path: 'a.txt', staged: 'added' },
            { path: 'b.txt', untracked: true },
        ]);
    });

    test("counts how far the branch and its upstream have grown apart, and lists the branch's commits, newest first", async () => {
        const { work: path, seed } = clone();

        put(path, { 'one.txt': lines('one') });

        const first = commit(path, 'Add one');

        put(path, { 'two.txt': lines('two') });

        const second = commit(path, 'Add two: with a "colon"');

        put(seed, { 'upstream.txt': lines('theirs') });
        commit(seed, "Someone else's work");
        git(seed, 'push', '-q', 'origin', 'main');
        git(path, 'fetch', '-q');

        const answer = await status(placeAt(path));

        expect(answer.upstream).toEqual({ name: 'origin/main', ahead: 2, behind: 1 });
        expect(answer.base).toMatchObject({
            state: 'ready',
            name: 'origin/main',
            ahead: 2,
            behind: 1,
            mergeBase: git(path, 'rev-parse', 'HEAD~2'),
        });
        expect(answer.base.state === 'ready' && answer.base.commits).toEqual([
            {
                sha: second,
                shortSha: second.slice(0, 7),
                subject: 'Add two: with a "colon"',
                author: 'Test',
                committedAt: expect.any(Number),
            },
            {
                sha: first,
                shortSha: first.slice(0, 7),
                subject: 'Add one',
                author: 'Test',
                committedAt: expect.any(Number),
            },
        ]);

        const times = answer.base.state === 'ready' ? answer.base.commits.map(entry => entry.committedAt) : [];

        // Milliseconds, and not the time of the test run: git's own seconds, times a thousand.
        expect(times.every(time => time % 1000 === 0 && Math.abs(Date.now() - time) < 60_000)).toBe(true);
    });

    test('lists at most the newest commits, and says how many there are', async () => {
        const { work: path } = clone();

        for (let index = 0; index < MAX_GIT_COMMITS + 5; index++)
            git(path, 'commit', '-q', '--allow-empty', '-m', `Commit ${index}`);

        const base = (await status(placeAt(path))).base;

        expect(base.state === 'ready' && base.ahead).toBe(MAX_GIT_COMMITS + 5);
        expect(base.state === 'ready' && base.commits).toHaveLength(MAX_GIT_COMMITS);
        expect(base.state === 'ready' && base.commits[0]?.subject).toBe(`Commit ${MAX_GIT_COMMITS + 4}`);
    });

    test('stops reading a tree that is all new at a thousand entries and says it was cut', async () => {
        const path = makeRepo(tempDir('git-changes'));

        for (let index = 0; index < MAX_GIT_STATUS_ENTRIES + 20; index++)
            writeFileSync(join(path, `file-${String(index).padStart(5, '0')}.txt`), 'x\n');

        const answer = await status(placeAt(path));

        expect(answer.entries).toHaveLength(MAX_GIT_STATUS_ENTRIES);
        expect(answer.truncated).toBe(true);
        expect(answer.entries[0]).toEqual({ path: 'file-00000.txt', untracked: true });
    });
});

describe('the base', () => {
    test("is origin's branch when the local one is equal to it, behind it or not there, and the local one when it is ahead or has diverged", async () => {
        const { work: path, seed } = clone();
        const origin = git(path, 'rev-parse', 'origin/main');

        // Equal, and a name that is only the remote's.
        expect(await resolveRef(path, 'main')).toEqual({ name: 'origin/main', commit: origin });
        expect(await resolveRef(path, 'dev')).toEqual({ name: 'origin/dev', commit: origin });
        expect(await resolveRef(path, 'origin/dev')).toEqual({ name: 'origin/dev', commit: origin });

        // Behind: the person has not pulled.
        put(seed, { 'later.txt': lines('later') });

        const later = commit(seed, 'Later');

        git(seed, 'push', '-q', 'origin', 'main');
        git(path, 'fetch', '-q');
        expect(await resolveRef(path, 'main')).toEqual({ name: 'origin/main', commit: later });

        // Ahead.
        git(path, 'merge', '-q', '--ff-only', 'origin/main');
        put(path, { 'mine.txt': lines('mine') });

        const mine = commit(path, 'Mine');

        expect(await resolveRef(path, 'main')).toEqual({ name: 'main', commit: mine });

        // Diverged.
        put(seed, { 'even-later.txt': lines('even later') });
        commit(seed, 'Even later');
        git(seed, 'push', '-q', 'origin', 'main');
        git(path, 'fetch', '-q');
        expect(await resolveRef(path, 'main')).toEqual({ name: 'main', commit: mine });
    });

    test("is a ref as it is spelled when it is a full ref or a hash, and never a tag that has a branch's name", async () => {
        const { work: path } = clone();
        const head = git(path, 'rev-parse', 'HEAD');

        put(path, { 'more.txt': lines('more') });

        const more = commit(path, 'More');

        git(path, 'tag', 'dev', more);
        // A tag that has the local branch's name, on the commit before its own work: the branch is what `main` means.
        git(path, 'tag', 'main', head);

        expect(await resolveRef(path, 'refs/remotes/origin/dev')).toEqual({ name: 'origin/dev', commit: head });
        expect(await resolveRef(path, 'refs/heads/main')).toEqual({ name: 'main', commit: more });
        expect(await resolveRef(path, head.slice(0, 10))).toEqual({ name: head.slice(0, 7), commit: head });
        // The tag is called `dev`, and so is the branch the remote has.
        expect(await resolveRef(path, 'dev')).toEqual({ name: 'origin/dev', commit: head });
        expect(await resolveRef(path, 'main')).toEqual({ name: 'main', commit: more });
        expect(await resolveRef(path, 'nope')).toBeUndefined();
        // What is not a ref's name is not a ref, whatever a revision would make of it.
        for (const name of ['main~1', 'main^', 'main@{1}', 'HEAD:lib.ts', 'refs/heads/main~1', '--all', 'a b', ''])
            expect(await resolveRef(path, name)).toBeUndefined();
    });

    test("is the branch the request names first, then the worktree's own base, then the folder's", async () => {
        const { work: path } = clone();

        put(path, { 'on-main.txt': lines('x') });
        commit(path, 'On main');
        git(path, 'switch', '-q', '-c', 'feature');
        put(path, { 'on-feature.txt': lines('y') });
        commit(path, 'On feature');

        const nameOf = async (place: Place, options?: { base?: string }) => {
            const base = await readBase(place, options);

            return base.state === 'ready' ? `${base.name} +${base.ahead} -${base.behind}` : base.state;
        };

        // The folder's own: `origin/main`, two commits behind the feature branch's work.
        expect(await nameOf(placeAt(path))).toBe('origin/main +2 -0');
        // The worktree's own base, as it was made from.
        expect(await nameOf(placeAt(path, 'origin/dev'))).toBe('origin/dev +2 -0');
        // The branch a pull request is for wins over both, and a bare name takes the rule above.
        expect(await nameOf(placeAt(path, 'origin/dev'), { base: 'main' })).toBe('main +1 -0');
        // A name that is not there is passed over for the next one.
        expect(await nameOf(placeAt(path, 'gone-branch'), { base: 'also-gone' })).toBe('origin/main +2 -0');
    });

    test('says there is no merge base for a branch with no history in common', async () => {
        const { work: path } = clone();

        git(path, 'switch', '-q', '--orphan', 'island');
        put(path, { 'island.txt': lines('alone') });
        git(path, 'add', 'island.txt');
        git(path, 'commit', '-q', '-m', 'An island');

        const base = (await status(placeAt(path))).base;

        expect(base).toEqual({
            state: 'no_merge_base',
            name: 'origin/main',
            commit: git(path, 'rev-parse', 'origin/main'),
        });
        expect(await mergeBaseOf(placeAt(path))).toEqual({
            state: 'no_merge_base',
            name: 'origin/main',
            commit: git(path, 'rev-parse', 'origin/main'),
        });
        // All counts from HEAD then, and the branch is empty.
        expect(await changes(placeAt(path), 'all')).toMatchObject({
            baseState: 'no_merge_base',
            fileCount: 0,
            files: [],
        });
        expect(await changes(placeAt(path), 'branch')).toMatchObject({
            baseState: 'no_merge_base',
            fileCount: 0,
            files: [],
        });
    });
});

describe('placeChanges', () => {
    test('lists what the branch committed against its merge base, with the numbers of each file, and nothing that is not committed', async () => {
        const { path, base } = work();
        const answer = await changes(placeAt(path), 'branch');

        expect(answer).toMatchObject({
            scope: 'branch',
            from: base,
            baseState: 'ready',
            fileCount: 5,
            additions: 3 + 2 + 1,
            deletions: 1 + 1 + 1,
            statsComplete: true,
        });
        expect(answer.truncated).toBeUndefined();
        expect(
            answer.files.map(file => [file.path, file.kind, file.oldPath, file.additions, file.deletions, file.binary])
        ).toEqual([
            ['gone.txt', 'deleted', undefined, 0, 1, undefined],
            ['lib.ts', 'modified', undefined, 2, 1, undefined],
            ['logo.bin', 'added', undefined, undefined, undefined, true],
            ['renamed.ts', 'renamed', 'old-name.ts', 1, 1, undefined],
            ['src/new.ts', 'added', undefined, 3, 0, undefined],
        ]);
        expect(answer.files.some(file => file.untracked)).toBe(false);
    });

    test('lists the working tree against HEAD for the uncommitted scope: what is edited, what is staged and what is new', async () => {
        const { path, second } = work();
        const answer = await changes(placeAt(path), 'uncommitted');

        expect(answer).toMatchObject({
            scope: 'uncommitted',
            from: second,
            fileCount: 3,
            additions: 1 + 2 + 1,
            deletions: 0,
            statsComplete: true,
        });
        expect(answer.baseState).toBeUndefined();
        expect(
            answer.files.map(file => [file.path, file.kind, file.untracked, file.additions, file.deletions])
        ).toEqual([
            ['lib.ts', 'modified', undefined, 1, 0],
            ['scratch.txt', 'added', true, 2, 0],
            ['src/staged.ts', 'added', undefined, 1, 0],
        ]);
    });

    test('lists the working tree against the merge base for the all scope, so a file edited again counts once with all its lines', async () => {
        const { path, base } = work();
        const answer = await changes(placeAt(path), 'all');

        expect(answer).toMatchObject({
            scope: 'all',
            from: base,
            baseState: 'ready',
            fileCount: 7,
            statsComplete: true,
        });
        expect(answer.files.map(file => file.path)).toEqual([
            'gone.txt',
            'lib.ts',
            'logo.bin',
            'renamed.ts',
            'scratch.txt',
            'src/new.ts',
            'src/staged.ts',
        ]);
        // `lib.ts`: `B`, `d` and `e` are new and `b` is gone, against the base's `a b c`.
        expect(answer.files.find(file => file.path === 'lib.ts')).toMatchObject({
            kind: 'modified',
            additions: 3,
            deletions: 1,
        });
        // The totals are the sum of the files': committed, staged, edited and new.
        expect(answer.additions).toBe(3 + 1 + 2 + 3 + 1);
        expect(answer.deletions).toBe(1 + 1 + 1);
    });

    test('lists one commit against its first parent, and a root commit against nothing', async () => {
        const { path, first, second } = work();
        const one = await changes(placeAt(path), commitScope(first));
        const two = await changes(placeAt(path), commitScope(second.slice(0, 9)));

        expect(one).toMatchObject({
            scope: `commit:${first}`,
            from: git(path, 'rev-parse', `${first}^`),
            fileCount: 3,
        });
        expect(one.files.map(file => file.path)).toEqual(['lib.ts', 'renamed.ts', 'src/new.ts']);
        expect(two.files.map(file => file.path)).toEqual(['gone.txt', 'logo.bin']);
        expect(two.baseState).toBeUndefined();

        const root = git(path, 'rev-list', '--max-parents=0', 'HEAD');
        const rootChanges = await changes(placeAt(path), commitScope(root));

        expect(rootChanges.from).toBeUndefined();
        expect(rootChanges.files.map(file => [file.path, file.kind, file.additions])).toEqual([
            ['README.md', 'added', 1],
        ]);
        expect((await failure(placeChanges(placeAt(path), commitScope('0123456789abcdef')))).code).toBe('not_found');
        expect((await failure(placeChanges(placeAt(path), 'commit:--all' as GitScope))).code).toBe('invalid');
    });

    test("follows a merge commit's first parent, so the work it merged is what it shows", async () => {
        const { work: path } = clone();

        git(path, 'switch', '-q', '-c', 'side');
        put(path, { 'side.txt': lines('side') });
        commit(path, 'Add side');
        git(path, 'switch', '-q', 'main');
        put(path, { 'main.txt': lines('main') });
        commit(path, 'Add main');
        git(path, 'merge', '-q', '--no-ff', '--no-edit', 'side');

        expect(
            (await changes(placeAt(path), commitScope(git(path, 'rev-parse', 'HEAD')))).files.map(file => file.path)
        ).toEqual(['side.txt']);
    });

    test('gives each file the revision of its two sides, which an edit of the file in the working tree changes', async () => {
        const { path, base } = work();
        const zeros = '0'.repeat(40);
        const blob = (revision: string, path_: string) => git(path, 'rev-parse', `${revision}:${path_}`);
        const committed = await changes(placeAt(path), 'branch');
        const all = await changes(placeAt(path), 'all');
        const revisionOf = (answer: typeof all, name: string) =>
            answer.files.find(file => file.path === name)?.revision;

        // Committed: the blobs of the merge base and of HEAD.
        expect(revisionOf(committed, 'lib.ts')).toBe(`100644:${blob(base, 'lib.ts')}:100644:${blob('HEAD', 'lib.ts')}`);
        expect(revisionOf(committed, 'src/new.ts')).toBe(`000000:${zeros}:100644:${blob('HEAD', 'src/new.ts')}`);
        expect(revisionOf(committed, 'gone.txt')).toBe(`100644:${blob(base, 'gone.txt')}:000000:${zeros}`);
        expect(revisionOf(committed, 'renamed.ts')).toBe(
            `100644:${blob(base, 'old-name.ts')}:100644:${blob('HEAD', 'renamed.ts')}`
        );

        // The working tree: the id git gives the file there, a new file included.
        const hash = (name: string) => git(path, 'hash-object', name);

        expect(revisionOf(all, 'lib.ts')).toBe(`100644:${blob(base, 'lib.ts')}:100644:${hash('lib.ts')}`);
        expect(revisionOf(all, 'scratch.txt')).toBe(`000000:${zeros}:100644:${hash('scratch.txt')}`);
        expect(revisionOf(all, 'src/staged.ts')).toBe(`000000:${zeros}:100644:${hash('src/staged.ts')}`);
        expect(await changes(placeAt(path), 'all')).toEqual(all);

        const before = revisionOf(all, 'lib.ts');

        writeFileSync(join(path, 'lib.ts'), lines('a', 'B', 'c', 'd', 'e', 'f'));
        writeFileSync(join(path, 'scratch.txt'), lines('one', 'two', 'three'));

        const after = await changes(placeAt(path), 'all');

        expect(revisionOf(after, 'lib.ts')).not.toBe(before);
        expect(revisionOf(after, 'lib.ts')).toBe(`100644:${blob(base, 'lib.ts')}:100644:${hash('lib.ts')}`);
        expect(revisionOf(after, 'scratch.txt')).toBe(`000000:${zeros}:100644:${hash('scratch.txt')}`);
        // A file that was not touched keeps its revision.
        expect(revisionOf(after, 'renamed.ts')).toBe(revisionOf(all, 'renamed.ts'));
    });

    onPosix("records an executable file's mode, a link as a link and a new file's mode from the disk", async () => {
        const { work: path } = clone();

        put(path, { 'run.sh': lines('#!/bin/sh'), 'plain.txt': lines('x') });
        chmodSync(join(path, 'run.sh'), 0o755);
        symlinkSync('plain.txt', join(path, 'alias'));

        const answer = await changes(placeAt(path), 'uncommitted');
        const revision = (name: string) => answer.files.find(file => file.path === name)?.revision.split(':');

        expect(revision('run.sh')?.[2]).toBe('100755');
        expect(revision('plain.txt')?.[2]).toBe('100644');
        expect(revision('alias')?.[2]).toBe('120000');
        expect(answer.files.find(file => file.path === 'alias')).toMatchObject({ additions: 1, deletions: 0 });

        // Committed, the same modes come from the commit, and a link's id in the working tree is the one git stores for its target.
        const linkId = revision('alias')?.[3];

        commit(path, 'Add them');
        expect(linkId).toBe(git(path, 'rev-parse', 'HEAD:alias'));

        const committed = await changes(placeAt(path), commitScope(git(path, 'rev-parse', 'HEAD')));

        expect(committed.files.map(file => [file.path, file.revision.split(':')[2]])).toEqual([
            ['alias', '120000'],
            ['plain.txt', '100644'],
            ['run.sh', '100755'],
        ]);
    });

    test('says a binary file, a new binary file and a file too big to draw', async () => {
        const { work: path } = clone();

        put(path, {
            'new.bin': Buffer.from([0, 1, 2, 0]),
            'huge-lines.txt': Array.from({ length: 25_000 }, (_, index) => `line ${index}`).join('\n'),
            'wide.txt': 'w'.repeat(MAX_GIT_SIDE_BYTES + 10),
            'fine.txt': lines('fine'),
        });

        const answer = await changes(placeAt(path), 'uncommitted');
        const byName = (name: string) => answer.files.find(file => file.path === name);

        expect(byName('new.bin')).toMatchObject({ binary: true, untracked: true });
        expect(byName('new.bin')?.additions).toBeUndefined();
        expect(byName('huge-lines.txt')).toMatchObject({ additions: 25_000, tooLarge: true });
        // One line, but more bytes than a side may have.
        expect(byName('wide.txt')).toMatchObject({ additions: 1, tooLarge: true });
        expect(byName('fine.txt')?.tooLarge).toBeUndefined();
        expect(byName('fine.txt')).toMatchObject({ additions: 1, deletions: 0 });

        commit(path, 'Add the big ones');
        put(path, { 'huge-lines.txt': Array.from({ length: 25_000 }, (_, index) => `changed ${index}`).join('\n') });

        // A tracked file is too big by its changed lines, which git counted.
        expect((await changes(placeAt(path), 'uncommitted')).files).toMatchObject([
            { path: 'huge-lines.txt', additions: 25_000, deletions: 25_000, tooLarge: true },
        ]);
    });

    test('counts the lines of new files only within a budget, and says when the totals are a lower bound', async () => {
        const { work: path } = clone();

        for (let index = 0; index < 230; index++)
            put(path, { [`many/file-${String(index).padStart(3, '0')}.txt`]: lines('a', 'b') });

        const answer = await changes(placeAt(path), 'uncommitted');

        expect(answer.fileCount).toBe(230);
        expect(answer.statsComplete).toBe(false);
        // The first two hundred are counted, in path order, and the rest are listed with no numbers.
        expect(answer.additions).toBe(400);
        expect(answer.files[199]).toMatchObject({ path: 'many/file-199.txt', additions: 2 });
        expect(answer.files[200]?.additions).toBeUndefined();
        expect(answer.files[200]).toMatchObject({ path: 'many/file-200.txt', kind: 'added', untracked: true });
    });

    test('lists at most `MAX_GIT_CHANGED_FILES`, the first by path, and counts them all', async () => {
        const { work: path } = clone();

        for (let index = 0; index < MAX_GIT_CHANGED_FILES + 20; index++)
            put(path, { [`bulk/file-${String(index).padStart(3, '0')}.txt`]: lines('x') });

        const answer = await changes(placeAt(path), 'uncommitted');

        expect(answer.files).toHaveLength(MAX_GIT_CHANGED_FILES);
        expect(answer.fileCount).toBe(MAX_GIT_CHANGED_FILES + 20);
        expect(answer.truncated).toBe(true);
        expect(answer.files[0]?.path).toBe('bulk/file-000.txt');
        expect(answer.files.at(-1)?.path).toBe(`bulk/file-${MAX_GIT_CHANGED_FILES - 1}.txt`);
        expect(answer.additions).toBe(200);
    });

    test('stops listing new files at a few thousand, and says the list and the totals are cut', async () => {
        const { work: path } = clone();

        mkdirSync(join(path, 'flood'));

        for (let index = 0; index < 5010; index++)
            writeFileSync(join(path, 'flood', `file-${String(index).padStart(4, '0')}.txt`), 'x\n');

        const answer = await changes(placeAt(path), 'uncommitted');

        // Read only as far as the cap: the tree has 5010 new files and the answer does not claim to know them all.
        expect(answer.fileCount).toBeGreaterThan(MAX_GIT_CHANGED_FILES);
        expect(answer.fileCount).toBeLessThan(5010);
        expect(answer.files).toHaveLength(MAX_GIT_CHANGED_FILES);
        expect(answer.truncated).toBe(true);
        expect(answer.statsComplete).toBe(false);
    });

    test("keeps paths whole whatever the repository's configuration says: spaces, non-ASCII and a newline in a name", async () => {
        const { work: path } = clone();

        git(path, 'config', 'core.quotepath', 'true');
        git(path, 'config', 'color.ui', 'always');
        git(path, 'config', 'diff.noprefix', 'true');
        git(path, 'config', 'diff.mnemonicprefix', 'true');
        git(path, 'config', 'diff.relative', 'true');

        const names = [
            'dir with space/ünï code.txt',
            'тест.txt',
            ...(posix ? ['line\nbreak.txt', 'tab\there.txt'] : []),
        ];

        for (const name of names) put(path, { [name]: lines('x') });

        const answer = await changes(placeAt(path), 'uncommitted');

        expect(answer.files.map(file => file.path).sort()).toEqual([...names].sort());
        expect((await status(placeAt(path))).entries.map(entry => entry.path).sort()).toEqual([...names].sort());

        commit(path, 'Add the odd names');
        put(path, { [names[0]!]: lines('x', 'y') });
        expect((await changes(placeAt(path), 'uncommitted')).files).toMatchObject([
            { path: names[0], additions: 1, deletions: 0 },
        ]);
    });

    test('leaves out a folder that is a repository of its own, and what git ignores', async () => {
        const { work: path } = clone();

        put(path, {
            '.gitignore': 'build/\n*.log\n',
            'build/out.js': 'x\n',
            'debug.log': 'x\n',
            'src/keep.ts': lines('keep'),
        });

        const nested = join(path, 'vendor', 'lib');

        mkdirSync(nested, { recursive: true });
        git(nested, 'init', '-q', '-b', 'main');
        put(nested, { 'inside.txt': 'x\n' });

        expect((await changes(placeAt(path), 'uncommitted')).files.map(file => file.path)).toEqual([
            '.gitignore',
            'src/keep.ts',
        ]);
    });

    test('gives a submodule the commit its own checkout is at, so moving it again changes its revision', async () => {
        const { work: path } = clone();
        const library = makeRepo(tempDir('git-changes'), 'library');

        git(path, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', library, 'vendor/library');
        commit(path, 'Add the submodule');

        const inside = join(path, 'vendor', 'library');
        const recorded = git(path, 'rev-parse', 'HEAD:vendor/library');
        const revision = async () =>
            (await changes(placeAt(path), 'uncommitted')).files.find(file => file.path === 'vendor/library')?.revision;

        // Both moves only edit a file that is already there: nothing about the submodule's folder itself changes.
        put(inside, { 'README.md': lines('two') });

        const second = commit(inside, 'Second');

        expect(await revision()).toBe(`160000:${recorded}:160000:${second}`);
        put(inside, { 'README.md': lines('three') });

        const third = commit(inside, 'Third');

        expect(await revision()).toBe(`160000:${recorded}:160000:${third}`);
    });

    test("does not change the repository's index or take its lock", async () => {
        const { path } = work();
        const index = join(path, '.git', 'index');
        const before = Bun.file(index).size;
        const modified = (await Bun.file(index).stat()).mtimeMs;

        await changes(placeAt(path), 'all');
        await status(placeAt(path));
        await placeFile(placeAt(path), 'all', 'lib.ts', undefined);

        expect(Bun.file(index).size).toBe(before);
        expect((await Bun.file(index).stat()).mtimeMs).toBe(modified);
        expect(await Bun.file(join(path, '.git', 'index.lock')).exists()).toBe(false);
    });

    test('lists a branch with no commit yet from nothing: what is in the index and what is new', async () => {
        const path = tempDir('git-changes');

        git(path, 'init', '-q', '-b', 'main');
        put(path, { 'a.txt': lines('a', 'a'), 'b.txt': lines('b') });
        git(path, 'add', 'a.txt');

        for (const scope of ['all', 'uncommitted'] as const) {
            const answer = await changes(placeAt(path), scope);

            expect(answer.from).toBeUndefined();
            expect(answer.files.map(file => [file.path, file.kind, file.untracked, file.additions])).toEqual([
                ['a.txt', 'added', undefined, 2],
                ['b.txt', 'added', true, 1],
            ]);
        }

        expect(await changes(placeAt(path), 'branch')).toMatchObject({ baseState: 'unborn', files: [], fileCount: 0 });
    });

    test('says a path that a staged deletion left on the disk once, as the deletion', async () => {
        const { work: path } = clone();

        git(path, 'rm', '-q', '--cached', 'gone.txt');

        const answer = await changes(placeAt(path), 'uncommitted');

        expect(answer.files.map(file => [file.path, file.kind, file.untracked])).toEqual([
            ['gone.txt', 'deleted', undefined],
        ]);
    });
});

describe('placeFile', () => {
    const text = async (
        place: Place,
        scope: GitScope,
        path: string,
        oldPath?: string
    ): Promise<Extract<GitFileSides, { state: 'text' }>> => {
        const sides = await placeFile(place, scope, path, oldPath);

        if (sides.state !== 'text') throw new Error(`${path} is ${sides.state}`);

        return sides;
    };

    test("reads a file before and after: the merge base's text, and the file on disk for a scope that includes the working tree", async () => {
        const { path } = work();
        const all = await text(placeAt(path), 'all', 'lib.ts');
        const branch = await text(placeAt(path), 'branch', 'lib.ts');
        const uncommitted = await text(placeAt(path), 'uncommitted', 'lib.ts');

        expect(all.original).toBe(lines('a', 'b', 'c'));
        expect(all.modified).toBe(lines('a', 'B', 'c', 'd', 'e'));
        expect(branch.original).toBe(lines('a', 'b', 'c'));
        expect(branch.modified).toBe(lines('a', 'B', 'c', 'd'));
        expect(uncommitted.original).toBe(lines('a', 'B', 'c', 'd'));
        expect(uncommitted.modified).toBe(lines('a', 'B', 'c', 'd', 'e'));
        expect((await changes(placeAt(path), 'all')).files.find(file => file.path === 'lib.ts')?.revision).toBe(
            all.revision
        );
        expect((await changes(placeAt(path), 'branch')).files.find(file => file.path === 'lib.ts')?.revision).toBe(
            branch.revision
        );
    });

    test("reads one commit's two sides from the repository, whatever is on the disk now", async () => {
        const { path, first, base } = work();

        writeFileSync(join(path, 'lib.ts'), lines('something else entirely'));

        const sides = await text(placeAt(path), commitScope(first), 'lib.ts');

        expect(sides.original).toBe(lines('a', 'b', 'c'));
        expect(sides.modified).toBe(lines('a', 'B', 'c', 'd'));
        expect(sides.revision).toBe(
            `100644:${git(path, 'rev-parse', `${base}:lib.ts`)}:100644:${git(path, 'rev-parse', `${first}:lib.ts`)}`
        );
    });

    test('has no old side for a new file and no new side for a deleted one, and reads a new file git does not track', async () => {
        const { path } = work();

        expect(await text(placeAt(path), 'branch', 'src/new.ts')).toMatchObject({
            original: null,
            modified: lines('export const one = 1;', 'export const two = 2;', 'export const three = 3;'),
        });
        expect(await text(placeAt(path), 'branch', 'gone.txt')).toMatchObject({
            original: lines('bye'),
            modified: null,
        });
        expect(await text(placeAt(path), 'uncommitted', 'scratch.txt')).toMatchObject({
            original: null,
            modified: lines('one', 'two'),
        });
        expect(await text(placeAt(path), 'all', 'src/staged.ts')).toMatchObject({
            original: null,
            modified: lines('export const staged = true;'),
        });
    });

    test('reads a renamed file from its old path when it is given, and as a new file when it is not', async () => {
        const { path } = work();
        const renamed = await text(placeAt(path), 'branch', 'renamed.ts', 'old-name.ts');

        expect(renamed.original).toBe(lines('export const x = 1;', 'export const y = 2;', 'export const z = 3;'));
        expect(renamed.modified).toBe(lines('export const x = 1;', 'export const y = 22;', 'export const z = 3;'));
        expect((await changes(placeAt(path), 'branch')).files.find(file => file.path === 'renamed.ts')?.revision).toBe(
            renamed.revision
        );
        expect(await text(placeAt(path), 'branch', 'renamed.ts')).toMatchObject({ original: null });
    });

    test('sends no text for a binary file, a side over the limit or a change of too many lines', async () => {
        const { work: path } = clone();

        put(path, {
            'logo.bin': Buffer.from([0, 1, 2]),
            'wide.txt': 'w'.repeat(MAX_GIT_SIDE_BYTES + 10),
            'many.txt': Array.from({ length: 25_000 }, (_, index) => `line ${index}`).join('\n'),
            'edge.txt': 'e'.repeat(MAX_GIT_SIDE_BYTES),
        });

        const binary = await placeFile(placeAt(path), 'uncommitted', 'logo.bin', undefined);

        expect(binary).toEqual({ state: 'binary', revision: expect.stringMatching(/^000000:0+:100644:[0-9a-f]{40}$/) });
        expect(await placeFile(placeAt(path), 'uncommitted', 'wide.txt', undefined)).toMatchObject({
            state: 'too_large',
        });
        expect(await placeFile(placeAt(path), 'uncommitted', 'many.txt', undefined)).toMatchObject({
            state: 'too_large',
        });
        // A side exactly at the limit is still sent.
        expect(await placeFile(placeAt(path), 'uncommitted', 'edge.txt', undefined)).toMatchObject({
            state: 'text',
            original: null,
        });

        commit(path, 'Add them');
        // The old side of a tracked file is measured too.
        writeFileSync(join(path, 'wide.txt'), 'small\n');
        expect(await placeFile(placeAt(path), 'uncommitted', 'wide.txt', undefined)).toMatchObject({
            state: 'too_large',
        });
        // A binary file that is committed is told by git's own numbers.
        expect(await placeFile(placeAt(path), 'branch', 'logo.bin', undefined)).toMatchObject({ state: 'binary' });
    });

    test('reads a file against the start its list was counted from, and the same as it does without one when nothing moved', async () => {
        const { path, first, second } = work();
        const place = placeAt(path);

        for (const scope of ['all', 'branch', 'uncommitted', commitScope(first), commitScope(second)] as const) {
            const list = await changes(place, scope);

            expect(list.from).toBeDefined();

            for (const file of list.files.filter(candidate => !candidate.binary)) {
                const without = await placeFile(place, scope, file.path, file.oldPath);
                const pinned = await placeFile(place, scope, file.path, file.oldPath, { from: list.from });

                expect(pinned).toEqual(without);
                expect(pinned).toMatchObject({ revision: file.revision });
            }
        }

        // A short hash is a hash, as it is in a scope.
        expect(
            await placeFile(place, 'branch', 'lib.ts', undefined, {
                from: (await changes(place, 'branch')).from!.slice(0, 10),
            })
        ).toEqual(await placeFile(place, 'branch', 'lib.ts', undefined));
    });

    test('starts a scope at the commit it is given, whatever the base or HEAD is', async () => {
        const { path, first, base } = work();
        const place = placeAt(path);

        // `all` and `branch` start at `from` and not at the merge base: here the branch's first commit, so lib.ts has the text it had after it.
        expect(await text(place, 'all', 'lib.ts')).toMatchObject({ original: lines('a', 'b', 'c') });
        expect(await placeFile(place, 'all', 'lib.ts', undefined, { from: first })).toMatchObject({
            state: 'text',
            original: lines('a', 'B', 'c', 'd'),
            modified: lines('a', 'B', 'c', 'd', 'e'),
        });
        // The branch from its first commit to HEAD is the second commit's work: gone.txt is deleted in it, and lib.ts is not touched by it.
        expect(await placeFile(place, 'branch', 'gone.txt', undefined, { from: first })).toMatchObject({
            state: 'text',
            original: lines('bye'),
            modified: null,
        });
        expect((await failure(placeFile(place, 'branch', 'lib.ts', undefined, { from: first }))).code).toBe(
            'not_found'
        );
        // `uncommitted` is HEAD to the disk: told another start it is that start to the disk.
        expect(await text(place, 'uncommitted', 'lib.ts')).toMatchObject({ original: lines('a', 'B', 'c', 'd') });
        expect(await placeFile(place, 'uncommitted', 'lib.ts', undefined, { from: base })).toMatchObject({
            state: 'text',
            original: lines('a', 'b', 'c'),
            modified: lines('a', 'B', 'c', 'd', 'e'),
        });
        // A commit's scope starts at the parent the list gave, the commit itself still being the commit.
        expect(await placeFile(place, commitScope(first), 'lib.ts', undefined, { from: base })).toMatchObject({
            original: lines('a', 'b', 'c'),
            modified: lines('a', 'B', 'c', 'd'),
        });
        // A file that did not change since `from` is not in the scope, as it is not in a list.
        expect((await failure(placeFile(place, 'branch', 'src/new.ts', undefined, { from: first }))).code).toBe(
            'not_found'
        );
    });

    test('refuses a start that is not a hash or not a commit of the repository, whatever the scope', async () => {
        const { path, first } = work();
        const place = placeAt(path);
        const blob = git(path, 'rev-parse', 'HEAD:lib.ts');

        for (const scope of ['all', 'branch', 'uncommitted', commitScope(first)] as const) {
            for (const bad of [
                '',
                'abc',
                'HEAD',
                'main',
                '--stat',
                'zzzzzzz',
                `${first}~1`,
                `${first}^`,
                `${first}\0`,
                'a'.repeat(65),
            ]) {
                expect((await failure(placeFile(place, scope, 'lib.ts', undefined, { from: bad }))).code).toBe(
                    'invalid'
                );
            }

            expect(
                (
                    await failure(
                        placeFile(place, scope, 'lib.ts', undefined, {
                            from: '0123456789abcdef0123456789abcdef01234567',
                        })
                    )
                ).code
            ).toBe('not_found');
            // An object that is not a commit is no start.
            expect((await failure(placeFile(place, scope, 'lib.ts', undefined, { from: blob }))).code).toBe(
                'not_found'
            );
        }
    });

    onPosix('looks up no base when it is given the start, which saves the processes of finding it', async () => {
        const { path } = work();
        const place = placeAt(path);
        const { from } = await changes(place, 'all');
        const unpinned = await gitProcessesOf(() => placeFile(place, 'all', 'lib.ts', undefined));
        const pinned = await gitProcessesOf(() => placeFile(place, 'all', 'lib.ts', undefined, { from }));

        expect(unpinned.some(line => line.includes('merge-base'))).toBe(true);
        expect(pinned.some(line => line.includes('merge-base'))).toBe(false);
        expect(
            pinned.some(
                line => line.includes('for-each-ref') || line.includes('symbolic-ref') || line.includes('config')
            )
        ).toBe(false);
        expect(pinned.length).toBeLessThan(unpinned.length - 4);
    });

    test('does not know a path that did not change in the scope, and refuses a path that is not one', async () => {
        const { path, first } = work();

        expect((await failure(placeFile(placeAt(path), 'uncommitted', 'README.md', undefined))).code).toBe('not_found');
        expect((await failure(placeFile(placeAt(path), 'branch', 'scratch.txt', undefined))).code).toBe('not_found');
        expect((await failure(placeFile(placeAt(path), commitScope(first), 'logo.bin', undefined))).code).toBe(
            'not_found'
        );

        for (const bad of ['', '../outside.txt', '/etc/passwd', 'a/../b', 'a//b', 'dir/', './lib.ts', 'lib.ts\0']) {
            expect((await failure(placeFile(placeAt(path), 'all', bad, undefined))).code).toBe('invalid');
        }

        expect((await failure(placeFile(placeAt(path), 'all', 'lib.ts', '../x'))).code).toBe('invalid');
        expect((await failure(placeFile(placeAt(tempDir('git-changes')), 'all', 'lib.ts', undefined))).code).toBe(
            'invalid'
        );
    });

    onPosix('takes a path as the path it is, whatever pattern characters it has', async () => {
        const { work: path } = clone();

        put(path, {
            'a*b.txt': lines('star'),
            'axb.txt': lines('x'),
            '[id].tsx': lines('bracket'),
            ':colon.txt': lines('colon'),
            '--stat.txt': lines('dash'),
        });

        expect(await text(placeAt(path), 'uncommitted', 'a*b.txt')).toMatchObject({ modified: lines('star') });
        expect(await text(placeAt(path), 'uncommitted', '[id].tsx')).toMatchObject({ modified: lines('bracket') });
        expect(await text(placeAt(path), 'uncommitted', ':colon.txt')).toMatchObject({ modified: lines('colon') });
        // A name that starts like an option is a name: git is told where the options end.
        expect(await text(placeAt(path), 'uncommitted', '--stat.txt')).toMatchObject({ modified: lines('dash') });
        expect((await changes(placeAt(path), 'uncommitted')).files.map(file => file.path)).toContain('--stat.txt');
    });

    onPosix('does not read through a folder that was replaced by a link out of the place', async () => {
        const { work: path } = clone();
        const outside = tempDir('git-changes');

        put(path, { 'docs/guide.md': lines('guide') });
        commit(path, 'Add the docs');
        writeFileSync(join(outside, 'guide.md'), 'outside the place\n');
        rmSync(join(path, 'docs'), { recursive: true });
        symlinkSync(outside, join(path, 'docs'));

        // Git does not look through the link: the file it tracked is gone, and the link is a new file of its own.
        const gone = await placeFile(placeAt(path), 'uncommitted', 'docs/guide.md', undefined);

        expect(gone).toMatchObject({ state: 'text', original: lines('guide'), modified: null });
        expect((await text(placeAt(path), 'uncommitted', 'docs')).modified).toBe(outside);
        expect(JSON.stringify(gone)).not.toContain('outside the place');
    });

    onPosix('reads a link as its target and never what the link points at', async () => {
        const { work: path } = clone();
        const secret = join(tempDir('git-changes'), 'secret.txt');

        writeFileSync(secret, "the daemon's own business\n");
        symlinkSync(secret, join(path, 'leak'));
        mkdirSync(join(path, 'real'));
        put(path, { 'real/in.txt': lines('in') });

        const sides = await text(placeAt(path), 'uncommitted', 'leak');

        expect(sides.modified).toBe(secret);
        expect(JSON.stringify(sides)).not.toContain('business');
    });
});

describe('the scope of a run', () => {
    /** The two trees around a change the callback makes: what a turn's start and end take. */
    async function around(path: string, act: () => void): Promise<{ start: string; end: string; scope: GitScope }> {
        const start = await snapshotTree(path);

        act();

        const end = await snapshotTree(path);

        if (!start || !end) throw new Error('No tree was made');

        return { start, end, scope: turnScope(start, end) };
    }

    test('counts the files between the two trees: edited, renamed, new, deleted and binary ones, and not the committed or the earlier uncommitted work', async () => {
        const { path } = work();
        const { scope } = await around(path, () => {
            writeFileSync(join(path, 'lib.ts'), lines('a', 'B', 'c', 'd', 'e', 'f'));
            renameSync(join(path, 'renamed.ts'), join(path, 'moved.ts'));
            rmSync(join(path, 'scratch.txt'));
            put(path, { 'fresh.md': lines('alpha', 'beta', 'gamma'), 'icon.bin': Buffer.from([0, 9, 0, 9]) });
        });
        const answer = await changes(placeAt(path), scope);

        expect(answer).toMatchObject({ scope, fileCount: 5, statsComplete: true });
        expect(answer.from).toBeUndefined();
        expect(answer.baseState).toBeUndefined();
        expect(
            answer.files.map(file => [file.path, file.kind, file.oldPath, file.additions, file.deletions, file.binary])
        ).toEqual([
            ['fresh.md', 'added', undefined, 3, 0, undefined],
            ['icon.bin', 'added', undefined, undefined, undefined, true],
            ['lib.ts', 'modified', undefined, 1, 0, undefined],
            ['moved.ts', 'renamed', 'renamed.ts', 0, 0, undefined],
            ['scratch.txt', 'deleted', undefined, 0, 2, undefined],
        ]);
        // The files git does not track yet are files of the trees: none of them is `untracked`, which means "not in the index".
        expect(answer.files.some(file => file.untracked)).toBe(false);
        expect(answer.additions).toBe(4);
        expect(answer.deletions).toBe(2);
    });

    test('reads a file from the trees whatever `from` and the base are, and costs no base lookup', async () => {
        const { path } = work();
        const { scope } = await around(path, () => {
            writeFileSync(join(path, 'lib.ts'), lines('a', 'B', 'c', 'd', 'e', 'edited by the run'));
        });
        const place = placeAt(path);
        const expected = {
            state: 'text',
            original: lines('a', 'B', 'c', 'd', 'e'),
            modified: lines('a', 'B', 'c', 'd', 'e', 'edited by the run'),
        };

        expect(await placeFile(place, scope, 'lib.ts', undefined)).toMatchObject(expected);
        // A card sends the `from` of its list, which a run's list does not have; one that is sent anyway is not looked at.
        expect(await placeFile(place, scope, 'lib.ts', undefined, { from: 'not a hash' })).toMatchObject(expected);
        expect(await placeFile(place, scope, 'lib.ts', undefined, { base: 'no-such-branch' })).toMatchObject(expected);
        await expect(placeFile(place, scope, 'README.md', undefined)).rejects.toMatchObject({ code: 'not_found' });

        if (posix) {
            const processes = await gitProcessesOf(() => placeFile(place, scope, 'lib.ts', undefined));

            expect(
                processes.some(
                    line =>
                        line.includes('merge-base') || line.includes('for-each-ref') || line.includes('symbolic-ref')
                )
            ).toBe(false);
        }
    });

    test('keeps the revision of a file the same for as long as the trees are, so a mark of viewed holds', async () => {
        const { path } = work();
        const { scope } = await around(path, () => {
            writeFileSync(join(path, 'lib.ts'), lines('a', 'run'));
        });
        const first = (await changes(placeAt(path), scope)).files[0]!.revision;

        writeFileSync(join(path, 'lib.ts'), lines('somebody else afterwards'));
        git(path, 'add', '-A');
        git(path, 'commit', '-q', '-m', 'Later work');
        expect((await changes(placeAt(path), scope)).files[0]!.revision).toBe(first);
    });

    test('refuses what is not two trees: an object of another kind, and a pair of ids in a repository that has neither', async () => {
        const { path } = work();
        const tree = git(path, 'rev-parse', 'HEAD^{tree}');
        const blob = git(path, 'rev-parse', 'HEAD:lib.ts');
        const commitId = git(path, 'rev-parse', 'HEAD');
        const place = placeAt(path);

        expect((await failure(placeChanges(place, turnScope(tree, blob)))).code).toBe('invalid');
        expect((await failure(placeChanges(place, turnScope(commitId, tree)))).code).toBe('invalid');
        expect((await failure(placeChanges(place, turnScope('0'.repeat(40), tree)))).code).toBe('unavailable');
        expect((await failure(placeChanges(place, turnScope(tree, 'f'.repeat(40))))).code).toBe('unavailable');
        expect((await failure(placeFile(place, turnScope('0'.repeat(40), tree), 'lib.ts', undefined))).code).toBe(
            'unavailable'
        );
        expect(await changes(place, turnScope(tree, tree))).toMatchObject({ fileCount: 0, files: [] });
        // Another repository does not have the trees of this one.
        expect(
            (
                await failure(
                    placeChanges(
                        placeAt(makeRepo(tempDir('git-changes'), 'other')),
                        turnScope(tree, git(path, 'rev-parse', 'HEAD~1^{tree}'))
                    )
                )
            ).code
        ).toBe('unavailable');
    });
});

describe('over HTTP', () => {
    let h: Harness;

    beforeEach(async () => {
        h = await startHarness();
    });

    afterEach(async () => {
        await h.stop();
    });

    const json = async <T>(response: Response) => (await response.json()) as T;

    test('answers a place of the project over the three routes, behind the token, and says what is wrong with a request', async () => {
        const { path, first } = work();
        const { project } = h.ok('project.add', { folders: [path] });
        const folderId = project.folders[0].id as string;
        const base = `/v1/projects/${project.id}/git`;
        const query = (extra = '') => `?folderId=${folderId}${extra}`;

        const answer = await json<Extract<GitStatus, { isRepository: true }>>(
            await h.fetch(`${base}/status${query()}`)
        );

        expect(answer).toMatchObject({
            isRepository: true,
            head: { kind: 'branch', name: 'feature' },
            origin: true,
            base: { state: 'ready', name: 'origin/main', ahead: 2, behind: 0 },
        });
        expect(answer.entries.map(entry => entry.path)).toEqual(['lib.ts', 'src/staged.ts', 'scratch.txt']);

        const all = await json<Extract<GitChanges, { isRepository: true }>>(await h.fetch(`${base}/changes${query()}`));

        expect(all).toMatchObject({ scope: 'all', fileCount: 7, baseState: 'ready' });
        expect(await json<GitChanges>(await h.fetch(`${base}/changes${query('&scope=branch')}`))).toMatchObject({
            scope: 'branch',
            fileCount: 5,
        });
        expect(
            await json<GitChanges>(await h.fetch(`${base}/changes${query(`&scope=commit:${first}`)}`))
        ).toMatchObject({ fileCount: 3 });

        const sides = await json<GitFileSides>(await h.fetch(`${base}/file${query('&scope=all&path=lib.ts')}`));

        expect(sides).toMatchObject({
            state: 'text',
            original: lines('a', 'b', 'c'),
            modified: lines('a', 'B', 'c', 'd', 'e'),
        });
        expect(
            await json<GitFileSides>(
                await h.fetch(
                    `${base}/file${query(`&scope=branch&path=${encodeURIComponent('renamed.ts')}&oldPath=old-name.ts`)}`
                )
            )
        ).toMatchObject({ state: 'text', original: expect.stringContaining('y = 2') });

        // A card sends the start of its list.
        expect(
            await json<GitFileSides>(await h.fetch(`${base}/file${query(`&scope=all&path=lib.ts&from=${all.from}`)}`))
        ).toEqual(sides);
        expect(
            await json<GitFileSides>(await h.fetch(`${base}/file${query(`&scope=all&path=lib.ts&from=${first}`)}`))
        ).toMatchObject({ original: lines('a', 'B', 'c', 'd') });
        expect((await h.fetch(`${base}/file${query('&scope=all&path=lib.ts&from=main')}`)).status).toBe(400);
        expect((await h.fetch(`${base}/file${query('&scope=all&path=lib.ts&from=')}`)).status).toBe(400);
        expect((await h.fetch(`${base}/file${query('&scope=all&path=lib.ts&from=0123456789abcdef')}`)).status).toBe(
            404
        );

        expect((await h.fetch(`${base}/status`)).status).toBe(400);
        expect((await h.fetch(`${base}/changes${query('&scope=sideways')}`)).status).toBe(400);
        expect((await h.fetch(`${base}/changes${query('&scope=commit:abc')}`)).status).toBe(400);
        expect((await h.fetch(`${base}/changes${query('&scope=commit:0123456789abcdef')}`)).status).toBe(404);
        expect((await h.fetch(`${base}/file${query('&scope=all')}`)).status).toBe(400);
        expect((await h.fetch(`${base}/file${query('&scope=all&path=nothing.txt')}`)).status).toBe(404);
        expect((await h.fetch(`${base}/file${query('&scope=all&path=../lib.ts')}`)).status).toBe(400);
        expect((await h.fetch(`${base}/status?folderId=fld_unknown`)).status).toBe(404);
        expect((await h.fetch(`/v1/projects/prj_unknown/git/status${query()}`)).status).toBe(404);
        expect((await fetch(`${h.url}${base}/status${query()}`)).status).toBe(401);

        rmSync(path, { recursive: true });
        expect((await h.fetch(`${base}/status${query()}`)).status).toBe(503);
    });

    test("answers a run's scope by its two trees, and says what is wrong with a scope that is none", async () => {
        const { path } = work();
        const start = await snapshotTree(path);

        put(path, { 'run-made.ts': lines('made by the run', 'in two lines') });

        const end = await snapshotTree(path);
        const { project } = h.ok('project.add', { folders: [path] });
        const base = `/v1/projects/${project.id}/git`;
        const query = (scope: string, extra = '') => `?folderId=${project.folders[0].id}&scope=${scope}${extra}`;
        const scope = turnScope(start as string, end as string);

        expect(await json<GitChanges>(await h.fetch(`${base}/changes${query(scope)}`))).toMatchObject({
            isRepository: true,
            scope,
            fileCount: 1,
            additions: 2,
            files: [{ path: 'run-made.ts', kind: 'added' }],
        });
        expect(
            await json<GitFileSides>(await h.fetch(`${base}/file${query(scope, '&path=run-made.ts')}`))
        ).toMatchObject({ state: 'text', original: null, modified: lines('made by the run', 'in two lines') });
        // The ids are made lower case, as a commit's are.
        expect((await h.fetch(`${base}/changes${query(scope.toUpperCase().replace('TURN:', 'turn:'))}`)).status).toBe(
            200
        );

        for (const bad of [
            'turn:abc',
            `turn:${start}`,
            `turn:${start}:${'a'.repeat(64)}`,
            `turn:main:${end}`,
            'turn:',
        ]) {
            expect((await h.fetch(`${base}/changes${query(bad)}`)).status).toBe(400);
        }

        // A tree git does not have, and one that is no tree.
        expect((await h.fetch(`${base}/changes${query(turnScope(start as string, 'e'.repeat(40)))}`)).status).toBe(503);
        expect(
            (
                await h.fetch(
                    `${base}/changes${query(turnScope(start as string, git(path, 'rev-parse', 'HEAD:lib.ts')))}`
                )
            ).status
        ).toBe(400);
    });

    test('says a folder that is no repository is none', async () => {
        const plain = tempDir('git-changes');
        const { project } = h.ok('project.add', { folders: [plain] });
        const query = `?folderId=${project.folders[0].id}`;

        expect(await json<GitStatus>(await h.fetch(`/v1/projects/${project.id}/git/status${query}`))).toEqual({
            isRepository: false,
        });
        expect(await json<GitChanges>(await h.fetch(`/v1/projects/${project.id}/git/changes${query}`))).toEqual({
            isRepository: false,
        });
        expect((await h.fetch(`/v1/projects/${project.id}/git/file${query}&path=a.txt`)).status).toBe(400);
    });

    test("answers a chat's worktree on its own, as the file routes do, and refuses a workspace that is not the folder's or not made", async () => {
        const { work: repo } = clone();
        const tree = join(tempDir('git-changes'), 'chat-tree');

        // The main checkout has work of its own that the worktree has not.
        put(repo, { 'in-checkout.txt': lines('only here') });
        git(repo, 'worktree', 'add', '-q', '-b', 'chat-branch', tree, 'origin/main');
        put(tree, { 'in-tree.txt': lines('t1', 't2') });
        commit(tree, 'Work in the tree');
        put(tree, { 'lib.ts': lines('a', 'b', 'c', 'tree edit') });

        const stranger = makeRepo(tempDir('git-changes'), 'stranger');
        const strangerTree = join(tempDir('git-changes'), 'stranger-tree');

        git(stranger, 'worktree', 'add', '-q', '-b', 'theirs', strangerTree);

        const { project } = h.ok('project.add', { name: 'Shop', folders: [repo] });
        const { project: other } = h.ok('project.add', { name: 'Other', folders: [stranger] });
        const folderId = project.folders[0].id as string;
        const workspaceId = (
            h.ok('chat.create', { projectId: project.id, workspace: { mode: 'existing', path: tree } }).chat
                .workspace as { id: string }
        ).id;
        const otherId = (
            h.ok('chat.create', { projectId: other.id, workspace: { mode: 'existing', path: strangerTree } }).chat
                .workspace as { id: string }
        ).id;
        const base = `/v1/projects/${project.id}/git`;
        const at = (query: string) => `?folderId=${folderId}&workspaceId=${workspaceId}${query}`;

        const own = await json<Extract<GitStatus, { isRepository: true }>>(await h.fetch(`${base}/status${at('')}`));
        const checkout = await json<Extract<GitStatus, { isRepository: true }>>(
            await h.fetch(`${base}/status?folderId=${folderId}`)
        );

        expect(own.head).toMatchObject({ kind: 'branch', name: 'chat-branch' });
        expect(own.entries).toEqual([{ path: 'lib.ts', unstaged: 'modified' }]);
        expect(own.base).toMatchObject({ state: 'ready', name: 'origin/main', ahead: 1, behind: 0 });
        expect(checkout.head).toMatchObject({ kind: 'branch', name: 'main' });
        expect(checkout.entries).toEqual([{ path: 'in-checkout.txt', untracked: true }]);

        const treeChanges = await json<Extract<GitChanges, { isRepository: true }>>(
            await h.fetch(`${base}/changes${at('&scope=all')}`)
        );

        expect(treeChanges.files.map(file => file.path)).toEqual(['in-tree.txt', 'lib.ts']);
        expect(
            (
                await json<Extract<GitChanges, { isRepository: true }>>(
                    await h.fetch(`${base}/changes?folderId=${folderId}&scope=all`)
                )
            ).files.map(file => file.path)
        ).toEqual(['in-checkout.txt']);
        expect(await json(await h.fetch(`${base}/file${at('&scope=all&path=lib.ts')}`))).toMatchObject({
            state: 'text',
            modified: lines('a', 'b', 'c', 'tree edit'),
        });
        expect((await h.fetch(`${base}/file?folderId=${folderId}&scope=all&path=in-tree.txt`)).status).toBe(404);

        // The worktree's own base is what its compare starts from, when it has one; the folder's is still the default for the rest.
        git(repo, 'branch', '-q', 'release', 'origin/dev');
        h.store.db.query('UPDATE workspaces SET base = ? WHERE id = ?').run('release', workspaceId);
        expect(
            (await json<Extract<GitStatus, { isRepository: true }>>(await h.fetch(`${base}/status${at('')}`))).base
        ).toMatchObject({ state: 'ready', name: 'release', ahead: 1 });

        // Another project's worktree, an unknown one and a worktree that is not made are not places of this project.
        expect((await h.fetch(`${base}/status${at('').replace(workspaceId, otherId)}`)).status).toBe(404);
        expect((await h.fetch(`${base}/changes${at('&scope=all').replace(workspaceId, 'wks_unknown')}`)).status).toBe(
            404
        );
        h.store.db.query('UPDATE workspaces SET ready = 0 WHERE id = ?').run(workspaceId);
        expect((await h.fetch(`${base}/status${at('')}`)).status).toBe(503);
        h.store.db.query('UPDATE workspaces SET ready = 1 WHERE id = ?').run(workspaceId);
        rmSync(tree, { recursive: true });
        expect((await h.fetch(`${base}/file${at('&scope=all&path=lib.ts')}`)).status).toBe(503);
    });
});

import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import {
    chmodSync,
    existsSync,
    lstatSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    readlinkSync,
    realpathSync,
    renameSync,
    rmSync,
    statSync,
    symlinkSync,
    utimesSync,
    writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { GIT_DISCARD_KEEP_DAYS, MAX_GIT_DISCARD_PATHS } from '@clowdy/protocol';

import { DiscardCopies, KEEP_COPIES_MS, MAX_COPY_FILE_BYTES, MAX_KEPT_BYTES } from '../src/git/discardCopies';
import { WriteEnvironment } from '../src/git/writeEnv';
import { cleanTempDirs, git, makeRepo, startHarness, tempDir, waitFor } from './helpers';

import type { GitDiscardResult } from '@clowdy/protocol';
import type { CopyJob, KeptCopy } from '../src/git/discardCopies';
import type { Harness } from './helpers';

afterAll(cleanTempDirs);

const posix = process.platform !== 'win32';
/** Links, modes and hooks are POSIX: on Windows these cases are skipped, not run against another behaviour. */
const withPosix = posix ? describe : describe.skip;

const harnesses: Harness[] = [];

afterEach(async () => {
    await Promise.all(harnesses.splice(0).map(h => h.stop().catch(() => undefined)));
});

/** The person's own git configuration (which signs every commit on a developer's machine) and the system's stay out of the writes of a test. */
const isolated = () =>
    new WriteEnvironment({
        env: () => ({
            ...process.env,
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_CONFIG_NOSYSTEM: '1',
            SHELL: '/usr/bin/true',
        }),
    });

const FILES = {
    'a.txt': 'a\n',
    'b.txt': 'b\n',
    'gone.txt': 'gone\n',
    'old.txt': 'one\ntwo\nthree\nfour\nfive\n',
    'src/mod.ts': 'export const mod = 1;\n',
};

/** A repository with its own identity and no signing, and the files `files` committed. */
function repository(files: Record<string, string> = FILES): string {
    const path = makeRepo(tempDir('git-discard'));

    git(path, 'config', 'user.name', 'Test');
    git(path, 'config', 'user.email', 'test@example.com');
    git(path, 'config', 'commit.gpgsign', 'false');
    put(path, files);
    git(path, 'add', '-A');
    git(path, 'commit', '-q', '-m', 'Add the files');

    return path;
}

/** Writes files (and the folders above them) under `root`. */
function put(root: string, files: Record<string, string>): void {
    for (const [path, content] of Object.entries(files)) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), content);
    }
}

function hook(path: string, name: string, ...lines: string[]): void {
    const file = join(path, '.git', 'hooks', name);

    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, ['#!/bin/sh', ...lines].join('\n'));
    chmodSync(file, 0o755);
}

/** What is left in the tree and the index as `status --porcelain` says it. */
const left = (path: string): string[] =>
    Bun.spawnSync(['git', 'status', '--porcelain', '--untracked-files=all'], {
        cwd: path,
        stdout: 'pipe',
        stderr: 'pipe',
    })
        .stdout.toString()
        .split('\n')
        .filter(line => line !== '')
        .sort();

/** Everything about a place that a refusal must not change: HEAD, what the index holds, and every file and link on the disk (outside `.git`). */
function snapshot(path: string): { head: string; index: string; tree: Record<string, string> } {
    const tree: Record<string, string> = {};
    const walk = (directory: string) => {
        for (const name of readdirSync(directory)) {
            const full = join(directory, name);
            const info = lstatSync(full);
            const key = relative(path, full);

            if (name === '.git' && directory === path) continue;

            if (info.isSymbolicLink()) {
                tree[key] = `-> ${readlinkSync(full)}`;
            } else if (info.isDirectory()) {
                tree[`${key}/`] = 'dir';
                walk(full);
            } else {
                tree[key] = `${info.mode & 0o777}:${readFileSync(full, 'utf8')}`;
            }
        }
    };

    walk(path);

    return { head: git(path, 'rev-parse', 'HEAD'), index: git(path, 'ls-files', '--stage'), tree };
}

const json = async <T>(response: Response) => (await response.json()) as T;

interface Failure {
    ok: false;
    error: { code: string; message: string; details?: unknown };
}

/** A copy that is spied on and may be made to misbehave: what the daemon makes copies with, with a hand in `keep`. */
class SpyCopies extends DiscardCopies {
    jobs: CopyJob[] = [];
    before?: () => void | Promise<void>;
    after?: (copy: KeptCopy) => void | Promise<void>;
    fail?: Error;

    override async keep(job: CopyJob): Promise<KeptCopy> {
        this.jobs.push(job);
        await this.before?.();

        if (this.fail) throw this.fail;

        const copy = await super.keep(job);

        await this.after?.(copy);

        return copy;
    }
}

interface StartOptions {
    copies?: DiscardCopies;
}

async function start({ copies }: StartOptions = {}): Promise<Harness> {
    const h = await startHarness({}, { gitEnvironment: isolated(), ...(copies && { discardCopies: copies }) });

    harnesses.push(h);

    return h;
}

/** The project of a repository and the request that discards `paths` in it. */
async function open(path: string, h: Harness) {
    const { project } = h.ok('project.add', { folders: [path] });
    const folderId = project.folders[0].id as string;
    const url = `/v1/projects/${project.id}/git/discard`;
    const discard = (paths: unknown, place: Record<string, string> = {}) =>
        h.fetch(url, { method: 'POST', body: JSON.stringify({ folderId, paths, ...place }) });

    return { project, folderId, url, discard };
}

/** The manifest of a copy, and a copied file. */
const manifestOf = (copy: { folder: string }) =>
    JSON.parse(readFileSync(join(copy.folder, 'manifest.json'), 'utf8')) as Record<string, any>;
const copied = (copy: { folder: string }, path: string, kind: 'files' | 'staged' = 'files') =>
    readFileSync(join(copy.folder, kind, path), 'utf8');

describe('POST /v1/projects/:id/git/discard', () => {
    test('puts an edited file back as the last commit has it, keeps a copy of the edit, and leaves every other file and HEAD alone', async () => {
        const h = await start();
        const path = repository();
        const { discard, project, folderId } = await open(path, h);

        put(path, { 'a.txt': 'a\nthe agent wrote this\n', 'b.txt': 'b\nmore\n', 'fresh.txt': 'fresh\n' });

        const head = git(path, 'rev-parse', 'HEAD');
        const response = await discard(['a.txt']);
        const result = await json<GitDiscardResult>(response);

        expect(response.status).toBe(200);
        expect(result.discarded).toEqual([{ path: 'a.txt', action: 'restored' }]);
        expect(readFileSync(join(path, 'a.txt'), 'utf8')).toBe('a\n');
        expect(left(path)).toEqual([' M b.txt', '?? fresh.txt']);
        expect(git(path, 'rev-parse', 'HEAD')).toBe(head);
        // The other edits are what they were.
        expect(readFileSync(join(path, 'b.txt'), 'utf8')).toBe('b\nmore\n');
        expect(readFileSync(join(path, 'fresh.txt'), 'utf8')).toBe('fresh\n');

        // The copy is the file as it was just before, in the daemon's data folder and not in the repository.
        expect(result.copy.files).toBe(1);
        expect(result.copy.folder.startsWith(join(h.config.dataDir, 'discarded', project.id))).toBe(true);
        expect(result.copy.folder.startsWith(path)).toBe(false);
        expect(copied(result.copy, 'a.txt')).toBe('a\nthe agent wrote this\n');
        expect(result.copy.keptUntil).toBeGreaterThan(Date.now() + KEEP_COPIES_MS - 60_000);
        expect(result.copy.keptUntil).toBeLessThanOrEqual(Date.now() + KEEP_COPIES_MS);
        expect(manifestOf(result.copy)).toMatchObject({
            version: 1,
            projectId: project.id,
            folderId,
            branch: 'main',
            head,
            completed: true,
            files: [{ path: 'a.txt', action: 'restored', copied: 'file', size: 'a\nthe agent wrote this\n'.length }],
        });
        expect(manifestOf(result.copy).place).toBe(realpathSync(path));
        expect(existsSync(join(path, '.git', 'discarded'))).toBe(false);
    });

    test('brings back a deleted file, and says there is nothing to copy of it', async () => {
        const h = await start();
        const path = repository();
        const { discard } = await open(path, h);

        rmSync(join(path, 'gone.txt'));

        const result = await json<GitDiscardResult>(await discard(['gone.txt']));

        expect(result.discarded).toEqual([{ path: 'gone.txt', action: 'restored' }]);
        expect(result.copy.files).toBe(0);
        expect(readFileSync(join(path, 'gone.txt'), 'utf8')).toBe('gone\n');
        expect(left(path)).toEqual([]);
    });

    test('puts back a file that was staged for removal as well', async () => {
        const h = await start();
        const path = repository();
        const { discard } = await open(path, h);

        git(path, 'rm', '-q', 'gone.txt');

        expect(left(path)).toEqual(['D  gone.txt']);
        expect((await discard(['gone.txt'])).status).toBe(200);
        expect(left(path)).toEqual([]);
        expect(readFileSync(join(path, 'gone.txt'), 'utf8')).toBe('gone\n');
    });

    test('replaces a staged edit and the edit of the file after it, and keeps both versions, the staged one apart', async () => {
        const h = await start();
        const path = repository();
        const { discard } = await open(path, h);

        put(path, { 'a.txt': 'a\nstaged\n' });
        git(path, 'add', 'a.txt');
        put(path, { 'a.txt': 'a\nstaged\nand then edited\n', 'b.txt': 'b\nstaged too\n' });
        git(path, 'add', 'b.txt');

        expect(left(path)).toEqual(['M  b.txt', 'MM a.txt']);

        const result = await json<GitDiscardResult>(await discard(['a.txt', 'b.txt']));

        expect(left(path)).toEqual([]);
        expect(readFileSync(join(path, 'a.txt'), 'utf8')).toBe('a\n');
        expect(readFileSync(join(path, 'b.txt'), 'utf8')).toBe('b\n');
        // What was on the disk is kept for both; the staged version of a (which is not on the disk any more) is kept apart, and b's, which the file still is, is not repeated.
        expect(copied(result.copy, 'a.txt')).toBe('a\nstaged\nand then edited\n');
        expect(copied(result.copy, 'a.txt', 'staged')).toBe('a\nstaged\n');
        expect(copied(result.copy, 'b.txt')).toBe('b\nstaged too\n');
        expect(existsSync(join(result.copy.folder, 'staged', 'b.txt'))).toBe(false);
        expect(result.copy.files).toBe(3);
    });

    test('keeps the staged version of a file that was staged and then deleted from the disk', async () => {
        const h = await start();
        const path = repository();
        const { discard } = await open(path, h);

        put(path, { 'a.txt': 'a\nstaged and gone\n' });
        git(path, 'add', 'a.txt');
        rmSync(join(path, 'a.txt'));

        const result = await json<GitDiscardResult>(await discard(['a.txt']));

        expect(left(path)).toEqual([]);
        expect(readFileSync(join(path, 'a.txt'), 'utf8')).toBe('a\n');
        expect(existsSync(join(result.copy.folder, 'files', 'a.txt'))).toBe(false);
        expect(copied(result.copy, 'a.txt', 'staged')).toBe('a\nstaged and gone\n');
    });

    test('removes a new file that was staged from the index and the disk, and only that file', async () => {
        const h = await start();
        const path = repository();
        const { discard } = await open(path, h);

        put(path, { 'fresh/deep/new.ts': 'new\n', 'fresh/deep/other.ts': 'other\n', 'plain.txt': 'plain\n' });
        git(path, 'add', 'fresh/deep/new.ts');
        put(path, { 'fresh/deep/new.ts': 'new\nedited after the staging\n' });

        const before = git(path, 'rev-parse', 'HEAD');
        const result = await json<GitDiscardResult>(await discard(['fresh/deep/new.ts']));

        expect(result.discarded).toEqual([{ path: 'fresh/deep/new.ts', action: 'removed' }]);
        expect(existsSync(join(path, 'fresh/deep/new.ts'))).toBe(false);
        expect(git(path, 'ls-files', '--', 'fresh')).toBe('');
        // The files beside it, and the folders above it, are the person's.
        expect(readFileSync(join(path, 'fresh/deep/other.ts'), 'utf8')).toBe('other\n');
        expect(left(path)).toEqual(['?? fresh/deep/other.ts', '?? plain.txt']);
        expect(git(path, 'rev-parse', 'HEAD')).toBe(before);
        expect(copied(result.copy, 'fresh/deep/new.ts')).toBe('new\nedited after the staging\n');
        expect(copied(result.copy, 'fresh/deep/new.ts', 'staged')).toBe('new\n');

        // The folder is left even when it is empty now.
        rmSync(join(path, 'fresh/deep/other.ts'));
        put(path, { 'only/one.ts': '1\n' });
        await discard(['only/one.ts']);

        expect(statSync(join(path, 'only')).isDirectory()).toBe(true);
        expect(readdirSync(join(path, 'only'))).toEqual([]);
    });

    test('removes a file that was only marked to be added', async () => {
        const h = await start();
        const path = repository();
        const { discard } = await open(path, h);

        put(path, { 'intent.txt': 'intent\n' });
        git(path, 'add', '-N', 'intent.txt');

        expect((await discard(['intent.txt'])).status).toBe(200);
        expect(existsSync(join(path, 'intent.txt'))).toBe(false);
        expect(left(path)).toEqual([]);
    });

    test('puts a renamed file back under its old name and removes the new one, whether it was staged or not', async () => {
        const h = await start();
        const path = repository();
        const { discard } = await open(path, h);

        git(path, 'mv', 'old.txt', 'renamed.txt');
        put(path, { 'renamed.txt': 'one\ntwo\nthree\nfour\nfive\nsix\n' });

        expect(left(path)).toEqual(['RM old.txt -> renamed.txt']);

        const result = await json<GitDiscardResult>(await discard(['renamed.txt']));

        // One file, which the person saw once: its old path is not an entry of its own.
        expect(result.discarded).toEqual([{ path: 'renamed.txt', action: 'restored' }]);
        expect(left(path)).toEqual([]);
        expect(readFileSync(join(path, 'old.txt'), 'utf8')).toBe('one\ntwo\nthree\nfour\nfive\n');
        expect(existsSync(join(path, 'renamed.txt'))).toBe(false);
        expect(copied(result.copy, 'renamed.txt')).toBe('one\ntwo\nthree\nfour\nfive\nsix\n');
        expect(manifestOf(result.copy).files.map((file: { path: string }) => file.path)).toEqual([
            'renamed.txt',
            'old.txt',
        ]);
    });

    test('deletes an untracked file and that file only: no folder, no sibling, no ignored file', async () => {
        const h = await start();
        const path = repository();
        const { discard } = await open(path, h);

        writeFileSync(join(path, '.gitignore'), 'ignored.log\n');
        git(path, 'add', '.gitignore');
        git(path, 'commit', '-q', '-m', 'Ignore the log');
        put(path, {
            'notes/draft.md': 'draft\n',
            'notes/keep.md': 'keep\n',
            'ignored.log': 'log\n',
            'tmp/only.txt': 'only\n',
            'new.txt': 'new\n',
        });

        const result = await json<GitDiscardResult>(await discard(['notes/draft.md']));

        expect(result.discarded).toEqual([{ path: 'notes/draft.md', action: 'removed' }]);
        expect(existsSync(join(path, 'notes/draft.md'))).toBe(false);
        expect(readFileSync(join(path, 'notes/keep.md'), 'utf8')).toBe('keep\n');
        expect(readFileSync(join(path, 'ignored.log'), 'utf8')).toBe('log\n');
        expect(left(path)).toEqual(['?? new.txt', '?? notes/keep.md', '?? tmp/only.txt']);
        expect(copied(result.copy, 'notes/draft.md')).toBe('draft\n');

        // The folder of the last file is left, empty, and a path that is a folder is not a changed file: it is never removed whole.
        await discard(['tmp/only.txt']);

        expect(statSync(join(path, 'tmp')).isDirectory()).toBe(true);
        expect((await discard(['notes'])).status).toBe(400);
        expect((await discard(['notes/'])).status).toBe(400);
        expect(readFileSync(join(path, 'notes/keep.md'), 'utf8')).toBe('keep\n');
    });

    test("takes a path with pattern characters, a space or a leading dash as the file's own, and not as a pattern for its neighbours", async () => {
        const h = await start();
        const path = repository({
            'src/[id].tsx': '1\n',
            'src/i.tsx': '2\n',
            'star*.txt': '3\n',
            'starX.txt': '4\n',
            'a b.txt': '5\n',
            '-p': '6\n',
            ':colon.txt': '7\n',
        });
        const { discard } = await open(path, h);

        for (const file of ['src/[id].tsx', 'src/i.tsx', 'star*.txt', 'starX.txt', 'a b.txt', '-p', ':colon.txt'])
            put(path, { [file]: 'edited\n' });

        expect((await discard(['src/[id].tsx', 'star*.txt', 'a b.txt', '-p', ':colon.txt'])).status).toBe(200);
        expect(left(path)).toEqual([' M src/i.tsx', ' M starX.txt']);
    });

    test('works in a repository with no commit yet', async () => {
        const h = await start();
        const path = tempDir('git-discard');

        mkdirSync(path, { recursive: true });
        git(path, 'init', '-q', '-b', 'main');
        put(path, { 'staged.txt': 'staged\n', 'plain.txt': 'plain\n' });
        git(path, 'add', 'staged.txt');

        const { discard } = await open(path, h);
        const result = await json<GitDiscardResult>(await discard(['staged.txt', 'plain.txt']));

        expect(result.discarded.map(file => file.action)).toEqual(['removed', 'removed']);
        expect(left(path)).toEqual([]);
        expect(readdirSync(path)).toEqual(['.git']);
        expect(copied(result.copy, 'staged.txt')).toBe('staged\n');
        expect(manifestOf(result.copy).head).toBeUndefined();
    });

    test("keeps what is in the repository the person's: the copy is readable by them alone", async () => {
        const h = await start();
        const path = repository();
        const { discard } = await open(path, h);

        put(path, { 'a.txt': 'secret\n' });

        const result = await json<GitDiscardResult>(await discard(['a.txt']));

        if (posix) {
            expect(statSync(result.copy.folder).mode & 0o077).toBe(0);
            expect(statSync(join(result.copy.folder, 'files', 'a.txt')).mode & 0o077).toBe(0);
            expect(statSync(join(result.copy.folder, 'manifest.json')).mode & 0o077).toBe(0);
        }
    });

    withPosix('with links, modes and what a file is on the disk', () => {
        test('puts back a file whose only change is its mode, with its content', async () => {
            const h = await start();
            const path = repository();
            const { discard } = await open(path, h);

            chmodSync(join(path, 'a.txt'), 0o755);

            expect(left(path)).toEqual([' M a.txt']);
            expect((await discard(['a.txt'])).status).toBe(200);
            expect(left(path)).toEqual([]);
            expect(statSync(join(path, 'a.txt')).mode & 0o111).toBe(0);
            expect(readFileSync(join(path, 'a.txt'), 'utf8')).toBe('a\n');
        });

        test('discards an untracked link, never what it points to', async () => {
            const h = await start();
            const path = repository();
            const outside = tempDir('git-discard-outside');
            const { discard } = await open(path, h);

            put(outside, { 'precious.txt': 'do not touch\n' });
            put(path, { 'real/inside.txt': 'inside\n' });
            symlinkSync(join(outside, 'precious.txt'), join(path, 'link-to-file'));
            symlinkSync(outside, join(path, 'link-to-folder'));
            symlinkSync('real', join(path, 'link-inside'));

            const result = await json<GitDiscardResult>(
                await discard(['link-to-file', 'link-to-folder', 'link-inside'])
            );

            expect(result.discarded.map(file => file.action)).toEqual(['removed', 'removed', 'removed']);
            expect(existsSync(join(path, 'link-to-file'))).toBe(false);
            expect(lstatSync(join(outside, 'precious.txt')).isFile()).toBe(true);
            expect(readFileSync(join(outside, 'precious.txt'), 'utf8')).toBe('do not touch\n');
            expect(readFileSync(join(path, 'real/inside.txt'), 'utf8')).toBe('inside\n');
            // The copy of a link is what it points to, as text, and not what is there.
            expect(copied(result.copy, 'link-to-file')).toBe(join(outside, 'precious.txt'));
            expect(manifestOf(result.copy).files[0]).toMatchObject({ path: 'link-to-file', copied: 'link' });
        });

        test('turns a link that was retargeted back, and a file that was made a link back into the file, without writing through the link', async () => {
            const h = await start();
            const path = repository();
            const outside = tempDir('git-discard-outside');
            const { discard } = await open(path, h);

            put(path, { 'target.txt': 'target\n' });
            symlinkSync('target.txt', join(path, 'link'));
            git(path, 'add', '-A');
            git(path, 'commit', '-q', '-m', 'Add a link');
            put(outside, { 'outside.txt': 'outside\n' });

            // The link points elsewhere, and a.txt is a link to a file outside the repository.
            rmSync(join(path, 'link'));
            symlinkSync(join(outside, 'outside.txt'), join(path, 'link'));
            rmSync(join(path, 'a.txt'));
            symlinkSync(join(outside, 'outside.txt'), join(path, 'a.txt'));

            expect(left(path)).toEqual([' M link', ' T a.txt']);

            const result = await json<GitDiscardResult>(await discard(['link', 'a.txt']));

            expect(left(path)).toEqual([]);
            expect(readlinkSync(join(path, 'link'))).toBe('target.txt');
            expect(lstatSync(join(path, 'a.txt')).isFile()).toBe(true);
            expect(readFileSync(join(path, 'a.txt'), 'utf8')).toBe('a\n');
            expect(readFileSync(join(outside, 'outside.txt'), 'utf8')).toBe('outside\n');
            expect(copied(result.copy, 'a.txt')).toBe(join(outside, 'outside.txt'));
        });

        test('refuses a path that runs through a link, to a place outside the repository or inside it, and does nothing', async () => {
            const h = await start();
            const path = repository({ ...FILES, 'dir/inner.txt': 'inner\n', 'twin/inner.txt': 'twin\n' });
            const outside = tempDir('git-discard-outside');
            const { discard } = await open(path, h);

            put(outside, { 'inner.txt': 'outside inner\n' });
            // `dir` is a link to the outside now, and `twin` one to a folder of the repository: the files below them are gone as git sees it.
            rmSync(join(path, 'dir'), { recursive: true });
            symlinkSync(outside, join(path, 'dir'));
            rmSync(join(path, 'twin'), { recursive: true });
            symlinkSync('dir', join(path, 'twin'));

            const before = snapshot(path);
            const out = await discard(['dir/inner.txt']);
            const inside = await discard(['twin/inner.txt']);

            expect(out.status).toBe(400);
            expect((await json<Failure>(out)).error.message).toMatch(
                /dir\/inner\.txt runs through a symbolic link that leaves the folder/
            );
            expect(inside.status).toBe(400);
            expect((await json<Failure>(inside)).error.message).toMatch(
                /twin\/inner\.txt runs through a symbolic link/
            );
            expect(snapshot(path)).toEqual(before);
            expect(readFileSync(join(outside, 'inner.txt'), 'utf8')).toBe('outside inner\n');
            expect(existsSync(join(h.config.dataDir, 'discarded'))).toBe(false);
        });

        test('refuses a file that is in the way of the folder it would be restored into, and a folder where a file is', async () => {
            const h = await start();
            const path = repository({ ...FILES, 'dir/inner.txt': 'inner\n', 'plain.txt': 'plain\n' });
            const { discard } = await open(path, h);

            // `dir` is a file the person wrote: restoring dir/inner.txt would remove it. `plain.txt` is a folder with a file in it.
            rmSync(join(path, 'dir'), { recursive: true });
            writeFileSync(join(path, 'dir'), 'a file where a folder was\n');
            rmSync(join(path, 'plain.txt'));
            put(path, { 'plain.txt/new.txt': 'new\n' });

            const before = snapshot(path);
            const blocked = await discard(['dir/inner.txt']);
            const folder = await discard(['plain.txt']);

            expect(blocked.status).toBe(400);
            expect((await json<Failure>(blocked)).error.message).toBe(
                'dir is in the way of dir/inner.txt, discard it first'
            );
            expect(folder.status).toBe(400);
            expect((await json<Failure>(folder)).error.message).toBe('plain.txt is not a file any more');
            expect(snapshot(path)).toEqual(before);
        });
    });

    test('refuses a file with merge conflicts, with `Resolve the conflict first`, during the merge and after it, and does nothing', async () => {
        const h = await start();
        const path = repository();
        const { discard } = await open(path, h);

        git(path, 'switch', '-q', '-c', 'side');
        put(path, { 'a.txt': 'side\n' });
        git(path, 'commit', '-q', '-am', 'Side edit');
        git(path, 'switch', '-q', 'main');
        put(path, { 'a.txt': 'main\n' });
        git(path, 'commit', '-q', '-am', 'Main edit');

        expect(Bun.spawnSync(['git', 'merge', 'side'], { cwd: path, stdout: 'pipe', stderr: 'pipe' }).exitCode).toBe(1);
        put(path, { 'b.txt': 'b\nedited\n' });

        const before = snapshot(path);
        const merging = await discard(['a.txt']);
        const withOther = await discard(['b.txt', 'a.txt']);

        expect(merging.status).toBe(409);
        expect((await json<Failure>(merging)).error).toMatchObject({
            code: 'conflict',
            message: 'Resolve the conflict first',
        });
        expect(withOther.status).toBe(409);
        // The other file of the request was not discarded either.
        expect(snapshot(path)).toEqual(before);
        expect(git(path, 'ls-files', '-u')).not.toBe('');
        expect(existsSync(join(path, '.git', 'MERGE_HEAD'))).toBe(true);

        // No merge going on any more, and the file still unmerged in the index.
        rmSync(join(path, '.git', 'MERGE_HEAD'));

        const stale = await discard(['a.txt']);

        expect(stale.status).toBe(409);
        expect((await json<Failure>(stale)).error.message).toBe('Resolve the conflict first');
        expect(git(path, 'ls-files', '-u')).not.toBe('');
    });

    test('refuses a submodule, with its own words, and does nothing', async () => {
        const h = await start();
        const path = repository();
        const sub = makeRepo(tempDir('git-discard-sub'), 'sub');
        const { discard } = await open(path, h);

        git(path, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'vendor/sub');
        git(path, 'commit', '-q', '-m', 'Add the submodule');
        // The submodule moves to a commit the superproject does not record.
        put(join(path, 'vendor/sub'), { 'more.txt': 'more\n' });
        git(join(path, 'vendor/sub'), 'add', '.');
        git(join(path, 'vendor/sub'), 'commit', '-q', '-m', 'More');
        put(path, { 'a.txt': 'a\nedited\n' });

        expect(left(path)).toContain(' M vendor/sub');

        const before = snapshot(path);
        const refused = await discard(['vendor/sub']);
        const mixed = await discard(['a.txt', 'vendor/sub']);

        expect(refused.status).toBe(400);
        expect((await json<Failure>(refused)).error.message).toBe("A submodule can't be discarded here");
        expect(mixed.status).toBe(400);
        expect(snapshot(path)).toEqual(before);
        expect(git(join(path, 'vendor/sub'), 'log', '-1', '--format=%s')).toBe('More');
    });

    test('refuses a path that is not changed, an absolute path, one that leaves the place, and one that is no file path, and changes nothing', async () => {
        const h = await start();
        const path = repository();
        const { discard, url, folderId } = await open(path, h);

        put(path, { 'a.txt': 'a\nedited\n', 'ignored/skip.txt': 'x\n' });
        git(path, 'update-index', '--chmod=+x', 'b.txt');

        const before = snapshot(path);
        const refuse = async (response: Response, message: RegExp) => {
            const body = await json<Failure>(response);

            expect(response.status).toBe(400);
            expect(body.error).toMatchObject({ code: 'invalid' });
            expect(body.error.message).toMatch(message);
        };

        await refuse(await discard([]), /at least one file/);
        // One that is not changed spoils the whole request: the changed one beside it is not discarded.
        await refuse(await discard(['a.txt', 'README.md']), /README\.md is not a changed file/);
        await refuse(await discard(['nothing.txt']), /not a changed file/);
        await refuse(await discard(['../outside.txt']), /not a path inside the repository/);
        await refuse(await discard(['src/../a.txt']), /not a path inside the repository/);
        await refuse(await discard(['/etc/passwd']), /not a path inside the repository/);
        await refuse(await discard([join(path, 'a.txt')]), /not a path inside the repository/);
        await refuse(await discard(['.git/config']), /not a changed file/);
        await refuse(await discard(['.git/HEAD']), /not a changed file/);
        await refuse(await discard(['src/']), /not a path inside the repository/);
        await refuse(await discard(['']), /not a path inside the repository/);
        await refuse(await discard(['a.txt\0']), /not a path inside the repository/);
        await refuse(await discard(['a.txt', 'a.txt\n']), /not a changed file/);
        await refuse(
            await discard(Array.from({ length: MAX_GIT_DISCARD_PATHS + 1 }, (_, index) => `f${index}.txt`)),
            /at most 50/
        );
        await refuse(await discard('a.txt'), /./);
        await refuse(await h.fetch(url, { method: 'POST', body: JSON.stringify({ folderId }) }), /./);
        await refuse(await h.fetch(url, { method: 'POST', body: 'not json' }), /JSON/);

        expect(snapshot(path)).toEqual(before);
        expect(existsSync(join(h.config.dataDir, 'discarded'))).toBe(false);
    });

    test('takes the most files a discard names, and a file once however often it is named', async () => {
        const h = await start();
        const files = Object.fromEntries(
            Array.from({ length: MAX_GIT_DISCARD_PATHS }, (_, index) => [`f${index}.txt`, `${index}\n`])
        );
        const path = repository(files);
        const { discard } = await open(path, h);

        for (const name of Object.keys(files)) put(path, { [name]: 'edited\n' });

        const names = Object.keys(files);
        const result = await json<GitDiscardResult>(
            await discard([...names.slice(0, MAX_GIT_DISCARD_PATHS - 1), 'f0.txt'])
        );

        expect(result.discarded).toHaveLength(MAX_GIT_DISCARD_PATHS - 1);
        expect(left(path)).toEqual([' M f49.txt']);
    });

    test('is behind the token, and says a project, a folder or a place that is none, and a folder that is no repository', async () => {
        const h = await start();
        const path = repository();
        const { discard, url, folderId } = await open(path, h);

        put(path, { 'a.txt': 'a\nedited\n' });

        expect(
            (await fetch(`${h.url}${url}`, { method: 'POST', body: JSON.stringify({ folderId, paths: ['a.txt'] }) }))
                .status
        ).toBe(401);
        expect(
            (
                await h.fetch('/v1/projects/prj_unknown/git/discard', {
                    method: 'POST',
                    body: JSON.stringify({ folderId, paths: ['a.txt'] }),
                })
            ).status
        ).toBe(404);
        expect((await discard(['a.txt'], { folderId: 'fld_unknown' })).status).toBe(404);
        expect((await discard(['a.txt'], { workspaceId: 'wks_unknown' })).status).toBe(404);

        const plain = tempDir('git-discard');
        const { project } = h.ok('project.add', { folders: [plain] });
        const refused = await h.fetch(`/v1/projects/${project.id}/git/discard`, {
            method: 'POST',
            body: JSON.stringify({ folderId: project.folders[0].id, paths: ['a.txt'] }),
        });

        expect(refused.status).toBe(400);
        expect((await json<Failure>(refused)).error.message).toMatch(/not the root of a git repository/);
        expect(left(path)).toEqual([' M a.txt']);
    });

    test("discards in a chat's worktree on its own, and leaves the same file of the main checkout alone", async () => {
        const h = await start();
        const path = repository();
        const tree = join(tempDir('git-discard'), 'chat-tree');

        git(path, 'worktree', 'add', '-q', '-b', 'chat-branch', tree);
        put(path, { 'a.txt': 'a\nin the checkout\n' });
        put(tree, { 'a.txt': 'a\nin the tree\n', 'tree-only.txt': 'new\n' });

        const { project, folderId } = await open(path, h);
        const workspaceId = (
            h.ok('chat.create', { projectId: project.id, workspace: { mode: 'existing', path: tree } }).chat
                .workspace as { id: string }
        ).id;
        const response = await h.fetch(`/v1/projects/${project.id}/git/discard`, {
            method: 'POST',
            body: JSON.stringify({ folderId, workspaceId, paths: ['a.txt', 'tree-only.txt'] }),
        });
        const result = await json<GitDiscardResult>(response);

        expect(response.status).toBe(200);
        expect(result.discarded.map(file => file.action)).toEqual(['restored', 'removed']);
        expect(left(tree)).toEqual([]);
        expect(readFileSync(join(tree, 'a.txt'), 'utf8')).toBe('a\n');
        expect(git(tree, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('chat-branch');
        // The checkout has its own edit of the same name, and it is not touched.
        expect(left(path)).toEqual([' M a.txt']);
        expect(readFileSync(join(path, 'a.txt'), 'utf8')).toBe('a\nin the checkout\n');
        expect(copied(result.copy, 'a.txt')).toBe('a\nin the tree\n');
        expect(manifestOf(result.copy)).toMatchObject({ workspaceId, folderId, branch: 'chat-branch' });
        expect(manifestOf(result.copy).place).toBe(realpathSync(tree));

        // A file the worktree does not list as changed is refused, though the checkout lists it.
        put(tree, { 'b.txt': 'b\n' });

        const asked = await h.fetch(`/v1/projects/${project.id}/git/discard`, {
            method: 'POST',
            body: JSON.stringify({ folderId, workspaceId, paths: ['b.txt'] }),
        });

        expect(asked.status).toBe(400);
    });
});

describe('the copy of a discard', () => {
    test('is made before anything is touched, from what the files hold at that moment, and not from HEAD', async () => {
        const dataDir = tempDir('git-discard-data');
        const spy = new SpyCopies(dataDir);
        const h = await start({ copies: spy });
        const path = repository();
        const { discard } = await open(path, h);
        const seen: Array<{ a: string; status: string[]; fresh: boolean }> = [];

        spy.before = () => {
            seen.push({
                a: readFileSync(join(path, 'a.txt'), 'utf8'),
                status: left(path),
                fresh: existsSync(join(path, 'fresh.txt')),
            });
        };
        put(path, { 'a.txt': 'a\nwritten a minute ago\n', 'fresh.txt': 'fresh\n' });

        const result = await json<GitDiscardResult>(await discard(['a.txt', 'fresh.txt']));

        // When the copy began nothing had been discarded, and what it holds is the working bytes.
        expect(seen).toEqual([{ a: 'a\nwritten a minute ago\n', status: [' M a.txt', '?? fresh.txt'], fresh: true }]);
        expect(copied(result.copy, 'a.txt')).toBe('a\nwritten a minute ago\n');
        expect(copied(result.copy, 'fresh.txt')).toBe('fresh\n');
        expect(result.copy.folder.startsWith(dataDir)).toBe(true);
        expect(spy.jobs[0]?.files.map(file => file.path)).toEqual(['a.txt', 'fresh.txt']);
    });

    test('that fails discards nothing, in a place with edits, new files and a staged one, and says so', async () => {
        const spy = new SpyCopies(tempDir('git-discard-data'));
        const h = await start({ copies: spy });
        const path = repository();
        const { discard } = await open(path, h);

        put(path, { 'a.txt': 'a\nedited\n', 'fresh.txt': 'fresh\n', 'staged.txt': 'staged\n' });
        git(path, 'add', 'staged.txt');
        rmSync(join(path, 'gone.txt'));
        spy.fail = new Error('ENOSPC: no space left on device');

        const before = snapshot(path);
        const response = await discard(['a.txt', 'fresh.txt', 'staged.txt', 'gone.txt']);
        const body = await json<Failure>(response);

        expect(response.status).toBe(503);
        expect(body.error).toMatchObject({ code: 'unavailable' });
        expect(body.error.message).toBe(
            "Couldn't keep a copy of the files, so nothing was discarded: ENOSPC: no space left on device"
        );
        expect(snapshot(path)).toEqual(before);
        expect(left(path)).toEqual([' D gone.txt', ' M a.txt', '?? fresh.txt', 'A  staged.txt']);

        // The same files go the moment the copy works.
        spy.fail = undefined;
        expect((await discard(['a.txt', 'fresh.txt', 'staged.txt', 'gone.txt'])).status).toBe(200);
        expect(left(path)).toEqual([]);
    });

    test('that is half made leaves no folder behind, and discards nothing', async () => {
        const dataDir = tempDir('git-discard-data');
        const spy = new SpyCopies(dataDir);
        const h = await start({ copies: spy });
        const path = repository();
        const { discard } = await open(path, h);

        put(path, { 'a.txt': 'a\nedited\n', 'b.txt': 'b\nedited\n' });
        // The second file goes before it is copied: the copy of the first is made, and the second cannot be.
        spy.before = () => rmSync(join(path, 'b.txt'));

        const before = snapshot(path);
        const response = await discard(['a.txt', 'b.txt']);

        // The copy of b is made from a file that is not there: the copy fails, and what it made of a is removed.
        expect(response.status).toBe(503);
        expect(
            existsSync(join(dataDir, 'discarded'))
                ? readdirSync(join(dataDir, 'discarded')).flatMap(project =>
                      readdirSync(join(dataDir, 'discarded', project))
                  )
                : []
        ).toEqual([]);
        expect(readFileSync(join(path, 'a.txt'), 'utf8')).toBe('a\nedited\n');
        expect(before.head).toBe(git(path, 'rev-parse', 'HEAD'));
    });

    test('refuses a file that was written to while it was being copied, and discards nothing', async () => {
        const spy = new SpyCopies(tempDir('git-discard-data'));
        const h = await start({ copies: spy });
        const path = repository();
        const { discard } = await open(path, h);

        put(path, { 'a.txt': 'a\nedited\n' });
        spy.after = () => {
            // The agent writes again right after the copy was taken.
            writeFileSync(join(path, 'a.txt'), 'a\nedited again, after the copy\n');
            utimesSync(join(path, 'a.txt'), new Date(Date.now() + 5000), new Date(Date.now() + 5000));
        };

        const response = await discard(['a.txt']);

        expect(response.status).toBe(409);
        expect((await json<Failure>(response)).error.message).toBe('a.txt changed while its copy was made, try again');
        expect(readFileSync(join(path, 'a.txt'), 'utf8')).toBe('a\nedited again, after the copy\n');

        spy.after = undefined;

        const retried = await json<GitDiscardResult>(await discard(['a.txt']));

        expect(copied(retried.copy, 'a.txt')).toBe('a\nedited again, after the copy\n');
        expect(left(path)).toEqual([]);
    });

    test('refuses a file over the per-file limit, and a staged version over it, and leaves everything in the request where it is', async () => {
        const copies = new DiscardCopies(tempDir('git-discard-data'), { maxFileBytes: 2048, maxBytes: 100_000 });
        const h = await start({ copies });
        const path = repository();
        const { discard } = await open(path, h);

        put(path, { 'a.txt': 'a\nsmall edit\n', 'big.bin': 'x'.repeat(3000) });

        const before = snapshot(path);
        const big = await discard(['a.txt', 'big.bin']);

        expect(big.status).toBe(400);
        expect((await json<Failure>(big)).error).toMatchObject({
            code: 'invalid',
            message: 'big.bin is over 2 KB, discard it in a terminal',
        });
        expect(snapshot(path)).toEqual(before);

        // The version in the index is a file's too: a small file on the disk with a big staged version is not a small file.
        put(path, { 'b.txt': 'y'.repeat(3000) });
        git(path, 'add', 'b.txt');
        put(path, { 'b.txt': 'small again\n' });

        const staged = await discard(['b.txt']);

        expect(staged.status).toBe(400);
        expect((await json<Failure>(staged)).error.message).toBe('b.txt is over 2 KB, discard it in a terminal');
        expect(readFileSync(join(path, 'b.txt'), 'utf8')).toBe('small again\n');

        // Within the limit it goes.
        expect((await discard(['a.txt'])).status).toBe(200);
        expect(existsSync(join(h.config.dataDir, 'discarded'))).toBe(false);
    });

    test('refuses files whose copies would not fit together, with a refusal that names no file', async () => {
        const copies = new DiscardCopies(tempDir('git-discard-data'), { maxFileBytes: 2048, maxBytes: 5000 });
        const h = await start({ copies });
        const path = repository();
        const { discard } = await open(path, h);

        put(path, { 'a.txt': 'a'.repeat(2000), 'b.txt': 'b'.repeat(2000), 'gone.txt': 'g'.repeat(2000) });

        const before = snapshot(path);
        const response = await discard(['a.txt', 'b.txt', 'gone.txt']);

        expect(response.status).toBe(400);
        expect((await json<Failure>(response)).error.message).toBe(
            'The files are too big to keep a copy of together, discard fewer of them'
        );
        expect(snapshot(path)).toEqual(before);
        expect((await discard(['a.txt', 'b.txt'])).status).toBe(200);
    });

    test('has limits of 7 days, 500 MB in all and 50 MB for a file', () => {
        expect(KEEP_COPIES_MS).toBe(GIT_DISCARD_KEEP_DAYS * 24 * 60 * 60 * 1000);
        expect(GIT_DISCARD_KEEP_DAYS).toBe(7);
        expect(MAX_KEPT_BYTES).toBe(500 * 1024 * 1024);
        expect(MAX_COPY_FILE_BYTES).toBe(50 * 1024 * 1024);
    });
});

describe('the retention of the copies', () => {
    /** A discard of one edited file of `name`, in a daemon whose copies run on a clock the test moves. */
    async function setup(options: { keepMs?: number; maxBytes?: number; maxFileBytes?: number } = {}) {
        const state = { now: 1_800_000_000_000 };
        const copies = new DiscardCopies(tempDir('git-discard-data'), { ...options, now: () => state.now });
        const h = await start({ copies });
        const path = repository();
        const { discard } = await open(path, h);
        const discardEdit = async (name: string, content: string) => {
            put(path, { [name]: content });

            return json<GitDiscardResult>(await discard([name]));
        };

        return { state, copies, h, path, discardEdit };
    }

    test('removes a copy once it is older than its time, when the next discard is made, and never the one just made', async () => {
        const { state, discardEdit } = await setup({ keepMs: 10_000 });
        const first = await discardEdit('a.txt', 'first\n');

        state.now += 9_000;

        const second = await discardEdit('b.txt', 'second\n');

        // The first is nine seconds old, which is within its time.
        expect(existsSync(first.copy.folder)).toBe(true);
        expect(existsSync(second.copy.folder)).toBe(true);

        state.now += 2_000;

        const third = await discardEdit('gone.txt', 'third\n');

        expect(existsSync(first.copy.folder)).toBe(false);
        expect(existsSync(second.copy.folder)).toBe(true);
        expect(existsSync(third.copy.folder)).toBe(true);

        // A copy that is already past its time when it is made is still kept for the person to find.
        state.now += 60_000;

        const fourth = await discardEdit('old.txt', 'fourth\n');

        expect(existsSync(second.copy.folder)).toBe(false);
        expect(existsSync(third.copy.folder)).toBe(false);
        expect(copied(fourth.copy, 'old.txt')).toBe('fourth\n');
    });

    test('removes the oldest copies first while all of them are over the cap, and keeps the newest', async () => {
        const { state, discardEdit } = await setup({ maxBytes: 5000, maxFileBytes: 2048 });
        const made: GitDiscardResult[] = [];

        for (const name of ['a.txt', 'b.txt', 'gone.txt', 'old.txt']) {
            state.now += 1000;
            made.push(await discardEdit(name, 'x'.repeat(2000)));
        }

        // Two copies are 4000 bytes, three would be 6000: only the newest two are left.
        expect(made.map(result => existsSync(result.copy.folder))).toEqual([false, false, true, true]);
    });

    test('removes what is past its time when the daemon starts, and leaves what is not, what is not ours, and a copy of this week', async () => {
        const dataDir = tempDir('git-discard-data');
        const old = join(dataDir, 'discarded', 'prj_x', '20260101T000000000Z-aaaaaa');
        const fresh = join(dataDir, 'discarded', 'prj_x', '20990101T000000000Z-bbbbbb');
        const cut = join(dataDir, 'discarded', 'prj_y', '20260101T000000000Z-cccccc');

        mkdirSync(join(old, 'files'), { recursive: true });
        writeFileSync(join(old, 'files', 'a.txt'), 'old\n');
        writeFileSync(join(old, 'manifest.json'), JSON.stringify({ at: Date.now() - 8 * 24 * 3600 * 1000, bytes: 4 }));
        mkdirSync(join(fresh, 'files'), { recursive: true });
        writeFileSync(join(fresh, 'files', 'a.txt'), 'fresh\n');
        writeFileSync(
            join(fresh, 'manifest.json'),
            JSON.stringify({ at: Date.now() - 6 * 24 * 3600 * 1000, bytes: 6 })
        );
        // A copy that was interrupted has no manifest and is judged by the time of its folder.
        mkdirSync(join(cut, 'files'), { recursive: true });
        utimesSync(cut, new Date(Date.now() - 9 * 24 * 3600 * 1000), new Date(Date.now() - 9 * 24 * 3600 * 1000));
        writeFileSync(join(dataDir, 'discarded', 'stray.txt'), 'not a project folder\n');

        const h = await startHarness({ dataDir }, { gitEnvironment: isolated() });

        harnesses.push(h);
        await waitFor(() => !existsSync(old) && !existsSync(cut), 'the old copies to be pruned');

        expect(existsSync(fresh)).toBe(true);
        expect(readFileSync(join(fresh, 'files', 'a.txt'), 'utf8')).toBe('fresh\n');
        expect(existsSync(join(dataDir, 'discarded', 'stray.txt'))).toBe(true);
        // The project folder of the last copy it held is gone with it.
        expect(existsSync(join(dataDir, 'discarded', 'prj_y'))).toBe(false);
        expect(existsSync(join(dataDir, 'discarded', 'prj_x'))).toBe(true);
    });

    test('makes a copy that reads as it was written: a link as its target, a deleted file as nothing, and the manifest of a discard that did not finish says so', async () => {
        const dataDir = tempDir('git-discard-data');
        const copies = new DiscardCopies(dataDir);
        const source = join(tempDir('git-discard'), 'src.txt');

        writeFileSync(source, 'bytes\n');

        const kept = await copies.keep({
            projectId: 'prj/../x',
            folderId: 'fld_1',
            place: '/repo',
            files: [
                { path: 'f.txt', action: 'restored', work: { kind: 'file', source, size: 6 } },
                { path: 'l', action: 'removed', work: { kind: 'link', target: '../elsewhere' } },
                { path: 'd.txt', action: 'restored' },
            ],
        });

        expect(kept.folder.startsWith(join(dataDir, 'discarded', 'prj____x'))).toBe(true);
        expect(kept.files).toBe(2);
        expect(kept.bytes).toBe(6 + '../elsewhere'.length);
        expect(manifestOf(kept)).toMatchObject({ completed: false, bytes: kept.bytes });
        expect(copied(kept, 'l')).toBe('../elsewhere');

        await copies.finish(kept);

        expect(manifestOf(kept).completed).toBe(true);
    });

    test('is checked: a file that is not the size it was measured at is no copy, and leaves no folder', async () => {
        const dataDir = tempDir('git-discard-data');
        const copies = new DiscardCopies(dataDir);
        const source = join(tempDir('git-discard'), 'src.txt');

        writeFileSync(source, 'twelve bytes');

        await expect(
            copies.keep({
                projectId: 'prj_1',
                folderId: 'fld_1',
                place: '/repo',
                files: [{ path: 'f.txt', action: 'restored', work: { kind: 'file', source, size: 99 } }],
            })
        ).rejects.toThrow(/12 bytes/);
        await expect(
            copies.keep({
                projectId: 'prj_1',
                folderId: 'fld_1',
                place: '/repo',
                files: [
                    { path: 'g.txt', action: 'restored', staged: { size: 3, read: async () => Buffer.from('four') } },
                ],
            })
        ).rejects.toThrow(/not the size/);
        expect(readdirSync(join(dataDir, 'discarded', 'prj_1'))).toEqual([]);
    });
});

withPosix("GitDiscard on the place's line of writes", () => {
    test('runs two discards of one place one after the other', async () => {
        const spy = new SpyCopies(tempDir('git-discard-data'));
        const h = await start({ copies: spy });
        const path = repository();
        const { discard } = await open(path, h);
        const log: string[] = [];
        let count = 0;

        spy.before = async () => {
            const number = ++count;

            log.push(`start ${number}`);
            await Bun.sleep(300);
            log.push(`end ${number}`);
        };
        put(path, { 'a.txt': 'a\nedited\n', 'b.txt': 'b\nedited\n' });

        const [first, second] = await Promise.all([discard(['a.txt']), discard(['b.txt'])]);

        expect([first.status, second.status]).toEqual([200, 200]);
        expect(log).toEqual(['start 1', 'end 1', 'start 2', 'end 2']);
        expect(left(path)).toEqual([]);
    });

    test('and a commit of the same place never overlap, whichever comes first', async () => {
        const spy = new SpyCopies(tempDir('git-discard-data'));
        const h = await start({ copies: spy });
        const path = repository();
        const { discard, project, folderId } = await open(path, h);
        const log = join(path, '.git', 'order.log');
        const commit = () =>
            h.fetch(`/v1/projects/${project.id}/git/commit`, {
                method: 'POST',
                body: JSON.stringify({ folderId, paths: ['a.txt'], message: 'Edit a' }),
            });

        put(path, { 'a.txt': 'a\nedited\n', 'b.txt': 'b\nedited\n' });
        hook(path, 'pre-commit', `echo "commit start" >> '${log}'`, 'sleep 0.5', `echo "commit end" >> '${log}'`);
        spy.before = async () => {
            writeFileSync(log, `${existsSync(log) ? readFileSync(log, 'utf8') : ''}discard start\n`);
            await Bun.sleep(300);
            writeFileSync(log, `${readFileSync(log, 'utf8')}discard end\n`);
        };

        const [committed, discarded] = await Promise.all([commit(), discard(['b.txt'])]);

        expect([committed.status, discarded.status]).toEqual([200, 200]);

        const lines = readFileSync(log, 'utf8').trim().split('\n');

        // Each one ends before the other begins.
        expect(lines).toHaveLength(4);
        expect(lines[0]!.split(' ')[0]).toBe(lines[1]!.split(' ')[0]!);
        expect(lines[1]!.split(' ')[1]).toBe('end');
        expect(lines[2]!.split(' ')[0]).toBe(lines[3]!.split(' ')[0]!);
        expect(left(path)).toEqual([]);
    });

    test("runs the person's git without a switch that skips what they set, never a clean, a checkout, a reset, a stash or a force, and runs no hook of a commit", async () => {
        const dir = tempDir('git-discard');
        const argvLog = join(dir, 'argv');
        const bin = join(dir, 'bin');

        mkdirSync(bin);
        const real = Bun.which('git') as string;

        writeFileSync(join(bin, 'git'), ['#!/bin/sh', `echo "$@" >> '${argvLog}'`, `exec '${real}' "$@"`].join('\n'));
        chmodSync(join(bin, 'git'), 0o755);

        const environment = new WriteEnvironment({
            env: () => ({
                ...process.env,
                GIT_CONFIG_GLOBAL: '/dev/null',
                GIT_CONFIG_NOSYSTEM: '1',
                SHELL: '/usr/bin/true',
                PATH: `${bin}:${process.env.PATH}`,
            }),
        });
        const h = await startHarness({}, { gitEnvironment: environment });

        harnesses.push(h);

        const path = repository();
        const { discard } = await open(path, h);

        put(path, { 'a.txt': 'a\nedited\n', 'fresh.txt': 'fresh\n', 'staged.txt': 'staged\n' });
        git(path, 'add', 'staged.txt');
        for (const name of ['pre-commit', 'prepare-commit-msg', 'commit-msg', 'post-checkout'])
            hook(path, name, `echo "${name} $@" >> '${join(dir, 'hooks')}'`);

        expect((await discard(['a.txt', 'fresh.txt', 'staged.txt'])).status).toBe(200);

        const runs = readFileSync(argvLog, 'utf8')
            .trim()
            .split('\n')
            .filter(line => /restore|rm --cached/.test(line));

        expect(runs).toContain('--literal-pathspecs restore --source=HEAD --staged --worktree -- a.txt');
        expect(runs).toContain('--literal-pathspecs rm --cached -f -q -- staged.txt');
        expect(readFileSync(argvLog, 'utf8')).not.toMatch(
            /\bclean\b|\bcheckout\b|\breset\b|\bstash\b|--force|no-verify|\bcommit\b/
        );
        // No hook of a commit is run. The hooks git itself runs for a restore are the person's own, as when they restore in a terminal: `post-checkout` (with 0, a checkout of files) and
        // `post-index-change`, which Clowdy does not turn off (a test of the daemon documents it).
        const ran = readFileSync(join(dir, 'hooks'), 'utf8').trim().split('\n');

        expect(ran.some(line => /^pre-commit|^prepare-commit-msg|^commit-msg/.test(line))).toBe(false);
        expect(ran.filter(line => line.startsWith('post-checkout'))).toEqual([
            expect.stringMatching(/^post-checkout [0-9a-f]{40} [0-9a-f]{40} 0$/) as unknown as string,
        ]);
    });

    test('says a post-checkout hook that fails with its own line, after the restore it followed, and leaves the new file for the next try', async () => {
        const h = await start();
        const path = repository();
        const { discard } = await open(path, h);

        put(path, { 'a.txt': 'a\nedited\n', 'fresh.txt': 'fresh\n' });
        hook(path, 'post-checkout', 'echo "post-checkout: the build is broken" >&2', 'exit 1');

        const response = await discard(['a.txt', 'fresh.txt']);

        expect(response.status).toBe(409);
        expect((await json<Failure>(response)).error).toMatchObject({
            code: 'conflict',
            message: 'post-checkout: the build is broken',
        });
        // git restored the file before the hook ran; the new file was not deleted, since the discard stops where git did.
        expect(left(path)).toEqual(['?? fresh.txt']);
        expect(readFileSync(join(path, 'fresh.txt'), 'utf8')).toBe('fresh\n');

        hook(path, 'post-checkout', 'exit 0');

        expect((await discard(['fresh.txt'])).status).toBe(200);
        expect(left(path)).toEqual([]);
    });

    test("says git's own line when git refuses, and changes the disk no further", async () => {
        const h = await start();
        const path = repository();
        const { discard } = await open(path, h);

        put(path, { 'a.txt': 'a\nedited\n', 'fresh.txt': 'fresh\n' });
        // A lock another git holds: the restore cannot take the index.
        writeFileSync(join(path, '.git', 'index.lock'), '');

        const response = await discard(['a.txt', 'fresh.txt']);
        const body = await json<Failure>(response);

        expect(response.status).toBe(409);
        expect(body.error.code).toBe('conflict');
        expect(body.error.message).toMatch(/^fatal: Unable to create '.*index\.lock': File exists\.?$/);
        // The untracked file is still there: nothing is deleted from the disk after a restore that failed.
        expect(readFileSync(join(path, 'fresh.txt'), 'utf8')).toBe('fresh\n');
        expect(readFileSync(join(path, 'a.txt'), 'utf8')).toBe('a\nedited\n');

        rmSync(join(path, '.git', 'index.lock'));

        expect((await discard(['a.txt', 'fresh.txt'])).status).toBe(200);
        expect(left(path)).toEqual([]);
    });

    test('moves a file the person renamed in the shell, by its two entries, one at a time', async () => {
        const h = await start();
        const path = repository();
        const { discard } = await open(path, h);

        // Not staged: the old file is gone and the new one is not tracked, two entries that the person discards one by one.
        renameSync(join(path, 'a.txt'), join(path, 'moved.txt'));

        expect(left(path)).toEqual([' D a.txt', '?? moved.txt']);
        expect((await discard(['moved.txt'])).status).toBe(200);
        expect(left(path)).toEqual([' D a.txt']);
        expect((await discard(['a.txt'])).status).toBe(200);
        expect(left(path)).toEqual([]);
    });
});

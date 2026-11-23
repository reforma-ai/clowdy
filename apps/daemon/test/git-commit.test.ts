import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { MAX_GIT_COMMIT_PATHS, MAX_GIT_MESSAGE_CHARS } from '@clowdy/protocol';

import { CommandError } from '../src/errors';
import { failureLine, GitWrites } from '../src/git/commit';
import { WriteEnvironment } from '../src/git/writeEnv';
import { cleanTempDirs, git, makeRepo, startHarness, tempDir } from './helpers';

import type { GitCommitResult } from '@clowdy/protocol';
import type { Place } from '../src/domain/places';
import type { Harness } from './helpers';

afterAll(cleanTempDirs);

const posix = process.platform !== 'win32';
/** Hooks and the stand-in signing program are POSIX shell scripts: on Windows these cases are skipped, not run against another program. */
const withScripts = posix ? describe : describe.skip;

const harnesses: Harness[] = [];

afterEach(async () => {
    await Promise.all(harnesses.splice(0).map(h => h.stop().catch(() => undefined)));
});

/**
 * The environment of the daemon's writes in a test: the person's own git configuration (which on a developer's machine signs every commit, and asks for a fingerprint)
 * and the system's stay out, and the login shell finds no signing agent. What a test repository needs is in its own config (`repository`).
 */
const isolated = (extra: Record<string, string> = {}) =>
    new WriteEnvironment({
        env: () => ({
            ...process.env,
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_CONFIG_NOSYSTEM: '1',
            SHELL: '/usr/bin/true',
            ...extra,
        }),
    });

/** A repository with its own identity and no signing, and the files `files` committed. */
function repository(
    files: Record<string, string> = {
        'a.txt': 'a\n',
        'b.txt': 'b\n',
        'gone.txt': 'gone\n',
        'old.txt': 'one\ntwo\nthree\nfour\nfive\n',
    }
): string {
    const path = makeRepo(tempDir('git-commit'));

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

/** What a commit changed, as `name-status` lists it: `M\ta.txt`, `R100\told\tnew`. */
const changedBy = (path: string, ref = 'HEAD'): string[] =>
    git(path, '-c', 'core.quotepath=false', 'diff-tree', '--no-commit-id', '--name-status', '-r', '-M', ref)
        .split('\n')
        .filter(line => line !== '');

/** What is left in the tree and the index as `status --porcelain` says it. */
const left = (path: string): string[] =>
    Bun.spawnSync(['git', 'status', '--porcelain'], { cwd: path, stdout: 'pipe', stderr: 'pipe' })
        .stdout.toString()
        .split('\n')
        .filter(line => line !== '')
        .sort();

async function start(): Promise<Harness> {
    const h = await startHarness({}, { gitEnvironment: isolated() });

    harnesses.push(h);

    return h;
}

const json = async <T>(response: Response) => (await response.json()) as T;

interface Failure {
    ok: false;
    error: { code: string; message: string; details?: { hint?: string } };
}

describe('failureLine', () => {
    test("is git's own fatal or error line, else the first line of what a hook said", () => {
        expect(
            failureLine(
                'hint: x\nerror: No private key found for public key "a.pub"?\nfatal: failed to write commit object\n',
                ''
            )
        ).toBe('error: No private key found for public key "a.pub"?');
        expect(failureLine('lint failed: 2 problems\nsee the log\n', 'out')).toBe('lint failed: 2 problems');
        expect(failureLine('', '\n\nTests failed\nmore')).toBe('Tests failed');
        expect(failureLine('', '')).toBe('git could not make the commit');
    });

    test('is one line, with no colour, no credential of an address and not too long', () => {
        expect(
            failureLine('\u001B[31mfatal:\u001B[0m unable to access https://user:s3cret@github.com/acme/app.git/', '')
        ).toBe('fatal: unable to access https://github.com/acme/app.git/');
        expect(failureLine(`fatal: ${'x'.repeat(1000)}`, '')).toHaveLength(300);
    });
});

withScripts('POST /v1/projects/:id/git/commit', () => {
    /** The project of a repository, and the request that commits `paths` with `message` in it. */
    async function open(path: string, h: Harness) {
        const { project } = h.ok('project.add', { folders: [path] });
        const folderId = project.folders[0].id as string;
        const url = `/v1/projects/${project.id}/git/commit`;
        const commit = (paths: unknown, message: unknown = 'Commit the files', place: Record<string, string> = {}) =>
            h.fetch(url, { method: 'POST', body: JSON.stringify({ folderId, paths, message, ...place }) });

        return { project, folderId, url, commit };
    }

    test('commits the ticked files alone and leaves every other change in the tree and in the index as it was', async () => {
        const h = await start();
        const path = repository();
        const { commit } = await open(path, h);

        // a: edited; b: edited; c: new and staged; d: new and not staged; gone: deleted.
        put(path, { 'a.txt': 'a\nmore\n', 'b.txt': 'b\nmore\n', 'c.txt': 'c\n', 'd.txt': 'd\n' });
        git(path, 'add', 'c.txt');

        const before = git(path, 'rev-parse', 'HEAD');
        const response = await commit(['a.txt'], 'Edit a');
        const result = await json<GitCommitResult>(response);

        expect(response.status).toBe(200);
        expect(result.sha).toBe(git(path, 'rev-parse', 'HEAD'));
        expect(result).toMatchObject({ shortSha: result.sha.slice(0, 7), subject: 'Edit a' });
        expect(git(path, 'rev-parse', 'HEAD~1')).toBe(before);
        expect(changedBy(path)).toEqual(['M\ta.txt']);
        expect(git(path, 'log', '-1', '--format=%s')).toBe('Edit a');
        expect(left(path)).toEqual([' M b.txt', '?? d.txt', 'A  c.txt']);
        // The edit that was committed is the working tree's, and the others are still there.
        expect(readFileSync(join(path, 'b.txt'), 'utf8')).toBe('b\nmore\n');
    });

    test('commits a new file, an edited one and a deleted one in one commit, with the message as written', async () => {
        const h = await start();
        const path = repository();
        const { commit } = await open(path, h);

        put(path, { 'fresh.txt': 'fresh\n', 'a.txt': 'a\nmore\n' });
        rmSync(join(path, 'gone.txt'));

        const message = 'feat(files): add fresh\n\nIt is new.\nAnd a second line.';
        const response = await commit(['fresh.txt', 'gone.txt', 'a.txt'], message);

        expect(response.status).toBe(200);
        expect(changedBy(path).sort()).toEqual(['A\tfresh.txt', 'D\tgone.txt', 'M\ta.txt']);
        expect(git(path, 'log', '-1', '--format=%B').trim()).toBe(message);
        expect(left(path)).toEqual([]);
    });

    test('commits a rename, staged or not, with both of its paths', async () => {
        const h = await start();
        const path = repository();
        const { commit } = await open(path, h);

        git(path, 'mv', 'old.txt', 'renamed.txt');
        writeFileSync(join(path, 'renamed.txt'), 'one\ntwo\nthree\nfour\nfive\nsix\n');

        // The list names the new path; the old one is brought along, so the commit is a rename and not a new file with the old one left behind.
        expect((await commit(['renamed.txt'], 'Rename old')).status).toBe(200);
        expect(changedBy(path)).toEqual([expect.stringMatching(/^R\d+\told\.txt\trenamed\.txt$/) as unknown as string]);
        expect(left(path)).toEqual([]);

        // Not staged: the old file is gone and the new one is not tracked, two entries that the person ticks one by one.
        renameSync(join(path, 'a.txt'), join(path, 'moved.txt'));

        const moved = await commit(['moved.txt'], 'Move a');

        expect(moved.status).toBe(200);
        expect(left(path)).toEqual([' D a.txt']);
        expect((await commit(['a.txt'], 'Remove a')).status).toBe(200);
        expect(left(path)).toEqual([]);
    });

    test('commits a deletion that is staged already, which git add has no path for', async () => {
        const h = await start();
        const path = repository();
        const { commit } = await open(path, h);

        git(path, 'rm', '-q', 'gone.txt');
        put(path, { 'a.txt': 'a\nmore\n' });

        expect((await commit(['gone.txt'], 'Remove gone')).status).toBe(200);
        expect(changedBy(path)).toEqual(['D\tgone.txt']);
        expect(left(path)).toEqual([' M a.txt']);
    });

    test("takes a path whose name has pattern characters, a space or a quote as the file's own", async () => {
        const h = await start();
        const path = repository();
        const { commit } = await open(path, h);

        put(path, {
            'src/[id].tsx': '1\n',
            'star*.txt': '2\n',
            'a b.txt': '3\n',
            'src/other.tsx': '4\n',
            ':colon.txt': '5\n',
            "it's.txt": '6\n',
            'ünï.txt': '7\n',
            '--amend.txt': '8\n',
            '-p': '9\n',
        });

        const count = Number(git(path, 'rev-list', '--count', 'HEAD'));

        // A name that starts with a dash is a path after `--`, and a message that starts with one is the value of `-m`: neither is an option.
        expect(
            (
                await commit(
                    ['src/[id].tsx', 'star*.txt', 'a b.txt', ':colon.txt', "it's.txt", 'ünï.txt', '--amend.txt', '-p'],
                    '--amend the odd names'
                )
            ).status
        ).toBe(200);
        expect(
            changedBy(path)
                .map(line => line.split('\t')[1])
                .sort()
        ).toEqual(
            ['--amend.txt', ':colon.txt', '-p', 'a b.txt', "it's.txt", 'src/[id].tsx', 'star*.txt', 'ünï.txt'].sort()
        );
        expect(git(path, 'log', '-1', '--format=%s')).toBe('--amend the odd names');
        expect(Number(git(path, 'rev-list', '--count', 'HEAD'))).toBe(count + 1);
        expect(left(path)).toEqual(['?? src/other.tsx']);
    });

    test("runs the person's hooks, and says a hook that failed with its own line, makes no commit and leaves the index as it found it", async () => {
        const h = await start();
        const path = repository();
        const { commit } = await open(path, h);

        put(path, { 'a.txt': 'a\nmore\n', 'b.txt': 'b\nmore\n' });
        hook(path, 'pre-commit', 'echo "lint: 2 problems in a.txt" >&2', 'echo "see the log" >&2', 'exit 1');

        const before = git(path, 'rev-parse', 'HEAD');
        const response = await commit(['a.txt'], 'Edit a');
        const body = await json<Failure>(response);

        expect(response.status).toBe(409);
        expect(body.error).toMatchObject({ code: 'conflict', message: 'lint: 2 problems in a.txt' });
        expect(body.error.details).toBeUndefined();
        expect(git(path, 'rev-parse', 'HEAD')).toBe(before);
        // What the add staged is taken back, and the other paths are not touched.
        expect(left(path)).toEqual([' M a.txt', ' M b.txt']);

        // A hook that passes lets the commit through, and sees the commit's own files.
        hook(path, 'pre-commit', 'git diff --cached --name-only > "$(git rev-parse --git-dir)/seen"', 'exit 0');
        expect((await commit(['a.txt'], 'Edit a')).status).toBe(200);
        expect(readFileSync(join(path, '.git', 'seen'), 'utf8')).toBe('a.txt\n');
    });

    test('takes back what it staged when the commit fails, a new file and a deletion too, and leaves what the person had staged as it was', async () => {
        const h = await start();
        const path = repository();
        const { commit } = await open(path, h);

        // a: edited and staged by the person; b: edited, not staged; fresh: new; gone: deleted; c: new and staged by the person.
        put(path, { 'a.txt': 'a\nstaged\n', 'c.txt': 'c\n' });
        git(path, 'add', 'a.txt', 'c.txt');
        put(path, { 'b.txt': 'b\nmore\n', 'fresh.txt': 'fresh\n' });
        rmSync(join(path, 'gone.txt'));
        hook(path, 'pre-commit', 'echo "lint failed" >&2', 'exit 1');

        const response = await commit(['a.txt', 'b.txt', 'c.txt', 'fresh.txt', 'gone.txt'], 'Take the lot');

        expect(response.status).toBe(409);
        expect((await json<Failure>(response)).error.message).toBe('lint failed');
        // Only the person's own staging is left: a and c as they staged them. The edit of b, the new file and the deletion are where they were before the commit.
        expect(left(path)).toEqual([' D gone.txt', ' M b.txt', '?? fresh.txt', 'A  c.txt', 'M  a.txt']);
    });

    test('takes back what it staged in a repository with no commit yet', async () => {
        const h = await start();
        const path = makeRepo(tempDir('git-commit'));

        git(path, 'config', 'user.name', 'Test');
        git(path, 'config', 'user.email', 'test@example.com');
        git(path, 'config', 'commit.gpgsign', 'false');
        put(path, { 'first.txt': 'first\n' });
        hook(path, 'pre-commit', 'exit 1');

        const { commit } = await open(path, h);

        expect((await commit(['first.txt'], 'First')).status).toBe(409);
        expect(left(path)).toEqual(['?? first.txt']);

        hook(path, 'pre-commit', 'exit 0');
        expect((await commit(['first.txt'], 'First')).status).toBe(200);
        expect(left(path)).toEqual([]);
    });

    test('commits two requests for one place one after the other', async () => {
        const h = await start();
        const path = repository();
        const { commit } = await open(path, h);
        const log = join(path, '.git', 'order.log');

        put(path, { 'a.txt': 'a\nmore\n', 'b.txt': 'b\nmore\n' });
        hook(path, 'pre-commit', `echo "start" >> '${log}'`, 'sleep 0.5', `echo "end" >> '${log}'`);

        const [first, second] = await Promise.all([commit(['a.txt'], 'Edit a'), commit(['b.txt'], 'Edit b')]);

        expect([first.status, second.status]).toEqual([200, 200]);
        // A second hook that started before the first ended would put two starts in a row.
        expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual(['start', 'end', 'start', 'end']);
        expect(git(path, 'rev-list', '--count', 'HEAD')).toBe('4');
        expect(left(path)).toEqual([]);
    });

    test('refuses no paths, a path that is not a changed file or not a path, no message and a message too long, and changes nothing', async () => {
        const h = await start();
        const path = repository();
        const { commit, url, folderId } = await open(path, h);

        put(path, { 'a.txt': 'a\nmore\n' });
        git(path, 'update-index', '--chmod=+x', 'b.txt');

        const before = git(path, 'rev-parse', 'HEAD');
        const refuse = async (response: Response, message: RegExp) => {
            const body = await json<Failure>(response);

            expect(response.status).toBe(400);
            expect(body.error).toMatchObject({ code: 'invalid' });
            expect(body.error.message).toMatch(message);
        };

        await refuse(await commit([], 'Edit a'), /at least one file/);
        await refuse(await commit(['a.txt'], ''), /message/);
        await refuse(await commit(['a.txt'], '  \n '), /message/);
        await refuse(await commit(['a.txt'], 'x'.repeat(MAX_GIT_MESSAGE_CHARS + 1)), /over/);
        await refuse(await commit(['a.txt'], 'bad\0message'), /character/);
        // A file that is not changed, one that does not exist, and a path that is no path of the repository.
        await refuse(await commit(['a.txt', 'README.md'], 'Edit'), /README\.md is not a changed file/);
        await refuse(await commit(['nothing.txt'], 'Edit'), /not a changed file/);
        await refuse(await commit(['../outside.txt'], 'Edit'), /not a path inside the repository/);
        await refuse(await commit(['/etc/passwd'], 'Edit'), /not a path inside the repository/);
        await refuse(await commit(['.git/config'], 'Edit'), /not a changed file/);
        await refuse(await commit(['src/'], 'Edit'), /not a path inside the repository/);
        await refuse(
            await commit(
                Array.from({ length: MAX_GIT_COMMIT_PATHS + 1 }, (_, index) => `f${index}.txt`),
                'Edit'
            ),
            /at most/
        );
        await refuse(await commit('a.txt', 'Edit'), /./);
        await refuse(await h.fetch(url, { method: 'POST', body: JSON.stringify({ folderId }) }), /./);
        await refuse(await h.fetch(url, { method: 'POST', body: 'not json' }), /JSON/);

        expect(git(path, 'rev-parse', 'HEAD')).toBe(before);
        // What was staged before is still the only thing staged.
        expect(git(path, 'diff', '--cached', '--name-only')).toBe('b.txt');
        expect(left(path)).toEqual([' M a.txt', 'MM b.txt']);
    });

    test('is behind the token, and says a project, a folder or a place that is none, and a folder that is no repository', async () => {
        const h = await start();
        const path = repository();
        const { commit, url, folderId } = await open(path, h);

        put(path, { 'a.txt': 'a\nmore\n' });

        expect(
            (
                await fetch(`${h.url}${url}`, {
                    method: 'POST',
                    body: JSON.stringify({ folderId, paths: ['a.txt'], message: 'x' }),
                })
            ).status
        ).toBe(401);
        expect(
            (
                await h.fetch('/v1/projects/prj_unknown/git/commit', {
                    method: 'POST',
                    body: JSON.stringify({ folderId, paths: ['a.txt'], message: 'x' }),
                })
            ).status
        ).toBe(404);
        expect((await commit(['a.txt'], 'x', { folderId: 'fld_unknown' })).status).toBe(404);
        expect((await commit(['a.txt'], 'x', { workspaceId: 'wks_unknown' })).status).toBe(404);

        const plain = tempDir('git-commit');
        const { project } = h.ok('project.add', { folders: [plain] });
        const refused = await h.fetch(`/v1/projects/${project.id}/git/commit`, {
            method: 'POST',
            body: JSON.stringify({ folderId: project.folders[0].id, paths: ['a.txt'], message: 'x' }),
        });

        expect(refused.status).toBe(400);
        expect((await json<Failure>(refused)).error.message).toMatch(/not the root of a git repository/);
        expect(left(path)).toEqual([' M a.txt']);
    });

    test("commits in a chat's worktree on its own and leaves the main checkout and its changes alone", async () => {
        const h = await start();
        const path = repository();
        const tree = join(tempDir('git-commit'), 'chat-tree');

        git(path, 'worktree', 'add', '-q', '-b', 'chat-branch', tree);
        put(path, { 'a.txt': 'a\nin the checkout\n' });
        put(tree, { 'a.txt': 'a\nin the tree\n', 'tree-only.txt': 'new\n' });

        const { project } = h.ok('project.add', { folders: [path] });
        const folderId = project.folders[0].id as string;
        const workspaceId = (
            h.ok('chat.create', { projectId: project.id, workspace: { mode: 'existing', path: tree } }).chat
                .workspace as { id: string }
        ).id;
        const checkoutHead = git(path, 'rev-parse', 'HEAD');
        const response = await h.fetch(`/v1/projects/${project.id}/git/commit`, {
            method: 'POST',
            body: JSON.stringify({
                folderId,
                workspaceId,
                paths: ['tree-only.txt', 'a.txt'],
                message: 'Work in the tree',
            }),
        });
        const result = await json<GitCommitResult>(response);

        expect(response.status).toBe(200);
        expect(git(tree, 'rev-parse', 'HEAD')).toBe(result.sha);
        expect(changedBy(tree).sort()).toEqual(['A\ttree-only.txt', 'M\ta.txt']);
        expect(git(tree, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('chat-branch');
        expect(left(tree)).toEqual([]);
        // The checkout is on its own branch with its own edit, which is not a path of the worktree's list.
        expect(git(path, 'rev-parse', 'HEAD')).toBe(checkoutHead);
        expect(left(path)).toEqual([' M a.txt']);

        const asked = await h.fetch(`/v1/projects/${project.id}/git/commit`, {
            method: 'POST',
            body: JSON.stringify({ folderId, paths: ['tree-only.txt'], message: 'Again' }),
        });

        // The same name in the checkout is not changed there.
        expect(asked.status).toBe(400);
    });

    test('refuses while a merge is going on, and a file with conflicts, and commits nothing', async () => {
        const h = await start();
        const path = repository();
        const { commit } = await open(path, h);

        git(path, 'switch', '-q', '-c', 'side');
        put(path, { 'a.txt': 'side\n' });
        git(path, 'commit', '-q', '-am', 'Side edit');
        git(path, 'switch', '-q', 'main');
        put(path, { 'a.txt': 'main\n' });
        git(path, 'commit', '-q', '-am', 'Main edit');

        // `git merge` fails with a conflict and leaves MERGE_HEAD.
        expect(Bun.spawnSync(['git', 'merge', 'side'], { cwd: path, stdout: 'pipe', stderr: 'pipe' }).exitCode).toBe(1);
        put(path, { 'other.txt': 'other\n', 'a.txt': 'resolved\n' });

        const before = git(path, 'rev-parse', 'HEAD');
        const response = await commit(['other.txt', 'a.txt'], 'Settle it');
        const body = await json<Failure>(response);

        expect(response.status).toBe(409);
        expect(body.error).toMatchObject({ code: 'conflict' });
        expect(body.error.message).toMatch(/merge, cherry-pick or revert is in progress/);
        expect(git(path, 'rev-parse', 'HEAD')).toBe(before);
        // Nothing was added: the conflict is still unresolved for the person.
        expect(git(path, 'ls-files', '-u')).not.toBe('');
        expect(existsSync(join(path, '.git', 'MERGE_HEAD'))).toBe(true);

        // No merge any more, but the file is still unmerged in the index (a stash that did not apply leaves that): it is not committed as it is.
        rmSync(join(path, '.git', 'MERGE_HEAD'));

        const refused = await commit(['a.txt'], 'Take it');

        expect(refused.status).toBe(409);
        expect((await json<Failure>(refused)).error.message).toMatch(/a\.txt has merge conflicts/);
        expect(git(path, 'ls-files', '-u')).not.toBe('');
    });

    test('concludes a merge once the conflicts are resolved, and not while one remains', async () => {
        const h = await start();
        const path = repository();
        const { folderId, url } = await open(path, h);
        const conclude = (message: string) =>
            h.fetch(url, {
                method: 'POST',
                body: JSON.stringify({ folderId, paths: [], message, conclude: true }),
            });

        git(path, 'switch', '-q', '-c', 'side');
        put(path, { 'a.txt': 'side\n' });
        git(path, 'commit', '-q', '-am', 'Side edit');
        git(path, 'switch', '-q', 'main');
        put(path, { 'a.txt': 'main\n' });
        git(path, 'commit', '-q', '-am', 'Main edit');
        expect(Bun.spawnSync(['git', 'merge', 'side'], { cwd: path, stdout: 'pipe', stderr: 'pipe' }).exitCode).toBe(1);

        const early = await conclude('Too soon');

        expect(early.status).toBe(409);
        expect((await json<Failure>(early)).error.message).toBe('Resolve the conflicts first');
        expect(existsSync(join(path, '.git', 'MERGE_HEAD'))).toBe(true);

        put(path, { 'a.txt': 'resolved\n' });
        git(path, 'add', 'a.txt');

        const response = await conclude('Merge side');
        const result = await json<GitCommitResult>(response);

        expect(response.status).toBe(200);
        expect(result.subject).toBe('Merge side');
        expect(git(path, 'rev-parse', 'HEAD')).toBe(result.sha);
        expect(git(path, 'rev-parse', 'HEAD^2')).toBe(git(path, 'rev-parse', 'side'));
        expect(existsSync(join(path, '.git', 'MERGE_HEAD'))).toBe(false);
        expect(readFileSync(join(path, 'a.txt'), 'utf8')).toBe('resolved\n');

        const none = await conclude('Again');

        expect(none.status).toBe(400);
        expect((await json<Failure>(none)).error.message).toBe('No merge to commit');
    });
});

withScripts('GitWrites', () => {
    /** A place at a checkout, with the writes of a daemon that was started. */
    async function writes(options: { timeoutMs?: number; environment?: WriteEnvironment } = {}) {
        const h = await start();
        const path = repository();
        const place: Place = { folder: { id: 'fld_test', path }, path };

        return { h, path, place, writes: new GitWrites({ store: h.store, environment: isolated(), ...options }) };
    }

    test('gives up on a commit that takes longer than its limit, as unavailable, and asks git to stop so it removes its lock', async () => {
        const { path, place, writes: slow } = await writes({ timeoutMs: 500 });

        put(path, { 'a.txt': 'a\nmore\n' });
        hook(path, 'pre-commit', 'sleep 20');

        const started = Date.now();
        const error = await slow
            .commit(place, { paths: ['a.txt'], message: 'Edit a' })
            .catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(CommandError);
        expect(error).toMatchObject({ code: 'unavailable', message: 'The commit did not finish in time' });
        expect(Date.now() - started).toBeLessThan(5000);

        // git got SIGTERM, which it answers by removing the lock files it made: the next commit is not stopped by a lock the last one left.
        await Bun.sleep(300);
        expect(existsSync(join(path, '.git', 'index.lock'))).toBe(false);

        hook(path, 'pre-commit', 'exit 0');
        expect(
            (await slow
                .commit(place, { paths: ['a.txt'], message: 'Edit a' })
                .catch((caught: unknown) => caught)) as unknown
        ).toMatchObject({ subject: 'Edit a' });
    });

    test('stops what is running when the daemon stops, and refuses a commit after it', async () => {
        const { path, place, writes: running } = await writes();

        put(path, { 'a.txt': 'a\nmore\n' });
        hook(path, 'pre-commit', 'sleep 20');

        const pending = running
            .commit(place, { paths: ['a.txt'], message: 'Edit a' })
            .catch((caught: unknown) => caught);

        await Bun.sleep(400);
        running.stop();

        expect(await pending).toMatchObject({ code: 'unavailable', message: 'The daemon is stopping' });
        expect(
            await running.commit(place, { paths: ['a.txt'], message: 'Edit a' }).catch((caught: unknown) => caught)
        ).toBeInstanceOf(Error);
    });

    test('says a commit git refused with its own line and a hint when the line names the signing key, and looks for the signing agent again', async () => {
        const dir = tempDir('git-commit');
        const sshLog = join(dir, 'ssh.log');
        const signerSeen = join(dir, 'signer-seen');
        const bin = join(dir, 'bin');

        mkdirSync(bin);
        writeFileSync(
            join(bin, 'ssh'),
            ['#!/bin/sh', `echo "$@" >> '${sshLog}'`, 'echo "identityagent /tmp/clowdy-test/secretive.sock"'].join('\n')
        );
        chmodSync(join(bin, 'ssh'), 0o755);

        // What `gpg.ssh.program` stands in for: it says what ssh-keygen says when it signs with a socket that has no key, and records the socket it was given.
        const signer = join(dir, 'signer');

        writeFileSync(
            signer,
            [
                '#!/bin/sh',
                `echo "$SSH_AUTH_SOCK" >> '${signerSeen}'`,
                'echo "No private key found for public key \\"/keys/abc.pub\\"?" >&2',
                'exit 1',
            ].join('\n')
        );
        chmodSync(signer, 0o755);
        writeFileSync(join(dir, 'abc.pub'), 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAA test\n');

        const environment = new WriteEnvironment({
            env: () => ({
                ...process.env,
                GIT_CONFIG_GLOBAL: '/dev/null',
                GIT_CONFIG_NOSYSTEM: '1',
                PATH: `${bin}:${process.env.PATH}`,
                SSH_AUTH_SOCK: '/var/run/com.apple.launchd.abc/Listeners',
                SHELL: '/usr/bin/true',
            }),
        });
        const { path, place, writes: signing } = await writes({ environment });

        git(path, 'remote', 'add', 'origin', 'git@github.com:acme/app.git');
        git(path, 'config', 'commit.gpgsign', 'true');
        git(path, 'config', 'gpg.format', 'ssh');
        git(path, 'config', 'gpg.ssh.program', signer);
        git(path, 'config', 'user.signingkey', join(dir, 'abc.pub'));
        put(path, { 'a.txt': 'a\nmore\n' });

        const before = git(path, 'rev-parse', 'HEAD');
        const error = (await signing
            .commit(place, { paths: ['a.txt'], message: 'Edit a' })
            .catch((caught: unknown) => caught)) as CommandError;

        expect(error).toBeInstanceOf(CommandError);
        expect(error.code).toBe('conflict');
        expect(error.message).toMatch(/No private key found for public key/);
        expect(error.details).toEqual({ hint: "The signing agent couldn't be reached" });
        expect(git(path, 'rev-parse', 'HEAD')).toBe(before);
        // The signing program was given the socket ssh named, not the one the daemon inherited.
        expect(readFileSync(signerSeen, 'utf8').trim()).toBe('/tmp/clowdy-test/secretive.sock');
        expect(readFileSync(sshLog, 'utf8').trim().split('\n')).toEqual(['-G -- github.com']);

        // A failure that names the key makes the next write look for the agent again.
        await signing.commit(place, { paths: ['a.txt'], message: 'Edit a' }).catch(() => undefined);
        expect(readFileSync(sshLog, 'utf8').trim().split('\n')).toEqual(['-G -- github.com', '-G -- github.com']);

        // A failure that does not name it carries no hint, and does not make it look again: the agent found for the third write is kept for the fourth.
        git(path, 'config', 'commit.gpgsign', 'false');
        hook(path, 'pre-commit', 'echo "lint failed" >&2', 'exit 1');

        const lint = (await signing
            .commit(place, { paths: ['a.txt'], message: 'Edit a' })
            .catch((caught: unknown) => caught)) as CommandError;

        expect(lint).toMatchObject({ code: 'conflict', message: 'lint failed' });
        expect(lint.details).toBeUndefined();
        await signing.commit(place, { paths: ['a.txt'], message: 'Edit a' }).catch(() => undefined);
        expect(readFileSync(sshLog, 'utf8').trim().split('\n')).toHaveLength(3);
    });

    test("never passes a switch that turns the person's checks off", async () => {
        const { h, path, place } = await writes();
        const argvLog = join(tempDir('git-commit'), 'argv');
        const bin = join(tempDir('git-commit'), 'bin');

        mkdirSync(bin);
        // A `git` that records what it is run with and runs the real one.
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
        const recorded = new GitWrites({ store: h.store, environment });

        put(path, { 'a.txt': 'a\nmore\n' });
        await recorded.commit(place, { paths: ['a.txt'], message: 'Edit a' });

        const runs = readFileSync(argvLog, 'utf8').trim().split('\n');

        expect(runs).toContain('--literal-pathspecs add -- a.txt');
        expect(runs).toContain('--literal-pathspecs commit -m Edit a -- a.txt');
        expect(runs.join('\n')).not.toMatch(/no-verify|gpgsign|no-gpg-sign/);
    });
});

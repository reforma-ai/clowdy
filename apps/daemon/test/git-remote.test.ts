import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { CommandError } from '../src/errors';
import { PullRequests } from '../src/git/pullRequest';
import { GitRemote, remoteFailureLine } from '../src/git/remote';
import { WriteEnvironment } from '../src/git/writeEnv';
import { cleanTempDirs, git, makeRepo, startHarness, tempDir } from './helpers';

import type { GitRemoteAction, GitRemoteResult } from '@clowdy/protocol';
import type { Place } from '../src/domain/places';
import type { Harness } from './helpers';

afterAll(cleanTempDirs);

const posix = process.platform !== 'win32';
/** Hooks and the stand-in programs are POSIX shell scripts: on Windows these cases are skipped, not run against another program. */
const withScripts = posix ? describe : describe.skip;

const harnesses: Harness[] = [];

afterEach(async () => {
    await Promise.all(harnesses.splice(0).map(h => h.stop().catch(() => undefined)));
});

/**
 * The environment of the daemon's writes in a test: the person's own git configuration (which on a developer's machine signs every commit, and asks for a fingerprint)
 * and the system's stay out, and the login shell finds no signing agent. What a test repository needs is in its own config.
 */
const isolated = (extra: Record<string, string> = {}) => new WriteEnvironment({ env: () => ({ ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', SHELL: '/usr/bin/true', ...extra }) });

async function start(environment = isolated()): Promise<Harness> {
    const h = await startHarness({}, { gitEnvironment: environment });

    harnesses.push(h);

    return h;
}

/** A bare repository to be somebody's `origin`. */
function bare(): string {
    const path = join(tempDir('git-remote'), 'origin.git');

    mkdirSync(path, { recursive: true });
    git(path, 'init', '-q', '--bare', '-b', 'main');

    return path;
}

/** Gives a working copy an identity and no signing. */
function identify(path: string): void {
    git(path, 'config', 'user.name', 'Test');
    git(path, 'config', 'user.email', 'test@example.com');
    git(path, 'config', 'commit.gpgsign', 'false');
}

/** A repository on `main` whose `origin` is `origin` and which has pushed `main` there, so it tracks `origin/main`. */
function repository(origin = bare()): { path: string; origin: string } {
    const path = makeRepo(tempDir('git-remote'));

    identify(path);
    git(path, 'remote', 'add', 'origin', origin);
    git(path, 'push', '-q', '-u', 'origin', 'main');

    return { path, origin };
}

/** Another working copy of `origin`: where somebody else's work comes from. */
function neighbour(origin: string): string {
    const path = join(tempDir('git-remote'), 'neighbour');

    git(dirname(path), 'clone', '-q', origin, path);
    identify(path);

    return path;
}

/** Writes a file and commits it on the branch that is checked out. */
function commitFile(path: string, name: string, text = `${ name }\n`): string {
    mkdirSync(dirname(join(path, name)), { recursive: true });
    writeFileSync(join(path, name), text);
    git(path, 'add', name);
    git(path, 'commit', '-q', '-m', `Add ${ name }`);

    return git(path, 'rev-parse', 'HEAD');
}

/** A hook of a working copy, or of a bare repository (whose `hooks` folder is its own). */
function hook(path: string, name: string, ...lines: string[]): void {
    const file = existsSync(join(path, '.git')) ? join(path, '.git', 'hooks', name) : join(path, 'hooks', name);

    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, ['#!/bin/sh', ...lines].join('\n'));
    chmodSync(file, 0o755);
}

/** What is left in the tree and the index as `status --porcelain` says it. */
const left = (path: string): string[] => Bun.spawnSync(['git', 'status', '--porcelain'], { cwd: path, stdout: 'pipe', stderr: 'pipe' }).stdout.toString().split('\n').filter(line => line !== '').sort();

const refsOf = (path: string): string => git(path, 'for-each-ref', '--format=%(refname) %(objectname)');

/** The lock files a repository has: what a git that was stopped in the middle of a ref update would leave behind. */
const locksIn = (path: string): string[] => readdirSync(join(path, '.git'), { recursive: true }).map(String).filter(name => name.endsWith('.lock'));

const json = async <T>(response: Response) => await response.json() as T;

interface Failure { ok: false; error: { code: string; message: string; details?: { hint?: string } } }

withScripts('remoteFailureLine', () => {
    test('is the cause and not the summary that follows it: the refused ref, a hook\'s line, ssh\'s line, a remote\'s line', () => {
        expect(remoteFailureLine('To /srv/origin.git\n ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs to \'/srv/origin.git\'\nhint: Updates were rejected\n', '', 'x')).toBe('! [rejected] main -> main (fetch first)');
        expect(remoteFailureLine('lint: 2 problems\nerror: failed to push some refs to \'/srv/origin.git\'\n', '', 'x')).toBe('lint: 2 problems');
        expect(remoteFailureLine('git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.\n', '', 'x')).toBe('git@github.com: Permission denied (publickey).');
        expect(remoteFailureLine('remote: Permission to acme/app.git denied to dev.\nfatal: unable to access \'https://github.com/acme/app.git/\': The requested URL returned error: 403\n', '', 'x')).toBe('remote: Permission to acme/app.git denied to dev.');
        expect(remoteFailureLine('fatal: unable to access \'https://github.com/acme/app.git/\': Could not resolve host: github.com\n', '', 'x')).toBe('fatal: unable to access \'https://github.com/acme/app.git/\': Could not resolve host: github.com');
    });

    test('is the line that names the signing key before any other, and the first of a summary only when nothing says more', () => {
        expect(remoteFailureLine('sign_and_send_pubkey: signing failed for ED25519 "k" from agent: agent refused operation\ngit@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.\n', '', 'x')).toContain('agent refused operation');
        expect(remoteFailureLine('fatal: Could not read from remote repository.\n', '', 'x')).toBe('fatal: Could not read from remote repository.');
        expect(remoteFailureLine('', 'only on the output\n', 'x')).toBe('only on the output');
        expect(remoteFailureLine('', '', 'git could not push to origin')).toBe('git could not push to origin');
    });

    test('is not a warning, a bare `remote:` or the remote\'s own progress, which come before the line that says why', () => {
        expect(remoteFailureLine('warning: redirecting to https://github.com/acme/app.git/\nremote: Repository not found.\nfatal: repository \'https://github.com/acme/app.git/\' not found\n', '', 'x')).toBe('remote: Repository not found.');
        expect(remoteFailureLine('remote: Resolving deltas: 100% (1/1), completed with 1 local object.\nremote: error: GH006: Protected branch update failed for refs/heads/main.\nTo github.com:acme/app.git\n ! [remote rejected] main -> main (protected branch hook declined)\n', '', 'x')).toBe('remote: error: GH006: Protected branch update failed for refs/heads/main.');
        expect(remoteFailureLine('remote:\nremote: error: GH013: Repository rule violations found for refs/heads/main.\n', '', 'x')).toBe('remote: error: GH013: Repository rule violations found for refs/heads/main.');
        // Nothing the remote said besides what git says of the ref: that is the line.
        expect(remoteFailureLine('To github.com:acme/app.git\n ! [remote rejected] main -> main (pre-receive hook declined)\nerror: failed to push some refs to \'github.com:acme/app.git\'\n', '', 'x')).toBe('! [remote rejected] main -> main (pre-receive hook declined)');
    });

    test('is one line, with no colour and no credential of an address', () => {
        expect(remoteFailureLine('\u001B[31mfatal:\u001B[0m unable to access https://user:s3cret@github.com/acme/app.git/', '', 'x')).toBe('fatal: unable to access https://github.com/acme/app.git/');
        // A password that has an `@` in it goes whole, whatever the form of the address.
        expect(remoteFailureLine('fatal: unable to access \'https://user:p@ss@github.com/acme/app.git/\': Could not resolve host', '', 'x')).toBe('fatal: unable to access \'https://github.com/acme/app.git/\': Could not resolve host');
        expect(remoteFailureLine('fatal: unable to connect to ssh://git:t0k@n@github.com:22/acme/app.git', '', 'x')).toBe('fatal: unable to connect to ssh://github.com:22/acme/app.git');
        expect(remoteFailureLine(`remote: ${ 'x'.repeat(1000) }`, '', 'x')).toHaveLength(300);
    });
});

withScripts('POST /v1/projects/:id/git/fetch, pull and push', () => {
    /** The project of a repository, and the call that runs an action in it (or in a worktree of it, by `place`). */
    async function open(path: string, h: Harness) {
        const { project } = h.ok('project.add', { folders: [path] });
        const folderId = project.folders[0].id as string;
        const call = (action: GitRemoteAction, place: Record<string, string> = {}) => h.fetch(`/v1/projects/${ project.id }/git/${ action }`, { method: 'POST', body: JSON.stringify({ folderId, ...place }) });
        const result = async (action: GitRemoteAction, place: Record<string, string> = {}) => {
            const response = await call(action, place);

            expect(response.status).toBe(200);

            return await json<GitRemoteResult>(response);
        };
        const failure = async (action: GitRemoteAction, status: number, place: Record<string, string> = {}) => {
            const response = await call(action, place);

            expect(response.status).toBe(status);

            return (await json<Failure>(response)).error;
        };

        return { project, folderId, call, result, failure };
    }

    describe('fetch', () => {
        test('brings in what origin has and moves nothing of the person\'s own, and says how far the branch is from its upstream', async () => {
            const h = await start();
            const { path, origin } = repository();
            const { result } = await open(path, h);
            const other = neighbour(origin);
            const theirs = commitFile(other, 'theirs.txt');

            git(other, 'push', '-q');
            writeFileSync(join(path, 'wip.txt'), 'wip\n');

            const before = git(path, 'rev-parse', 'HEAD');

            expect(await result('fetch')).toEqual({ state: 'done', action: 'fetch', upstream: { name: 'origin/main', ahead: 0, behind: 1 } });
            expect(git(path, 'rev-parse', 'origin/main')).toBe(theirs);
            expect(git(path, 'rev-parse', 'HEAD')).toBe(before);
            expect(left(path)).toEqual(['?? wip.txt']);
        });

        test('does not prune: a branch that is gone from origin is still known afterwards', async () => {
            const h = await start();
            const { path, origin } = repository();
            const { result } = await open(path, h);
            const other = neighbour(origin);

            git(other, 'push', '-q', 'origin', 'HEAD:refs/heads/short-lived');
            await result('fetch');
            expect(git(path, 'branch', '-r', '--list', 'origin/short-lived')).toContain('origin/short-lived');

            git(other, 'push', '-q', 'origin', '--delete', 'short-lived');
            await result('fetch');
            expect(git(path, 'branch', '-r', '--list', 'origin/short-lived')).toContain('origin/short-lived');
        });

        test('asks origin and nothing else: a submodule whose remote cannot be reached does not fail it', async () => {
            const h = await start();
            const { path, origin } = repository();
            const { result } = await open(path, h);
            const library = makeRepo(tempDir('git-remote'), 'library');

            git(path, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', library, 'library');
            git(path, 'commit', '-q', '-m', 'Add the library');
            git(path, 'push', '-q');

            // Somebody moves the commit the submodule is at, which is what makes git fetch the submodule by itself.
            const other = neighbour(origin);

            git(other, '-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '-q');
            commitFile(join(other, 'library'), 'newer.txt');
            git(other, 'add', 'library');
            git(other, 'commit', '-q', '-m', 'Bump the library');
            git(other, 'push', '-q');
            git(path, '-C', 'library', 'config', 'remote.origin.url', join(tempDir('git-remote'), 'gone.git'));

            expect(await result('fetch')).toMatchObject({ state: 'done', action: 'fetch', upstream: { name: 'origin/main', ahead: 0, behind: 1 } });
        });

        test('works on a detached HEAD and on a branch that tracks nothing, with no upstream in the answer', async () => {
            const h = await start();
            const { path } = repository();
            const { result } = await open(path, h);

            git(path, 'switch', '-q', '-c', 'local-only');
            expect(await result('fetch')).toEqual({ state: 'done', action: 'fetch' });

            git(path, 'switch', '-q', '--detach');
            expect(await result('fetch')).toEqual({ state: 'done', action: 'fetch' });
        });

        test('says a remote that cannot be reached with git\'s own line and without the credential of the address', async () => {
            const h = await start();
            const { path } = repository();
            const { failure } = await open(path, h);

            git(path, 'remote', 'set-url', 'origin', 'https://user:s3cret@127.0.0.1:1/acme/app.git');

            const error = await failure('fetch', 409);

            expect(error.code).toBe('conflict');
            expect(error.message).toMatch(/^fatal: unable to access/);
            expect(error.message).not.toContain('s3cret');
            expect(error.details).toBeUndefined();
        });
    });

    describe('pull', () => {
        test('fast-forwards a branch that is behind, and leaves the person\'s uncommitted work where it was', async () => {
            const h = await start();
            const { path, origin } = repository();
            const { result } = await open(path, h);
            const other = neighbour(origin);

            commitFile(other, 'one.txt');

            const theirs = commitFile(other, 'two.txt');

            git(other, 'push', '-q');
            writeFileSync(join(path, 'wip.txt'), 'wip\n');

            expect(await result('pull')).toEqual({ state: 'done', action: 'pull', pulled: 2, upstream: { name: 'origin/main', ahead: 0, behind: 0 } });
            expect(git(path, 'rev-parse', 'HEAD')).toBe(theirs);
            expect(readFileSync(join(path, 'two.txt'), 'utf8')).toBe('two.txt\n');
            expect(left(path)).toEqual(['?? wip.txt']);
        });

        test('has nothing to do for a branch that is level, or only ahead, and moves nothing', async () => {
            const h = await start();
            const { path } = repository();
            const { result } = await open(path, h);
            const level = git(path, 'rev-parse', 'HEAD');

            expect(await result('pull')).toEqual({ state: 'done', action: 'pull', pulled: 0, upstream: { name: 'origin/main', ahead: 0, behind: 0 } });

            const mine = commitFile(path, 'mine.txt');

            expect(level).not.toBe(mine);
            expect(await result('pull')).toEqual({ state: 'done', action: 'pull', pulled: 0, upstream: { name: 'origin/main', ahead: 1, behind: 0 } });
            expect(git(path, 'rev-parse', 'HEAD')).toBe(mine);
        });

        test('answers a branch that diverged from its upstream as diverged, not as an error, and leaves it exactly as it was: no merge, no rebase, no reset', async () => {
            const h = await start();
            const { path, origin } = repository();
            const { result } = await open(path, h);
            const other = neighbour(origin);
            const theirs = commitFile(other, 'theirs.txt');

            git(other, 'push', '-q');
            writeFileSync(join(path, 'wip.txt'), 'wip\n');

            const mine = commitFile(path, 'mine.txt');
            const reflog = git(path, 'reflog', '--format=%H %gs');
            const index = git(path, 'ls-files', '--stage');

            expect(await result('pull')).toEqual({ state: 'diverged', upstream: { name: 'origin/main', ahead: 1, behind: 1 } });
            expect(git(path, 'rev-parse', 'HEAD')).toBe(mine);
            // The fetch did bring origin's commit in, which is all that moved.
            expect(git(path, 'rev-parse', 'origin/main')).toBe(theirs);
            expect(git(path, 'reflog', '--format=%H %gs')).toBe(reflog);
            expect(git(path, 'ls-files', '--stage')).toBe(index);
            expect(existsSync(join(path, '.git', 'MERGE_HEAD'))).toBe(false);
            expect(existsSync(join(path, '.git', 'rebase-merge'))).toBe(false);
            expect(existsSync(join(path, 'theirs.txt'))).toBe(false);
            expect(left(path)).toEqual(['?? wip.txt']);
        });

        test('does not touch an uncommitted change that the incoming commits would overwrite, and says git\'s own line', async () => {
            const h = await start();
            const { path, origin } = repository();
            const { failure } = await open(path, h);
            const other = neighbour(origin);

            commitFile(other, 'README.md', 'their readme\n');
            git(other, 'push', '-q');
            writeFileSync(join(path, 'README.md'), 'my readme\n');

            const before = git(path, 'rev-parse', 'HEAD');
            const error = await failure('pull', 409);

            expect(error).toMatchObject({ code: 'conflict' });
            expect(error.message).toMatch(/^error: Your local changes to the following files would be overwritten by merge/);
            expect(git(path, 'rev-parse', 'HEAD')).toBe(before);
            expect(readFileSync(join(path, 'README.md'), 'utf8')).toBe('my readme\n');
        });

        test('refuses a branch with no upstream, one whose upstream is gone from origin, and a detached HEAD, and moves nothing', async () => {
            const h = await start();
            const { path, origin } = repository();
            const { failure } = await open(path, h);

            git(path, 'switch', '-q', '-c', 'local-only');
            expect((await failure('pull', 400)).message).toMatch(/local-only has no upstream to pull from/);

            // Set to track a branch that origin does not have, and no fetch brings: there is nothing to take.
            git(path, 'switch', '-q', '-c', 'short-lived');
            git(path, 'config', 'branch.short-lived.remote', 'origin');
            git(path, 'config', 'branch.short-lived.merge', 'refs/heads/short-lived');
            expect((await failure('pull', 400)).message).toBe('short-lived is no longer on origin');

            git(path, 'switch', '-q', '--detach');
            expect((await failure('pull', 400)).message).toMatch(/HEAD is detached/);
        });
    });

    describe('push', () => {
        test('sends the commits of a branch that has an upstream to it, and says the branch is level', async () => {
            const h = await start();
            const { path, origin } = repository();
            const { result } = await open(path, h);
            const mine = commitFile(path, 'mine.txt');

            expect(await result('push')).toEqual({ state: 'done', action: 'push', upstream: { name: 'origin/main', ahead: 0, behind: 0 } });
            expect(git(origin, 'rev-parse', 'refs/heads/main')).toBe(mine);
        });

        test('publishes a branch that has no upstream with `-u`, so it tracks origin afterwards', async () => {
            const h = await start();
            const { path, origin } = repository();
            const { result } = await open(path, h);

            git(path, 'switch', '-q', '-c', 'feature/new-menu');

            const mine = commitFile(path, 'menu.txt');

            expect(await result('push')).toEqual({ state: 'done', action: 'push', published: true, upstream: { name: 'origin/feature/new-menu', ahead: 0, behind: 0 } });
            expect(git(origin, 'rev-parse', 'refs/heads/feature/new-menu')).toBe(mine);
            expect(git(path, 'config', 'branch.feature/new-menu.remote')).toBe('origin');
            expect(git(path, 'config', 'branch.feature/new-menu.merge')).toBe('refs/heads/feature/new-menu');

            // A second push is a plain one: it publishes nothing.
            commitFile(path, 'more.txt');
            expect(await result('push')).toEqual({ state: 'done', action: 'push', upstream: { name: 'origin/feature/new-menu', ahead: 0, behind: 0 } });
        });

        test('publishes a branch whose upstream is set to a branch that origin does not have, as a new one', async () => {
            const h = await start();
            const { path, origin } = repository();
            const { result } = await open(path, h);

            git(path, 'switch', '-q', '-c', 'short-lived');
            git(path, 'config', 'branch.short-lived.remote', 'origin');
            git(path, 'config', 'branch.short-lived.merge', 'refs/heads/short-lived');

            const mine = commitFile(path, 'mine.txt');

            expect(await result('push')).toMatchObject({ state: 'done', action: 'push', published: true, upstream: { name: 'origin/short-lived', ahead: 0, behind: 0 } });
            expect(git(origin, 'rev-parse', 'refs/heads/short-lived')).toBe(mine);
            // Now it is there: the next push is a plain one.
            expect(await result('push')).toEqual({ state: 'done', action: 'push', upstream: { name: 'origin/short-lived', ahead: 0, behind: 0 } });
        });

        test('reports a push that origin rejects with git\'s own line, changes nothing and does not try again', async () => {
            const h = await start();
            const { path, origin } = repository();
            const { failure } = await open(path, h);
            const other = neighbour(origin);
            const theirs = commitFile(other, 'theirs.txt');

            git(other, 'push', '-q');
            commitFile(path, 'mine.txt');

            const error = await failure('push', 409);

            expect(error).toEqual({ code: 'conflict', message: '! [rejected] main -> main (fetch first)' });
            expect(git(origin, 'rev-parse', 'refs/heads/main')).toBe(theirs);
        });

        test('reports a failing pre-push hook by its own line', async () => {
            const h = await start();
            const { path, origin } = repository();
            const { failure } = await open(path, h);
            const before = git(origin, 'rev-parse', 'refs/heads/main');

            commitFile(path, 'mine.txt');
            hook(path, 'pre-push', 'echo "lint: 2 problems in mine.txt" >&2', 'exit 1');

            expect(await failure('push', 409)).toEqual({ code: 'conflict', message: 'lint: 2 problems in mine.txt' });
            expect(git(origin, 'rev-parse', 'refs/heads/main')).toBe(before);
        });

        test('reports a remote that refuses the update with the remote\'s own line', async () => {
            const h = await start();
            const { path, origin } = repository();
            const { failure } = await open(path, h);

            commitFile(path, 'mine.txt');
            hook(origin, 'pre-receive', 'echo "protected branch: use a pull request" >&2', 'exit 1');

            const error = await failure('push', 409);

            expect(error.code).toBe('conflict');
            expect(error.message).toBe('remote: protected branch: use a pull request');
        });

        test('sends the branch alone, to its own upstream: no tag, no other branch, no force, whatever the person\'s configuration says', async () => {
            const h = await start();
            const { path, origin } = repository();
            const { result } = await open(path, h);

            // What a person's configuration may say: tags with every push, every branch with a force.
            git(path, 'config', 'push.followTags', 'true');
            git(path, 'config', 'remote.origin.push', '+refs/heads/*:refs/heads/*');
            git(path, 'switch', '-q', '-c', 'side');
            commitFile(path, 'side.txt');
            git(path, 'switch', '-q', 'main');

            const mine = commitFile(path, 'mine.txt');

            git(path, 'tag', '-a', '-m', 'release', 'v1.0');

            expect(await result('push')).toMatchObject({ state: 'done', action: 'push' });
            expect(git(origin, 'rev-parse', 'refs/heads/main')).toBe(mine);
            expect(refsOf(origin)).not.toContain('refs/tags/v1.0');
            expect(refsOf(origin)).not.toContain('refs/heads/side');
        });

        test('works in a folder and against an origin whose paths have spaces and odd characters, with a branch named with non-ASCII letters and a hash', async () => {
            const h = await start();
            const origin = join(tempDir('git remote'), 'my origin (bare).git');

            mkdirSync(origin, { recursive: true });
            git(origin, 'init', '-q', '--bare', '-b', 'main');

            const path = makeRepo(tempDir('git remote'), 'my repo #1');

            identify(path);
            git(path, 'remote', 'add', 'origin', origin);
            git(path, 'push', '-q', '-u', 'origin', 'main');

            const { result } = await open(path, h);

            git(path, 'switch', '-q', '-c', 'feat/ünï-#7');

            const mine = commitFile(path, 'mine.txt');

            expect(await result('push')).toEqual({ state: 'done', action: 'push', published: true, upstream: { name: 'origin/feat/ünï-#7', ahead: 0, behind: 0 } });
            expect(git(origin, 'rev-parse', 'refs/heads/feat/ünï-#7')).toBe(mine);
            expect(await result('fetch')).toMatchObject({ state: 'done', action: 'fetch' });
            expect(await result('pull')).toMatchObject({ state: 'done', action: 'pull', pulled: 0 });
        });

        test('is never forced, and goes to origin, whatever the person\'s configuration says: a `+` refspec, `pushRemote` and `remote.pushDefault` of another remote', async () => {
            const h = await start();
            const { path, origin } = repository();
            const { failure } = await open(path, h);
            const other = neighbour(origin);
            const theirs = commitFile(other, 'theirs.txt');
            const elsewhere = bare();

            git(other, 'push', '-q');
            commitFile(path, 'mine.txt');
            git(path, 'remote', 'add', 'elsewhere', elsewhere);
            git(path, 'config', 'remote.origin.push', '+refs/heads/main:refs/heads/main');
            git(path, 'config', 'push.default', 'matching');
            git(path, 'config', 'branch.main.pushRemote', 'elsewhere');
            git(path, 'config', 'remote.pushDefault', 'elsewhere');

            expect((await failure('push', 409)).message).toBe('! [rejected] main -> main (fetch first)');
            expect(git(origin, 'rev-parse', 'refs/heads/main')).toBe(theirs);
            expect(refsOf(elsewhere)).toBe('');
        });

        test('sends a branch that tracks a branch of another name to that branch, and publishes one that tracks nothing under its own name', async () => {
            const h = await start();
            const { path, origin } = repository();
            const { result } = await open(path, h);

            git(path, 'push', '-q', 'origin', 'main:refs/heads/shared');
            git(path, 'fetch', '-q', 'origin');
            git(path, 'switch', '-q', '-c', 'mine', '--track', 'origin/shared');

            const mine = commitFile(path, 'mine.txt');

            expect(await result('push')).toEqual({ state: 'done', action: 'push', upstream: { name: 'origin/shared', ahead: 0, behind: 0 } });
            expect(git(origin, 'rev-parse', 'refs/heads/shared')).toBe(mine);
            expect(refsOf(origin)).not.toContain('refs/heads/mine');
        });

        test('refuses a detached HEAD, a branch with no commit, a repository with no origin and a folder that is no repository, and sends nothing', async () => {
            const h = await start();
            const { path, origin } = repository();
            const { failure } = await open(path, h);
            const before = refsOf(origin);

            git(path, 'switch', '-q', '--detach');
            commitFile(path, 'floating.txt');
            expect((await failure('push', 400)).message).toMatch(/HEAD is detached/);
            expect(refsOf(origin)).toBe(before);

            const fresh = tempDir('git-remote');

            git(fresh, 'init', '-q', '-b', 'main');
            git(fresh, 'remote', 'add', 'origin', origin);
            expect((await (await open(fresh, h)).failure('push', 400)).message).toBe('main has no commits yet');
            expect(refsOf(origin)).toBe(before);

            const lonely = makeRepo(tempDir('git-remote'));

            expect((await (await open(lonely, h)).failure('push', 400)).message).toBe('The repository has no origin');
            expect((await (await open(lonely, h)).failure('fetch', 400)).message).toBe('The repository has no origin');
            expect((await (await open(tempDir('git-remote'), h)).failure('fetch', 400)).message).toMatch(/not the root of a git repository/);
        });

        test('refuses a branch that tracks another remote, a local branch or something that is not a branch, and sends nothing', async () => {
            const h = await start();
            const { path, origin } = repository();
            const { failure } = await open(path, h);
            const elsewhere = bare();
            const before = refsOf(origin);

            git(path, 'remote', 'add', 'elsewhere', elsewhere);
            git(path, 'config', 'branch.main.remote', 'elsewhere');
            expect((await failure('push', 400)).message).toBe('main tracks elsewhere, and only origin is used');
            expect((await failure('pull', 400)).message).toBe('main tracks elsewhere, and only origin is used');

            // A remote that is an address names no credential in what is said.
            git(path, 'config', 'branch.main.remote', 'https://user:s3cret@example.invalid/acme/app.git');
            expect((await failure('push', 400)).message).toBe('main tracks https://example.invalid/acme/app.git, and only origin is used');

            git(path, 'config', 'branch.main.remote', '.');
            expect((await failure('push', 400)).message).toBe('main tracks a local branch, and only origin is used');

            git(path, 'config', 'branch.main.remote', 'origin');
            git(path, 'config', 'branch.main.merge', 'refs/tags/v1');
            expect((await failure('push', 400)).message).toBe('main tracks refs/tags/v1, which is not a branch of origin');
            expect(refsOf(origin)).toBe(before);
            expect(refsOf(elsewhere)).toBe('');
        });

        test('says what git said about the signing agent with a hint, and anything else without one', async () => {
            const h = await start();
            const { path } = repository();
            const { failure } = await open(path, h);
            const dir = tempDir('git-remote');
            const ssh = join(dir, 'ssh-stand-in');

            // What ssh says when the agent that holds the key refuses to sign (a cancelled fingerprint), and then what git adds.
            writeFileSync(ssh, ['#!/bin/sh', 'echo \'sign_and_send_pubkey: signing failed for ED25519 "key" from agent: agent refused operation\' >&2', 'echo \'git@github.com: Permission denied (publickey).\' >&2', 'exit 255'].join('\n'));
            chmodSync(ssh, 0o755);
            git(path, 'remote', 'set-url', 'origin', 'git@example.invalid:acme/app.git');
            git(path, 'config', 'core.sshCommand', ssh);
            commitFile(path, 'mine.txt');

            const signing = await failure('push', 409);

            expect(signing.message).toBe('sign_and_send_pubkey: signing failed for ED25519 "key" from agent: agent refused operation');
            expect(signing.details).toEqual({ hint: 'The signing agent couldn\'t be reached' });

            writeFileSync(ssh, ['#!/bin/sh', 'echo \'git@github.com: Permission denied (publickey).\' >&2', 'exit 255'].join('\n'));

            const denied = await failure('fetch', 409);

            expect(denied.message).toBe('git@github.com: Permission denied (publickey).');
            expect(denied.details).toBeUndefined();
        });

        test('publishes a chat\'s worktree on its own and leaves the checkout and its branch alone', async () => {
            const h = await start();
            const { path, origin } = repository();
            const tree = join(tempDir('git-remote'), 'chat-tree');

            git(path, 'worktree', 'add', '-q', '-b', 'chat-branch', tree);

            const mine = commitFile(tree, 'in-the-tree.txt');
            const { project } = h.ok('project.add', { folders: [path] });
            const folderId = project.folders[0].id as string;
            const workspaceId = (h.ok('chat.create', { projectId: project.id, workspace: { mode: 'existing', path: tree } }).chat.workspace as { id: string }).id;
            const response = await h.fetch(`/v1/projects/${ project.id }/git/push`, { method: 'POST', body: JSON.stringify({ folderId, workspaceId }) });

            expect(response.status).toBe(200);
            expect(await json<GitRemoteResult>(response)).toMatchObject({ state: 'done', action: 'push', published: true });
            expect(git(origin, 'rev-parse', 'refs/heads/chat-branch')).toBe(mine);
            expect(git(path, 'config', '--get', 'branch.chat-branch.remote')).toBe('origin');
            expect(refsOf(origin)).not.toContain('refs/heads/side');
        });
    });

    test('has the pull request of the branch asked of GitHub again after an action, whether it worked or not, so a push shows at once', async () => {
        class Watching extends PullRequests {
            forgotten: string[] = [];

            override async forget(place: Place): Promise<void> {
                this.forgotten.push(place.path);
                await super.forget(place);
            }
        }

        const pullRequests = new Watching({ env: () => ({ PATH: tempDir('empty-path') }), fallbackPaths: [] });
        const h = await startHarness({}, { gitEnvironment: isolated(), pullRequests });

        harnesses.push(h);

        const { path, origin } = repository();
        const { result, failure } = await open(path, h);

        commitFile(path, 'mine.txt');
        await result('push');
        expect(pullRequests.forgotten).toHaveLength(1);

        const other = neighbour(origin);

        commitFile(other, 'theirs.txt');
        git(other, 'push', '-q');
        commitFile(path, 'more.txt');
        await failure('push', 409);
        expect(pullRequests.forgotten).toHaveLength(2);

        await result('fetch');
        await result('pull');
        expect(pullRequests.forgotten).toHaveLength(4);
        pullRequests.stop();
    });

    test('is behind the token, and says a project, a folder or a place that is none, and a body that is none', async () => {
        const h = await start();
        const { path } = repository();
        const { project, folderId, call } = await open(path, h);
        const url = `/v1/projects/${ project.id }/git/push`;

        expect((await fetch(`${ h.url }${ url }`, { method: 'POST', body: JSON.stringify({ folderId }) })).status).toBe(401);
        expect((await h.fetch('/v1/projects/prj_unknown/git/fetch', { method: 'POST', body: JSON.stringify({ folderId }) })).status).toBe(404);
        expect((await call('fetch', { folderId: 'fld_unknown' })).status).toBe(404);
        expect((await call('pull', { workspaceId: 'wks_unknown' })).status).toBe(404);
        expect((await h.fetch(url, { method: 'POST', body: JSON.stringify({}) })).status).toBe(400);
        expect((await h.fetch(url, { method: 'POST', body: 'not json' })).status).toBe(400);
        expect((await h.fetch(`/v1/projects/${ project.id }/git/force`, { method: 'POST', body: JSON.stringify({ folderId }) })).status).toBe(404);
    });
});

withScripts('GitRemote', () => {
    /** A place at a checkout that tracks a bare origin, and the actions of a daemon that was started. */
    async function remote(options: { timeoutMs?: number; environment?: WriteEnvironment } = {}) {
        const h = await start();
        const { path, origin } = repository();
        const place: Place = { folder: { id: 'fld_test', path }, path };

        return { h, path, origin, place, remote: new GitRemote({ store: h.store, environment: isolated(), ...options }) };
    }

    test('stops a push that takes longer than its limit, as unavailable, and a daemon that stops ends one that is running', async () => {
        const { h, path, place, remote: slow } = await remote({ timeoutMs: 500 });

        commitFile(path, 'mine.txt');
        hook(path, 'pre-push', 'sleep 20');

        const started = Date.now();
        const error = await slow.push(place).catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(CommandError);
        expect(error).toMatchObject({ code: 'unavailable', message: 'The push did not finish in time' });
        expect(Date.now() - started).toBeLessThan(5000);
        expect(locksIn(path)).toEqual([]);

        const running = new GitRemote({ store: h.store, environment: isolated() });
        const pending = running.push(place).catch((caught: unknown) => caught);

        await Bun.sleep(400);
        running.stop();

        expect(await pending).toMatchObject({ code: 'unavailable', message: 'The daemon is stopping' });
        expect(await running.fetch(place).catch((caught: unknown) => caught)).toBeInstanceOf(Error);
    });

    test('never runs two of the place\'s writes together: a fetch and a pull, a commit and a push, one after the other', async () => {
        const dir = tempDir('git-remote');
        const bin = join(dir, 'bin');
        const log = join(dir, 'order.log');
        const real = Bun.which('git') as string;

        mkdirSync(bin);
        // A `git` that says when each of its runs starts and ends, and takes a while, so a second run that was let in would show between the two.
        writeFileSync(join(bin, 'git'), ['#!/bin/sh', `echo "start $*" >> '${ log }'`, 'sleep 0.3', `'${ real }' "$@"`, 'code=$?', `echo "end $*" >> '${ log }'`, 'exit $code'].join('\n'));
        chmodSync(join(bin, 'git'), 0o755);

        const environment = isolated({ PATH: `${ bin }:${ process.env.PATH }` });
        const h = await start(environment);
        const { path, origin } = repository();
        const { project } = h.ok('project.add', { folders: [path] });
        const folderId = project.folders[0].id as string;
        const post =(action: string, body: Record<string, unknown> = {}) => h.fetch(`/v1/projects/${ project.id }/git/${ action }`, { method: 'POST', body: JSON.stringify({ folderId, ...body }) });
        const other = neighbour(origin);

        commitFile(other, 'theirs.txt');
        git(other, 'push', '-q');
        writeFileSync(join(path, 'a.txt'), 'a\n');

        const responses = await Promise.all([post('fetch'), post('pull'), post('commit', { paths: ['a.txt'], message: 'Add a' }), post('push')]);

        expect(responses.map(response => response.status)).toEqual([200, 200, 200, 200]);

        const runs = readFileSync(log, 'utf8').trim().split('\n');

        // A fetch, a pull's fetch and merge, a commit's add and commit, and a push: each run that was started ended before the next began.
        expect(runs.length).toBeGreaterThanOrEqual(10);
        runs.forEach((line, index) => expect(line.startsWith(index % 2 === 0 ? 'start ' : 'end ')).toBe(true));
    });

    test('runs git with the arguments it says: nothing forced, no hook skipped, no tag, no pruning, and a refspec for the branch alone', async () => {
        const dir = tempDir('git-remote');
        const bin = join(dir, 'bin');
        const log = join(dir, 'argv.log');
        const real = Bun.which('git') as string;

        mkdirSync(bin);
        writeFileSync(join(bin, 'git'), ['#!/bin/sh', `echo "$@" >> '${ log }'`, `exec '${ real }' "$@"`].join('\n'));
        chmodSync(join(bin, 'git'), 0o755);

        const { path, origin, place, remote: recorded } = await remote({ environment: isolated({ PATH: `${ bin }:${ process.env.PATH }` }) });
        const other = neighbour(origin);

        commitFile(other, 'theirs.txt');
        git(other, 'push', '-q');
        await recorded.fetch(place);
        await recorded.pull(place);
        commitFile(path, 'mine.txt');
        await recorded.push(place);
        git(path, 'switch', '-q', '-c', 'feature');
        await recorded.push(place);

        const runs = readFileSync(log, 'utf8').trim().split('\n');

        expect(runs).toContain('fetch --no-recurse-submodules origin');
        expect(runs).toContain('merge --ff-only @{upstream}');
        expect(runs).toContain('push --no-follow-tags --no-recurse-submodules origin refs/heads/main:refs/heads/main');
        // A branch that was never published is sent as a full ref too, never as `HEAD`, which is whatever is checked out when git runs.
        expect(runs).toContain('push --no-follow-tags --no-recurse-submodules -u origin refs/heads/feature:refs/heads/feature');
        expect(runs.join('\n')).not.toMatch(/--force|\s-f\s|--no-verify|--tags|--mirror|--all|--prune|\+refs|--delete|--rebase|reset|pull\b|\bHEAD\b/);
    });

    test('publishes the branch it judged, not the one that is checked out by the time git runs', async () => {
        const dir = tempDir('git-remote');
        const bin = join(dir, 'bin');
        const real = Bun.which('git') as string;

        mkdirSync(bin);
        // A `git` that checks out another branch just before it pushes, as an agent working in the same place may.
        writeFileSync(join(bin, 'git'), ['#!/bin/sh', 'if [ "$1" = push ]; then', `  '${ real }' switch -q side`, 'fi', `exec '${ real }' "$@"`].join('\n'));
        chmodSync(join(bin, 'git'), 0o755);

        const { path, origin, place, remote: publishing } = await remote({ environment: isolated({ PATH: `${ bin }:${ process.env.PATH }` }) });

        git(path, 'switch', '-q', '-c', 'side');
        commitFile(path, 'side.txt');
        git(path, 'switch', '-q', '-c', 'feature');

        const feature = commitFile(path, 'feature.txt');

        await publishing.push(place);

        expect(git(origin, 'rev-parse', 'refs/heads/feature')).toBe(feature);
        expect(refsOf(origin)).not.toContain('refs/heads/side');
        expect(git(path, 'config', 'branch.feature.merge')).toBe('refs/heads/feature');
    });

    test('lets two worktrees of one repository fetch and push at once, each on its own line, with nothing corrupted or left locked', async () => {
        const { path, origin, place, remote: actions } = await remote();
        const trees = ['b', 'c'].map((name) => {
            const tree = join(tempDir('git-remote'), `tree-${ name }`);

            git(path, 'worktree', 'add', '-q', '-b', `wt-${ name }`, tree);

            return { name: `wt-${ name }`, place: { folder: place.folder, path: tree } satisfies Place };
        });

        for (let round = 0; round < 4; round++) {
            for (const tree of trees) commitFile(tree.place.path, `${ tree.name }-${ round }.txt`);

            // The first round publishes both branches, the next ones push them: a fetch of the checkout and of a worktree run between.
            const results = await Promise.all([actions.fetch(place), actions.push(trees[0]!.place), actions.push(trees[1]!.place), actions.fetch(trees[0]!.place)]);

            expect(results.map(result => result.state)).toEqual(['done', 'done', 'done', 'done']);
        }

        for (const tree of trees) expect(git(origin, 'rev-parse', `refs/heads/${ tree.name }`)).toBe(git(tree.place.path, 'rev-parse', 'HEAD'));

        expect(locksIn(path)).toEqual([]);
        expect(git(path, 'fsck', '--no-progress')).not.toMatch(/error|missing/i);
    });

    test('leaves no lock file when a fetch that waits for the network is stopped at its limit', async () => {
        const { path, place, remote: slow } = await remote({ timeoutMs: 400 });
        const ssh = join(tempDir('git-remote'), 'ssh-that-waits');

        // What ssh does while a fingerprint is waited for, or a network does not answer.
        writeFileSync(ssh, ['#!/bin/sh', 'sleep 20'].join('\n'));
        chmodSync(ssh, 0o755);
        git(path, 'remote', 'set-url', 'origin', 'git@example.invalid:acme/app.git');
        git(path, 'config', 'core.sshCommand', ssh);

        const started = Date.now();

        expect(await slow.fetch(place).catch((caught: unknown) => caught)).toMatchObject({ code: 'unavailable', message: 'The fetch did not finish in time' });
        expect(Date.now() - started).toBeLessThan(5000);
        expect(locksIn(path)).toEqual([]);
        // What git was running when it was stopped is gone, not left waiting.
        expect(Bun.spawnSync(['pgrep', '-f', ssh]).exitCode).not.toBe(0);
    });

    test('gives the place\'s writes the environment of the daemon: no prompt for a password, and the signing agent that was found', async () => {
        const dir = tempDir('git-remote');
        const bin = join(dir, 'bin');
        const seen = join(dir, 'env.log');
        const real = Bun.which('git') as string;

        mkdirSync(bin);
        writeFileSync(join(bin, 'git'), ['#!/bin/sh', `echo "$GIT_TERMINAL_PROMPT $SSH_AUTH_SOCK $LANGUAGE" >> '${ seen }'`, `exec '${ real }' "$@"`].join('\n'));
        chmodSync(join(bin, 'git'), 0o755);

        const sshBin = join(dir, 'ssh-bin');

        mkdirSync(sshBin);
        writeFileSync(join(sshBin, 'ssh'), ['#!/bin/sh', 'echo "identityagent /tmp/clowdy-test/secretive.sock"'].join('\n'));
        chmodSync(join(sshBin, 'ssh'), 0o755);

        const environment = isolated({ PATH: `${ bin }:${ sshBin }:${ process.env.PATH }`, SSH_AUTH_SOCK: '/var/run/com.apple.launchd.abc/Listeners' });
        const { path, place, remote: asked } = await remote({ environment });

        // `ssh -G` is asked for a host: a path as origin has none, so the login shell is asked, which stands in for no agent here, and the inherited socket stays.
        await asked.fetch(place);
        expect(readFileSync(seen, 'utf8').trim().split('\n')[0]).toBe('0 /var/run/com.apple.launchd.abc/Listeners C');

        git(path, 'remote', 'set-url', 'origin', 'git@github.com:acme/app.git');
        git(path, 'config', 'core.sshCommand', 'false');
        await asked.fetch(place).catch(() => undefined);
        expect(readFileSync(seen, 'utf8').trim().split('\n').at(-1)).toBe('0 /tmp/clowdy-test/secretive.sock C');
    });
});

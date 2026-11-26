import { afterAll, afterEach, describe, expect, spyOn, test } from 'bun:test';
import {
    chmodSync,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { CommandError } from '../src/errors';
import { CloneOutput, GitClone, repositoryName } from '../src/git/clone';
import { isolated } from './gitRepos';
import { cleanTempDirs, git, makeRepo, startHarness, tempDir, waitFor } from './helpers';

import type { GitCloneEvent, GitCloneTarget } from '@clowdy/protocol';
import type { Harness } from './helpers';

afterAll(cleanTempDirs);

const posix = process.platform !== 'win32';
/** Hooks and the stand-in programs are POSIX shell scripts: on Windows these cases are skipped, not run against another program. */
const withScripts = posix ? describe : describe.skip;

const harnesses: Harness[] = [];

afterEach(async () => {
    await Promise.all(harnesses.splice(0).map(h => h.stop().catch(() => undefined)));
});

async function start(extra: Record<string, string> = {}): Promise<Harness> {
    const h = await startHarness({}, { gitEnvironment: isolated(extra) });

    harnesses.push(h);

    return h;
}

/** A bare repository with a few commits on `branch`, somebody's `origin`; `HEAD` of it is that branch. */
function origin(branch = 'main', commits = 3): string {
    const work = makeRepo(tempDir('git-clone'), 'work');
    const bare = join(tempDir('git-clone'), 'origin.git');

    git(work, 'branch', '-m', branch);

    for (let index = 1; index < commits; index++) {
        writeFileSync(join(work, `f${index}.txt`), `${index}\n`);
        git(work, 'add', '.');
        git(work, 'commit', '-q', '-m', `Commit ${index}`);
    }

    git(work, 'branch', 'other');
    git(tempDir('git-clone'), 'clone', '-q', '--bare', work, bare);

    return bare;
}

const target = async (h: Harness, url: string, folder?: string): Promise<GitCloneTarget> => {
    const query = new URLSearchParams({ url, ...(folder !== undefined && { folder }) });
    const response = await h.fetch(`/v1/git/clone-target?${query}`);

    return (await response.json()) as GitCloneTarget;
};

const eventsOf = (text: string): GitCloneEvent[] =>
    text
        .trimEnd()
        .split('\n\n')
        .filter(Boolean)
        .map(frame => JSON.parse(frame.slice('data: '.length)) as GitCloneEvent);

/** `POST /v1/git/clone` to its end: every event the stream held. */
async function clone(h: Harness, url: string, path: string): Promise<GitCloneEvent[]> {
    const response = await h.fetch('/v1/git/clone', { method: 'POST', body: JSON.stringify({ url, path }) });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toStartWith('text/event-stream');

    return eventsOf(await response.text());
}

const last = (events: GitCloneEvent[]): GitCloneEvent => events[events.length - 1] as GitCloneEvent;

/** A clone that is slow where a test needs it to be: the server side of the clone waits for `hold` to go (a `uploadpack.packObjectsHook` in the global config, which is one of the few that reads it). */
function slow(): { env: Record<string, string>; hold: string; started: string; pid: string; release(): void } {
    const dir = tempDir('git-clone-slow');
    const hold = join(dir, 'hold');
    const started = join(dir, 'started');
    const pid = join(dir, 'pid');
    const script = join(dir, 'hook.sh');

    writeFileSync(hold, '');
    writeFileSync(
        script,
        [
            '#!/bin/sh',
            `echo $$ > '${pid}'`,
            `touch '${started}'`,
            `while test -f '${hold}'; do sleep 0.02; done`,
            'exec "$@"',
        ].join('\n')
    );
    chmodSync(script, 0o755);

    const config = join(dir, 'gitconfig');

    writeFileSync(config, `[uploadpack]\n\tpackObjectsHook = ${script}\n`);

    return {
        env: { GIT_CONFIG_GLOBAL: config },
        hold,
        started,
        pid,
        release: () => rmSync(hold, { force: true }),
    };
}

const alive = (pid: number): boolean => {
    try {
        process.kill(pid, 0);

        return true;
    } catch {
        return false;
    }
};

describe('repositoryName', () => {
    test('is the last part of the address without .git', () => {
        expect(repositoryName('https://github.com/own/repo.git')).toBe('repo');
        expect(repositoryName('https://github.com/own/repo')).toBe('repo');
        expect(repositoryName('https://github.com/own/repo.git/')).toBe('repo');
        expect(repositoryName('git@github.com:own/repo.git')).toBe('repo');
        expect(repositoryName('host:repo.git')).toBe('repo');
        expect(repositoryName('ssh://git@host:2222/srv/git/repo.git')).toBe('repo');
        expect(repositoryName('/srv/git/repo.git')).toBe('repo');
        expect(repositoryName('file:///srv/git/My Repo.git')).toBe('My Repo');
        expect(repositoryName('  https://github.com/own/repo.git  ')).toBe('repo');
    });

    test('is nothing for an address that names no repository', () => {
        expect(repositoryName('')).toBeUndefined();
        expect(repositoryName('https://github.com')).toBeUndefined();
        expect(repositoryName('https://github.com/')).toBeUndefined();
        expect(repositoryName('git@github.com:')).toBeUndefined();
        expect(repositoryName('https://github.com/own/.git')).toBeUndefined();
        expect(repositoryName('https://github.com/own/..')).toBeUndefined();
        expect(repositoryName('https://github.com/own/a?b')).toBeUndefined();
    });
});

describe('CloneOutput', () => {
    test("reads git's progress from lines ended by a carriage return, whatever the pieces it arrives in", () => {
        const output = new CloneOutput(() => 0);

        expect(output.feed("Cloning into 'x'...\nremote: Enumerating objects: 12, done.\n")).toEqual([
            { label: 'Enumerating objects' },
        ]);
        expect(output.feed('remote: Counting objects:  50% (6/12)   \rremote: Counting')).toEqual([
            { label: 'Counting objects', percent: 50 },
        ]);
        expect(output.feed(' objects: 100% (12/12)   \r')).toEqual([{ label: 'Counting objects', percent: 100 }]);
        expect(output.feed('Receiving objec')).toEqual([]);
        expect(output.feed('ts:  45% (45/100), 1.2 MiB | 2.0 MiB/s\r')).toEqual([
            { label: 'Receiving objects', percent: 45 },
        ]);
        expect(output.finish()).toEqual([]);
    });

    test('keeps the steps few: not a repeat, and not a phase that is not finished more than every 100 ms', () => {
        let now = 0;
        const output = new CloneOutput(() => now);
        const sent: unknown[] = [];

        for (let percent = 1; percent <= 100; percent++) {
            now += 1;
            sent.push(...output.feed(`Receiving objects: ${String(percent).padStart(3)}% (${percent}/100)\r`));
        }

        expect(sent).toEqual([
            { label: 'Receiving objects', percent: 1 },
            { label: 'Receiving objects', percent: 100 },
        ]);

        now += 500;
        expect(output.feed('Receiving objects: 100% (100/100), done.\n')).toEqual([]);
        expect(output.feed('Resolving deltas:   3% (1/30)\r')).toEqual([{ label: 'Resolving deltas', percent: 3 }]);

        now += 150;
        expect(output.feed('Resolving deltas:   6% (2/30)\r')).toEqual([{ label: 'Resolving deltas', percent: 6 }]);
        expect(output.feed('Resolving deltas:   6% (2/30)\r')).toEqual([]);
    });

    test('keeps every other line for the failure, and the end of a stream that has no newline', () => {
        const output = new CloneOutput();

        output.feed(
            "Cloning into 'x'...\nwarning: redirecting to https://host/x.git/\nfatal: 128 is not a phase\nfatal: early"
        );
        output.feed(' EOF');

        expect(output.finish()).toEqual([
            'warning: redirecting to https://host/x.git/',
            'fatal: 128 is not a phase',
            'fatal: early EOF',
        ]);
    });
});

describe('GET /v1/git/clone-target', () => {
    const repo = 'file:///srv/git/repo.git';

    test('a folder that is missing or empty is the repository itself, and one that has something in it holds it', async () => {
        const h = await start();
        const dir = tempDir('git-clone');
        const empty = join(dir, 'empty');
        const full = join(dir, 'full');

        mkdirSync(empty);
        mkdirSync(full);
        writeFileSync(join(full, 'a.txt'), 'a');

        expect(await target(h, repo, join(dir, 'missing', 'deeper'))).toEqual({
            folder: join(dir, 'missing', 'deeper'),
            path: join(dir, 'missing', 'deeper'),
        });
        expect(await target(h, repo, empty)).toEqual({ folder: empty, path: empty });
        expect(await target(h, repo, full)).toEqual({ folder: full, path: join(full, 'repo') });
    });

    test('the projects folder is where repositories go: never the repository itself, empty or not there yet', async () => {
        const h = await start();
        const projects = h.config.projectsDir;

        expect(existsSync(projects)).toBe(false);
        expect(await target(h, repo)).toEqual({ folder: projects, path: join(projects, 'repo') });

        mkdirSync(projects, { recursive: true });
        expect(await target(h, repo)).toEqual({ folder: projects, path: join(projects, 'repo') });
        expect(await target(h, repo, '')).toEqual({ folder: projects, path: join(projects, 'repo') });
    });

    test('says what blocks the path: something in it, a file, a file above it', async () => {
        const h = await start();
        const dir = tempDir('git-clone');
        const full = join(dir, 'full');
        const file = join(dir, 'file.txt');

        mkdirSync(join(full, 'repo'), { recursive: true });
        writeFileSync(join(full, 'repo', 'x.txt'), 'x');
        writeFileSync(join(full, 'other'), 'x');
        writeFileSync(file, 'x');

        expect(await target(h, repo, full)).toEqual({
            folder: full,
            path: join(full, 'repo'),
            blocked: `${join(full, 'repo')} already exists and is not an empty folder`,
        });
        expect(await target(h, 'file:///srv/git/other.git', full)).toEqual({
            folder: full,
            path: join(full, 'other'),
            blocked: `${join(full, 'other')} is a file`,
        });
        expect(await target(h, repo, file)).toEqual({ folder: file, path: file, blocked: `${file} is a file` });
        expect(await target(h, repo, join(file, 'sub'))).toEqual({
            folder: join(file, 'sub'),
            path: join(file, 'sub'),
            blocked: `A parent of ${join(file, 'sub')} is a file`,
        });
        // An empty folder of that name is where the repository goes.
        mkdirSync(join(full, 'hollow'));
        expect(await target(h, 'file:///srv/git/hollow.git', full)).toEqual({
            folder: full,
            path: join(full, 'hollow'),
        });
    });

    test('has no path while the address is empty or names no repository', async () => {
        const h = await start();
        const dir = tempDir('git-clone');

        for (const url of [
            '',
            '   ',
            'owner/repo',
            'https://github.com',
            '--upload-pack=x',
            'ext::sh -c true',
            'with\u0007bell',
        ]) {
            expect(await target(h, url, dir)).toEqual({ folder: dir });
        }
    });

    test('a folder that is not absolute is invalid', async () => {
        const h = await start();
        const response = await h.fetch(`/v1/git/clone-target?${new URLSearchParams({ url: repo, folder: 'rel/x' })}`);

        expect(response.status).toBe(400);
    });
});

describe('POST /v1/git/clone', () => {
    test('clones a repository by path and by file:// URL into a missing folder, an empty one and a folder with files, and says the real path', async () => {
        const h = await start();
        const bare = origin();
        const dir = tempDir('git-clone');
        const empty = join(dir, 'empty');
        const full = join(dir, 'full');

        mkdirSync(empty);
        mkdirSync(join(full, 'keep'), { recursive: true });
        writeFileSync(join(full, 'keep', 'x.txt'), 'x');

        const cases: [string, string][] = [
            [bare, join(dir, 'a', 'b', 'repo')],
            [`file://${bare}`, join(dir, 'viaurl')],
            [bare, empty],
            [`file://${bare}`, join(full, 'origin')],
        ];

        for (const [url, path] of cases) {
            const events = await clone(h, url, path);

            expect(last(events)).toEqual({ type: 'result', path: realpathSync(path) });
            expect(events.filter(event => event.type === 'error')).toEqual([]);
            expect(git(path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
            expect(git(path, 'rev-list', '--count', 'HEAD')).toBe('3');
            expect(git(path, 'status', '--porcelain')).toBe('');
        }

        expect(readdirSync(join(full, 'keep'))).toEqual(['x.txt']);
        expect(git(join(dir, 'viaurl'), 'remote', 'get-url', 'origin')).toBe(`file://${bare}`);
    });

    test("streams git's own phases as progress events, few and in order, and ends with the result", async () => {
        const h = await start();
        const path = join(tempDir('git-clone'), 'repo');
        const events = await clone(h, `file://${origin()}`, path);
        const steps = events.flatMap(event => (event.type === 'progress' ? [event] : []));

        expect(last(events)).toEqual({ type: 'result', path: realpathSync(path) });
        expect(events.indexOf(last(events))).toBe(events.length - 1);
        expect(steps.length).toBeGreaterThan(0);
        expect(steps.length).toBeLessThan(40);
        expect(steps.map(step => step.label)).toContain('Receiving objects');

        for (const step of steps) {
            expect(step.label).toMatch(/^\p{L}[\p{L} ]*$/u);
            expect(step.percent === undefined || (step.percent >= 0 && step.percent <= 100)).toBe(true);
        }
    });

    test('checks out the default branch of the remote, with no submodules and no shallow clone', async () => {
        const h = await start();
        const work = makeRepo(tempDir('git-clone'), 'work');
        const module = makeRepo(tempDir('git-clone'), 'module');

        git(work, 'branch', '-m', 'trunk');
        git(work, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', module, 'vendor');
        git(work, 'commit', '-q', '-m', 'Add a submodule');
        git(work, 'switch', '-q', '-c', 'feature');
        writeFileSync(join(work, 'feature.txt'), 'f');
        git(work, 'add', '.');
        git(work, 'commit', '-q', '-m', 'On a branch');
        git(work, 'switch', '-q', 'trunk');

        const path = join(tempDir('git-clone'), 'repo');

        expect(last(await clone(h, `file://${work}`, path)).type).toBe('result');
        expect(git(path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('trunk');
        expect(git(path, 'rev-parse', '--is-shallow-repository')).toBe('false');
        expect(git(path, 'rev-list', '--count', 'HEAD')).toBe('2');
        expect(readFileSync(join(path, '.gitmodules'), 'utf8')).toContain('vendor');
        expect(readdirSync(join(path, 'vendor'))).toEqual([]);
        expect(existsSync(join(path, '.git', 'modules'))).toBe(false);
    });

    test('refuses a path that exists and is not an empty folder with conflict, before git runs and touching nothing', async () => {
        const h = await start();
        const bare = origin();
        const dir = tempDir('git-clone');
        const full = join(dir, 'full');

        mkdirSync(full);
        writeFileSync(join(full, 'x.txt'), 'x');
        writeFileSync(join(dir, 'file.txt'), 'f');

        expect(await clone(h, bare, full)).toEqual([
            { type: 'error', status: 409, message: `${full} already exists and is not an empty folder` },
        ]);
        expect(await clone(h, bare, join(dir, 'file.txt'))).toEqual([
            { type: 'error', status: 409, message: `${join(dir, 'file.txt')} is a file` },
        ]);
        expect(await clone(h, bare, join(dir, 'file.txt', 'inside'))).toEqual([
            { type: 'error', status: 409, message: `A parent of ${join(dir, 'file.txt', 'inside')} is a file` },
        ]);
        expect(readdirSync(full)).toEqual(['x.txt']);
        expect(readFileSync(join(dir, 'file.txt'), 'utf8')).toBe('f');
    });

    test('refuses an address that starts with a dash, has a control character, is blank, is the ext transport or is not a full address, and a path that is not absolute', async () => {
        const h = await start();
        const dir = tempDir('git-clone');
        const marker = join(dir, 'marker');
        const refused = async (url: string, path = join(dir, 'x')) => {
            const events = await clone(h, url, path);

            expect(events).toHaveLength(1);
            expect(events[0]).toMatchObject({ type: 'error', status: 400 });
            expect(existsSync(path)).toBe(false);
        };

        await refused('--upload-pack=touch marker');
        await refused('-c core.sshCommand=touch');
        await refused('  -x');
        await refused('https://host/repo.git\n--upload-pack=x');
        await refused('https://host/\u0000repo.git');
        await refused('');
        await refused(' \t ');
        await refused(`ext::sh -c "touch ${marker}"`);
        await refused(`EXT::sh -c "touch ${marker}"`);
        await refused('owner/repo');
        await refused('./repo.git');
        await refused('https://host/repo.git', 'relative/path');
        await refused('https://host/repo.git', join(dir, 'with\nnewline'));

        expect(existsSync(marker)).toBe(false);
    });

    test('rejects a body that is not a url and a path', async () => {
        const h = await start();
        const post = (body: string) => h.fetch('/v1/git/clone', { method: 'POST', body });

        expect((await post('not json')).status).toBe(400);
        expect((await post(JSON.stringify({ url: 'x' }))).status).toBe(400);
        expect((await post(JSON.stringify({ url: 1, path: '/x' }))).status).toBe(400);
    });

    test("is git's first useful line when the repository is not there, and leaves no folder behind", async () => {
        const h = await start();
        const dir = tempDir('git-clone');
        const missing = join(dir, 'nope.git');
        const empty = join(dir, 'empty');

        mkdirSync(empty);

        for (const [url, path] of [
            [missing, join(dir, 'p', 'q', 'repo')],
            [`file://${missing}`, join(dir, 'viaurl')],
            [missing, empty],
        ] as const) {
            const events = await clone(h, url, path);

            expect(events).toHaveLength(1);
            expect(events[0]).toMatchObject({ type: 'error', status: 409 });
            expect((events[0] as { message: string }).message).toMatch(
                /^fatal: .*(does not exist|does not appear to be a git repository)/
            );
        }

        expect(readdirSync(dir).sort()).toEqual(['empty']);
        expect(readdirSync(empty)).toEqual([]);
    });

    test('refuses a second clone to a path that is being cloned into, or above or below it, and leaves the first one alone', async () => {
        const hold = slow();
        const h = await start(hold.env);
        const bare = origin();
        const dir = tempDir('git-clone');
        const path = join(dir, 'repo');
        const first = clone(h, `file://${bare}`, path);

        await waitFor(() => existsSync(hold.started), 'the first clone to reach the remote');

        for (const other of [path, join(path, 'inner'), dir]) {
            expect(await clone(h, `file://${bare}`, other)).toEqual([
                { type: 'error', status: 409, message: `${other} is already being cloned into` },
            ]);
        }

        hold.release();

        expect(last(await first)).toEqual({ type: 'result', path: realpathSync(path) });
        expect(git(path, 'rev-list', '--count', 'HEAD')).toBe('3');
        // The path is free again once the clone is over.
        expect(await clone(h, `file://${bare}`, path)).toEqual([
            { type: 'error', status: 409, message: `${path} already exists and is not an empty folder` },
        ]);
    });

    withScripts('while it is running', () => {
        /** Starts a clone that the remote holds, and gives back what stops it. */
        async function running(path: string, hold = slow()) {
            const h = await start(hold.env);
            const closing = new AbortController();
            const response = h.fetch('/v1/git/clone', {
                method: 'POST',
                body: JSON.stringify({ url: `file://${origin()}`, path }),
                signal: closing.signal,
            });

            // The answer starts with its first event, so a clone that is held has no response yet: whoever closes it or stops the daemon is not told of it.
            response.catch(() => undefined);

            await waitFor(() => existsSync(hold.started), 'the clone to reach the remote');
            await waitFor(() => existsSync(join(path, '.git')), 'git to have made the repository');

            return { h, hold, close: () => closing.abort(), response };
        }

        const goneWithGit = async (hold: ReturnType<typeof slow>) => {
            const pid = Number(readFileSync(hold.pid, 'utf8'));

            await waitFor(() => !alive(pid), 'the remote side of the clone to be gone');
        };

        test('closing the request kills git and takes away the folders the clone made, and nothing else', async () => {
            const dir = tempDir('git-clone');
            const made = join(dir, 'p1', 'p2', 'repo');
            const { hold, close, response } = await running(made);

            close();
            await response.catch(() => undefined);
            await goneWithGit(hold);
            await waitFor(() => !existsSync(join(dir, 'p1')), 'the folders the clone made to be taken away');

            expect(readdirSync(dir)).toEqual([]);
        });

        test('closing the request leaves the empty folder the person gave, empty', async () => {
            const dir = tempDir('git-clone');
            const given = join(dir, 'given');

            mkdirSync(given);

            const { hold, close, response } = await running(given);

            close();
            await response.catch(() => undefined);
            await goneWithGit(hold);
            await waitFor(() => readdirSync(given).length === 0, 'what the clone made in the folder to be taken away');

            expect(existsSync(given)).toBe(true);
        });

        test('the daemon stopping ends the clone and takes away what it made before it answers', async () => {
            const dir = tempDir('git-clone');
            const path = join(dir, 'p', 'repo');
            const { h, hold } = await running(path);

            await h.stop();
            await goneWithGit(hold);

            expect(readdirSync(dir)).toEqual([]);
        });

        test('a clone that goes on past the limit is stopped and taken away', async () => {
            const hold = slow();
            const dir = tempDir('git-clone');
            const path = join(dir, 'p', 'repo');
            const cloning = new GitClone({
                projectsDir: join(dir, 'projects'),
                environment: isolated(hold.env),
                timeoutMs: 600,
            });
            const failure = await cloning
                .clone({ url: `file://${origin()}`, path }, () => undefined, new AbortController().signal)
                .catch((error: unknown) => error);

            expect(failure).toBeInstanceOf(CommandError);
            expect(failure).toMatchObject({ code: 'unavailable', message: 'The clone did not finish in time' });
            await goneWithGit(hold);

            expect(readdirSync(dir)).toEqual([]);
        });
    });
});

withScripts('what git is run with', () => {
    /** A `git` on the path that writes down how it was run, then is the real one. */
    function recording(): { env: Record<string, string>; argv: () => string[][]; environments: () => string[] } {
        const dir = tempDir('git-clone-bin');
        const bin = join(dir, 'bin');
        const log = join(dir, 'argv.log');
        const envLog = join(dir, 'env.log');
        const real = Bun.which('git') as string;

        mkdirSync(bin);
        writeFileSync(
            join(bin, 'git'),
            [
                '#!/bin/sh',
                'if [ "$1" = "-c" ]; then',
                `  for argument in "$@"; do printf '%s\\n' "$argument" >> '${log}'; done`,
                `  printf -- '--end\\n' >> '${log}'`,
                `  env | grep -E '^(GIT_TERMINAL_PROMPT|LANGUAGE|CLOWDY_[A-Z]+)=' >> '${envLog}'`,
                'fi',
                `exec '${real}' "$@"`,
            ].join('\n')
        );
        chmodSync(join(bin, 'git'), 0o755);

        return {
            env: { PATH: `${bin}:${process.env.PATH}`, CLOWDY_TOKEN: 'must-not-reach-git' },
            argv: () =>
                existsSync(log)
                    ? readFileSync(log, 'utf8')
                          .split('--end\n')
                          .filter(Boolean)
                          .map(run => run.trimEnd().split('\n'))
                    : [],
            environments: () => (existsSync(envLog) ? readFileSync(envLog, 'utf8').trim().split('\n') : []),
        };
    }

    test('is the one command, with the address after `--`, no shell, no prompt for a password, no submodules and the ext transport off', async () => {
        const run = recording();
        const h = await start(run.env);
        const bare = origin();
        const dir = tempDir('git-clone');
        const path = join(dir, 'repo');

        expect(last(await clone(h, `  file://${bare}  `, path)).type).toBe('result');
        expect(run.argv()).toEqual([
            [
                '-c',
                'protocol.ext.allow=never',
                'clone',
                '--progress',
                '--no-recurse-submodules',
                '--',
                `file://${bare}`,
                path,
            ],
        ]);

        const environment = run.environments();

        expect(environment).toContain('GIT_TERMINAL_PROMPT=0');
        expect(environment).toContain('LANGUAGE=C');
        expect(environment.filter(line => line.startsWith('CLOWDY_'))).toEqual([]);
    });

    /** A `git` on the path that is not git: it runs `body`, with the path of the clone as `$dest`, and `started` written in `$dir`. */
    function standIn(body: string): { env: Record<string, string>; dir: string } {
        const dir = tempDir('git-clone-bin');
        const bin = join(dir, 'bin');

        mkdirSync(bin);
        writeFileSync(
            join(bin, 'git'),
            ['#!/bin/sh', 'for dest; do :; done', `dir='${dir}'`, 'touch "$dir/started"', body].join('\n')
        );
        chmodSync(join(bin, 'git'), 0o755);

        return { env: { PATH: `${bin}:${process.env.PATH}` }, dir };
    }

    test("never shows a credential of the address: not in a step, an error or a log, only git's line without it", async () => {
        const logged = spyOn(console, 'error').mockImplementation(() => undefined);
        const addresses: [string, string, string][] = [
            [
                'https://user:s3cr3tTOKEN@example.com/own/repo.git',
                "fatal: unable to access 'https://user:s3cr3tTOKEN@example.com/own/repo.git/': Could not resolve host",
                "fatal: unable to access 'https://example.com/own/repo.git/': Could not resolve host",
            ],
            // ssh prints the credential bare, as `user:token@host`, and percent-decoded.
            [
                'ssh://user:s3cr3tTOKEN@example.com/own/repo.git',
                'user:s3cr3tTOKEN@example.com: Permission denied (publickey).',
                'example.com: Permission denied (publickey).',
            ],
            [
                'ssh://user:p%40ss-s3cr3tTOKEN@example.com/own/repo.git',
                'user:p@ss-s3cr3tTOKEN@example.com: Permission denied (publickey).',
                'example.com: Permission denied (publickey).',
            ],
            [
                'https://s3cr3tTOKEN@example.com/own/repo.git',
                'remote: Invalid username or token for s3cr3tTOKEN',
                'remote: Invalid username or token for …',
            ],
        ];

        try {
            for (const [url, said, shown] of addresses) {
                const fake = standIn(
                    [
                        'echo "Cloning into \'$dest\'..." >&2',
                        'printf "Receiving objects:  10%% (1/10)\\r" >&2',
                        `printf '%s\\n' "$SAID" >&2`,
                        'exit 128',
                    ].join('\n')
                );
                const h = await start({ ...fake.env, SAID: said });
                const dir = tempDir('git-clone');
                const response = await h.fetch('/v1/git/clone', {
                    method: 'POST',
                    body: JSON.stringify({ url, path: join(dir, 'repo') }),
                });
                const text = await response.text();

                expect(text).not.toContain('s3cr3tTOKEN');
                expect(eventsOf(text)).toEqual([
                    { type: 'progress', label: 'Receiving objects', percent: 10 },
                    { type: 'error', status: 409, message: shown },
                ]);
                expect(await target(h, url, dir)).toEqual({ folder: dir, path: dir });
                expect(readdirSync(dir)).toEqual([]);
            }

            expect(JSON.stringify(logged.mock.calls)).not.toContain('s3cr3tTOKEN');
        } finally {
            logged.mockRestore();
        }
    });

    describe('what a git that was killed leaves', () => {
        /** Cancels a clone whose `git` has made `.git` and a file, and does not take them away when it is stopped. */
        async function cancelled(body: string, path: string, beforeCancel?: () => void) {
            const fake = standIn(body);
            const h = await start(fake.env);
            const closing = new AbortController();
            const response = h.fetch('/v1/git/clone', {
                method: 'POST',
                body: JSON.stringify({ url: 'https://example.com/own/repo.git', path }),
                signal: closing.signal,
            });

            response.catch(() => undefined);
            await waitFor(() => existsSync(join(fake.dir, 'started')), 'the stand-in git to start');
            await waitFor(() => existsSync(join(fake.dir, 'ready')), 'the stand-in git to make its files');
            beforeCancel?.();
            closing.abort();
            await Bun.sleep(1500);
        }

        const leaves =
            'mkdir -p "$dest/.git" "$dest/src"; echo x > "$dest/src/file.txt"; touch "$dir/ready"\n' +
            "trap 'exit 143' TERM\nwhile :; do sleep 0.05; done";

        test('is taken away, with the folders the clone made', async () => {
            const dir = tempDir('git-clone');

            await cancelled(leaves, join(dir, 'p', 'repo'));

            expect(readdirSync(dir)).toEqual([]);
        });

        test('is taken away from the empty folder the person gave, which stays', async () => {
            const dir = tempDir('git-clone');
            const given = join(dir, 'given');

            mkdirSync(given);
            await cancelled(leaves, given);

            expect(readdirSync(given)).toEqual([]);
        });

        test('leaves what somebody else put in the empty folder, when git left nothing of its own', async () => {
            const dir = tempDir('git-clone');
            const given = join(dir, 'given');

            mkdirSync(given);
            await cancelled('touch "$dir/ready"\ntrap \'exit 143\' TERM\nwhile :; do sleep 0.05; done', given, () =>
                writeFileSync(join(given, 'notes.md'), 'mine')
            );

            expect(readdirSync(given)).toEqual(['notes.md']);
        });
    });

    test('says git is missing when it cannot be started, and leaves no folder', async () => {
        const h = await start({ PATH: tempDir('git-clone-empty-path') });
        const dir = tempDir('git-clone');

        expect(await clone(h, 'https://example.com/own/repo.git', join(dir, 'repo'))).toEqual([
            { type: 'error', status: 503, message: 'git is not installed or not on PATH' },
        ]);
        expect(readdirSync(dir)).toEqual([]);
    });
});

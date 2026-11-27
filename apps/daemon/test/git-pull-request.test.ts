import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { openDatabase } from '../src/db/connection';
import { CommandError } from '../src/errors';
import { parseRemote } from '../src/git/githubRemote';
import { PullRequests } from '../src/git/pullRequest';
import { rollupChecks } from '../src/git/pullRequestRollup';
import { Store } from '../src/store';
import { cleanTempDirs, git, makeRepo, startHarness, tempDir } from './helpers';

import type {
    GitBranchPullRequests,
    GitChecks,
    GitHubRepo,
    GitPullRequest,
    GitPullRequestInfo,
    GitStatus,
} from '@clowdy/protocol';
import type { Place } from '../src/domain/places';
import type { Harness } from './helpers';

afterAll(cleanTempDirs);

const posix = process.platform !== 'win32';
/** The stand-in `gh` is a POSIX shell script: on Windows these cases are skipped, not run against another program. */
const withStandIn = posix ? describe : describe.skip;

describe('parseRemote', () => {
    const repo = (host: string, owner = 'acme', name = 'app'): GitHubRepo => ({ host, owner, name });

    test('reads the host, the owner and the name of every form of address', () => {
        expect(parseRemote('https://github.com/acme/app.git')).toEqual(repo('github.com'));
        expect(parseRemote('https://github.com/acme/app')).toEqual(repo('github.com'));
        expect(parseRemote('https://github.com/acme/app/')).toEqual(repo('github.com'));
        expect(parseRemote('git@github.com:acme/app.git')).toEqual(repo('github.com'));
        expect(parseRemote('github.com:acme/app')).toEqual(repo('github.com'));
        expect(parseRemote('ssh://git@github.com/acme/app.git')).toEqual(repo('github.com'));
        expect(parseRemote('ssh://git@git.example.com:2222/acme/app.git')).toEqual(repo('git.example.com'));
        expect(parseRemote('git://github.com/acme/app.git')).toEqual(repo('github.com'));
        expect(parseRemote('  https://GitHub.com/Acme/my.app.git\n')).toEqual(repo('github.com', 'Acme', 'my.app'));
        expect(parseRemote('git@ghe.corp.example:team/service-api.git')).toEqual(
            repo('ghe.corp.example', 'team', 'service-api')
        );
    });

    test("keeps the port of a web address, which is the server's, and drops the port of ssh", () => {
        expect(parseRemote('https://ghe.example.com:8443/acme/app.git')).toEqual(repo('ghe.example.com:8443'));
        expect(parseRemote('ssh://git@ghe.example.com:22/acme/app.git')).toEqual(repo('ghe.example.com'));
    });

    test('takes the ssh over port 443 name of GitHub for GitHub', () => {
        expect(parseRemote('ssh://git@ssh.github.com:443/acme/app.git')).toEqual(repo('github.com'));
    });

    test('leaves out a credential, whatever form it has', () => {
        for (const address of [
            'https://user:s3cret@github.com/acme/app.git',
            'https://s3cret@github.com/acme/app.git',
            'https://x-access-token:ghp_s3cret@github.com/acme/app',
            'ssh://user:s3cret@github.com/acme/app.git',
        ]) {
            const parsed = parseRemote(address);

            expect(parsed).toEqual(repo('github.com'));
            expect(JSON.stringify(parsed)).not.toContain('s3cret');
        }
    });

    test('says nothing of an address that is not host/owner/repo', () => {
        for (const address of [
            '',
            '   ',
            '/srv/git/app.git',
            '../app',
            'app',
            'C:\\work\\app',
            'C:/work/app',
            'file:///srv/git/app.git',
            'ftp://github.com/acme/app.git',
            'https://github.com/acme',
            'https://github.com/acme/app/extra',
            'https://github.com/',
            'https://github.com',
            'git@github.com:acme',
            'git@github.com:/acme/app.git',
            'https://github.com/acme/app.git?x=1',
            'https://-evil.example/acme/app',
            'https://github.com/../app',
            'https://github.com/acme/ app',
            'https://[::1]/acme/app',
        ]) {
            expect(parseRemote(address)).toBeUndefined();
        }
    });
});

describe('rollupChecks', () => {
    const run = (name: string, status: string, conclusion: string | null, startedAt?: string) => ({
        __typename: 'CheckRun',
        name,
        status,
        conclusion,
        startedAt: startedAt ?? null,
    });
    const context = (name: string, state: string, createdAt?: string) => ({
        __typename: 'StatusContext',
        context: name,
        state,
        createdAt: createdAt ?? null,
    });

    test('counts each check by how it ended', () => {
        const checks = rollupChecks([
            run('lint', 'COMPLETED', 'SUCCESS'),
            run('typecheck', 'COMPLETED', 'NEUTRAL'),
            run('e2e', 'IN_PROGRESS', null),
            run('deploy', 'QUEUED', null),
            run('docs', 'COMPLETED', 'SKIPPED'),
            run('unit', 'COMPLETED', 'FAILURE'),
            run('build', 'COMPLETED', 'TIMED_OUT'),
            run('approve', 'COMPLETED', 'ACTION_REQUIRED'),
            run('odd', 'COMPLETED', null),
            context('coverage', 'SUCCESS'),
            context('legacy', 'ERROR'),
            context('required', 'EXPECTED'),
        ]);

        expect(checks).toMatchObject({ state: 'failing', passing: 3, failing: 4, pending: 4, skipped: 1 });
        expect(checks.truncated).toBeUndefined();
    });

    test('adds up to pending when nothing failed and something is not done, passing when all are, and none when no check ran', () => {
        expect(rollupChecks([run('a', 'COMPLETED', 'SUCCESS'), run('b', 'QUEUED', null)]).state).toBe('pending');
        expect(rollupChecks([run('a', 'COMPLETED', 'SUCCESS'), run('b', 'COMPLETED', 'SKIPPED')]).state).toBe(
            'passing'
        );
        expect(rollupChecks([run('a', 'COMPLETED', 'SKIPPED')]).state).toBe('passing');
        expect(rollupChecks([])).toEqual({ state: 'none', passing: 0, failing: 0, pending: 0, skipped: 0 });
    });

    test('keeps the run that began last of a name, a commit status by its context, and the later in the list when neither has a time', () => {
        const checks = rollupChecks([
            run('build', 'COMPLETED', 'FAILURE', '2026-11-20T10:00:00Z'),
            run('build', 'COMPLETED', 'SUCCESS', '2026-11-20T10:05:00Z'),
            run('build', 'COMPLETED', 'FAILURE', '2026-11-20T09:00:00Z'),
            context('ci/old', 'FAILURE', '2026-11-20T10:00:00Z'),
            context('ci/old', 'SUCCESS', '2026-11-20T11:00:00Z'),
            run('plain', 'COMPLETED', 'FAILURE'),
            run('plain', 'COMPLETED', 'SUCCESS'),
        ]);

        expect(checks).toEqual({ state: 'passing', passing: 3, failing: 0, pending: 0, skipped: 0 });
    });

    test('ignores a node it cannot read, and a check with no name', () => {
        const checks = rollupChecks([
            null,
            'text',
            4,
            {},
            { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' },
            run('ok', 'COMPLETED', 'SUCCESS'),
        ]);

        expect(checks).toEqual({ state: 'passing', passing: 1, failing: 0, pending: 0, skipped: 0 });
    });

    test("takes the worse of its own state and GitHub's when GitHub has more checks than were read", () => {
        const page = [run('a', 'COMPLETED', 'SUCCESS'), run('b', 'COMPLETED', 'SUCCESS')];

        expect(rollupChecks(page, { more: true, state: 'FAILURE' })).toMatchObject({
            state: 'failing',
            truncated: true,
            passing: 2,
        });
        expect(rollupChecks(page, { more: true, state: 'PENDING' }).state).toBe('pending');
        expect(rollupChecks(page, { more: true, state: 'SUCCESS' }).state).toBe('passing');
        expect(rollupChecks([run('a', 'COMPLETED', 'FAILURE')], { more: true, state: 'SUCCESS' }).state).toBe(
            'failing'
        );
        // Without more checks than were read, GitHub's own total is not asked.
        expect(rollupChecks(page, { more: false, state: 'FAILURE' }).state).toBe('passing');
    });
});

/** What a stand-in `gh` answers to one branch: the JSON GitHub would send, what `gh` would say on its error stream, and its exit code. */
interface Reply {
    body?: unknown;
    stderr?: string;
    code?: number;
}

/** A shell word for `text`, which no character of it can end. */
const quoted = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

/**
 * A `gh` that is a shell script: it answers by its arguments, with nothing of GitHub behind it, using nothing but the shell's own commands (so a `PATH` that has only its
 * folder is enough), and writes each call it gets (its arguments, one to a line, a `---` after them) to a log. `gh --version` works, `gh auth status` works unless the folder
 * holds `signed-out` (and, as `gh` does, fails without `--active` when it holds `stale-second`, and does not know `--active` when it holds `old-gh`), and `gh api graphql`
 * answers with what `reply` set for the branch in `-f head=<branch>`.
 */
class StandIn {
    readonly root = tempDir('gh-stand-in');
    readonly bin = join(this.root, 'bin');
    readonly log = join(this.root, 'calls.log');
    readonly #replies = new Map<string, Reply>();

    constructor() {
        mkdirSync(this.bin);

        const script = `#!/bin/sh
state=\${0%/*}/..
{ for arg in "$@"; do printf '%s\\n' "$arg"; done; echo '---'; } >> "$state/calls.log"
case "$1" in
    --version) echo 'gh version 0.0.0 (stand-in)'; exit 0 ;;
    auth)
        active=''
        for arg in "$@"; do if [ "$arg" = '--active' ]; then active=yes; fi; done
        if [ -f "$state/old-gh" ] && [ -n "$active" ]; then echo 'unknown flag: --active' >&2; exit 1; fi
        if [ -f "$state/stale-second" ] && [ -z "$active" ]; then echo 'X Failed to log in to github.com account second (keyring)' >&2; exit 1; fi
        if [ -f "$state/signed-out" ]; then echo 'You are not logged into any GitHub hosts. To log in, run: gh auth login' >&2; exit 1; fi
        echo 'Logged in (stand-in)'; exit 0 ;;
    api)
        head=''
        cursor=''
        for arg in "$@"; do case "$arg" in head=*) head=\${arg#head=} ;; cursor=*) cursor=\${arg#cursor=} ;; esac; done
        case "$*" in
            *mergeStateStatus*) if [ -f "$state/old-server" ]; then printf '%s' '{"errors":[{"type":"undefinedField","message":"Field '"'"'mergeStateStatus'"'"' doesn'"'"'t exist on type '"'"'PullRequest'"'"'","extensions":{"code":"undefinedField","typeName":"PullRequest","fieldName":"mergeStateStatus"}}]}'; exit 1; fi ;;
        esac
        . "$state/answers.sh"
        exit 0 ;;
esac
exit 64
`;

        writeFileSync(join(this.bin, 'gh'), script);
        chmodSync(join(this.bin, 'gh'), 0o755);
        this.#writeAnswers();
    }

    /** The environment that finds this `gh`, and nothing else. */
    env = (): Record<string, string> => ({ PATH: this.bin });

    /** What the stand-in answers when asked for `branch`. */
    reply(branch: string, reply: Reply, cursor = ''): void {
        this.#replies.set(`${branch}:${cursor}`, reply);
        this.#writeAnswers();
    }

    /** `answers.sh`: a `case` over the branch that prints what `reply` set, and exits with its code. */
    #writeAnswers(): void {
        const cases = [...this.#replies].map(([branch, { body, stderr, code }]) => {
            const say = stderr ? `printf '%s\\n' ${quoted(stderr)} >&2; ` : '';
            const print = body === undefined ? '' : `printf '%s' ${quoted(JSON.stringify(body))}; `;

            return `    ${quoted(branch)}) ${say}${print}exit ${code ?? 0} ;;`;
        });

        writeFileSync(join(this.root, 'answers.sh'), `case "$head:$cursor" in\n${cases.join('\n')}\nesac\n`);
    }

    signOut(): void {
        writeFileSync(join(this.root, 'signed-out'), '');
    }

    signIn(): void {
        rmSync(join(this.root, 'signed-out'), { force: true });
    }

    /** A second account of the host whose token is bad, which fails `gh auth status` for the host unless it is asked of the active account alone. */
    staleSecondAccount(): void {
        writeFileSync(join(this.root, 'stale-second'), '');
    }

    /** A `gh` too old to have `auth status --active`. */
    oldGh(): void {
        writeFileSync(join(this.root, 'old-gh'), '');
    }

    /** A server of an older version, which does not have `mergeStateStatus`. */
    oldServer(): void {
        writeFileSync(join(this.root, 'old-server'), '');
    }

    /** The calls so far: the arguments of each. */
    calls(): string[][] {
        if (!existsSync(this.log)) return [];

        return readFileSync(this.log, 'utf8')
            .split('---\n')
            .filter(call => call !== '')
            .map(call => call.replace(/\n$/, '').split('\n'));
    }

    /** The calls that read pull requests, as the branch each asked for. */
    reads(): string[] {
        return this.calls()
            .filter(call => call[0] === 'api' && call[1] === 'graphql')
            .map(call => call.find(arg => arg.startsWith('head='))!.slice('head='.length));
    }

    /** The whole log, for a test that looks for what must not be in it. */
    text(): string {
        return existsSync(this.log) ? readFileSync(this.log, 'utf8') : '';
    }
}

/** A pull request as GitHub's GraphQL answers it. */
function node(
    fields: Record<string, unknown> = {},
    contexts: unknown[] = [],
    rollupState: string | null = 'SUCCESS',
    hasNextPage = false
): Record<string, unknown> {
    return {
        number: 7,
        title: 'Add the weekend rate',
        state: 'OPEN',
        url: 'https://github.com/acme/app/pull/7',
        isDraft: false,
        baseRefName: 'main',
        headRefName: 'feature',
        headRefOid: '0'.repeat(40),
        updatedAt: '2026-11-20T10:00:00Z',
        isCrossRepository: false,
        headRepositoryOwner: { login: 'acme' },
        reviewDecision: null,
        mergeStateStatus: 'CLEAN',
        mergeable: 'MERGEABLE',
        commits: {
            nodes: [
                {
                    commit: {
                        statusCheckRollup:
                            rollupState === null
                                ? null
                                : { state: rollupState, contexts: { nodes: contexts, pageInfo: { hasNextPage } } },
                    },
                },
            ],
        },
        ...fields,
    };
}

/** What GitHub's GraphQL answers to the read of a branch. */
const graphql = (nodes: unknown[], defaultBranch = 'main') => ({
    data: { repository: { defaultBranchRef: { name: defaultBranch }, pullRequests: { nodes } } },
});

const historyPage = (nodes: unknown[], endCursor?: string) => ({
    data: {
        repository: {
            pullRequests: { nodes, pageInfo: { hasNextPage: endCursor !== undefined, endCursor } },
        },
    },
});

/** GitHub's lightweight history node. History asks for the head commit, and not for checks or mergeability. */
const historyNode = (number: number, state = 'OPEN', extra: Record<string, unknown> = {}) => ({
    number,
    title: `Pull request ${number}`,
    state,
    url: `https://github.com/acme/app/pull/${number}`,
    isDraft: false,
    baseRefName: 'main',
    headRefName: 'feature',
    updatedAt: '2026-11-20T10:00:00Z',
    isCrossRepository: false,
    headRepositoryOwner: { login: 'acme' },
    ...extra,
});

const checkRun = (name: string, status: string, conclusion: string | null) => ({
    __typename: 'CheckRun',
    name,
    status,
    conclusion,
    startedAt: '2026-11-20T10:00:00Z',
});

/** A place at a checkout, as `resolvePlace` makes one for a folder. */
const placeAt = (path: string): Place => ({ folder: { id: 'fld_test', path }, path });

/** A repository on the branch `feature`, one commit past `main`, whose `origin` is at `address` (none when it is `null`). */
function repoOn(address: string | null = 'https://github.com/acme/app.git'): {
    path: string;
    place: Place;
    main: string;
    head: string;
} {
    const path = makeRepo(tempDir('git-pull-request'), 'app');
    const main = git(path, 'rev-parse', 'HEAD');

    git(path, 'checkout', '-q', '-b', 'feature');
    writeFileSync(join(path, 'feature.txt'), 'one\n');
    git(path, 'add', '.');
    git(path, 'commit', '-q', '-m', 'Feature work');

    if (address !== null) git(path, 'remote', 'add', 'origin', address);

    return { path, place: placeAt(path), main, head: git(path, 'rev-parse', 'HEAD') };
}

/** Adds a commit on the branch that is checked out. */
function commitMore(path: string, name = 'more.txt'): string {
    writeFileSync(join(path, name), 'more\n');
    git(path, 'add', '.');
    git(path, 'commit', '-q', '-m', `Add ${name}`);

    return git(path, 'rev-parse', 'HEAD');
}

/** Runs `action` with a `git` on the daemon's `PATH` that dies without an answer when it is asked for a commit (`<ref>^{commit}`), as one killed for the time does. */
async function withGitSilentOnCommits<T>(action: () => Promise<T>): Promise<T> {
    const bin = tempDir('git-silent');
    const path = process.env.PATH;

    writeFileSync(
        join(bin, 'git'),
        `#!/bin/sh\ncase "$*" in *'^{commit}'*) kill -9 $$ ;; esac\nexec ${Bun.which('git')} "$@"\n`
    );
    chmodSync(join(bin, 'git'), 0o755);
    process.env.PATH = `${bin}:${path}`;

    try {
        return await action();
    } finally {
        process.env.PATH = path;
    }
}

/** What a read of a place that is a repository answers: the answer is checked to be one. */
function ready(info: GitPullRequestInfo): Extract<GitPullRequestInfo, { isRepository: true }> {
    if (!info.isRepository) throw new Error('The place is not a repository');

    return info;
}

withStandIn('PullRequests', () => {
    let gh: StandIn;
    let now: number;
    let pullRequests: PullRequests;

    beforeEach(() => {
        gh = new StandIn();
        now = 1_000_000;
        pullRequests = new PullRequests({ env: gh.env, fallbackPaths: [], now: () => now });
    });

    afterEach(() => {
        pullRequests.stop();
    });

    /** Reads the place and gives back what it says of its pull request. */
    async function pullRequestOf(place: Place): Promise<GitPullRequest | undefined> {
        return ready(await pullRequests.read(place)).pullRequest;
    }

    describe('access', () => {
        test('says gh is not installed when no gh is on the path or in the usual places, and asks nothing', async () => {
            const { place } = repoOn();
            const none = new PullRequests({
                env: () => ({ PATH: tempDir('empty-path') }),
                fallbackPaths: [],
                now: () => now,
            });

            expect(await none.read(place)).toEqual({
                isRepository: true,
                access: 'no_gh',
                repo: { host: 'github.com', owner: 'acme', name: 'app' },
            });
            expect(gh.calls()).toEqual([]);
        });

        test('looks in the usual places after the path, and finds a gh there', async () => {
            const { place } = repoOn();
            const elsewhere = new PullRequests({
                env: () => ({ PATH: tempDir('empty-path') }),
                fallbackPaths: [join(tempDir('missing'), 'gh'), join(gh.bin, 'gh')],
                now: () => now,
            });

            gh.reply('feature', { body: graphql([]) });

            expect(await elsewhere.read(place)).toMatchObject({ isRepository: true, access: 'ready' });
        });

        test('says a gh that cannot be run is not installed', async () => {
            const { place } = repoOn();
            const broken = join(tempDir('broken-gh'), 'gh');

            writeFileSync(broken, '#!/bin/sh\nexit 3\n');
            chmodSync(broken, 0o755);

            const none = new PullRequests({ env: () => ({ PATH: '' }), fallbackPaths: [broken], now: () => now });

            expect(ready(await none.read(place)).access).toBe('no_gh');
        });

        test('says gh is not signed in for the host by the exit code of auth status, and names the host', async () => {
            const { place } = repoOn('git@ghe.example.com:team/app.git');

            gh.signOut();

            expect(await pullRequests.read(place)).toEqual({
                isRepository: true,
                access: 'not_signed_in',
                repo: { host: 'ghe.example.com', owner: 'team', name: 'app' },
            });
            expect(gh.calls()).toEqual([
                ['--version'],
                ['auth', 'status', '--hostname', 'ghe.example.com', '--active'],
            ]);
        });

        test('asks about the active account alone, so a second account of the host with a bad token does not sign the person out', async () => {
            const { place } = repoOn();

            gh.staleSecondAccount();
            gh.reply('feature', { body: graphql([node()]) });

            expect((await pullRequestOf(place))?.number).toBe(7);
        });

        test('asks again without the flag of a gh that does not have it, and keeps the answer of that', async () => {
            const { place } = repoOn();

            gh.oldGh();
            gh.reply('feature', { body: graphql([node()]) });

            expect((await pullRequestOf(place))?.number).toBe(7);
            expect(gh.calls().filter(call => call[0] === 'auth')).toEqual([
                ['auth', 'status', '--hostname', 'github.com', '--active'],
                ['auth', 'status', '--hostname', 'github.com'],
            ]);

            gh.signOut();
            now += 20_000;
            expect(ready(await pullRequests.read(place)).access).toBe('ready');
            expect(gh.calls().filter(call => call[0] === 'auth')).toHaveLength(2);

            now += 60_000;
            expect(ready(await pullRequests.read(place)).access).toBe('not_signed_in');
        });

        test('says there is no remote for a repository with no origin, and runs no gh', async () => {
            const { place } = repoOn(null);

            expect(await pullRequests.read(place)).toEqual({ isRepository: true, access: 'no_remote' });
            expect(gh.calls()).toEqual([]);
        });

        test('says there is no remote for an origin that is not host/owner/repo, a remote of another name does not count', async () => {
            const local = repoOn('/srv/git/app.git');
            const other = repoOn(null);

            git(other.path, 'remote', 'add', 'upstream', 'https://github.com/acme/app.git');

            expect(await pullRequests.read(local.place)).toEqual({ isRepository: true, access: 'no_remote' });
            expect(await pullRequests.read(other.place)).toEqual({ isRepository: true, access: 'no_remote' });
            expect(gh.calls()).toEqual([]);
        });

        test('says a folder that is not a repository is none', async () => {
            expect(await pullRequests.read(placeAt(tempDir('plain')))).toEqual({ isRepository: false });
            expect(gh.calls()).toEqual([]);
        });

        test('keeps what it found of gh and of the login for a minute, a no for a few seconds, and asks again after', async () => {
            const { place } = repoOn();

            gh.reply('feature', { body: graphql([]) });
            gh.signOut();

            expect(ready(await pullRequests.read(place)).access).toBe('not_signed_in');
            gh.signIn();
            now += 3000;
            expect(ready(await pullRequests.read(place)).access).toBe('not_signed_in');
            expect(gh.calls().filter(call => call[0] === 'auth')).toHaveLength(1);

            now += 3000;
            expect(ready(await pullRequests.read(place)).access).toBe('ready');
            expect(gh.calls().filter(call => call[0] === 'auth')).toHaveLength(2);

            // A yes holds for a minute: another branch of the repository, which has no answer of its own yet, does not ask again.
            git(place.path, 'checkout', '-q', '-b', 'second');
            gh.reply('second', { body: graphql([]) });
            now += 30_000;
            expect(ready(await pullRequests.read(place)).access).toBe('ready');
            expect(gh.calls().filter(call => call[0] === 'auth')).toHaveLength(2);
            expect(gh.calls().filter(call => call[0] === '--version')).toHaveLength(1);

            now += 31_000;
            git(place.path, 'checkout', '-q', 'feature');
            expect(ready(await pullRequests.read(place)).access).toBe('ready');
            expect(gh.calls().filter(call => call[0] === 'auth')).toHaveLength(3);
            expect(gh.calls().filter(call => call[0] === '--version')).toHaveLength(2);
        });

        test('asks again for the login after a read that says it is no good, and says so at once', async () => {
            const { place } = repoOn();

            gh.reply('feature', { stderr: 'To get started with GitHub CLI, please run:  gh auth login', code: 4 });

            expect(await pullRequests.read(place)).toEqual({
                isRepository: true,
                access: 'not_signed_in',
                repo: { host: 'github.com', owner: 'acme', name: 'app' },
            });
            expect(gh.calls().filter(call => call[0] === 'auth')).toHaveLength(1);

            // The answer was not kept, and neither was the login: both are asked for again.
            gh.reply('feature', { body: graphql([node()]) });
            expect((await pullRequestOf(place))?.number).toBe(7);
            expect(gh.calls().filter(call => call[0] === 'auth')).toHaveLength(2);
        });

        test('takes a rejected token from the server (HTTP 401) as a login that is no good', async () => {
            const { place } = repoOn();

            gh.reply('feature', {
                body: { message: 'Bad credentials', status: '401' },
                stderr: 'gh: Bad credentials (HTTP 401)',
                code: 1,
            });

            expect(ready(await pullRequests.read(place)).access).toBe('not_signed_in');
        });

        test("passes the daemon's environment to gh and adds nothing to it", async () => {
            const { place } = repoOn();
            const seen = join(gh.root, 'env.txt');
            const real = join(gh.bin, 'gh');

            writeFileSync(real, `#!/bin/sh\nenv > '${seen}'\nexit 0\n`);

            const own = new PullRequests({
                env: () => ({ PATH: `${gh.bin}:/usr/bin:/bin`, GH_TOKEN: 'tok-from-the-daemon', MARKER: 'yes' }),
                fallbackPaths: [],
                now: () => now,
            });

            // The stand-in prints nothing of a pull request this time: the read fails, which is not what is looked at.
            await own.read(place).catch(() => undefined);

            const environment = readFileSync(seen, 'utf8');

            expect(environment).toContain('MARKER=yes');
            expect(environment).toContain('GH_TOKEN=tok-from-the-daemon');
            expect(environment).not.toContain('GH_HOST');
            expect(environment).not.toContain('GH_REPO');
            expect(environment).not.toContain('GITHUB_TOKEN');
        });
    });

    describe('the read', () => {
        test('asks gh once for the branch with the repository and the branch as variables, nothing in a shell', async () => {
            const { place } = repoOn('https://github.com/acme/app.git');

            gh.reply('feature', { body: graphql([]) });
            await pullRequests.read(place);

            const [call] = gh.calls().filter(args => args[0] === 'api');

            expect(call).toEqual([
                'api',
                'graphql',
                '--hostname',
                'github.com',
                '--method',
                'POST',
                '-f',
                expect.stringMatching(
                    /^query=query\(\$owner: String!, \$name: String!, \$head: String!\) \{ repository\(owner: \$owner, name: \$name\)/
                ),
                '-f',
                'owner=acme',
                '-f',
                'name=app',
                '-f',
                'head=feature',
            ]);
            expect(call![7]).toContain(
                'pullRequests(headRefName: $head, first: 20, orderBy: { field: CREATED_AT, direction: DESC })'
            );
            expect(call![7]).toContain('statusCheckRollup { state contexts(first: 100)');
            expect(call![7]).not.toMatch(/detailsUrl|targetUrl/);
        });

        test('answers an open pull request with the CI summary', async () => {
            const { place, head } = repoOn();

            gh.reply('feature', {
                body: graphql([
                    node(
                        { headRefOid: head, reviewDecision: 'REVIEW_REQUIRED', mergeStateStatus: 'BLOCKED' },
                        [
                            checkRun('lint', 'COMPLETED', 'SUCCESS'),
                            checkRun('unit', 'COMPLETED', 'FAILURE'),
                            checkRun('e2e', 'IN_PROGRESS', null),
                            {
                                __typename: 'StatusContext',
                                context: 'ci/legacy',
                                state: 'SUCCESS',
                                createdAt: '2026-11-20T10:00:00Z',
                            },
                        ],
                        'FAILURE'
                    ),
                ]),
            });

            const info = ready(await pullRequests.read(place));

            expect(info).toEqual({
                isRepository: true,
                access: 'ready',
                repo: { host: 'github.com', owner: 'acme', name: 'app' },
                pullRequest: {
                    number: 7,
                    title: 'Add the weekend rate',
                    url: 'https://github.com/acme/app/pull/7',
                    state: 'open',
                    base: 'main',
                    head: 'feature',
                    headCommit: head,
                    updatedAt: Date.parse('2026-11-20T10:00:00Z'),
                    reviewDecision: 'review_required',
                    mergeability: 'blocked',
                    checks: {
                        state: 'failing',
                        passing: 2,
                        failing: 1,
                        pending: 1,
                        skipped: 0,
                    },
                },
            });
        });

        test('answers a draft, and an open pull request that GitHub has not yet worked out or that conflicts', async () => {
            const { place } = repoOn();

            gh.reply('feature', { body: graphql([node({ isDraft: true, mergeStateStatus: 'DRAFT' })]) });
            expect(await pullRequestOf(place)).toMatchObject({ state: 'draft', checks: { state: 'none' } });
            expect((await pullRequestOf(place))?.mergeability).toBeUndefined();

            now += 20_000;
            gh.reply('feature', {
                body: graphql([node({ isDraft: true, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' })]),
            });
            expect(await pullRequestOf(place)).toMatchObject({ state: 'draft', mergeability: 'conflicts' });

            now += 20_000;
            gh.reply('feature', {
                body: graphql(
                    [node({ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN', reviewDecision: 'APPROVED' })],
                    'main'
                ),
            });
            expect(await pullRequestOf(place)).toMatchObject({ state: 'open', reviewDecision: 'approved' });
            expect((await pullRequestOf(place))?.mergeability).toBeUndefined();

            now += 20_000;
            gh.reply('feature', {
                body: graphql([
                    node({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', reviewDecision: 'CHANGES_REQUESTED' }),
                ]),
            });
            expect(await pullRequestOf(place)).toMatchObject({
                state: 'open',
                mergeability: 'conflicts',
                reviewDecision: 'changes_requested',
            });

            now += 20_000;
            gh.reply('feature', { body: graphql([node({ mergeStateStatus: 'CLEAN' })]) });
            expect(await pullRequestOf(place)).toMatchObject({ mergeability: 'mergeable' });
        });

        test('answers a pull request with no check, and one whose commit has no rollup', async () => {
            const { place } = repoOn();

            gh.reply('feature', { body: graphql([node({}, [], null)]) });

            expect((await pullRequestOf(place))?.checks).toEqual({
                state: 'none',
                passing: 0,
                failing: 0,
                pending: 0,
                skipped: 0,
            });
        });

        test('says a branch with no pull request is ready, with none', async () => {
            const { place } = repoOn();

            gh.reply('feature', { body: graphql([]) });

            expect(await pullRequests.read(place)).toEqual({
                isRepository: true,
                access: 'ready',
                repo: { host: 'github.com', owner: 'acme', name: 'app' },
            });
        });

        test('keeps a merged pull request when the branch has nothing new, and drops it once HEAD has moved past it', async () => {
            const { place, path, head } = repoOn();

            gh.reply('feature', { body: graphql([node({ state: 'MERGED', headRefOid: head })]) });

            expect(await pullRequestOf(place)).toMatchObject({ number: 7, state: 'merged' });
            expect((await pullRequestOf(place))?.mergeability).toBeUndefined();

            // New work on the branch: the merged pull request is about what was there, and the branch has none.
            commitMore(path);
            expect(await pullRequests.read(place)).toEqual({
                isRepository: true,
                access: 'ready',
                repo: { host: 'github.com', owner: 'acme', name: 'app' },
            });
        });

        test('picks up a new open pull request on a branch whose old one merged', async () => {
            const { place, path, head } = repoOn();

            gh.reply('feature', { body: graphql([node({ state: 'MERGED', headRefOid: head })]) });
            expect(await pullRequestOf(place)).toMatchObject({ number: 7, state: 'merged' });

            const next = commitMore(path);

            gh.reply('feature', {
                body: graphql([
                    node({ number: 9, url: 'https://github.com/acme/app/pull/9', headRefOid: next }),
                    node({ state: 'MERGED', headRefOid: head }),
                ]),
            });
            expect(await pullRequestOf(place)).toMatchObject({ number: 9, state: 'open', headCommit: next });
        });

        test('keeps a closed pull request as it keeps a merged one, and drops it the same way', async () => {
            const { place, path, head } = repoOn();

            gh.reply('feature', { body: graphql([node({ state: 'CLOSED', headRefOid: head })]) });
            expect(await pullRequestOf(place)).toMatchObject({ number: 7, state: 'closed' });

            commitMore(path);
            expect(await pullRequestOf(place)).toBeUndefined();
        });

        test('keeps a merged pull request that is ahead of HEAD, or whose commit the repository does not have', async () => {
            const { place, path, head } = repoOn();
            const ahead = commitMore(path);

            git(path, 'reset', '-q', '--hard', head);

            // The pull request's branch has a commit more than the place (someone pushed): HEAD is among its commits.
            gh.reply('feature', { body: graphql([node({ state: 'MERGED', headRefOid: ahead })]) });
            expect(await pullRequestOf(place)).toMatchObject({ state: 'merged' });

            // The place has never fetched what the pull request's branch is at: it cannot say, and keeps it.
            now += 20_000;
            gh.reply('feature', { body: graphql([node({ state: 'MERGED', headRefOid: 'a'.repeat(40) })]) });
            expect(await pullRequestOf(place)).toMatchObject({ state: 'merged' });

            // A hash that is none is not given to git at all.
            now += 20_000;
            gh.reply('feature', { body: graphql([node({ state: 'MERGED', headRefOid: '--all' })]) });
            expect(await pullRequestOf(place)).toMatchObject({ state: 'merged' });

            // A branch that diverged from the pull request's branch has commits it lacks.
            now += 20_000;
            git(path, 'checkout', '-q', '-b', 'other', head);
            gh.reply('other', { body: graphql([node({ state: 'MERGED', headRefOid: ahead, headRefName: 'other' })]) });
            commitMore(path, 'other.txt');
            expect(await pullRequestOf(place)).toBeUndefined();
        });

        test('keeps a merged pull request that HEAD has moved past when git does not answer whether it has the commit', async () => {
            const { place, path, head } = repoOn();

            commitMore(path);
            gh.reply('feature', { body: graphql([node({ state: 'MERGED', headRefOid: head })]) });

            expect(await withGitSilentOnCommits(() => pullRequestOf(place))).toMatchObject({
                number: 7,
                state: 'merged',
            });
        });

        test('never drops an open pull request, however far the branch has moved', async () => {
            const { place, path } = repoOn();

            commitMore(path);
            gh.reply('feature', { body: graphql([node({ headRefOid: 'b'.repeat(40) })]) });

            expect(await pullRequestOf(place)).toMatchObject({ state: 'open' });
        });

        test('prefers an open pull request to a newer merged one, and the newest open one among several', async () => {
            const { place, head } = repoOn();

            gh.reply('feature', {
                body: graphql([
                    node({ number: 9, state: 'MERGED', headRefOid: head }),
                    node({ number: 5, headRefOid: head }),
                    node({ number: 8, headRefOid: head }),
                    node({ number: 3, state: 'CLOSED', headRefOid: head }),
                ]),
            });

            expect(await pullRequestOf(place)).toMatchObject({ number: 8, state: 'open' });
        });

        test('takes the newest of those that are not open when none is', async () => {
            const { place, head } = repoOn();

            gh.reply('feature', {
                body: graphql([
                    node({ number: 4, state: 'CLOSED', headRefOid: head }),
                    node({ number: 9, state: 'MERGED', headRefOid: head }),
                    node({ number: 6, state: 'CLOSED', headRefOid: head }),
                ]),
            });

            expect(await pullRequestOf(place)).toMatchObject({ number: 9, state: 'merged' });
        });

        test('skips a pull request that comes from a fork, whichever way GitHub says so', async () => {
            const { place, head } = repoOn();

            gh.reply('feature', {
                body: graphql([
                    node({
                        number: 12,
                        isCrossRepository: true,
                        headRepositoryOwner: { login: 'stranger' },
                        headRefOid: head,
                    }),
                    node({
                        number: 11,
                        isCrossRepository: false,
                        headRepositoryOwner: { login: 'Stranger' },
                        headRefOid: head,
                    }),
                    node({ number: 10, isCrossRepository: true, headRepositoryOwner: null, headRefOid: head }),
                ]),
            });
            expect(await pullRequestOf(place)).toBeUndefined();

            now += 20_000;
            gh.reply('feature', {
                body: graphql([
                    node({ number: 12, isCrossRepository: true, headRepositoryOwner: { login: 'stranger' } }),
                    node({ number: 7, headRepositoryOwner: { login: 'ACME' } }),
                ]),
            });
            expect(await pullRequestOf(place)).toMatchObject({ number: 7 });
        });

        test("counts only an open pull request on the repository's default branch", async () => {
            const { place, path } = repoOn();

            git(path, 'checkout', '-q', 'main');
            gh.reply('main', { body: graphql([node({ number: 3, state: 'MERGED', headRefName: 'main' })], 'main') });
            expect(await pullRequestOf(place)).toBeUndefined();

            now += 20_000;
            gh.reply('main', {
                body: graphql(
                    [
                        node({ number: 3, state: 'MERGED', headRefName: 'main' }),
                        node({ number: 4, headRefName: 'main' }),
                    ],
                    'main'
                ),
            });
            expect(await pullRequestOf(place)).toMatchObject({ number: 4 });

            // Another branch is not the default one: its merged pull request counts.
            now += 20_000;
            git(path, 'checkout', '-q', 'feature');
            gh.reply('feature', {
                body: graphql([node({ state: 'MERGED', headRefOid: git(path, 'rev-parse', 'HEAD') })], 'main'),
            });
            expect(await pullRequestOf(place)).toMatchObject({ state: 'merged' });
        });

        test('says a branch with a slash is looked up by its own name', async () => {
            const { place, path } = repoOn();

            git(path, 'checkout', '-q', '-b', 'user/fix-it');
            gh.reply('user/fix-it', { body: graphql([node({ headRefName: 'user/fix-it' })]) });

            expect(await pullRequestOf(place)).toMatchObject({ head: 'user/fix-it' });
            expect(gh.reads()).toEqual(['user/fix-it']);
        });

        test('asks again without a field that an older server does not have, and remembers for the next read', async () => {
            const { place, path } = repoOn();

            gh.oldServer();
            gh.reply('feature', { body: graphql([node({ mergeStateStatus: undefined, mergeable: 'MERGEABLE' })]) });

            expect(await pullRequestOf(place)).toMatchObject({ number: 7, mergeability: 'mergeable' });
            expect(gh.reads()).toEqual(['feature', 'feature']);
            expect(
                gh
                    .calls()
                    .filter(call => call[0] === 'api')
                    .map(call => call[7]!.includes('mergeStateStatus'))
            ).toEqual([true, false]);

            git(path, 'checkout', '-q', '-b', 'second');
            gh.reply('second', { body: graphql([]) });
            await pullRequests.read(place);
            expect(gh.reads()).toEqual(['feature', 'feature', 'second']);
        });

        test('keeps what a read answers when GitHub adds errors to it', async () => {
            const { place } = repoOn();

            gh.reply('feature', {
                body: { ...graphql([node()]), errors: [{ type: 'FORBIDDEN', message: 'Resource not accessible' }] },
                code: 1,
            });

            expect(await pullRequestOf(place)).toMatchObject({ number: 7 });
        });

        test('keeps a pull request whose node lacks its number, address or state out of the choice', async () => {
            const { place } = repoOn();

            gh.reply('feature', {
                body: graphql([
                    null,
                    'text',
                    { state: 'OPEN' },
                    node({ url: undefined }),
                    node({ number: 99, url: 'file:///etc/passwd' }),
                    node({ state: 'DRAFT' }),
                    node({ number: 5 }),
                ]),
            });

            expect(await pullRequestOf(place)).toMatchObject({ number: 5 });
        });

        test("reads the first hundred checks and says there are more, taking GitHub's own total into account", async () => {
            const { place } = repoOn();
            const many = Array.from({ length: 100 }, (_, index) =>
                checkRun(`job ${String(index).padStart(3, '0')}`, 'COMPLETED', 'SUCCESS')
            );

            gh.reply('feature', { body: graphql([node({}, many, 'PENDING', true)]) });

            const checks = (await pullRequestOf(place))?.checks as GitChecks;

            expect(checks).toMatchObject({ state: 'pending', truncated: true, passing: 100 });
        });
    });

    describe('a gh that fails', () => {
        const expectUnavailable = async (read: Promise<unknown>, message: string) => {
            const error = await read.then(
                () => undefined,
                (failure: unknown) => failure
            );

            expect(error).toBeInstanceOf(CommandError);
            expect(error).toMatchObject({ code: 'unavailable', message });
        };

        test('is unavailable with a short reason, never an answer that says there is none', async () => {
            const { place } = repoOn();

            gh.reply('feature', { stderr: 'gh: Bad gateway (HTTP 502)', code: 1 });
            await expectUnavailable(pullRequests.read(place), "GitHub didn't answer");

            gh.reply('feature', {
                stderr: 'Post "https://api.github.com/graphql": dial tcp: lookup api.github.com: no such host',
                code: 1,
            });
            await expectUnavailable(pullRequests.read(place), "GitHub didn't answer");

            gh.reply('feature', {
                body: { message: 'API rate limit exceeded for user ID 1', status: '403' },
                stderr: 'gh: API rate limit exceeded (HTTP 403)',
                code: 1,
            });
            await expectUnavailable(pullRequests.read(place), "GitHub's rate limit is reached");

            gh.reply('feature', {
                body: {
                    data: { repository: null },
                    errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }],
                },
                code: 1,
            });
            await expectUnavailable(pullRequests.read(place), "GitHub's rate limit is reached");

            gh.reply('feature', { stderr: 'gh: Forbidden (HTTP 403)', code: 1 });
            await expectUnavailable(pullRequests.read(place), 'GitHub refused the request');

            gh.reply('feature', { stderr: 'gh: something nobody expected', code: 1 });
            await expectUnavailable(pullRequests.read(place), "Couldn't read the pull request");
        });

        test('is unavailable for a repository the account cannot see, and for an answer that cannot be read', async () => {
            const { place } = repoOn();

            gh.reply('feature', {
                body: {
                    data: { repository: null },
                    errors: [
                        {
                            type: 'NOT_FOUND',
                            path: ['repository'],
                            message: "Could not resolve to a Repository with the name 'acme/app'.",
                        },
                    ],
                },
                code: 1,
            });
            await expectUnavailable(
                pullRequests.read(place),
                "GitHub doesn't show this repository to the signed-in account"
            );

            gh.reply('feature', { stderr: 'gh: Not Found (HTTP 404)', code: 1 });
            await expectUnavailable(
                pullRequests.read(place),
                "GitHub doesn't show this repository to the signed-in account"
            );

            gh.reply('feature', { body: undefined, code: 0 });
            await expectUnavailable(pullRequests.read(place), "GitHub's answer couldn't be read");

            gh.reply('feature', { body: { data: { repository: { pullRequests: {} } } }, code: 0 });
            await expectUnavailable(pullRequests.read(place), "GitHub's answer couldn't be read");
        });

        test('keeps no failure: the next read asks again, and a read that succeeds is kept', async () => {
            const { place } = repoOn();

            gh.reply('feature', { stderr: 'gh: Bad gateway (HTTP 502)', code: 1 });
            await expectUnavailable(pullRequests.read(place), "GitHub didn't answer");
            await expectUnavailable(pullRequests.read(place), "GitHub didn't answer");
            expect(gh.reads()).toHaveLength(2);

            gh.reply('feature', { body: graphql([node()]) });
            expect(await pullRequestOf(place)).toMatchObject({ number: 7 });
            await pullRequestOf(place);
            expect(gh.reads()).toHaveLength(3);
        });

        test('is unavailable when the daemon is stopping', async () => {
            const { place } = repoOn();

            pullRequests.stop();

            await expectUnavailable(pullRequests.read(place), 'The daemon is stopping');
        });
    });

    describe('what is not asked', () => {
        test('runs no gh for a detached HEAD, and says there is no pull request', async () => {
            const { place, path } = repoOn();

            git(path, 'checkout', '-q', '--detach');

            expect(await pullRequests.read(place)).toEqual({
                isRepository: true,
                access: 'ready',
                repo: { host: 'github.com', owner: 'acme', name: 'app' },
            });
            expect(gh.calls()).toEqual([]);
        });

        test('runs no gh for a branch with no commit yet', async () => {
            const path = join(tempDir('git-pull-request'), 'fresh');

            mkdirSync(path);
            git(path, 'init', '-q', '-b', 'topic');
            git(path, 'remote', 'add', 'origin', 'https://github.com/acme/app.git');

            expect(await pullRequests.read(placeAt(path))).toEqual({
                isRepository: true,
                access: 'ready',
                repo: { host: 'github.com', owner: 'acme', name: 'app' },
            });
            expect(gh.calls()).toEqual([]);
        });
    });

    describe('the cache', () => {
        test('shares one gh call among the windows that ask at once, and keeps its answer for fifteen seconds', async () => {
            const { place } = repoOn();

            gh.reply('feature', { body: graphql([node()]) });

            const answers = await Promise.all([
                pullRequests.read(place),
                pullRequests.read(place),
                pullRequests.read(place),
            ]);

            expect(answers[1]).toEqual(answers[0]);
            expect(answers[2]).toEqual(answers[0]);
            expect(gh.reads()).toEqual(['feature']);
            expect(gh.calls().filter(call => call[0] === 'auth')).toHaveLength(1);
            expect(gh.calls().filter(call => call[0] === '--version')).toHaveLength(1);

            now += 14_000;
            await pullRequests.read(place);
            expect(gh.reads()).toHaveLength(1);

            now += 2000;
            await pullRequests.read(place);
            expect(gh.reads()).toHaveLength(2);
        });

        test('asks again when the commit the place is at has changed, and for another branch', async () => {
            const { place, path } = repoOn();

            gh.reply('feature', { body: graphql([node()]) });
            await pullRequests.read(place);
            commitMore(path);
            await pullRequests.read(place);
            expect(gh.reads()).toEqual(['feature', 'feature']);

            git(path, 'checkout', '-q', '-b', 'second');
            gh.reply('second', { body: graphql([]) });
            await pullRequests.read(place);
            expect(gh.reads()).toEqual(['feature', 'feature', 'second']);
        });

        test('forgets the answer of the branch the place is on, and only that one, so a push is seen by the next read', async () => {
            const { place, path } = repoOn();

            gh.reply('feature', { body: graphql([]) });
            await pullRequests.read(place);
            await pullRequests.read(place);
            expect(gh.reads()).toEqual(['feature']);

            // The pull request was opened on GitHub after the push: HEAD has not moved, and a kept answer would still say there is none.
            gh.reply('feature', { body: graphql([node()]) });
            await pullRequests.forget(place);
            expect((await pullRequestOf(place))?.number).toBe(7);
            expect(gh.reads()).toEqual(['feature', 'feature']);

            // Another branch's answer is kept.
            git(path, 'checkout', '-q', '-b', 'second');
            gh.reply('second', { body: graphql([]) });
            await pullRequests.read(place);
            git(path, 'checkout', '-q', 'feature');
            await pullRequests.forget(place);
            git(path, 'checkout', '-q', 'second');
            await pullRequests.read(place);
            expect(gh.reads()).toEqual(['feature', 'feature', 'second']);

            // A place with no repository, no origin or a detached HEAD has nothing to forget.
            await pullRequests.forget({ ...place, path: tempDir('no-repository') });
            git(path, 'checkout', '-q', '--detach');
            await pullRequests.forget(place);
        });

        test('keeps the answer of a repository apart from another that has a branch of the same name', async () => {
            const first = repoOn('https://github.com/acme/app.git');
            const second = repoOn('https://github.com/acme/other.git');

            gh.reply('feature', { body: graphql([node()]) });
            await pullRequests.read(first.place);
            await pullRequests.read(second.place);
            expect(gh.reads()).toEqual(['feature', 'feature']);
        });

        test('shares a failure among those who were waiting for it, and keeps it for none', async () => {
            const { place } = repoOn();

            gh.reply('feature', { stderr: 'gh: Bad gateway (HTTP 502)', code: 1 });

            const outcomes = await Promise.allSettled([pullRequests.read(place), pullRequests.read(place)]);

            expect(outcomes.map(outcome => outcome.status)).toEqual(['rejected', 'rejected']);
            expect(gh.reads()).toHaveLength(1);
        });

        test('holds as many answers as it is told to, the oldest going first', async () => {
            const { place, path } = repoOn();
            const small = new PullRequests({ env: gh.env, fallbackPaths: [], now: () => now, keep: 3 });

            for (const name of ['one', 'two', 'three', 'four']) {
                git(path, 'checkout', '-q', '-B', name);
                gh.reply(name, { body: graphql([]) });
                await small.read(place);
            }

            expect(gh.reads()).toEqual(['one', 'two', 'three', 'four']);

            // The first of them was let go, and is read again; the last is still there.
            git(path, 'checkout', '-q', 'four');
            await small.read(place);
            expect(gh.reads()).toHaveLength(4);
            git(path, 'checkout', '-q', 'one');
            await small.read(place);
            expect(gh.reads()).toEqual(['one', 'two', 'three', 'four', 'one']);
            small.stop();
        });
    });

    describe('the base of the pull request', () => {
        test('is the last one found for the place, forgotten when a read finds none or the place is not a repository', async () => {
            const { place, path, head } = repoOn();

            expect(await pullRequests.baseHint(place)).toBeUndefined();

            gh.reply('feature', { body: graphql([node({ baseRefName: 'dev' })]) });
            await pullRequests.read(place);
            expect(await pullRequests.baseHint(place)).toBe('dev');
            // Another place has its own.
            expect(await pullRequests.baseHint(placeAt(join(path, '..', 'elsewhere')))).toBeUndefined();

            // A merged pull request is the branch's own too, while the branch has nothing new.
            now += 20_000;
            gh.reply('feature', {
                body: graphql([node({ baseRefName: 'release', state: 'MERGED', headRefOid: head })]),
            });
            await pullRequests.read(place);
            expect(await pullRequests.baseHint(place)).toBe('release');

            commitMore(path);
            await pullRequests.read(place);
            expect(await pullRequests.baseHint(place)).toBeUndefined();
        });

        test('is forgotten when gh is gone, not signed in, or the remote is', async () => {
            const { place, path, head } = repoOn();

            gh.reply('feature', { body: graphql([node({ baseRefName: 'dev', headRefOid: head })]) });
            await pullRequests.read(place);
            expect(await pullRequests.baseHint(place)).toBe('dev');

            git(path, 'remote', 'remove', 'origin');
            await pullRequests.read(place);
            expect(await pullRequests.baseHint(place)).toBeUndefined();

            git(path, 'remote', 'add', 'origin', 'https://github.com/acme/app.git');
            await pullRequests.read(place);
            expect(await pullRequests.baseHint(place)).toBe('dev');

            gh.signOut();
            now += 70_000;
            await pullRequests.read(place);
            expect(await pullRequests.baseHint(place)).toBeUndefined();
        });

        test('holds for ten minutes and is then forgotten', async () => {
            const { place } = repoOn();

            gh.reply('feature', { body: graphql([node({ baseRefName: 'dev' })]) });
            await pullRequests.read(place);
            now += 9 * 60_000;
            expect(await pullRequests.baseHint(place)).toBe('dev');
            now += 2 * 60_000;
            expect(await pullRequests.baseHint(place)).toBeUndefined();
        });

        test('belongs to the branch it was found for: another branch or a detached HEAD has none, and it is back with the branch', async () => {
            const { place, path } = repoOn();

            gh.reply('feature', { body: graphql([node({ baseRefName: 'dev' })]) });
            await pullRequests.read(place);
            expect(await pullRequests.baseHint(place)).toBe('dev');

            git(path, 'checkout', '-q', '-b', 'second');
            expect(await pullRequests.baseHint(place)).toBeUndefined();

            git(path, 'checkout', '-q', '--detach');
            expect(await pullRequests.baseHint(place)).toBeUndefined();

            git(path, 'checkout', '-q', 'feature');
            expect(await pullRequests.baseHint(place)).toBe('dev');

            // The new commit is the same branch's: the pull request's base does not change with it.
            commitMore(path);
            expect(await pullRequests.baseHint(place)).toBe('dev');
        });

        test('is found also when the answer comes from the cache', async () => {
            const first = repoOn();

            gh.reply('feature', { body: graphql([node({ baseRefName: 'dev' })]) });
            await pullRequests.read(first.place);
            pullRequests.stop();

            // Another daemon of the same machine's kind: a new service, with the cache of the first not shared.
            pullRequests = new PullRequests({ env: gh.env, fallbackPaths: [], now: () => now });
            await pullRequests.read(first.place);
            await pullRequests.read(first.place);
            expect(await pullRequests.baseHint(first.place)).toBe('dev');
        });
    });

    describe('a credential in the remote', () => {
        const token = 'ghp_s3cretT0ken';

        test('is nowhere in the answer, in what gh was run with, or in an error', async () => {
            const { place } = repoOn(`https://octocat:${token}@github.com/acme/app.git`);

            gh.reply('feature', { body: graphql([node()]) });

            const info = await pullRequests.read(place);

            expect(JSON.stringify(info)).not.toContain(token);
            expect(JSON.stringify(info)).not.toContain('octocat');
            expect(info).toMatchObject({ repo: { host: 'github.com', owner: 'acme', name: 'app' } });
            expect(gh.text()).not.toContain(token);
            expect(gh.text()).not.toContain('octocat');

            now += 20_000;
            gh.reply('feature', {
                stderr: `gh: Post "https://octocat:${token}@api.github.com/graphql": no such host`,
                code: 1,
            });

            const failure = await pullRequests.read(place).then(
                () => undefined,
                (error: unknown) => error as CommandError
            );

            expect(failure).toBeInstanceOf(CommandError);
            expect(JSON.stringify({ message: failure?.message, details: failure?.details })).not.toContain(token);
            expect(gh.text()).not.toContain(token);
        });

        test('does not keep a remote that is not a repository from being said to have none, and does not repeat it', async () => {
            const { place } = repoOn(`https://octocat:${token}@internal.example/just-one-part`);

            const info = await pullRequests.read(place);

            expect(info).toEqual({ isRepository: true, access: 'no_remote' });
            expect(JSON.stringify(info)).not.toContain(token);
            expect(gh.calls()).toEqual([]);
        });
    });
});

withStandIn('Branch pull request history', () => {
    let gh: StandIn;
    let now: number;
    let pullRequests: PullRequests;
    let store: Store;
    let databasePath: string;

    beforeEach(() => {
        gh = new StandIn();
        now = 1_000_000;
        pullRequests = new PullRequests({ env: gh.env, fallbackPaths: [], now: () => now });
        databasePath = join(tempDir('pull-request-history'), 'clowdy.db');
        store = new Store(openDatabase(databasePath));
    });

    afterEach(() => {
        pullRequests.stop();
        store.db.close();
    });

    const read = (place: Place, branch = 'feature') => pullRequests.readHistory(store, place, branch);
    const archive = (place: Place, number: number, archived: boolean) =>
        pullRequests.archiveHistory(store, place, 'feature', number, archived, {
            host: 'github.com',
            owner: 'acme',
            name: 'app',
        });

    test('reads all pages for the explicit branch, retains historical PRs, and excludes forks or other branches', async () => {
        const { path, place } = repoOn();
        git(path, 'checkout', '-q', 'main');
        git(path, 'branch', '-D', 'feature');
        gh.reply('feature', {
            body: historyPage(
                [
                    historyNode(17, 'OPEN', { isDraft: true }),
                    historyNode(16, 'MERGED'),
                    historyNode(15, 'OPEN', { isCrossRepository: true }),
                ],
                'next-page'
            ),
        });
        gh.reply(
            'feature',
            {
                body: historyPage([
                    historyNode(14, 'CLOSED'),
                    historyNode(13, 'OPEN', { headRepositoryOwner: { login: 'another' } }),
                    historyNode(12, 'OPEN', { headRefName: 'other' }),
                    historyNode(11),
                ]),
            },
            'next-page'
        );

        expect(await read(place)).toEqual({
            branch: 'feature',
            access: 'ready',
            repo: { host: 'github.com', owner: 'acme', name: 'app' },
            pullRequests: [
                {
                    number: 17,
                    title: 'Pull request 17',
                    url: 'https://github.com/acme/app/pull/17',
                    state: 'draft',
                    base: 'main',
                    head: 'feature',
                    updatedAt: Date.parse('2026-11-20T10:00:00Z'),
                },
                {
                    number: 16,
                    title: 'Pull request 16',
                    url: 'https://github.com/acme/app/pull/16',
                    state: 'merged',
                    base: 'main',
                    head: 'feature',
                    updatedAt: Date.parse('2026-11-20T10:00:00Z'),
                },
                {
                    number: 14,
                    title: 'Pull request 14',
                    url: 'https://github.com/acme/app/pull/14',
                    state: 'closed',
                    base: 'main',
                    head: 'feature',
                    updatedAt: Date.parse('2026-11-20T10:00:00Z'),
                },
                {
                    number: 11,
                    title: 'Pull request 11',
                    url: 'https://github.com/acme/app/pull/11',
                    state: 'open',
                    base: 'main',
                    head: 'feature',
                    updatedAt: Date.parse('2026-11-20T10:00:00Z'),
                },
            ],
        });
        expect(gh.reads()).toEqual(['feature', 'feature']);
        expect(
            gh
                .calls()
                .filter(call => call[0] === 'api')
                .at(1)
        ).toContain('cursor=next-page');
        expect(gh.text()).not.toContain('statusCheckRollup');
    });

    test('deduplicates simultaneous reads across worktrees and equivalent origin addresses, then invalidates on git changes', async () => {
        const first = repoOn('https://github.com/ACME/App.git');
        const second = repoOn('git@github.com:acme/app.git');
        const tree = join(tempDir('git-pull-request'), 'shared-tree');
        git(first.path, 'worktree', 'add', '-q', '-b', 'other', tree, 'main');
        gh.reply('feature', { body: historyPage([historyNode(10, 'MERGED')]) });

        const histories = await Promise.all([read(first.place), read(second.place), read(placeAt(tree))]);

        expect(histories.map(history => history.pullRequests.map(pr => pr.number))).toEqual([[10], [10], [10]]);
        expect(gh.reads()).toEqual(['feature']);
        await archive(second.place, 10, true);
        expect((await read(first.place)).pullRequests[0]?.archived).toBe(true);
        expect(gh.reads()).toEqual(['feature']);

        gh.reply('feature', { body: historyPage([historyNode(11), historyNode(10, 'MERGED')]) });
        await pullRequests.forget(first.place);
        expect((await read(second.place)).pullRequests.map(pr => pr.number)).toEqual([11, 10]);
        expect(gh.reads()).toEqual(['feature', 'feature']);
    });

    test('marks the newest merged pull request once the branch has commits of its own since, also from the cache and after an archive', async () => {
        const { path, place, head } = repoOn();
        gh.reply('feature', { body: historyPage([historyNode(10, 'MERGED', { headRefOid: head })]) });

        // The branch is where the pull request left it, and its commits are in no base (a squash merge leaves them out): still the state of the branch.
        const merged = await read(place);
        expect(merged.pullRequests[0]).toMatchObject({ number: 10, state: 'merged', headCommit: head });
        expect(merged.pullRequests[0]?.movedPast).toBeUndefined();

        commitMore(path);

        const moved = await read(place);
        expect(moved.pullRequests[0]?.movedPast).toBe(true);
        expect(gh.reads()).toEqual(['feature']);

        // A linked worktree of the repository sees the branch as it is in the checkout that has it.
        const tree = join(tempDir('git-pull-request'), 'linked-tree');
        git(path, 'worktree', 'add', '-q', '-b', 'other', tree, 'main');
        expect((await read(placeAt(tree))).pullRequests[0]?.movedPast).toBe(true);
        expect((await archive(place, 10, true)).pullRequests[0]).toMatchObject({ archived: true, movedPast: true });
    });

    test('does not count a merge of the base into the branch, or a base that moved on, as work of its own', async () => {
        const { path, place, head } = repoOn();
        gh.reply('feature', { body: historyPage([historyNode(10, 'MERGED', { headRefOid: head })]) });

        git(path, 'checkout', '-q', 'main');
        commitMore(path, 'base.txt');
        git(path, 'checkout', '-q', 'feature');

        expect((await read(place)).pullRequests[0]?.movedPast).toBeUndefined();

        // What Update from main does: the branch has a commit that is not on the pull request's branch, but it is a merge, and what it brings is in the base.
        git(path, 'merge', '-q', '--no-edit', 'main');

        expect((await read(place)).pullRequests[0]?.movedPast).toBeUndefined();

        commitMore(path, 'own.txt');

        expect((await read(place)).pullRequests[0]?.movedPast).toBe(true);
    });

    test('judges only the newest merged pull request, and only while none is open and the repository can say', async () => {
        const { path, place, head, main } = repoOn();
        const absent = 'a'.repeat(40);
        const read10 = async (nodes: unknown[]) => {
            await pullRequests.forget(place);
            gh.reply('feature', { body: historyPage(nodes) });

            return (await read(place)).pullRequests;
        };

        commitMore(path);

        // The older pull request is passed by too, but it is the newest that stands for the branch.
        const both = await read10([
            historyNode(10, 'MERGED', { headRefOid: head }),
            historyNode(9, 'MERGED', { headRefOid: main }),
        ]);
        expect(both.map(pr => [pr.number, pr.movedPast])).toEqual([
            [10, true],
            [9, undefined],
        ]);
        // A live pull request, a draft as well, is shown as it is, and the merged one is history either way.
        expect(
            (await read10([historyNode(11), historyNode(10, 'MERGED', { headRefOid: head })])).map(pr => pr.movedPast)
        ).toEqual([undefined, undefined]);
        expect(
            (
                await read10([
                    historyNode(11, 'OPEN', { isDraft: true }),
                    historyNode(10, 'MERGED', { headRefOid: head }),
                ])
            ).map(pr => pr.movedPast)
        ).toEqual([undefined, undefined]);
        // No head commit in the row, a commit the repository does not have, and a closed pull request: nothing to judge by.
        expect((await read10([historyNode(10, 'MERGED')]))[0]?.movedPast).toBeUndefined();
        expect((await read10([historyNode(10, 'MERGED', { headRefOid: absent })]))[0]?.movedPast).toBeUndefined();
        expect((await read10([historyNode(10, 'CLOSED', { headRefOid: head })]))[0]?.movedPast).toBeUndefined();
        // A branch that is not local has no commits to speak of.
        git(path, 'checkout', '-q', 'main');
        git(path, 'branch', '-D', 'feature');
        expect((await read10([historyNode(10, 'MERGED', { headRefOid: head })]))[0]?.movedPast).toBeUndefined();
    });

    test('takes the base as origin has it when the local base is behind', async () => {
        const { path, place, head } = repoOn();
        gh.reply('feature', { body: historyPage([historyNode(10, 'MERGED', { headRefOid: head })]) });

        // What the branch merged from the base is on `origin/main` only, the local `main` has not caught up with it.
        git(path, 'checkout', '-q', 'main');
        git(path, 'update-ref', 'refs/remotes/origin/main', commitMore(path, 'base.txt'));
        git(path, 'reset', '-q', '--hard', 'HEAD~1');
        git(path, 'checkout', '-q', 'feature');
        git(path, 'merge', '-q', '--no-edit', 'origin/main');

        expect((await read(place)).pullRequests[0]?.movedPast).toBeUndefined();

        commitMore(path, 'own.txt');

        expect((await read(place)).pullRequests[0]?.movedPast).toBe(true);
    });

    test('does not mark a branch that git cannot count the commits of', async () => {
        const { path, place, head } = repoOn();
        gh.reply('feature', { body: historyPage([historyNode(10, 'MERGED', { headRefOid: head })]) });
        const middle = commitMore(path, 'one.txt');
        commitMore(path, 'two.txt');

        // Both ends are in the repository and the commit between them is not: that is an error of git, and an error is not "moved past".
        rmSync(join(path, '.git', 'objects', middle.slice(0, 2), middle.slice(2)));

        expect((await read(place)).pullRequests[0]?.movedPast).toBeUndefined();
    });

    test('does not mark a branch when git does not answer whether the repository has the base', async () => {
        const { path, place, head } = repoOn();
        gh.reply('feature', { body: historyPage([historyNode(10, 'MERGED', { headRefOid: head })]) });
        commitMore(path, 'own.txt');

        const [latest] = (await withGitSilentOnCommits(() => read(place))).pullRequests;

        expect([latest?.number, latest?.movedPast]).toEqual([10, undefined]);
    });

    test('keeps the complete stored history and archive across restarts, partial failures, offline reads and restores', async () => {
        const { place } = repoOn();
        gh.reply('feature', {
            body: historyPage([historyNode(3, 'MERGED'), historyNode(2, 'CLOSED'), historyNode(1)]),
        });
        expect((await read(place)).pullRequests).toHaveLength(3);
        expect((await archive(place, 2, true)).pullRequests.find(pr => pr.number === 2)?.archived).toBe(true);
        await expect(archive(place, 1, true)).rejects.toThrow('Only closed or merged');
        await expect(archive(place, 99, true)).rejects.toThrow('not in the branch history');

        // A failure on page two must not leave a partial list as the last good answer.
        gh.reply('feature', { body: historyPage([historyNode(4)], 'missing-page') });
        gh.reply('feature', { stderr: 'gh: Bad gateway (HTTP 502)', code: 1 }, 'missing-page');
        now += 31_000;
        expect(await read(place)).toMatchObject({
            access: 'ready',
            stale: true,
            pullRequests: [{ number: 3 }, { number: 2, archived: true }, { number: 1 }],
        });

        pullRequests.stop();
        store.db.close();
        store = new Store(openDatabase(databasePath));
        pullRequests = new PullRequests({ env: () => ({ PATH: '' }), fallbackPaths: [], now: () => now });
        expect(await read(place)).toMatchObject({
            access: 'no_gh',
            stale: true,
            pullRequests: [{ number: 3 }, { number: 2, archived: true }, { number: 1 }],
        });
        expect((await archive(place, 2, false)).pullRequests.find(pr => pr.number === 2)?.archived).toBeUndefined();
        expect((await read(place)).pullRequests.find(pr => pr.number === 2)?.archived).toBeUndefined();
    });

    test('a reopened PR loses its archive and stays visible if it closes again', async () => {
        const { place } = repoOn();
        gh.reply('feature', {
            body: historyPage([historyNode(2, 'CLOSED'), historyNode(1, 'OPEN', { isDraft: true })]),
        });
        await read(place);
        await archive(place, 2, true);
        await expect(archive(place, 1, true)).rejects.toThrow('Only closed or merged');

        now += 31_000;
        gh.reply('feature', { body: historyPage([historyNode(2), historyNode(1, 'OPEN', { isDraft: true })]) });
        expect((await read(place)).pullRequests.find(pr => pr.number === 2)).toMatchObject({ state: 'open' });
        expect((await read(place)).pullRequests.find(pr => pr.number === 2)?.archived).toBeUndefined();
        now += 31_000;
        gh.reply('feature', { body: historyPage([historyNode(2, 'MERGED')]) });
        expect((await read(place)).pullRequests[0]?.archived).toBeUndefined();
    });

    test('does not archive a different repository after the folder origin changes', async () => {
        const { path, place } = repoOn();
        gh.reply('feature', { body: historyPage([historyNode(1, 'MERGED')]) });
        await read(place);

        git(path, 'remote', 'set-url', 'origin', 'https://github.com/acme/another.git');
        gh.reply('feature', {
            body: historyPage([historyNode(1, 'MERGED', { url: 'https://github.com/acme/another/pull/1' })]),
        });
        await read(place);
        await expect(archive(place, 1, true)).rejects.toThrow('origin has changed');
        expect((await read(place)).pullRequests[0]?.archived).toBeUndefined();
    });

    test('distinguishes a successful empty history from a read that has never succeeded', async () => {
        const { place } = repoOn();
        gh.reply('feature', { stderr: 'gh: Bad gateway (HTTP 502)', code: 1 });
        expect(await read(place)).toMatchObject({ stale: true, pullRequests: [] });
        gh.reply('feature', { body: historyPage([]) });
        now += 6000;
        expect((await read(place)).stale).toBeUndefined();
        expect((await read(place)).pullRequests).toEqual([]);

        const noRemote = repoOn(null);
        expect(await read(noRemote.place)).toEqual({ branch: 'feature', access: 'no_remote', pullRequests: [] });
    });

    test('does not replace a good history with an invalid link or a looping pagination cursor', async () => {
        const { place } = repoOn();
        gh.reply('feature', { body: historyPage([historyNode(1)]) });
        const original = await read(place);

        now += 31_000;
        gh.reply('feature', {
            body: historyPage([historyNode(2, 'OPEN', { url: 'https://user:secret@github.com/acme/app/pull/2' })]),
        });
        expect(await read(place)).toEqual({ ...original, stale: true });

        now += 6_000;
        gh.reply('feature', { body: historyPage([historyNode(3)], 'repeated') });
        gh.reply('feature', { body: historyPage([historyNode(4)], 'repeated') }, 'repeated');
        expect(await read(place)).toEqual({ ...original, stale: true });
    });
});

withStandIn('GET /v1/projects/:id/git/pull-request', () => {
    let gh: StandIn;
    let now: number;
    let h: Harness;

    beforeEach(async () => {
        gh = new StandIn();
        now = 1_000_000;
        h = await startHarness(
            {},
            { pullRequests: new PullRequests({ env: gh.env, fallbackPaths: [], now: () => now }) }
        );
    });

    afterEach(async () => {
        await h.stop();
    });

    const json = async <T>(response: Response) => (await response.json()) as T;

    test('serves branch history and local archive behind the token, with folder and branch validation', async () => {
        const { path } = repoOn();
        const { project } = h.ok('project.add', { folders: [path] });
        const folderId = project.folders[0].id as string;
        const base = `/v1/projects/${project.id}/git/pull-requests`;
        const request = `${base}?folderId=${folderId}&branch=feature`;

        gh.reply('feature', { body: historyPage([historyNode(5, 'MERGED'), historyNode(2)]) });
        const history = await json<GitBranchPullRequests>(await h.fetch(request));
        expect(history.pullRequests.map(pr => pr.number)).toEqual([5, 2]);

        const mark = (number: number, archived: boolean) =>
            h.fetch(`${base}/archive`, {
                method: 'POST',
                body: JSON.stringify({ folderId, branch: 'feature', number, archived, repo: history.repo }),
            });
        expect((await json<GitBranchPullRequests>(await mark(5, true))).pullRequests[0]?.archived).toBe(true);
        expect((await json<GitBranchPullRequests>(await h.fetch(request))).pullRequests[0]?.archived).toBe(true);
        expect((await mark(2, true)).status).toBe(409);
        expect((await mark(5, false)).status).toBe(200);
        expect((await json<GitBranchPullRequests>(await h.fetch(request))).pullRequests[0]?.archived).toBeUndefined();

        expect((await fetch(`${h.url}${request}`)).status).toBe(401);
        expect((await h.fetch(`${base}?branch=feature`)).status).toBe(400);
        expect((await h.fetch(`${base}?folderId=${folderId}`)).status).toBe(400);
        expect((await h.fetch(`${base}?folderId=${folderId}&branch=bad..name`)).status).toBe(400);
        expect((await h.fetch(`${base}?folderId=unknown&branch=feature`)).status).toBe(404);
        expect(
            (await h.fetch(`/v1/projects/unknown/git/pull-requests?folderId=${folderId}&branch=feature`)).status
        ).toBe(404);
        expect(
            (
                await fetch(`${h.url}${base}/archive`, {
                    method: 'POST',
                    body: JSON.stringify({
                        folderId,
                        branch: 'feature',
                        number: 5,
                        archived: true,
                        repo: history.repo,
                    }),
                })
            ).status
        ).toBe(401);
    });

    test("answers the pull request of a folder's checkout and of a chat's worktree, each for its own branch, behind the token", async () => {
        const { path, head } = repoOn();
        const tree = join(tempDir('git-pull-request'), 'chat-tree');

        git(path, 'worktree', 'add', '-q', '-b', 'chat-branch', tree, 'main');

        const treeHead = commitMore(tree, 'in-tree.txt');
        const { project } = h.ok('project.add', { folders: [path] });
        const folderId = project.folders[0].id as string;
        const workspaceId = (
            (await h.okAsync('chat.create', { projectId: project.id, workspace: { mode: 'existing', path: tree } }))
                .chat.workspace as { id: string }
        ).id;
        const base = `/v1/projects/${project.id}/git/pull-request`;

        gh.reply('feature', {
            body: graphql([node({ headRefOid: head, number: 21, url: 'https://github.com/acme/app/pull/21' })]),
        });
        gh.reply('chat-branch', {
            body: graphql([
                node({
                    headRefOid: treeHead,
                    number: 22,
                    state: 'MERGED',
                    headRefName: 'chat-branch',
                    url: 'https://github.com/acme/app/pull/22',
                }),
            ]),
        });

        const own = await json<Extract<GitPullRequestInfo, { isRepository: true }>>(
            await h.fetch(`${base}?folderId=${folderId}`)
        );
        const inTree = await json<Extract<GitPullRequestInfo, { isRepository: true }>>(
            await h.fetch(`${base}?folderId=${folderId}&workspaceId=${workspaceId}`)
        );

        expect(own).toMatchObject({
            isRepository: true,
            access: 'ready',
            repo: { host: 'github.com', owner: 'acme', name: 'app' },
            pullRequest: { number: 21, state: 'open', head: 'feature' },
        });
        expect(inTree).toMatchObject({
            isRepository: true,
            access: 'ready',
            pullRequest: { number: 22, state: 'merged', head: 'chat-branch' },
        });
        expect(gh.reads()).toEqual(['feature', 'chat-branch']);

        expect((await fetch(`${h.url}${base}?folderId=${folderId}`)).status).toBe(401);
        expect((await h.fetch(base)).status).toBe(400);
        expect((await h.fetch(`${base}?folderId=fld_unknown`)).status).toBe(404);
        expect((await h.fetch(`/v1/projects/prj_unknown/git/pull-request?folderId=${folderId}`)).status).toBe(404);
        expect((await h.fetch(`${base}?folderId=${folderId}&workspaceId=wks_unknown`)).status).toBe(404);

        h.store.db.query('UPDATE workspaces SET ready = 0 WHERE id = ?').run(workspaceId);
        expect((await h.fetch(`${base}?folderId=${folderId}&workspaceId=${workspaceId}`)).status).toBe(503);
        h.store.db.query('UPDATE workspaces SET ready = 1 WHERE id = ?').run(workspaceId);

        rmSync(tree, { recursive: true });
        expect((await h.fetch(`${base}?folderId=${folderId}&workspaceId=${workspaceId}`)).status).toBe(503);
    });

    test('says a folder that is no repository is none, a machine without gh is no_gh, and a gh that fails is unavailable with its reason', async () => {
        const plain = tempDir('git-pull-request');
        const { path } = repoOn();
        const { project } = h.ok('project.add', { folders: [plain, path] });
        const [plainId, repoId] = project.folders.map((folder: { id: string }) => folder.id);
        const base = `/v1/projects/${project.id}/git/pull-request`;

        expect(await json<GitPullRequestInfo>(await h.fetch(`${base}?folderId=${plainId}`))).toEqual({
            isRepository: false,
        });

        gh.reply('feature', { stderr: 'gh: Bad gateway (HTTP 502)', code: 1 });

        const failed = await h.fetch(`${base}?folderId=${repoId}`);

        expect(failed.status).toBe(503);
        expect(await json(failed)).toMatchObject({
            ok: false,
            error: { code: 'unavailable', message: "GitHub didn't answer" },
        });

        await h.stop();
        h = await startHarness(
            {},
            {
                pullRequests: new PullRequests({
                    env: () => ({ PATH: tempDir('empty-path') }),
                    fallbackPaths: [],
                    now: () => now,
                }),
            }
        );

        const second = h.ok('project.add', { folders: [path] }).project;

        expect(
            await json<GitPullRequestInfo>(
                await h.fetch(`/v1/projects/${second.id}/git/pull-request?folderId=${second.folders[0].id}`)
            )
        ).toEqual({ isRepository: true, access: 'no_gh', repo: { host: 'github.com', owner: 'acme', name: 'app' } });

        // The routes of the local git answer on this machine all the same.
        expect((await h.fetch(`/v1/projects/${second.id}/git/status?folderId=${second.folders[0].id}`)).status).toBe(
            200
        );
    });

    test('gives the status, the changes and the file reads the base of the pull request that was found, and never asks gh itself', async () => {
        const path = makeRepo(tempDir('git-pull-request'), 'app');

        git(path, 'remote', 'add', 'origin', 'https://github.com/acme/app.git');
        git(path, 'checkout', '-q', '-b', 'dev');
        writeFileSync(join(path, 'dev.txt'), 'dev\n');
        git(path, 'add', '.');
        git(path, 'commit', '-q', '-m', 'Dev work');
        git(path, 'checkout', '-q', '-b', 'feature');
        writeFileSync(join(path, 'feature.txt'), 'feature\n');
        git(path, 'add', '.');
        git(path, 'commit', '-q', '-m', 'Feature work');

        const { project } = h.ok('project.add', { folders: [path] });
        const folderId = project.folders[0].id as string;
        const base = `/v1/projects/${project.id}/git`;
        const query = `?folderId=${folderId}`;
        const baseOf = async () =>
            (await json<Extract<GitStatus, { isRepository: true }>>(await h.fetch(`${base}/status${query}`))).base;
        const changed = async () =>
            (
                await json<{ files: Array<{ path: string }> }>(await h.fetch(`${base}/changes${query}&scope=all`))
            ).files.map(file => file.path);

        // Nothing has asked GitHub: the folder's own base, which is `main`, the default branch of the repository.
        expect(await baseOf()).toMatchObject({ state: 'ready', name: 'main', ahead: 2 });
        expect(await changed()).toEqual(['dev.txt', 'feature.txt']);

        gh.reply('feature', {
            body: graphql([node({ baseRefName: 'dev', headRefOid: git(path, 'rev-parse', 'HEAD') })]),
        });
        expect(await json(await h.fetch(`${base}/pull-request${query}`))).toMatchObject({
            pullRequest: { number: 7, base: 'dev' },
        });

        const reads = gh.calls().length;

        expect(await baseOf()).toMatchObject({ state: 'ready', name: 'dev', ahead: 1 });
        expect(await changed()).toEqual(['feature.txt']);

        // Another branch of the place is not the pull request's: its reads compare with the folder's own base until it has a read of its own.
        git(path, 'checkout', '-q', '-b', 'other');
        expect(await baseOf()).toMatchObject({ name: 'main', ahead: 2 });
        expect(await changed()).toEqual(['dev.txt', 'feature.txt']);
        git(path, 'checkout', '-q', 'feature');
        expect(await baseOf()).toMatchObject({ name: 'dev', ahead: 1 });

        expect(await json(await h.fetch(`${base}/file${query}&scope=all&path=feature.txt`))).toMatchObject({
            state: 'text',
            modified: 'feature\n',
        });
        expect((await h.fetch(`${base}/file${query}&scope=all&path=dev.txt`)).status).toBe(404);
        expect(gh.calls()).toHaveLength(reads);

        // The pull request merged and the branch went on: no pull request, and the folder's own base again.
        gh.reply('feature', {
            body: graphql([node({ baseRefName: 'dev', state: 'MERGED', headRefOid: git(path, 'rev-parse', 'HEAD') })]),
        });
        now += 20_000;
        commitMore(path, 'after.txt');
        expect(await json<GitPullRequestInfo>(await h.fetch(`${base}/pull-request${query}`))).toEqual({
            isRepository: true,
            access: 'ready',
            repo: { host: 'github.com', owner: 'acme', name: 'app' },
        });
        expect(await baseOf()).toMatchObject({ name: 'main', ahead: 3 });
        expect(await json(await h.fetch(`${base}/file${query}&scope=all&path=dev.txt`))).toMatchObject({
            state: 'text',
        });
    });
});

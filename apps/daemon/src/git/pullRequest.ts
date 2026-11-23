import { MAX_GIT_CHECKS } from '@clowdy/protocol';
import { statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { gitAnswer, gitLine, gitRead } from '../domain/git';
import { unavailable } from '../errors';
import { runProgram } from '../providers/exec';
import { parseRemote } from './githubRemote';
import { asObject, assemblePullRequest, asString, choosePullRequest, readPullRequest } from './pullRequestRollup';
import { workingTreeRoot } from './state';
import { commitAt } from './status';

import type { GitHubAccess, GitHubRepo, GitPullRequest, GitPullRequestInfo } from '@clowdy/protocol';
import type { Place } from '../domain/places';
import type { CommandError } from '../errors';
import type { RunResult } from '../providers/exec';
import type { Json } from './pullRequestRollup';

type Env = Record<string, string | undefined>;

/** How long one answer about a branch is kept: windows that ask within it share it, and a check that finishes shows within it. */
const ANSWER_TTL_MS = 15_000;

/** How long `gh` being there, and signed in for a host, is kept. What was found missing is kept briefly, since the person installs it or signs in and comes back. */
const ACCESS_TTL_MS = 60_000;
const ACCESS_MISS_TTL_MS = 5000;

/** How long the base branch of a place's pull request is offered to the git reads that do not ask GitHub (`PullRequests.baseHint`). */
const HINT_TTL_MS = 10 * 60_000;

/** How many answers, places and hosts are kept; the oldest go first. */
const MAX_KEPT = 200;

/** What `gh` is given to do: ask whether it is installed, whether a host knows it, and one read of GitHub. */
const VERSION_TIMEOUT_MS = 10_000;
const LOGIN_TIMEOUT_MS = 15_000;
const READ_TIMEOUT_MS = 30_000;

/** The most `gh` prints of a read: past it the answer is cut and cannot be read (about 20 pull requests with 100 checks of 300 characters each is 600 KB). */
const READ_MAX_CHARS = 2 * 1024 * 1024;

/** How many pull requests of one branch are read: a branch name that was used again and again has more, and the newest are what counts. */
const PULL_REQUESTS_READ = 20;

/** The fields of a pull request that an older GitHub Enterprise may not have: a server that says it has none of one is asked again without it, and remembered. */
const OPTIONAL_FIELDS = ['reviewDecision', 'mergeStateStatus', 'mergeable'];

// ---------------------------------------------------------------------------------------------------------------------
// gh
// ---------------------------------------------------------------------------------------------------------------------

/** What `gh` is run to read: the branch's pull requests of a repository and the repository's own default branch. The `$`-names are variables, so no value is part of the text. */
function queryOf(omitted: ReadonlySet<string>): string {
    const optional = OPTIONAL_FIELDS.filter(field => !omitted.has(field)).join(' ');

    return [
        'query($owner: String!, $name: String!, $head: String!) { repository(owner: $owner, name: $name) { defaultBranchRef { name }',
        `pullRequests(headRefName: $head, first: ${ PULL_REQUESTS_READ }, orderBy: { field: CREATED_AT, direction: DESC }) { nodes {`,
        `number title state url isDraft baseRefName headRefName headRefOid updatedAt isCrossRepository headRepositoryOwner { login } ${ optional }`,
        `commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: ${ MAX_GIT_CHECKS }) {`,
        'nodes { __typename ... on CheckRun { name status conclusion detailsUrl startedAt } ... on StatusContext { context state targetUrl createdAt } }',
        'pageInfo { hasNextPage } } } } } } } } } }',
    ].join(' ');
}

/** What the app shows when GitHub cannot be read, in our own words. */
const RATE_LIMIT = 'GitHub\'s rate limit is reached';
const NOT_VISIBLE = 'GitHub doesn\'t show this repository to the signed-in account';
const UNREADABLE = 'GitHub\'s answer couldn\'t be read';

const RATE_LIMITED = /rate limit|abuse detection|secondary rate|HTTP 429/i;
const NOT_SIGNED_IN = /gh auth login|not logged in|authentication required|HTTP 401|bad credentials|requires authentication/i;
const NOT_FOUND = /HTTP 404|could not resolve to a repository/i;
const NO_ANSWER = /HTTP 5\d\d|time(?:d )?out|connection|no such host|dial tcp|\bEOF\b|network|unreachable|reset by peer/i;

/** What a failed `gh` run came to: that its login is no good, or why the pull request could not be read. */
type Failure = { signedIn: false } | { signedIn: true; message: string };

/** Why `gh` failed, from its exit code and what it said, in words of our own: its text is not passed on. */
function failureOf(result: Pick<RunResult, 'code' | 'stderr'>): Failure {
    const said = result.stderr;

    if (RATE_LIMITED.test(said)) return { signedIn: true, message: RATE_LIMIT };

    if (result.code === 4 || NOT_SIGNED_IN.test(said)) return { signedIn: false };

    if (NOT_FOUND.test(said)) return { signedIn: true, message: NOT_VISIBLE };

    if (NO_ANSWER.test(said)) return { signedIn: true, message: 'GitHub didn\'t answer' };

    if (/HTTP 403/i.test(said)) return { signedIn: true, message: 'GitHub refused the request' };

    return { signedIn: true, message: 'Couldn\'t read the pull request' };
}

/** `gh`'s answer to the read as the JSON GitHub sent, which it prints also when it exits with a failure for the errors in it. */
function bodyOf(stdout: string): Json | undefined {
    if (!stdout.trimStart().startsWith('{')) return undefined;

    try {
        return asObject(JSON.parse(stdout));
    }
    catch {
        return undefined;
    }
}

/** The optional field a GraphQL error says the server does not have, nothing for any other error. */
function missingField(error: unknown): string | undefined {
    const object = asObject(error);
    const named = asString(asObject(object?.extensions)?.fieldName) ?? /Field '(\w+)' doesn't exist on type/.exec(asString(object?.message) ?? '')?.[1];

    return named !== undefined && OPTIONAL_FIELDS.includes(named) ? named : undefined;
}

/** What a read of one branch's pull requests found. */
type Found = { signedIn: false } | { signedIn: true; defaultBranch?: string; pullRequests: unknown[] };

// ---------------------------------------------------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------------------------------------------------

/** What is known about reaching a host: `gh` and its path, or why not. */
type Access = { kind: 'ready'; gh: string } | { kind: Exclude<GitHubAccess, 'ready' | 'no_remote'> };

/** Values kept for a time, by key, each asked for once at a time however many ask. */
class Cache<V> {
    readonly #kept = new Map<string, { value: V; until: number }>();
    readonly #pending = new Map<string, Promise<V>>();

    constructor(private readonly now: () => number, private readonly limit: number) {}

    /** The value kept for `key`, else what `load` finds, asked once for everyone who asks meanwhile. `load` says how long the value is kept (0: not at all); one that throws keeps nothing and fails all of them. */
    get(key: string, load: () => Promise<{ value: V; keepMs: number }>): Promise<V> {
        const kept = this.#kept.get(key);

        if (kept && kept.until > this.now()) return Promise.resolve(kept.value);

        let pending = this.#pending.get(key);

        if (!pending) {
            pending = load()
                .then(({ value, keepMs }) => {
                    if (keepMs > 0) this.set(key, value, keepMs);

                    return value;
                })
                .finally(() => this.#pending.delete(key));
            this.#pending.set(key, pending);
        }

        return pending;
    }

    /** The value kept for `key`, if it is still good. */
    peek(key: string): V | undefined {
        const kept = this.#kept.get(key);

        return kept && kept.until > this.now() ? kept.value : undefined;
    }

    set(key: string, value: V, keepMs: number): void {
        this.#kept.delete(key);

        while (this.#kept.size >= this.limit) this.#kept.delete(this.#kept.keys().next().value as string);

        this.#kept.set(key, { value, until: this.now() + keepMs });
    }

    delete(key: string): void {
        this.#kept.delete(key);
    }
}

export interface PullRequestsOptions {
    /** The environment `gh` runs in, and the `PATH` it is looked for on: the daemon's own, which already has the login shell's `PATH`. Read at each call. */
    env?: () => Env;
    /** Where `gh` is looked for after the `PATH`: the usual places of the platform. */
    fallbackPaths?: readonly string[];
    /** The clock, in milliseconds. */
    now?: () => number;
    /** How many answers (and as many places and hosts) are kept, the oldest going first: `MAX_KEPT`. */
    keep?: number;
}

/** The places the person's `gh` is usually installed, which a `PATH` of an app started from the dock may not have. */
function usualPaths(env: Env): string[] {
    return process.platform === 'win32'
        ? [join(env.ProgramFiles ?? 'C:\\Program Files', 'GitHub CLI', 'gh.exe')]
        : ['/opt/homebrew/bin/gh', '/usr/local/bin/gh'];
}

/** Whether a file is at the path. */
function isFile(path: string): boolean {
    try {
        return statSync(path).isFile();
    }
    catch {
        return false;
    }
}

/** Why a run of `gh` gave nothing to go on, when it did not: it did not answer in time, the daemon was stopping, or it could not be started. */
function unanswered(run: RunResult, subject: string): CommandError | undefined {
    if (run.timedOut) return unavailable(`${ subject } didn't answer in time`);

    if (run.error === 'stopped') return unavailable('The daemon is stopping');

    return run.error === undefined ? undefined : unavailable('Couldn\'t run gh');
}

/** What an answer about a branch is kept by: the repository, the branch and the commit the place is at (a new commit asks again). */
const answerKey = (repo: GitHubRepo, branch: string, commit: string): string => `${ repo.host }/${ repo.owner }/${ repo.name }#${ branch }@${ commit }`;

/**
 * Whether the place's HEAD has commits that the pull request's branch lacks, so the pull request is about work the branch has left behind. A commit the repository does
 * not have (the person has not fetched it), a git that cannot say, and a hash that is not one count as "not moved past", so the pull request stays.
 */
async function movedPast(cwd: string, headCommit: string): Promise<boolean> {
    if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(headCommit) || !await commitAt(cwd, headCommit)) return false;

    const read = await gitRead(cwd, ['merge-base', '--is-ancestor', 'HEAD', headCommit]);

    return !read.ok && read.reason === 'failed';
}

/**
 * The pull request of a place's branch, read through the person's own `gh`: the one door to GitHub, with no token kept, read or asked for (`gh` holds the login, and its
 * environment is the daemon's own with nothing added). Three things are kept for a time, each asked for once at a time however many windows ask: that `gh` is there, that it
 * is signed in for a host (a minute; a no is kept for a few seconds), and the answer for a branch (a few seconds, by host, repository, branch and the commit the place is
 * at). The address of `origin` is read to get the host, the owner and the name, and goes no further.
 */
export class PullRequests {
    readonly #env: () => Env;
    readonly #fallbackPaths?: readonly string[];
    readonly #presence: Cache<string | undefined>;
    readonly #logins: Cache<boolean>;
    readonly #answers: Cache<GitPullRequestInfo>;
    /** The base of the pull request last found for a place, and the branch it was found for. */
    readonly #hints: Cache<{ branch: string; base: string }>;
    /** What a host's server does not have of `OPTIONAL_FIELDS`. */
    readonly #omitted = new Map<string, Set<string>>();
    readonly #stopper = new AbortController();

    constructor({ env = () => process.env, fallbackPaths, now = Date.now, keep = MAX_KEPT }: PullRequestsOptions = {}) {
        this.#env = env;
        this.#fallbackPaths = fallbackPaths;
        this.#presence = new Cache(now, keep);
        this.#logins = new Cache(now, keep);
        this.#answers = new Cache(now, keep);
        this.#hints = new Cache(now, keep);
    }

    /** Ends the `gh` runs that are going on, and refuses new ones. */
    stop(): void {
        this.#stopper.abort();
    }

    /**
     * The base branch of the pull request this place was last found to have (`main`), for the git reads that compare a place with its base (`BaseOptions.base`). It is what
     * `read` last found for the branch the place has checked out now: it asks git for that branch and never runs `gh`, so the routes of status and changes can pass it freely.
     * It is nothing for a place that has had no read, whose last read found no pull request, that has moved to another branch (or a detached HEAD) since, or when the read was a
     * while ago (`HINT_TTL_MS`).
     */
    async baseHint(place: Place): Promise<string | undefined> {
        const hint = this.#hints.peek(place.path);

        // Most places have none: git is not asked for those.
        if (!hint) return undefined;

        return hint.branch === await gitLine(place.path, ['branch', '--show-current']) ? hint.base : undefined;
    }

    /**
     * Forgets the answer kept for the place's branch at the commit it is at, so the next `read` asks GitHub again. A push moves what GitHub says of the branch (a pull request
     * opened for it, its checks started) without moving HEAD, which is what the answer is kept by; a fetch brings the commit of a merged pull request that `read` judges it by.
     */
    async forget(place: Place): Promise<void> {
        const { branch, commit, repo } = await this.#target(place.path);

        if (repo && branch !== undefined && commit !== undefined) this.#answers.delete(answerKey(repo, branch, commit));
    }

    /** The branch, the commit and the repository `origin` names, of the place at `cwd`: what an answer is kept by. */
    async #target(cwd: string): Promise<{ branch: string | undefined; commit: string | undefined; repo?: GitHubRepo }> {
        const [branch, commit, address] = await Promise.all([
            gitAnswer(cwd, ['branch', '--show-current']),
            gitAnswer(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD']),
            gitAnswer(cwd, ['remote', 'get-url', 'origin']),
        ]);
        const repo = address === undefined ? undefined : parseRemote(address);

        return { branch, commit, ...(repo && { repo }) };
    }

    /** What GitHub says of the place's branch (`GET .../git/pull-request`): see `GitPullRequestInfo`. */
    async read(place: Place): Promise<GitPullRequestInfo> {
        const cwd = place.path;

        if (!await workingTreeRoot(cwd)) return this.#answer(cwd, { isRepository: false });

        const { branch, commit, repo } = await this.#target(cwd);

        if (!repo) return this.#answer(cwd, { isRepository: true, access: 'no_remote' });

        // A detached HEAD and a branch with no commit have no branch to look up: `gh` is not asked.
        if (branch === undefined || commit === undefined) return this.#answer(cwd, { isRepository: true, access: 'ready', repo });

        const access = await this.#accessTo(repo.host);

        if (access.kind !== 'ready') return this.#answer(cwd, { isRepository: true, access: access.kind, repo });

        const info = await this.#answers.get(answerKey(repo, branch, commit), async () => {
            const found = await this.#find(access.gh, repo, branch);

            // The login is no good any more, whatever was believed a moment ago: ask again next time.
            if (!found.signedIn) {
                this.#logins.delete(repo.host);

                return { value: { isRepository: true, access: 'not_signed_in', repo }, keepMs: 0 };
            }

            const pullRequest = await this.#choose(cwd, repo, branch, found);

            return { value: { isRepository: true, access: 'ready', repo, ...(pullRequest && { pullRequest }) }, keepMs: ANSWER_TTL_MS };
        });

        return this.#answer(cwd, info, branch);
    }

    /** Remembers the base of the pull request in the answer for the place and its branch (and forgets it when there is none), and gives the answer back. */
    #answer(cwd: string, info: GitPullRequestInfo, branch?: string): GitPullRequestInfo {
        if (branch !== undefined && info.isRepository && info.pullRequest) {
            this.#hints.set(cwd, { branch, base: info.pullRequest.base }, HINT_TTL_MS);
        }
        else {
            this.#hints.delete(cwd);
        }

        return info;
    }

    /** `gh`, run with the daemon's environment and nothing more, away from any repository. */
    #run(gh: string, args: string[], timeoutMs: number, maxChars?: number): Promise<RunResult> {
        const env = Object.fromEntries(Object.entries(this.#env()).filter((entry): entry is [string, string] => entry[1] !== undefined));

        return runProgram(gh, args, { env, cwd: tmpdir(), timeoutMs, ...(maxChars !== undefined && { maxChars }), signal: this.#stopper.signal });
    }

    /** Where a `gh` that runs is, nothing when there is none. A `gh` that was started and did not answer is `unavailable`. */
    #locateGh(): Promise<string | undefined> {
        return this.#presence.get('gh', async () => {
            const env = this.#env();
            const found = Bun.which('gh', { PATH: env.PATH ?? '' });
            const candidates = [...(found ? [found] : []), ...(this.#fallbackPaths ?? usualPaths(env))];

            for (const path of candidates) {
                if (!isFile(path)) continue;

                const run = await this.#run(path, ['--version'], VERSION_TIMEOUT_MS);

                // A `gh` that cannot be started is no `gh`; one that does not answer, or a daemon that is stopping, is no answer.
                if (run.timedOut || run.error === 'stopped') throw unanswered(run, 'gh');

                if (run.code === 0) return { value: path, keepMs: ACCESS_TTL_MS };
            }

            return { value: undefined, keepMs: ACCESS_MISS_TTL_MS };
        });
    }

    /**
     * Whether `gh` is signed in for the host, by the exit code of `gh auth status --hostname`: a token is never asked for, and what it prints is read only to tell a `gh` that
     * lacks `--active`. The command fails when any account of the host has a bad token, so it is asked of the active account alone, the one `gh api` uses; a `gh` too old to
     * have the flag says so and is asked without it.
     */
    async #accessTo(host: string): Promise<Access> {
        const gh = await this.#locateGh();

        if (gh === undefined) return { kind: 'no_gh' };

        const signedIn = await this.#logins.get(host, async () => {
            let run = await this.#run(gh, ['auth', 'status', '--hostname', host, '--active'], LOGIN_TIMEOUT_MS);

            if (run.code !== 0 && /unknown flag/i.test(run.stderr)) run = await this.#run(gh, ['auth', 'status', '--hostname', host], LOGIN_TIMEOUT_MS);

            const failed = unanswered(run, 'gh');

            if (failed) throw failed;

            return { value: run.code === 0, keepMs: run.code === 0 ? ACCESS_TTL_MS : ACCESS_MISS_TTL_MS };
        });

        return signedIn ? { kind: 'ready', gh } : { kind: 'not_signed_in' };
    }

    /**
     * One `gh api graphql` read of the branch's pull requests. A server that has not a field of `OPTIONAL_FIELDS` says so in its errors, and is asked again without it (the
     * names it lacks are kept for its host). Any failure but a login that is no good is `unavailable` with a short reason of our own, never an answer that says there is none.
     */
    async #find(gh: string, repo: GitHubRepo, branch: string): Promise<Found> {
        const omitted = this.#omitted.get(repo.host) ?? new Set<string>();

        this.#omitted.set(repo.host, omitted);

        for (let attempt = 0; attempt <= OPTIONAL_FIELDS.length; attempt++) {
            const args = ['api', 'graphql', '--hostname', repo.host, '--method', 'POST', '-f', `query=${ queryOf(omitted) }`, '-f', `owner=${ repo.owner }`, '-f', `name=${ repo.name }`, '-f', `head=${ branch }`];
            const run = await this.#run(gh, args, READ_TIMEOUT_MS, READ_MAX_CHARS);

            const failed = unanswered(run, 'GitHub');

            if (failed) throw failed;

            const body = bodyOf(run.stdout);
            const errors = Array.isArray(body?.errors) ? body.errors as unknown[] : [];
            const lacking = errors.map(missingField).find((field): field is string => field !== undefined && !omitted.has(field));

            if (lacking !== undefined) {
                omitted.add(lacking);

                continue;
            }

            const repository = asObject(asObject(body?.data)?.repository);

            if (!repository) {
                const type = asString(asObject(errors[0])?.type);

                if (type === 'NOT_FOUND') throw unavailable(NOT_VISIBLE);

                if (type === 'RATE_LIMITED') throw unavailable(RATE_LIMIT);

                if (run.code === 0) throw unavailable(UNREADABLE);

                const failure = failureOf(run);

                if (!failure.signedIn) return { signedIn: false };

                throw unavailable(failure.message);
            }

            const pullRequests = asObject(repository.pullRequests)?.nodes;

            if (!Array.isArray(pullRequests)) throw unavailable(UNREADABLE);

            const defaultBranch = asString(asObject(repository.defaultBranchRef)?.name);

            return { signedIn: true, ...(defaultBranch && { defaultBranch }), pullRequests };
        }

        throw unavailable('Couldn\'t read the pull request');
    }

    /** The pull request that is the branch's own, or nothing: the choice among those found, less one that HEAD has moved past. */
    async #choose(cwd: string, repo: GitHubRepo, branch: string, found: Extract<Found, { signedIn: true }>): Promise<GitPullRequest | undefined> {
        const candidates = found.pullRequests.flatMap((node) => {
            const pr = readPullRequest(node, repo.owner);

            return pr ? [pr] : [];
        });
        const chosen = choosePullRequest(candidates, { branch, ...(found.defaultBranch && { defaultBranch: found.defaultBranch }) });

        // A merged or closed pull request is about the work that was on the branch then: new commits since make it no pull request of what is checked out, and Create PR is offered again.
        if (!chosen || (chosen.state !== 'OPEN' && await movedPast(cwd, chosen.headCommit))) return undefined;

        return assemblePullRequest(chosen);
    }
}

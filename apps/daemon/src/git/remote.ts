import { gitAnswer, gitRead } from '../domain/git';
import { exclusive } from '../domain/workspaces';
import { conflict, invalid, unavailable } from '../errors';
import { runProgram } from '../providers/exec';
import { printedLines, shownLine, writeLine } from './commit';
import { rememberFetch } from './lastFetch';
import { workingTreeRoot } from './state';
import { parseStatus } from './status';
import { namesSigningKey, SIGNING_HINT, WriteEnvironment } from './writeEnv';

import type { GitErrorDetails, GitRemoteAction, GitRemoteResult, GitUpstream } from '@clowdy/protocol';
import type { Place } from '../domain/places';
import type { RunResult } from '../providers/exec';
import type { Store } from '../store';
import type { GitWritesOptions } from './commit';

/**
 * A push or a fetch over SSH may wait for the person's fingerprint (a key held by Secretive asks for Touch ID), or for a network that is slow to answer, so each git run gets about two
 * minutes; past it git is asked to stop and the action is `unavailable`. A pull is a fetch and a local merge, each with its own two minutes.
 */
const REMOTE_TIMEOUT_MS = 120_000;

/** The most of what git prints that is kept: only one line of it is ever shown. */
const MAX_PRINTED_CHARS = 256 * 1024;

/** The only remote the app moves commits to and from. */
const ORIGIN = 'origin';

/** Keeps a fetch to `origin`: git also fetches a submodule from its own remote when the commit of it that the superproject points at has moved, which is another remote and another failure. */
const NO_SUBMODULES = ['--no-recurse-submodules'];

/**
 * What git says around the line that matters, and says in every failure: the summary after the cause of a failed push, the second line of a failed connection, and the page a fetch
 * and a push name their remote on. These are never the line shown while a more particular one is there. So are the lines that say nothing of a cause: a `warning:`, a `remote:` with
 * nothing after it, and the remote's own progress (`remote: Resolving deltas: 100% ...`), which a remote may print before the line that says why it refused.
 */
const SUMMARY_LINE = /^(?:To |From |error: failed to push some refs|fatal: Could not read from remote repository|fatal: the remote end hung up unexpectedly|Please make sure you have the correct access rights|and the repository exists|hint:|warning:|remote:\s*$|remote: (?:Resolving deltas|Counting objects|Enumerating objects|Compressing objects|Total ))/i;

/**
 * The line git writes for a ref it would not send, which says why in its own parentheses: `! [rejected] main -> main (fetch first)`. A ref that the remote declined
 * (`! [remote rejected]`) is not this: the remote said why in its own `remote:` lines before it, which are the better line.
 */
const REJECTED_REF = /^!\s*\[rejected\]/i;

/** What git says first that is the cause: the line that names the signing key, else the refused ref, else the first line that is not a summary (a hook's line, ssh's, a remote's `remote:` line), else git's own first `fatal:` or `error:`. */
export function remoteFailureLine(stderr: string, stdout: string, fallback: string): string {
    const printed = printedLines(stderr);
    const line = printed.find(namesSigningKey)
        ?? printed.find(candidate => REJECTED_REF.test(candidate))?.replace(/\s+/g, ' ')
        ?? printed.find(candidate => !SUMMARY_LINE.test(candidate))
        ?? printed.find(candidate => /^(?:fatal|error):/i.test(candidate))
        ?? printedLines(stdout)[0]
        ?? fallback;

    return shownLine(line);
}

/** Where the place's HEAD is, as far as the actions need to know it, and where the branch is set to go. */
interface Head {
    /** The branch checked out; absent on a detached HEAD. */
    branch?: string;
    /** The branch has a commit. */
    born: boolean;
    /** The remote and the branch the branch tracks, as `branch.<name>.remote` and `.merge` say; absent when it tracks nothing. */
    tracking?: { remote: string; merge: string };
}

/**
 * What the daemon does between a person's branch and their `origin`: fetch, pull and push (which is also how a branch is published). The three run the person's own `git`
 * in the place, no shell, with their configuration and the write environment (`WriteEnvironment`: no prompt for a password, the signing agent's socket), on the place's one line
 * of writes (`writeLine`), so a commit and a push never overlap; nothing here runs on its own. **Only `origin` counts**, and nothing is ever forced:
 *
 * - fetch is `git fetch --no-recurse-submodules origin`: the submodules' own remotes are not asked (git does that by itself for a submodule whose commit moved, and a failure there ends the
 *   fetch with an error though `origin` was fetched);
 * - pull fetches, then takes what the upstream has with `git merge --ff-only`; a branch that diverged from its upstream (commits on both sides, counted with `rev-list --left-right --count`
 *   before anything moves) is answered as `diverged` and left alone: no merge, no rebase, no reset. It merges itself, and does not call `git pull`, so the network is asked once;
 * - push is `git push origin refs/heads/<branch>:<the upstream's ref>` for a branch that has an upstream, and `git push -u origin refs/heads/<branch>:refs/heads/<branch>` (publish) for one
 *   that has none. The branch is spelled as a full ref, never `HEAD`, so a branch that an agent or the person switched to while the push waited is not sent in its place, and a tag of its name
 *   is not meant. The refspec is given on the command line, so what the person's configuration says (`push.default`, `remote.origin.push`, a `+` in it) cannot widen it, and `--no-follow-tags`
 *   and `--no-recurse-submodules` keep a tag and a submodule from going with it. Never `--force`, never `--no-verify`.
 *
 * A place that is not a repository, a repository with no `origin`, a detached HEAD, a branch with no commit (pull and push) and a branch that tracks another remote are `invalid`. A
 * refusal by git is `conflict` with the line that says why (`remoteFailureLine`) and, for a signing or agent failure, the hint of `writeEnv`; a run that does not end in time and the daemon stopping are `unavailable`.
 */
export class GitRemote {
    readonly environment: WriteEnvironment;
    readonly #store: Store;
    readonly #timeoutMs: number;
    readonly #stopper = new AbortController();

    constructor({ store, environment = new WriteEnvironment(), timeoutMs = REMOTE_TIMEOUT_MS }: GitWritesOptions) {
        this.#store = store;
        this.environment = environment;
        this.#timeoutMs = timeoutMs;
    }

    /** Ends the git that is running, and refuses new actions. */
    stop(): void {
        this.#stopper.abort();
    }

    /** `POST .../git/fetch`: `git fetch --no-recurse-submodules origin`. */
    fetch(place: Place): Promise<GitRemoteResult> {
        return this.#alone(place, async () => {
            await this.#inspect(place);
            await this.#run(place, 'fetch', ['fetch', ...NO_SUBMODULES, ORIGIN]);
            await rememberFetch(place.path);

            const upstream = await this.#upstream(place);

            return { state: 'done', action: 'fetch', ...(upstream && { upstream }) };
        });
    }

    /** `POST .../git/pull`: fetches `origin` and fast-forwards the branch to its upstream; a diverged branch is `diverged` and untouched. */
    pull(place: Place): Promise<GitRemoteResult> {
        return this.#alone(place, async () => {
            const { branch, tracking } = await this.#branchOf(place, 'pull');

            if (!tracking) throw invalid(`${ branch } has no upstream to pull from, publish it first`);

            await this.#run(place, 'pull', ['fetch', ...NO_SUBMODULES, ORIGIN]);
            await rememberFetch(place.path);

            const apart = await this.#apart(place);

            if (!apart) throw invalid(`${ tracking.merge.replace(/^refs\/heads\//, '') } is no longer on origin`);

            if (apart.ahead > 0 && apart.behind > 0) {
                const upstream = await this.#upstream(place);

                return { state: 'diverged', upstream: { name: upstream?.name ?? `${ ORIGIN }/${ branch }`, ahead: apart.ahead, behind: apart.behind } };
            }

            if (apart.behind > 0) await this.#run(place, 'pull', ['merge', '--ff-only', '@{upstream}']);

            const upstream = await this.#upstream(place);

            return { state: 'done', action: 'pull', pulled: apart.behind, ...(upstream && { upstream }) };
        });
    }

    /** `POST .../git/push`: the branch to its upstream, or published to `origin` with an upstream when it has none. */
    push(place: Place): Promise<GitRemoteResult> {
        return this.#alone(place, async () => {
            const { branch, tracking } = await this.#branchOf(place, 'push');
            // A branch is published when it tracks nothing, and also when what it tracks is not on origin (the upstream is set and the remote's branch is gone): it is sent as a new one.
            const publish = tracking === undefined || await gitAnswer(place.path, ['rev-parse', '--verify', '--quiet', '@{upstream}']) === undefined;

            // Everything a person's configuration may add to a push (other refs, a force, tags, submodules) is overridden here: the branch goes to the branch it tracks, or to the one of its own
            // name when it tracks none (`-u` then makes it track that), nothing else. The source is spelled as a full ref (never `HEAD`, which is whatever is checked out when git runs, not
            // the branch that was judged), so a tag of the branch's name is not meant, and git names the ref as the branch in what it says of a refusal.
            await this.#run(place, 'push', ['push', '--no-follow-tags', '--no-recurse-submodules', ...(tracking === undefined ? ['-u'] : []), ORIGIN, `refs/heads/${ branch }:${ tracking?.merge ?? `refs/heads/${ branch }` }`]);

            const upstream = await this.#upstream(place);

            return { state: 'done', action: 'push', ...(publish && { published: true as const }), ...(upstream && { upstream }) };
        });
    }

    /** Runs `work` once the place's earlier writes have ended, and not while another starts. */
    #alone<T>(place: Place, work: () => Promise<T>): Promise<T> {
        return exclusive(this.#store, writeLine(place), this.#stopper.signal, work);
    }

    /** That the place is the root of a repository with an `origin`, and where its HEAD is. Judged on the place's line, so what it says is what the action finds. */
    async #inspect(place: Place): Promise<Head> {
        const cwd = place.path;

        if (!await workingTreeRoot(cwd)) throw invalid('The folder is not the root of a git repository');

        if (await gitAnswer(cwd, ['remote', 'get-url', ORIGIN]) === undefined) throw invalid('The repository has no origin');

        const branch = await gitAnswer(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']);

        if (branch === undefined) return { born: await gitAnswer(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD']) !== undefined };

        const [remote, merge, commit] = await Promise.all([
            gitAnswer(cwd, ['config', '--get', `branch.${ branch }.remote`]),
            gitAnswer(cwd, ['config', '--get', `branch.${ branch }.merge`]),
            gitAnswer(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD']),
        ]);

        return { branch, born: commit !== undefined, ...(remote !== undefined && merge !== undefined && { tracking: { remote, merge } }) };
    }

    /**
     * The branch a pull or a push is about: it has to be on a branch that has a commit and, when it tracks something, track a branch of `origin` (a branch of another remote, a local
     * branch and a tag are not the app's to move).
     */
    async #branchOf(place: Place, action: 'pull' | 'push'): Promise<{ branch: string; tracking?: { remote: string; merge: string } }> {
        const head = await this.#inspect(place);

        if (head.branch === undefined) throw invalid(`HEAD is detached, switch to a branch to ${ action }`);

        if (!head.born) throw invalid(`${ head.branch } has no commits yet`);

        const { tracking } = head;

        if (tracking && tracking.remote !== ORIGIN) throw invalid(`${ head.branch } tracks ${ tracking.remote === '.' ? 'a local branch' : shownLine(tracking.remote) }, and only ${ ORIGIN } is used`);

        if (tracking && !tracking.merge.startsWith('refs/heads/')) throw invalid(`${ head.branch } tracks ${ tracking.merge }, which is not a branch of ${ ORIGIN }`);

        return { branch: head.branch, ...(tracking && { tracking }) };
    }

    /** How many commits the branch has that its upstream lacks and the other way round, as last fetched; nothing when the upstream is not there. */
    async #apart(place: Place): Promise<{ ahead: number; behind: number } | undefined> {
        const counts = await gitAnswer(place.path, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}']);
        const [ahead, behind] = (counts ?? '').split(/\s+/).map(Number);

        return counts === undefined || ahead === undefined || behind === undefined || Number.isNaN(ahead) || Number.isNaN(behind) ? undefined : { ahead, behind };
    }

    /** The branch's upstream as it stands now, with how far apart the two are; nothing for a branch that tracks none and for a HEAD that is on no branch. */
    async #upstream(place: Place): Promise<GitUpstream | undefined> {
        const read = await gitRead(place.path, ['status', '--porcelain=v2', '--branch', '--untracked-files=no', '-z'], { parsed: true });

        return read.ok ? parseStatus(read.stdout.split('\0')).upstream : undefined;
    }

    /** `git <args>` in the place with the write environment, asked to stop with `SIGTERM` so it removes its lock files when the time is up; throws what a run that did not succeed came to. */
    async #run(place: Place, action: GitRemoteAction, args: string[]): Promise<void> {
        const env = await this.environment.of(place.path);
        const run = await runProgram('git', args, { env, cwd: place.path, timeoutMs: this.#timeoutMs, maxChars: MAX_PRINTED_CHARS, signal: this.#stopper.signal, stopSignal: 'SIGTERM' });

        this.#check(run, action);
    }

    /** Throws what a run that did not succeed came to, in words the person reads; returns when it did. */
    #check(run: RunResult, action: GitRemoteAction): void {
        if (run.error === 'stopped') throw unavailable('The daemon is stopping');

        if (run.timedOut) throw unavailable(`The ${ action } did not finish in time`);

        if (run.error !== undefined) throw unavailable('git is not installed or not on PATH');

        if (run.code === 0) return;

        const line = remoteFailureLine(run.stderr, run.stdout, `git could not ${ action === 'fetch' ? 'fetch from' : action === 'push' ? 'push to' : 'take what is on' } ${ ORIGIN }`);

        if (namesSigningKey(`${ run.stderr }\n${ run.stdout }`)) {
            // What was found of the agent may be what failed: it is looked for again at the next write.
            this.environment.forgetAgent();

            throw conflict(line, { hint: SIGNING_HINT } satisfies GitErrorDetails);
        }

        throw conflict(line);
    }
}

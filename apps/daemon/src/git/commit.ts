import { MAX_GIT_MESSAGE_CHARS } from '@clowdy/protocol';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';

import { gitLine, gitRead } from '../domain/git';
import { exclusive, pathKey, placeOf } from '../domain/workspaces';
import { conflict, invalid, unavailable } from '../errors';
import { runProgram } from '../providers/exec';
import { selectChanged } from './selection';
import { namesSigningKey, SIGNING_HINT, WriteEnvironment } from './writeEnv';

import type { GitCommitRequest, GitCommitResult, GitErrorDetails } from '@clowdy/protocol';
import type { Place } from '../domain/places';
import type { RunResult } from '../providers/exec';
import type { Store } from '../store';

/** A commit may wait for the person's fingerprint (a signing key that asks for one), so it gets time to be reached; a hung agent or hook still ends. */
const COMMIT_TIMEOUT_MS = 120_000;

/** The most of what git and its hooks print that is kept: only one line of it is ever shown. */
const MAX_PRINTED_CHARS = 256 * 1024;

/** The longest line of git's that is shown. */
const MAX_LINE_CHARS = 300;

/** What git says when there is nothing to commit, on its standard output. */
const NOTHING_TO_COMMIT = /nothing (?:added )?to commit|no changes added to commit/i;

export interface GitWritesOptions {
    /** Where the one-at-a-time line of each place is kept (`exclusive`). */
    store: Store;
    /** The environment of every write and its signing agent; the daemon's own by default. */
    environment?: WriteEnvironment;
    /** How long a commit may take: `COMMIT_TIMEOUT_MS`. */
    timeoutMs?: number;
}

/**
 * The first line of what git and its hooks printed that says what went wrong: the line that names the signing key when there is one, else git's own `fatal:` or `error:` line, else
 * the first line of what was printed on its error stream (a hook's), else of its output. One line, cut, without colour codes and without a credential in an address: never the whole of it, since a hook may print anything.
 */
export function failureLine(stderr: string, stdout: string): string {
    // eslint-disable-next-line no-control-regex
    const lines = (text: string) => text.replace(/\u001B\[[0-9;]*[A-Za-z]/g, '').split(/\r?\n/).map(line => line.trim()).filter(line => line !== '');
    const printed = lines(stderr);
    // The line that names the signing key comes first: git adds its own `fatal: failed to write commit object` after what the signing program said.
    const line = printed.find(namesSigningKey) ?? printed.find(candidate => /^(?:fatal|error):/i.test(candidate)) ?? printed[0] ?? lines(stdout)[0] ?? 'git could not make the commit';
    const plain = line.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1');

    return plain.length > MAX_LINE_CHARS ? `${ plain.slice(0, MAX_LINE_CHARS - 1) }…` : plain;
}

/**
 * The writes the daemon makes to a person's repository. Only the commit for now (fetch, pull and push come with their stage). Every write runs the person's own `git` in the place,
 * no shell, with their configuration: their signing, their hooks, their identity; nothing is turned off (`--no-verify`, `commit.gpgsign=false` are never passed), and the environment is
 * `WriteEnvironment`'s. Writes to one place run one after the other (`exclusive`, keyed by the place's real path, so two paths to one folder are one line), since git itself would refuse a
 * second one while the first holds its index lock; reads never wait for them.
 */
export class GitWrites {
    readonly environment: WriteEnvironment;
    readonly #store: Store;
    readonly #timeoutMs: number;
    readonly #stopper = new AbortController();

    constructor({ store, environment = new WriteEnvironment(), timeoutMs = COMMIT_TIMEOUT_MS }: GitWritesOptions) {
        this.#store = store;
        this.environment = environment;
        this.#timeoutMs = timeoutMs;
    }

    /** Ends the git that is running, and refuses new writes. */
    stop(): void {
        this.#stopper.abort();
    }

    /**
     * Commits the files a client ticked (`POST /v1/projects/:id/git/commit`): `git add -- <paths>`, then `git commit -m <message> -- <paths>`, which takes those files alone and leaves
     * everything else changed or staged in the place as it was. The paths are judged against the place's uncommitted changes as the moment finds them (`selectChanged`), a merge, a
     * cherry-pick or a revert in progress and a file with merge conflicts are refused (a partial commit would settle what the person has not looked at), and git's own refusal is the
     * error, as one line (`failureLine`). A commit that was refused takes back what the add staged: a path that was staged before the add stays staged as the person left it.
     */
    async commit(place: Place, request: Pick<GitCommitRequest, 'paths' | 'message'>): Promise<GitCommitResult> {
        const { message } = request;

        if (typeof message !== 'string' || message.trim() === '') throw invalid('Write a message for the commit');

        if (message.length > MAX_GIT_MESSAGE_CHARS) throw invalid(`The message is over ${ MAX_GIT_MESSAGE_CHARS } characters`);

        if (message.includes('\0')) throw invalid('The message has a character that cannot be in a commit');

        // Judged and written on one line, so a second commit of the place reads what the first one left.
        return exclusive(this.#store, `git:${ pathKey(placeOf(place.path)) }`, this.#stopper.signal, async () => {
            const { files, gitPaths } = await selectChanged(place, request.paths);

            await this.#refuseUnsettled(place, files.map(file => file.path));

            const env = await this.environment.of(place.path);
            const run = (args: string[]) => this.#git(place.path, env, args);
            const [toAdd, stagedBefore] = await Promise.all([this.#addable(place.path, gitPaths), this.#staged(place.path, gitPaths)]);

            try {
                // Nothing to add when every path is a removal that is staged already (`git rm`, the old side of `git mv`): the commit below takes it from there.
                if (toAdd.length > 0) this.#check(await run(['add', '--', ...toAdd]));

                this.#check(await run(['commit', '-m', message, '--', ...gitPaths]));
            }
            catch (error) {
                // Takes back what the add staged, which is `git reset` to HEAD for the paths whose entry was HEAD's before; one the person had staged stays as they left it. Best effort: when git
                // cannot (a commit that timed out is still letting go of its lock) the paths stay staged, which is what the next try does first. If the commit landed after all, HEAD is the new commit and the reset changes nothing.
                const added = gitPaths.filter(path => !stagedBefore.has(path));

                if (added.length > 0) await run(['reset', '-q', '--', ...added]);

                throw error;
            }

            const sha = await gitLine(place.path, ['rev-parse', 'HEAD']);

            if (!sha) throw unavailable('The commit was made, but git did not say which');

            return { sha, shortSha: sha.slice(0, 7), subject: message.trim().split('\n')[0]!.trim() };
        });
    }

    /**
     * The paths `git add` can be given: those that are in the working tree or still in the index (a deleted file is staged by adding it). `git add` refuses a path that is neither
     * (`pathspec did not match any files`), which is what the old path of a rename is once the rename is staged: the commit takes it from HEAD.
     */
    async #addable(cwd: string, paths: string[]): Promise<string[]> {
        const indexed = await gitRead(cwd, ['ls-files', '-z', '--cached', '--', ...paths.map(path => `:(literal)${ path }`)]);
        const known = new Set(indexed.ok ? indexed.stdout.split('\0') : []);
        const present = await Promise.all(paths.map(async path => known.has(path) || await lstat(join(cwd, path)).then(() => true, () => false)));

        return paths.filter((_, index) => present[index]);
    }

    /** The paths the index already holds differently from HEAD (staged by the person, or by an agent in the place): what a failed commit must leave staged. When git does not say, every path counts as staged. */
    async #staged(cwd: string, paths: string[]): Promise<Set<string>> {
        const read = await gitRead(cwd, ['diff', '--cached', '--name-only', '-z', '--no-renames', '--', ...paths.map(path => `:(literal)${ path }`)], { parsed: true });

        return new Set(read.ok ? read.stdout.split('\0').filter(path => path !== '') : paths);
    }

    /** A commit of some paths cannot be made in the middle of a merge (git says `cannot do a partial commit during a merge`), and a file with conflicts is not the person's to commit as it is. */
    async #refuseUnsettled(place: Place, paths: string[]): Promise<void> {
        const cwd = place.path;
        const [merging, unmerged] = await Promise.all([
            Promise.all(['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'].map(ref => gitRead(cwd, ['rev-parse', '-q', '--verify', ref]))),
            gitRead(cwd, ['diff', '--name-only', '--diff-filter=U', '-z'], { parsed: true }),
        ]);

        if (merging.some(read => read.ok)) throw conflict('A merge, cherry-pick or revert is in progress here, finish it first');

        const conflicted = unmerged.ok ? unmerged.stdout.split('\0').filter(path => path !== '' && paths.includes(path)) : [];

        if (conflicted.length > 0) throw conflict(`${ conflicted[0] } has merge conflicts`);
    }

    /** `git` in the place with the write environment, asked to stop with `SIGTERM` so it removes its lock files when the time is up. */
    #git(cwd: string, env: Record<string, string>, args: string[]): Promise<RunResult> {
        // The paths are plain names, never patterns: `*`, `[` and a leading `:` in a file's name are the file's own.
        return runProgram('git', ['--literal-pathspecs', ...args], { env, cwd, timeoutMs: this.#timeoutMs, maxChars: MAX_PRINTED_CHARS, signal: this.#stopper.signal, stopSignal: 'SIGTERM' });
    }

    /** Throws what a run that did not succeed came to, in words the person reads; returns when it did. */
    #check(run: RunResult): void {
        if (run.error === 'stopped') throw unavailable('The daemon is stopping');

        if (run.timedOut) throw unavailable('The commit did not finish in time');

        if (run.error !== undefined) throw unavailable('git is not installed or not on PATH');

        if (run.code === 0) return;

        if (NOTHING_TO_COMMIT.test(run.stdout) || NOTHING_TO_COMMIT.test(run.stderr)) throw invalid('Nothing to commit');

        const line = failureLine(run.stderr, run.stdout);

        if (namesSigningKey(`${ run.stderr }\n${ run.stdout }`)) {
            // What was found of the agent may be what failed: it is looked for again at the next write.
            this.environment.forgetAgent();

            throw conflict(line, { hint: SIGNING_HINT } satisfies GitErrorDetails);
        }

        throw conflict(line);
    }
}

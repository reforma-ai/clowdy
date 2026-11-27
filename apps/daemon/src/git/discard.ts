import { realpath, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { MAX_GIT_DISCARD_PATHS } from '@clowdy/protocol';

import { gitRead } from '../domain/git';
import { exclusive } from '../domain/workspaces';
import { conflict, invalid, unavailable } from '../errors';
import { fsFailure, locate, normalizeFsPath } from '../fs/paths';
import { LEFTOVER_GRACE_MS, runProgram } from '../process/run';
import { failureLine, writeLine } from './commit';
import { selectChanged } from './selection';
import { WriteEnvironment } from './writeEnv';

import type { GitChangedFile, GitDiscardedFile, GitDiscardResult } from '@clowdy/protocol';
import type { Place } from '../domain/places';
import type { RunResult } from '../process/run';
import type { Store } from '../store';

/** A restore or a removal of a few files is quick; this is for a smudge filter (Git LFS) that has to be fetched, and for a disk that is slow to answer. */
const DISCARD_TIMEOUT_MS = 60_000;

/** The most of what git prints that is kept: only one line of it is ever shown. */
const MAX_PRINTED_CHARS = 256 * 1024;

/** The mode git records for a submodule. */
const SUBMODULE_MODE = '160000';

export interface GitDiscardOptions {
    /** Where the one-at-a-time line of each place is kept (`exclusive`). */
    store: Store;
    /** The environment of every write (the commit's and the push's too): the daemon's own by default. */
    environment?: WriteEnvironment;
    /** How long one git run may take: `DISCARD_TIMEOUT_MS`. */
    timeoutMs?: number;
}

/** What a discard knows of one path before it touches it. */
interface Target {
    path: string;
    /** The entry of the changes list the path belongs to: a renamed file has two paths and one entry. */
    file: GitChangedFile;
    /** The last commit has a file at the path (and what it is), which is what a restore brings back. */
    head?: { oid: string };
    /** The index has the path, merged (stage 0). */
    index?: { mode: string; oid: string };
    work: Work;
}

/** What is on the disk at a path, found without following a link. */
type Work = { kind: 'missing' } | { kind: 'file' | 'link'; stamp: string };

/** What tells that a file on the disk is not the one that was inspected: its type, size, time and number. */
const stampOf = (info: { mode: bigint; size: bigint; mtimeNs: bigint; ino: bigint }) =>
    `${info.mode}:${info.size}:${info.mtimeNs}:${info.ino}`;

/** The path as the working tree has it, from the real root. */
const onDisk = (root: string, path: string) => join(root, ...path.split('/'));

/**
 * The discard of the changes of single files deletes work without a recovery copy. A request names the files (never a whole tree); they are judged against what git lists as changed
 * in the place right now, on the place's line of writes (`writeLine`, so it never overlaps a commit, a pull or a push). The paths are inspected and checked again before writing. Then:
 *
 * - a file the last commit has (edited, staged, deleted, a new mode, a link retargeted, a file made a link) goes back to it: `git restore --source=HEAD --staged --worktree`, which
 *   replaces the index and the file, and runs the person's own `post-checkout` hook as git does (a hook that fails after the files are back is a `warning`, see `#restore`);
 * - a file the last commit has not (a new file, staged or not; the new name of a renamed one) is removed from the index (`git rm --cached`) and deleted: that file alone, a link as
 *   the link and never what it points to, never `git clean`, never a folder and never the folders above it;
 * - a file with merge conflicts, a submodule, something that is a folder now, a path that leaves the place or runs through a link, and a path git does not list as changed are refused,
 *   and nothing is done.
 */
export class GitDiscard {
    readonly environment: WriteEnvironment;
    readonly #store: Store;
    readonly #timeoutMs: number;
    readonly #stopper = new AbortController();

    constructor({ store, environment = new WriteEnvironment(), timeoutMs = DISCARD_TIMEOUT_MS }: GitDiscardOptions) {
        this.#store = store;
        this.environment = environment;
        this.#timeoutMs = timeoutMs;
    }

    /** Ends the git that is running, and refuses new discards. */
    stop(): void {
        this.#stopper.abort();
    }

    /** Discards the named files of the place and says what happened to each one. */
    discard(place: Place, paths: unknown): Promise<GitDiscardResult> {
        return exclusive(this.#store, writeLine(place), this.#stopper.signal, () => this.#discard(place, paths));
    }

    async #discard(place: Place, paths: unknown): Promise<GitDiscardResult> {
        const cwd = place.path;
        // The judging is the commit's: what git lists as changed in the place right now, so nothing is touched that the person was not shown.
        const { files, gitPaths } = await selectChanged(place, paths, MAX_GIT_DISCARD_PATHS);

        if (files.some(file => file.kind === 'conflicted')) throw conflict('Resolve the conflict first');

        const root = await realpath(cwd).catch(() => cwd);
        const targets = await this.#inspect(cwd, root, files, gitPaths);
        const env = await this.environment.of(cwd);
        const git = (args: string[]) => this.#git(cwd, env, args);
        // A file may have changed after inspection, for example while preparing the write environment.
        await this.#unchanged(root, targets);

        const toRestore = targets.filter(target => target.head).map(target => target.path);
        const toUnstage = targets.filter(target => !target.head && target.index).map(target => target.path);
        const toDelete = targets.filter(target => !target.head && target.work.kind !== 'missing');
        let warning: string | undefined;

        // The restore comes first: a file git cannot bring back stops the discard with nothing deleted from the disk.
        if (toRestore.length > 0) warning = await this.#restore(cwd, git, toRestore);

        if (toUnstage.length > 0) this.#check(await git(['rm', '--cached', '-f', '-q', '--', ...toUnstage]));

        for (const target of toDelete) await this.#delete(root, target);

        return {
            discarded: files.map(
                (file): GitDiscardedFile => ({
                    path: file.path,
                    action: targets.some(target => target.file === file && target.head) ? 'restored' : 'removed',
                })
            ),
            ...(warning !== undefined && { warning }),
        };
    }

    /**
     * What the last commit, the index and the disk have at each path (the paths of the files, and the old paths of the renamed ones). The path has to stay in the place: it is walked from
     * the real root one component at a time (`locate`, the file routes' rule), a link on the way is refused (git writes below the link's place, and the link is the person's), and a file
     * in the way of a folder or a folder where a file is expected is refused, since a restore would remove what is in the way.
     */
    async #inspect(cwd: string, root: string, files: GitChangedFile[], gitPaths: string[]): Promise<Target[]> {
        const owner = new Map<string, GitChangedFile>();

        for (const file of files) {
            owner.set(file.path, file);

            if (file.oldPath !== undefined) owner.set(file.oldPath, file);
        }

        for (const path of gitPaths) {
            // The paths the app can name: no backslash or drive letter, and a line break would break the list `git cat-file` is given.
            if (normalizeFsPath(path) !== path || path.includes('\n'))
                throw invalid(`${path} is not a path that can be discarded here`);
        }

        const [heads, indexed] = await Promise.all([this.#headOf(cwd, gitPaths), this.#indexOf(cwd, gitPaths)]);

        if (indexed.unmerged.length > 0) throw conflict('Resolve the conflict first');

        return Promise.all(
            gitPaths.map(
                async (path, position): Promise<Target> => ({
                    path,
                    file: owner.get(path)!,
                    ...(heads[position] && { head: heads[position] }),
                    ...(indexed.entries.has(path) && { index: indexed.entries.get(path) }),
                    work: await this.#workOf(root, path),
                })
            )
        );
    }

    /** What the last commit has at each path: its id when it is a file, a submodule's commit refused on the spot, and nothing for a path it has not or has as a folder. */
    async #headOf(cwd: string, paths: string[]): Promise<Array<{ oid: string } | undefined>> {
        const read = await gitRead(cwd, ['cat-file', '--batch-check'], {
            input: `${paths.map(path => `HEAD:${path}`).join('\n')}\n`,
        });

        if (!read.ok) throw unavailable('git did not answer');

        const lines = read.stdout.split('\n');

        return paths.map((path, position) => {
            const [oid = '', type = ''] = lines[position]?.split(' ') ?? [];

            if (type === 'commit') throw invalid("A submodule can't be discarded here");

            return type === 'blob' ? { oid } : undefined;
        });
    }

    /** What the index has at each path: its merged entry (a submodule refused), and the paths it holds unmerged (conflicts). */
    async #indexOf(
        cwd: string,
        paths: string[]
    ): Promise<{ entries: Map<string, { mode: string; oid: string }>; unmerged: string[] }> {
        const read = await gitRead(cwd, ['ls-files', '--stage', '-z', '--', ...paths.map(path => `:(literal)${path}`)]);

        if (!read.ok) throw unavailable('git did not answer');

        const entries = new Map<string, { mode: string; oid: string }>();
        const unmerged: string[] = [];

        for (const record of read.stdout.split('\0')) {
            const found = /^(\d+) ([0-9a-f]+) (\d)\t([\s\S]*)$/.exec(record);

            if (!found) continue;

            const [, mode = '', oid = '', stage = '', path = ''] = found;

            if (mode === SUBMODULE_MODE) throw invalid("A submodule can't be discarded here");

            if (stage === '0') {
                entries.set(path, { mode, oid });
            } else {
                unmerged.push(path);
            }
        }

        return { entries, unmerged };
    }

    /** What is on the disk at the path, found without following a link, and the refusals of a path that is not a plain place for a file. */
    async #workOf(root: string, path: string): Promise<Work> {
        let located: Awaited<ReturnType<typeof locate>>;

        try {
            located = await locate(root, path, false);
        } catch (error) {
            throw fsFailure(error, path);
        }

        if (located.blockedBy !== undefined)
            throw invalid(`${located.blockedBy} is in the way of ${path}, discard it first`);

        // A link on the way is followed by `locate` when it stays inside the place, and what it found is then not the path: git does not write beyond a link, and the link is not ours.
        if (located.real !== onDisk(root, path)) throw invalid(`${path} runs through a symbolic link`);

        const info = located.stat;

        if (!info) return { kind: 'missing' };

        if (info.isSymbolicLink()) return { kind: 'link', stamp: stampOf(info) };

        if (info.isFile()) return { kind: 'file', stamp: stampOf(info) };

        throw invalid(`${path} is not a file any more`);
    }

    /** Rechecks every path and its stamp before the first write, including files that were missing. */
    async #unchanged(root: string, targets: Target[]): Promise<void> {
        for (const target of targets) {
            const now = await this.#workOf(root, target.path);
            const stamp = target.work.kind === 'missing' ? undefined : target.work.stamp;

            if ((now.kind === 'missing' ? undefined : now.stamp) !== stamp)
                throw conflict(`${target.path} changed before discard, try again`);
        }
    }

    /**
     * Brings the files back with `git restore`. git runs the person's `post-checkout` hook after it (with `0`, a checkout of files), and its exit status is then the hook's: when the files
     * are back as the last commit has them all the same, the discard was made and the hook's line is the warning, as for a switch that was made with a hook that failed (`GitSwitch`).
     * Any other failure is git's own, and the new files of the request are then left for the next try.
     */
    async #restore(
        cwd: string,
        git: (args: string[]) => Promise<RunResult>,
        paths: string[]
    ): Promise<string | undefined> {
        const run = await git(['restore', '--source=HEAD', '--staged', '--worktree', '--', ...paths]);

        if (run.code === 0) return undefined;

        if (run.error === undefined && (run.timedOut || run.code !== null) && (await this.#isBack(cwd, paths)))
            return run.timedOut
                ? 'The post-checkout hook did not finish in time'
                : failureLine(run.stderr, run.stdout, 'The post-checkout hook failed');

        this.#check(run);

        return undefined;
    }

    /** Whether the index and the disk have these paths as the last commit does. */
    async #isBack(cwd: string, paths: string[]): Promise<boolean> {
        const read = await gitRead(cwd, [
            'status',
            '--porcelain=v1',
            '-z',
            '--untracked-files=no',
            '--ignore-submodules=all',
            '--',
            ...paths.map(path => `:(literal)${path}`),
        ]);

        return read.ok && read.stdout === '';
    }

    /**
     * Deletes one file the commit does not have: the file or the link, found again and walked as before, and nothing else. The restore may have taken a while (a filter that fetches), so a file
     * that was written to since it was inspected is left where it is.
     */
    async #delete(root: string, target: Target): Promise<void> {
        const work = await this.#workOf(root, target.path);

        if (work.kind === 'missing') return;

        if (target.work.kind === 'missing' || work.stamp !== target.work.stamp)
            throw conflict(`${target.path} changed while the files were discarded, so it was left as it is`);

        try {
            await unlink(onDisk(root, target.path));
        } catch (error) {
            throw fsFailure(error, target.path);
        }
    }

    /** `git` in the place with the write environment, asked to stop with `SIGTERM` so it removes its lock files when the time is up. */
    #git(cwd: string, env: Record<string, string>, args: string[]): Promise<RunResult> {
        // The paths are plain names, never patterns: `*`, `[` and a leading `:` in a file's name are the file's own.
        return runProgram('git', ['--literal-pathspecs', ...args], {
            env,
            cwd,
            timeoutMs: this.#timeoutMs,
            maxChars: MAX_PRINTED_CHARS,
            signal: this.#stopper.signal,
            stopSignal: 'SIGTERM',
            leftoverGraceMs: LEFTOVER_GRACE_MS,
        });
    }

    /** Throws what a run that did not succeed came to, in words the person reads; returns when it did. */
    #check(result: RunResult): void {
        if (result.error === 'stopped') throw unavailable('The daemon is stopping');

        if (result.timedOut) throw unavailable('The discard did not finish in time');

        if (result.error !== undefined) throw unavailable('git is not installed or not on PATH');

        if (result.code !== 0)
            throw conflict(failureLine(result.stderr, result.stdout, 'git could not discard the files'));
    }
}

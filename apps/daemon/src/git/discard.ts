import { MAX_GIT_DISCARD_PATHS } from '@clowdy/protocol';
import { execFile } from 'node:child_process';
import { lstat, readlink, realpath, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { gitLine, gitRead } from '../domain/git';
import { exclusive } from '../domain/workspaces';
import { conflict, invalid, unavailable } from '../errors';
import { fsFailure, locate, normalizeFsPath } from '../fs/paths';
import { runProgram } from '../providers/exec';
import { failureLine, writeLine } from './commit';
import { DiscardCopies } from './discardCopies';
import { selectChanged } from './selection';
import { WriteEnvironment } from './writeEnv';

import type { GitChangedFile, GitDiscardedFile, GitDiscardResult } from '@clowdy/protocol';
import type { Place } from '../domain/places';
import type { RunResult } from '../providers/exec';
import type { Store } from '../store';
import type { CopySource, CopyStore } from './discardCopies';

const run = promisify(execFile);

/** A restore or a removal of a few files is quick; this is for a smudge filter (Git LFS) that has to be fetched, and for a disk that is slow to answer. */
const DISCARD_TIMEOUT_MS = 60_000;

/** The most of what git prints that is kept: only one line of it is ever shown. */
const MAX_PRINTED_CHARS = 256 * 1024;

/** The mode git records for a submodule. */
const SUBMODULE_MODE = '160000';

export interface GitDiscardOptions {
    /** Where the one-at-a-time line of each place is kept (`exclusive`). */
    store: Store;
    /** The daemon's data folder: the copies are made in `<dataDir>/discarded`. Ignored when `copies` is given. */
    dataDir: string;
    /** The environment of every write (the commit's and the push's too): the daemon's own by default. */
    environment?: WriteEnvironment;
    /** How long one git run may take: `DISCARD_TIMEOUT_MS`. */
    timeoutMs?: number;
    /** Where the copies are made and kept. A test gives one that fails, or that has small limits. */
    copies?: CopyStore;
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
type Work =
    | { kind: 'missing' }
    | { kind: 'file'; size: number; stamp: string }
    | { kind: 'link'; target: string; size: number; stamp: string };

/** What tells that a file on the disk is not the one that was copied: its type, size, time and number. */
const stampOf = (info: { mode: bigint; size: bigint; mtimeNs: bigint; ino: bigint }) => `${ info.mode }:${ info.size }:${ info.mtimeNs }:${ info.ino }`;

/** A size as a person reads it: whole megabytes from one up, else kilobytes. */
const readable = (bytes: number) => (bytes >= 1024 * 1024 ? `${ Math.round(bytes / (1024 * 1024)) } MB` : `${ Math.max(1, Math.ceil(bytes / 1024)) } KB`);

/** The path as the working tree has it, from the real root. */
const onDisk = (root: string, path: string) => join(root, ...path.split('/'));

/**
 * The discard of the changes of single files: the one write of the daemon that deletes work, so it is made to be deliberate and to leave a way back. A request names the files (never
 * a whole tree); they are judged against what git lists as changed in the place right now, on the place's line of writes (`writeLine`, so it never overlaps a commit, a pull or a
 * push); **a copy of what each file holds now (its bytes, not HEAD's) is made in the daemon's own data folder and checked before anything is touched**, and when the copy cannot be
 * made, or the work is over its limits, nothing is discarded. Then:
 *
 * - a file the last commit has (edited, staged, deleted, a new mode, a link retargeted, a file made a link) goes back to it: `git restore --source=HEAD --staged --worktree`, which
 *   replaces the index and the file and runs no hook;
 * - a file the last commit has not (a new file, staged or not; the new name of a renamed one) is removed from the index (`git rm --cached`) and deleted: that file alone, a link as
 *   the link and never what it points to, never `git clean`, never a folder and never the folders above it;
 * - a file with merge conflicts, a submodule, something that is a folder now, a path that leaves the place or runs through a link, and a path git does not list as changed are refused,
 *   and nothing is done.
 */
export class GitDiscard {
    readonly copies: CopyStore;
    readonly environment: WriteEnvironment;
    readonly #store: Store;
    readonly #timeoutMs: number;
    readonly #stopper = new AbortController();

    constructor({ store, dataDir, environment = new WriteEnvironment(), timeoutMs = DISCARD_TIMEOUT_MS, copies = new DiscardCopies(dataDir) }: GitDiscardOptions) {
        this.#store = store;
        this.environment = environment;
        this.#timeoutMs = timeoutMs;
        this.copies = copies;
    }

    /** Ends the git that is running, and refuses new discards. */
    stop(): void {
        this.#stopper.abort();
    }

    /** Removes the copies that are past their time or over the cap: at the start of the daemon (a discard does it itself afterwards). */
    prune(): Promise<void> {
        return this.copies.prune();
    }

    /**
     * Discards the files `request.paths` names in the place (`POST /v1/projects/:id/git/discard`). `projectId` is the project the place is read for, which the copy is filed under.
     * The answer says what happened to each file and where the copy is.
     */
    async discard(place: Place, request: { projectId: string; paths: unknown }): Promise<GitDiscardResult> {
        const result = await exclusive(this.#store, writeLine(place), this.#stopper.signal, () => this.#discard(place, request));

        // After the line is let go, and not an error of the discard's: the copies of other times are not what the person asked about.
        await this.copies.prune(result.copy.folder).catch(() => undefined);

        return result;
    }

    async #discard(place: Place, request: { projectId: string; paths: unknown }): Promise<GitDiscardResult> {
        const cwd = place.path;
        // The judging is the commit's: what git lists as changed in the place right now, so nothing is touched that the person was not shown.
        const { files, gitPaths } = await selectChanged(place, request.paths, MAX_GIT_DISCARD_PATHS);

        if (files.some(file => file.kind === 'conflicted')) throw conflict('Resolve the conflict first');

        const root = await realpath(cwd).catch(() => cwd);
        const targets = await this.#inspect(cwd, root, files, gitPaths);
        const env = await this.environment.of(cwd);
        const git = (args: string[]) => this.#git(cwd, env, args);
        const sources = await this.#sources(cwd, root, env, targets);

        this.#checkSizes(sources);

        const [branch, head] = await Promise.all([gitLine(cwd, ['symbolic-ref', '--short', '-q', 'HEAD']), gitLine(cwd, ['rev-parse', '--verify', '-q', 'HEAD'])]);
        let kept;

        try {
            kept = await this.copies.keep({
                projectId: request.projectId,
                folderId: place.folder.id,
                ...(place.workspace && { workspaceId: place.workspace.id }),
                place: cwd,
                ...(branch !== undefined && { branch }),
                ...(head !== undefined && { head }),
                files: sources,
            });
        }
        catch (error) {
            throw unavailable(`Couldn't keep a copy of the files, so nothing was discarded${ error instanceof Error && error.message ? `: ${ error.message }` : '' }`);
        }

        // Files that were written to while they were being copied have a copy that is not what is about to go: nothing is done, and the next try copies them again.
        await this.#unchanged(root, targets);

        const toRestore = targets.filter(target => target.head).map(target => target.path);
        const toUnstage = targets.filter(target => !target.head && target.index).map(target => target.path);
        const toDelete = targets.filter(target => !target.head && target.work.kind !== 'missing');

        // The restore comes first: a file git cannot bring back stops the discard with nothing deleted from the disk.
        if (toRestore.length > 0) this.#check(await git(['restore', '--source=HEAD', '--staged', '--worktree', '--', ...toRestore]));

        if (toUnstage.length > 0) this.#check(await git(['rm', '--cached', '-f', '-q', '--', ...toUnstage]));

        for (const target of toDelete) await this.#delete(root, target);

        await this.copies.finish(kept);

        return {
            discarded: files.map((file): GitDiscardedFile => ({ path: file.path, action: targets.some(target => target.file === file && target.head) ? 'restored' : 'removed' })),
            copy: { folder: kept.folder, keptUntil: kept.keptUntil, files: kept.files },
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
            if (normalizeFsPath(path) !== path || path.includes('\n')) throw invalid(`${ path } is not a path that can be discarded here`);
        }

        const [heads, indexed] = await Promise.all([this.#headOf(cwd, gitPaths), this.#indexOf(cwd, gitPaths)]);

        if (indexed.unmerged.length > 0) throw conflict('Resolve the conflict first');

        return Promise.all(gitPaths.map(async (path, position): Promise<Target> => ({
            path,
            file: owner.get(path)!,
            ...(heads[position] && { head: heads[position] }),
            ...(indexed.entries.has(path) && { index: indexed.entries.get(path) }),
            work: await this.#workOf(root, path),
        })));
    }

    /** What the last commit has at each path: its id when it is a file, a submodule's commit refused on the spot, and nothing for a path it has not or has as a folder. */
    async #headOf(cwd: string, paths: string[]): Promise<Array<{ oid: string } | undefined>> {
        const read = await gitRead(cwd, ['cat-file', '--batch-check'], { input: `${ paths.map(path => `HEAD:${ path }`).join('\n') }\n` });

        if (!read.ok) throw unavailable('git did not answer');

        const lines = read.stdout.split('\n');

        return paths.map((path, position) => {
            const [oid = '', type = ''] = lines[position]?.split(' ') ?? [];

            if (type === 'commit') throw invalid('A submodule can\'t be discarded here');

            return type === 'blob' ? { oid } : undefined;
        });
    }

    /** What the index has at each path: its merged entry (a submodule refused), and the paths it holds unmerged (conflicts). */
    async #indexOf(cwd: string, paths: string[]): Promise<{ entries: Map<string, { mode: string; oid: string }>; unmerged: string[] }> {
        const read = await gitRead(cwd, ['ls-files', '--stage', '-z', '--', ...paths.map(path => `:(literal)${ path }`)]);

        if (!read.ok) throw unavailable('git did not answer');

        const entries = new Map<string, { mode: string; oid: string }>();
        const unmerged: string[] = [];

        for (const record of read.stdout.split('\0')) {
            const found = /^(\d+) ([0-9a-f]+) (\d)\t([\s\S]*)$/.exec(record);

            if (!found) continue;

            const [, mode = '', oid = '', stage = '', path = ''] = found;

            if (mode === SUBMODULE_MODE) throw invalid('A submodule can\'t be discarded here');

            if (stage === '0') {
                entries.set(path, { mode, oid });
            }
            else {
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
        }
        catch (error) {
            throw fsFailure(error, path);
        }

        if (located.blockedBy !== undefined) throw invalid(`${ located.blockedBy } is in the way of ${ path }, discard it first`);

        // A link on the way is followed by `locate` when it stays inside the place, and what it found is then not the path: git does not write beyond a link, and the link is not ours.
        if (located.real !== onDisk(root, path)) throw invalid(`${ path } runs through a symbolic link`);

        const info = located.stat;

        if (!info) return { kind: 'missing' };

        if (info.isSymbolicLink()) return { kind: 'link', target: await readlink(located.real), size: Number(info.size), stamp: stampOf(info) };

        if (info.isFile()) return { kind: 'file', size: Number(info.size), stamp: stampOf(info) };

        throw invalid(`${ path } is not a file any more`);
    }

    /**
     * What each file gives to its copy: the bytes it holds now (a link as its target), and the staged version when the index holds one that is neither the commit's nor the file's (the
     * restore replaces the index as well, and that version exists nowhere else). A file or version over the cap, and sums over the cap, are refused here, before anything is copied.
     */
    async #sources(cwd: string, root: string, env: Record<string, string>, targets: Target[]): Promise<CopySource[]> {
        const staged = targets.filter(target => target.index && target.index.oid !== target.head?.oid);
        const sizes = await this.#blobSizes(cwd, staged.map(target => target.index!.oid));
        const hashes = await this.#hashes(cwd, staged.filter(target => target.work.kind === 'file').map(target => target.path));
        const entries = new Map<string, CopySource>();

        for (const target of targets) {
            const restored = target.head !== undefined;
            const source: CopySource = { path: target.path, action: restored ? 'restored' : 'removed' };

            if (target.work.kind === 'file') {
                source.work = { kind: 'file', source: onDisk(root, target.path), size: target.work.size };
            }
            else if (target.work.kind === 'link') {
                source.work = { kind: 'link', target: target.work.target };
            }

            entries.set(target.path, source);
        }

        for (const target of staged) {
            const size = sizes.get(target.index!.oid);

            // The empty file `git add -N` leaves, or an id git could not size: nothing to keep.
            if (size === undefined || size === 0) continue;

            // What is on the disk is the staged version already, or a copy of it is what is kept.
            if (target.work.kind === 'file' && hashes.get(target.path) === target.index!.oid) continue;

            const oid = target.index!.oid;

            entries.get(target.path)!.staged = { size, read: () => this.#blob(cwd, env, oid, size) };
        }

        return [...entries.values()];
    }

    /** Refuses a file, or a staged version of one, over what a copy may be, and files whose copies together would not fit: the work is left where it is, for the person to deal with in a terminal. */
    #checkSizes(sources: CopySource[]): void {
        const { maxFileBytes, maxBytes } = this.copies;
        let total = 0;

        for (const source of sources) {
            for (const size of [source.work?.kind === 'file' ? source.work.size : 0, source.staged?.size ?? 0]) {
                if (size > maxFileBytes) throw invalid(`${ source.path } is over ${ readable(maxFileBytes) }, discard it in a terminal`);

                total += size;
            }
        }

        if (total > maxBytes) throw invalid('The files are too big to keep a copy of together, discard fewer of them');
    }

    /** The sizes of blobs by id, in one `cat-file --batch-check`. An id git does not know has none. */
    async #blobSizes(cwd: string, ids: string[]): Promise<Map<string, number>> {
        const sizes = new Map<string, number>();

        if (ids.length === 0) return sizes;

        const read = await gitRead(cwd, ['cat-file', '--batch-check'], { input: `${ [...new Set(ids)].join('\n') }\n` });

        if (!read.ok) throw unavailable('git did not answer');

        for (const line of read.stdout.split('\n')) {
            const [id, type, size] = line.split(' ');

            if (id && type === 'blob' && size !== undefined) sizes.set(id, Number(size));
        }

        return sizes;
    }

    /** The ids git gives the files as they are on the disk (`hash-object`, which applies the same filters `git add` does). A file git could not hash has none, which counts as different. */
    async #hashes(cwd: string, paths: string[]): Promise<Map<string, string>> {
        const hashes = new Map<string, string>();

        if (paths.length === 0) return hashes;

        const read = await gitRead(cwd, ['hash-object', '--', ...paths]);
        const lines = read.ok ? read.stdout.split('\n').filter(line => line !== '') : [];

        if (lines.length === paths.length) paths.forEach((path, position) => hashes.set(path, lines[position]!));

        return hashes;
    }

    /** The bytes of a blob, as stored. */
    async #blob(cwd: string, env: Record<string, string>, oid: string, size: number): Promise<Buffer> {
        const { stdout } = await run('git', ['cat-file', 'blob', oid], { cwd, env, encoding: 'buffer', maxBuffer: size + 1024, timeout: this.#timeoutMs, windowsHide: true });

        return stdout;
    }

    /** Refuses when a file is not the one that was copied: it was written to after the copy was begun. */
    async #unchanged(root: string, targets: Target[]): Promise<void> {
        for (const target of targets) {
            if (target.work.kind === 'missing') continue;

            const now = await lstat(onDisk(root, target.path), { bigint: true }).catch(() => undefined);

            if (now === undefined || stampOf(now) !== target.work.stamp) throw conflict(`${ target.path } changed while its copy was made, try again`);
        }
    }

    /** Deletes one file the commit does not have: the file or the link, found again and walked as before, and nothing else. */
    async #delete(root: string, target: Target): Promise<void> {
        const work = await this.#workOf(root, target.path);

        if (work.kind === 'missing') return;

        try {
            await unlink(onDisk(root, target.path));
        }
        catch (error) {
            throw fsFailure(error, target.path);
        }
    }

    /** `git` in the place with the write environment, asked to stop with `SIGTERM` so it removes its lock files when the time is up. */
    #git(cwd: string, env: Record<string, string>, args: string[]): Promise<RunResult> {
        // The paths are plain names, never patterns: `*`, `[` and a leading `:` in a file's name are the file's own.
        return runProgram('git', ['--literal-pathspecs', ...args], { env, cwd, timeoutMs: this.#timeoutMs, maxChars: MAX_PRINTED_CHARS, signal: this.#stopper.signal, stopSignal: 'SIGTERM' });
    }

    /** Throws what a run that did not succeed came to, in words the person reads; returns when it did. */
    #check(result: RunResult): void {
        if (result.error === 'stopped') throw unavailable('The daemon is stopping');

        if (result.timedOut) throw unavailable('The discard did not finish in time');

        if (result.error !== undefined) throw unavailable('git is not installed or not on PATH');

        if (result.code !== 0) throw conflict(failureLine(result.stderr, result.stdout, 'git could not discard the files'));
    }
}

import { readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { gitRead } from '../domain/git';
import { placeOf } from './state';

/** The most linked worktrees whose own `FETCH_HEAD` is looked at: a repository with more is read for the first of them, which is more than a person has chats open in. */
const MAX_WORKTREE_RECORDS = 500;

/** The most repositories whose last fetch by the app is kept in memory: the one used longest ago is forgotten first. */
const MAX_REMEMBERED = 256;

/** When the app's own fetch last went through, by repository (the real path of its common git directory). Written by `rememberFetch`, read by `lastFetchedAt`, and gone with the daemon. */
const remembered = new Map<string, number>();

/** The two git directories of a place: its own (a linked worktree has one of its own under the common one) and the common one that holds the shared refs. Both absolute. */
interface GitDirs {
    gitDir: string;
    common: string;
}

async function gitDirsOf(cwd: string): Promise<GitDirs | undefined> {
    const dirs = await gitRead(cwd, ['rev-parse', '--git-dir', '--git-common-dir']);

    if (!dirs.ok) return undefined;

    // Paths as git prints them: relative to `cwd` for the main checkout (`.git`), absolute for a linked worktree.
    const [gitDir, common] = dirs.stdout.replace(/\n$/, '').split('\n');

    return gitDir && common ? { gitDir: resolve(cwd, gitDir), common: resolve(cwd, common) } : undefined;
}

/**
 * When a `FETCH_HEAD` was last written by a fetch that went through, in milliseconds: nothing for a file that is not there or is empty. `git fetch` empties the file before it connects, so
 * a fetch that failed (no network, the remote is gone) leaves it empty with a new time, and so does a fetch of a remote that has no refs; neither is a fetch that brought the refs up to
 * date, and the time of the one before them is gone with the content.
 */
async function fetchedAt(file: string): Promise<number | undefined> {
    try {
        const info = await stat(file);

        return info.isFile() && info.size > 0 ? Math.floor(info.mtimeMs) : undefined;
    }
    catch {
        return undefined;
    }
}

/** The files a repository keeps a `FETCH_HEAD` in: the place's own git directory, the common one, and the record of each linked worktree. */
async function fetchHeadFiles({ gitDir, common }: GitDirs): Promise<string[]> {
    const records = await readdir(join(common, 'worktrees'), { withFileTypes: true }).catch(() => []);
    const files = new Set([join(gitDir, 'FETCH_HEAD'), join(common, 'FETCH_HEAD')]);

    for (const record of records.slice(0, MAX_WORKTREE_RECORDS)) {
        if (record.isDirectory()) files.add(join(common, 'worktrees', record.name, 'FETCH_HEAD'));
    }

    return [...files];
}

const keyOf = async ({ common }: GitDirs): Promise<string> => await placeOf(common) ?? common;

/**
 * The app's own fetch of a place's repository went through now (`git fetch`, which a pull starts with). The time is kept in memory as a floor under what `FETCH_HEAD` says, because a fetch
 * that fails afterwards (offline, a remote that is gone) empties every `FETCH_HEAD` it touches and so takes the time of this one with it, and a worktree that is removed takes its own file along.
 * The refs this fetch brought are as old as it whatever the files say, so `Last fetched` keeps saying when it was, and a later fetch by anyone else is newer and wins (`lastFetchedAt`).
 * A daemon that restarts forgets it and goes back to the files, which is what it knew before.
 */
export async function rememberFetch(cwd: string, at: number = Date.now()): Promise<void> {
    const dirs = await gitDirsOf(cwd);

    if (!dirs) return;

    const key = await keyOf(dirs);

    // Deleted first so a repository that fetched again goes to the end of the map: the first key is the one used longest ago.
    remembered.delete(key);
    remembered.set(key, at);

    if (remembered.size > MAX_REMEMBERED) remembered.delete(remembered.keys().next().value!);
}

/**
 * When the repository of a place last fetched, which is how old the counts of ahead and behind are: the newest of the non-empty `FETCH_HEAD` files of the repository and of the app's own last
 * fetch (`rememberFetch`). Nothing when none has been written.
 *
 * `FETCH_HEAD` is per worktree: a fetch run in a linked worktree writes `<common>/worktrees/<name>/FETCH_HEAD` and the folder's own checkout writes `<common>/FETCH_HEAD`, and neither sees
 * the other's. The refs a fetch moves (`refs/remotes/origin/*`) are shared by all of them, so the counts a place shows are as fresh as the newest fetch of any worktree, and that is
 * the time that is read, the same for the folder's checkout and for each worktree of it. The file is written by `git fetch` and `git pull` whoever runs it (the app, a terminal, GitHub Desktop), and also by
 * a fetch of a remote other than `origin`; a fetch made with `--no-write-fetch-head` (git's own background prefetch) does not write it. Of fetches that are not the app's the time is the file's.
 */
export async function lastFetchedAt(cwd: string): Promise<number | undefined> {
    const dirs = await gitDirsOf(cwd);

    if (!dirs) return undefined;

    const [files, key] = await Promise.all([fetchHeadFiles(dirs), keyOf(dirs)]);
    const times = [...await Promise.all(files.map(fetchedAt)), remembered.get(key)];
    const found = times.filter((time): time is number => time !== undefined);

    return found.length > 0 ? Math.max(...found) : undefined;
}

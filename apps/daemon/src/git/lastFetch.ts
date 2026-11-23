import { readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { gitRead } from '../domain/git';

/** The most linked worktrees whose own `FETCH_HEAD` is looked at: a repository with more is read for the first of them, which is more than a person has chats open in. */
const MAX_WORKTREE_RECORDS = 500;

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

/** The directories a repository keeps a `FETCH_HEAD` in: the place's own git directory, the common one, and the record of each linked worktree. */
async function fetchHeadFiles(cwd: string): Promise<string[]> {
    const dirs = await gitRead(cwd, ['rev-parse', '--git-dir', '--git-common-dir']);

    if (!dirs.ok) return [];

    // Paths as git prints them: relative to `cwd` for the main checkout (`.git`), absolute for a linked worktree.
    const [gitDir, commonDir] = dirs.stdout.replace(/\n$/, '').split('\n');

    if (!gitDir || !commonDir) return [];

    const common = resolve(cwd, commonDir);
    const records = await readdir(join(common, 'worktrees'), { withFileTypes: true }).catch(() => []);
    const files = new Set([join(resolve(cwd, gitDir), 'FETCH_HEAD'), join(common, 'FETCH_HEAD')]);

    for (const record of records.slice(0, MAX_WORKTREE_RECORDS)) {
        if (record.isDirectory()) files.add(join(common, 'worktrees', record.name, 'FETCH_HEAD'));
    }

    return [...files];
}

/**
 * When the repository of a place last fetched, which is how old the counts of ahead and behind are: the newest non-empty `FETCH_HEAD` of the repository. Nothing when none has been written.
 *
 * `FETCH_HEAD` is per worktree: a fetch run in a linked worktree writes `<common>/worktrees/<name>/FETCH_HEAD` and the folder's own checkout writes `<common>/FETCH_HEAD`, and neither sees
 * the other's. The refs a fetch moves (`refs/remotes/origin/*`) are shared by all of them, so the counts a place shows are as fresh as the newest fetch of any worktree, and that is
 * the time that is read, the same for the folder's checkout and for each worktree of it. The file is written by `git fetch` and `git pull` whoever runs it (the app, a terminal, GitHub Desktop), and also by
 * a fetch of a remote other than `origin`; a fetch made with `--no-write-fetch-head` (git's own background prefetch) does not write it. The time is the file's, no record of the app's own.
 */
export async function lastFetchedAt(cwd: string): Promise<number | undefined> {
    const times = await Promise.all((await fetchHeadFiles(cwd)).map(fetchedAt));
    const found = times.filter((time): time is number => time !== undefined);

    return found.length > 0 ? Math.max(...found) : undefined;
}

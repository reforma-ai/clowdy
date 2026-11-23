import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, renameSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { lastFetchedAt } from '../src/git/lastFetch';
import { placeStatus } from '../src/git/status';
import { cleanTempDirs, git, makeRepo, tempDir } from './helpers';

import type { GitStatus } from '@clowdy/protocol';
import type { Place } from '../src/domain/places';

afterAll(cleanTempDirs);

/** A place at a checkout or a worktree, as `resolvePlace` makes one for a folder. */
const placeAt = (path: string): Place => ({ folder: { id: 'fld_test', path }, path });

const lastFetched = async (path: string): Promise<number | undefined> => {
    const answer: GitStatus = await placeStatus(placeAt(path));

    if (!answer.isRepository) throw new Error(`${ path } is not a repository`);

    return answer.lastFetchedAt;
};

/** Sets the time a file was last written, in seconds since the epoch. */
const touch = (file: string, seconds: number) => utimesSync(file, seconds, seconds);

/** A bare `origin` with `main`, and a clone of it that tracks `origin/main` and has not fetched since it was made. */
function clone(): { root: string; work: string; origin: string } {
    const root = tempDir('git-last-fetched');
    const origin = join(root, 'origin.git');
    const seed = makeRepo(root, 'seed');

    git(root, 'init', '--bare', '-q', '-b', 'main', origin);
    git(seed, 'remote', 'add', 'origin', origin);
    git(seed, 'push', '-q', 'origin', 'main');
    git(origin, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    git(root, 'clone', '-q', origin, 'work');

    return { root, work: join(root, 'work'), origin };
}

/** Someone else's commit on origin, which a fetch brings in. */
function pushedByNeighbour(root: string, origin: string): void {
    const neighbour = join(root, 'neighbour');

    if (!existsSync(neighbour)) git(root, 'clone', '-q', origin, 'neighbour');

    writeFileSync(join(neighbour, `n-${ Date.now() }.txt`), 'n\n');
    git(neighbour, 'add', '-A');
    git(neighbour, 'commit', '-q', '-m', 'Neighbour work');
    git(neighbour, 'push', '-q', 'origin', 'main');
}

const gitDirOf = (path: string): string => git(path, 'rev-parse', '--path-format=absolute', '--git-dir');

describe('lastFetchedAt in the status of a place', () => {
    test('is absent for a repository that has not fetched, and a clone is one: git clone writes no FETCH_HEAD', async () => {
        const { work } = clone();

        expect(existsSync(join(work, '.git', 'FETCH_HEAD'))).toBe(false);
        expect(await lastFetched(work)).toBeUndefined();
    });

    test('is the time of the fetch once there is one, and a fetch that brings nothing moves it all the same', async () => {
        const { work } = clone();
        const before = Date.now();

        git(work, 'fetch', '-q', 'origin');

        const first = await lastFetched(work);

        expect(first).toBeGreaterThanOrEqual(before - 1000);
        expect(first).toBeLessThanOrEqual(Date.now() + 1000);

        // Back to an hour ago: the fetch that follows has nothing to bring, and it is the one that is said.
        touch(join(work, '.git', 'FETCH_HEAD'), Math.floor(Date.now() / 1000) - 3600);
        expect(await lastFetched(work)).toBeLessThan(Date.now() - 3_000_000);

        git(work, 'fetch', '-q', 'origin');
        expect(await lastFetched(work)).toBeGreaterThan(Date.now() - 60_000);
    });

    test('is absent for a repository with no origin, whatever else wrote its FETCH_HEAD', async () => {
        const { root } = clone();
        const alone = makeRepo(root, 'alone');
        const other = join(root, 'other.git');

        git(root, 'init', '--bare', '-q', '-b', 'main', other);
        git(alone, 'remote', 'add', 'upstream', other);
        git(alone, 'push', '-q', 'upstream', 'main');
        git(alone, 'fetch', '-q', 'upstream');

        expect(existsSync(join(alone, '.git', 'FETCH_HEAD'))).toBe(true);
        expect(await lastFetched(alone)).toBeUndefined();
    });

    test('is the same for the folder\'s own checkout and for a worktree of it, whichever of them fetched: FETCH_HEAD is per worktree and the refs it moves are shared', async () => {
        const { root, work, origin } = clone();
        const tree = join(root, 'tree');

        git(work, 'worktree', 'add', '-q', '-b', 'feature', tree);

        // The worktree has its own git directory under the common one, and so its own FETCH_HEAD.
        expect(gitDirOf(tree)).not.toBe(gitDirOf(work));

        expect(await lastFetched(tree)).toBeUndefined();

        pushedByNeighbour(root, origin);
        git(tree, 'fetch', '-q', 'origin');

        const fromTree = await lastFetched(tree);

        // The fetch wrote the worktree's own file and not the checkout's...
        expect(existsSync(join(gitDirOf(tree), 'FETCH_HEAD'))).toBe(true);
        expect(existsSync(join(work, '.git', 'FETCH_HEAD'))).toBe(false);
        // ...and the checkout's counts moved all the same, so it says when they were brought up to date.
        expect(fromTree).toBeGreaterThan(Date.now() - 60_000);
        expect(await lastFetched(work)).toBe(fromTree);
        expect((await placeStatus(placeAt(work)) as { upstream?: { behind: number } }).upstream?.behind).toBe(1);

        // And the other way round: a fetch in the checkout is seen from the worktree.
        touch(join(gitDirOf(tree), 'FETCH_HEAD'), Math.floor(Date.now() / 1000) - 7200);
        expect(await lastFetched(tree)).toBeLessThan(Date.now() - 3_000_000);

        git(work, 'fetch', '-q', 'origin');

        const fromWork = await lastFetched(work);

        expect(fromWork).toBeGreaterThan(Date.now() - 60_000);
        expect(await lastFetched(tree)).toBe(fromWork);
    });

    test('is the newest of every worktree\'s FETCH_HEAD and the common one', async () => {
        const { root, work } = clone();
        const first = join(root, 'first');
        const second = join(root, 'second');
        const now = Math.floor(Date.now() / 1000);

        git(work, 'worktree', 'add', '-q', '-b', 'one', first);
        git(work, 'worktree', 'add', '-q', '-b', 'two', second);

        for (const path of [work, first, second]) git(path, 'fetch', '-q', 'origin');

        touch(join(work, '.git', 'FETCH_HEAD'), now - 3600);
        touch(join(gitDirOf(first), 'FETCH_HEAD'), now - 600);
        touch(join(gitDirOf(second), 'FETCH_HEAD'), now - 1800);

        for (const path of [work, first, second]) expect(await lastFetched(path)).toBe((now - 600) * 1000);
    });

    test('does not read a fetch that failed as one that worked: git empties FETCH_HEAD before it connects, and an empty file says nothing', async () => {
        const { root, work, origin } = clone();

        git(work, 'fetch', '-q', 'origin');
        expect(await lastFetched(work)).toBeGreaterThan(Date.now() - 60_000);

        renameSync(origin, `${ origin }.away`);
        expect(() => git(work, 'fetch', '-q', 'origin')).toThrow();
        expect(await lastFetched(work)).toBeUndefined();

        // Back on its feet, one fetch says it again.
        renameSync(`${ origin }.away`, origin);
        pushedByNeighbour(root, origin);
        git(work, 'fetch', '-q', 'origin');
        expect(await lastFetched(work)).toBeGreaterThan(Date.now() - 60_000);
    });

    test('does not count a fetch that was told not to write FETCH_HEAD (git\'s own background prefetch is one)', async () => {
        const { work } = clone();

        git(work, 'fetch', '-q', '--no-write-fetch-head', 'origin');
        expect(await lastFetched(work)).toBeUndefined();
    });

    test('is nothing for a folder that is no repository and for one that is not there', async () => {
        const { root } = clone();
        const plain = join(root, 'plain');

        mkdirSync(plain);
        expect(await lastFetchedAt(plain)).toBeUndefined();
        expect(await lastFetchedAt(join(root, 'missing', 'nothing'))).toBeUndefined();
    });
});

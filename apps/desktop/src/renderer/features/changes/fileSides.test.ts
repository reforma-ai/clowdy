import { autorun } from 'mobx';
import { describe, expect, it } from 'vitest';

import { SidesCache, sidesKey, type SidesEntry, type SidesRequest } from './fileSides';

import type { GitFileSides } from '@clowdy/protocol';

/** A read that waits until the test lets it end, and remembers what it was asked. */
function deferredReads() {
    const started: SidesRequest[] = [];
    const waiting = new Map<string, { resolve: (sides: GitFileSides) => void; reject: (error: Error) => void }>();

    return {
        started,
        read: (request: SidesRequest) => new Promise<GitFileSides>((resolve, reject) => {
            started.push(request);
            waiting.set(sidesKey(request), { resolve, reject });
        }),
        finish: (request: SidesRequest, sides: GitFileSides = text(request)) => waiting.get(sidesKey(request))!.resolve(sides),
        fail: (request: SidesRequest, message = 'git did not answer') => waiting.get(sidesKey(request))!.reject(new Error(message)),
    };
}

const text = (request: SidesRequest): GitFileSides => ({ state: 'text', original: `before ${ request.path }`, modified: `after ${ request.path }`, revision: request.revision });
const request = (path: string, revision = 'r1', scope: SidesRequest['scope'] = 'all'): SidesRequest => ({ scope, path, revision, from: 'abc1234' });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

describe('the files\' texts', () => {
    it('is kept under the scope, the path and the revision', () => {
        expect(sidesKey(request('a.ts'))).not.toBe(sidesKey(request('b.ts')));
        expect(sidesKey(request('a.ts', 'r1'))).not.toBe(sidesKey(request('a.ts', 'r2')));
        expect(sidesKey(request('a.ts', 'r1', 'all'))).not.toBe(sidesKey(request('a.ts', 'r1', 'branch')));
        // The start of the list is not part of it: the same revision is the same text.
        expect(sidesKey({ ...request('a.ts'), from: 'other' })).toBe(sidesKey(request('a.ts')));
    });

    it('reads a file once it is asked for, and has nothing before', async () => {
        const reads = deferredReads();
        const cache = new SidesCache(reads.read);

        expect(cache.entryOf(request('a.ts'))).toBeUndefined();

        cache.want(request('a.ts'));
        expect(cache.entryOf(request('a.ts'))).toEqual({ status: 'loading' });
        expect(reads.started).toHaveLength(1);

        reads.finish(request('a.ts'));
        await tick();

        expect(cache.entryOf(request('a.ts'))).toEqual({ status: 'ready', sides: text(request('a.ts')) });
    });

    it('does not read a file again that is here, on its way or waiting for its turn, and a refresh asks only for the files whose revision changed', async () => {
        const reads = deferredReads();
        const cache = new SidesCache(reads.read, 2);

        cache.want(request('a.ts'));
        cache.want(request('b.ts'));
        cache.want(request('c.ts'));
        cache.want(request('a.ts'));
        cache.want(request('c.ts'));
        expect(reads.started.map(started => started.path)).toEqual(['a.ts', 'b.ts']);

        reads.finish(request('a.ts'));
        reads.finish(request('b.ts'));
        await tick();
        reads.finish(request('c.ts'));
        await tick();

        // The list is read again: a.ts and b.ts are as they were, c.ts was edited.
        reads.started.length = 0;
        cache.want(request('a.ts'));
        cache.want(request('b.ts'));
        cache.want(request('c.ts', 'r2'));
        expect(reads.started).toEqual([request('c.ts', 'r2')]);
        expect(cache.entryOf(request('a.ts'))?.status).toBe('ready');
    });

    it('runs at most four reads at once by default, and the rest wait in the order they were asked', async () => {
        const reads = deferredReads();
        const cache = new SidesCache(reads.read);
        const paths = Array.from({ length: 9 }, (_, index) => `file-${ index }.ts`);

        for (const path of paths) cache.want(request(path));

        expect(reads.started.map(started => started.path)).toEqual(paths.slice(0, 4));
        expect(paths.slice(4).map(path => cache.entryOf(request(path))?.status)).toEqual(Array(5).fill('loading'));

        reads.finish(request(paths[0]!));
        await tick();
        expect(reads.started.map(started => started.path)).toEqual(paths.slice(0, 5));

        // A read that fails frees its place as well.
        reads.fail(request(paths[1]!));
        await tick();
        expect(reads.started.map(started => started.path)).toEqual(paths.slice(0, 6));

        for (const path of paths.slice(2, 6)) reads.finish(request(path));
        await tick();
        expect(reads.started.map(started => started.path)).toEqual(paths);
    });

    it('keeps a read that failed as an entry with its message, and reads it again on a retry', async () => {
        const reads = deferredReads();
        const cache = new SidesCache(reads.read);

        cache.want(request('a.ts'));
        reads.fail(request('a.ts'), 'The daemon answered 503');
        await tick();

        expect(cache.entryOf(request('a.ts'))).toEqual({ status: 'error', message: 'The daemon answered 503' });

        // Asking again does not read again: the entry is there.
        cache.want(request('a.ts'));
        expect(reads.started).toHaveLength(1);

        cache.retry(request('a.ts'));
        expect(reads.started).toHaveLength(2);
        expect(cache.entryOf(request('a.ts'))).toEqual({ status: 'loading' });

        reads.finish(request('a.ts'));
        await tick();

        expect(cache.entryOf(request('a.ts'))?.status).toBe('ready');
        // Nothing to retry on a file that is read.
        cache.retry(request('a.ts'));
        expect(reads.started).toHaveLength(2);
    });

    it('keeps the texts of a file as they were last read, for any revision, to show while the next one is on its way', async () => {
        const reads = deferredReads();
        const cache = new SidesCache(reads.read);

        expect(cache.latestOf(request('a.ts'))).toBeUndefined();

        cache.want(request('a.ts', 'r1'));
        reads.finish(request('a.ts', 'r1'));
        await tick();
        cache.want(request('a.ts', 'r2'));

        expect(cache.entryOf(request('a.ts', 'r2'))).toEqual({ status: 'loading' });
        expect(cache.latestOf(request('a.ts', 'r2'))).toMatchObject({ revision: 'r1' });
        // Another scope's file is another file.
        expect(cache.latestOf(request('a.ts', 'r1', 'branch'))).toBeUndefined();

        reads.finish(request('a.ts', 'r2'));
        await tick();

        expect(cache.latestOf(request('a.ts'))).toMatchObject({ revision: 'r2' });
    });

    it('lets go of the texts that were read longest ago once it holds more than its capacity, and never of one that is on its way', async () => {
        const reads = deferredReads();
        const cache = new SidesCache(reads.read, 4, 3);

        for (const path of ['a.ts', 'b.ts', 'c.ts']) {
            cache.want(request(path));
            reads.finish(request(path));
            await tick();
        }

        cache.want(request('slow.ts'));
        cache.want(request('d.ts'));
        reads.finish(request('d.ts'));
        await tick();

        expect(cache.entryOf(request('a.ts'))).toBeUndefined();
        expect(cache.entryOf(request('b.ts'))?.status).toBe('ready');
        expect(cache.entryOf(request('slow.ts'))).toEqual({ status: 'loading' });
        expect(cache.entryOf(request('d.ts'))?.status).toBe('ready');
    });

    it('drops the reads that wait for their turn when they are not wanted any more, and leaves the ones on their way', async () => {
        const reads = deferredReads();
        const cache = new SidesCache(reads.read, 1);

        cache.want(request('a.ts'));
        cache.want(request('b.ts'));
        cache.want(request('c.ts'));
        cache.retainQueued(wanted => wanted.path === 'c.ts');

        expect(cache.entryOf(request('a.ts'))).toEqual({ status: 'loading' });
        expect(cache.entryOf(request('b.ts'))).toBeUndefined();

        reads.finish(request('a.ts'));
        await tick();

        expect(reads.started.map(started => started.path)).toEqual(['a.ts', 'c.ts']);
    });

    it('forgets everything on a clear, and an answer that was on its way does not come back into it', async () => {
        const reads = deferredReads();
        const cache = new SidesCache(reads.read);

        cache.want(request('a.ts'));
        cache.clear();

        expect(cache.entryOf(request('a.ts'))).toBeUndefined();

        reads.finish(request('a.ts'));
        await tick();

        expect(cache.entryOf(request('a.ts'))).toBeUndefined();

        cache.want(request('a.ts'));
        expect(reads.started).toHaveLength(2);
    });

    it('is observable per file: a card follows its own file\'s entry and not the others\'', async () => {
        const reads = deferredReads();
        const cache = new SidesCache(reads.read);
        const seen: Array<SidesEntry | undefined> = [];

        cache.want(request('a.ts'));
        cache.want(request('b.ts'));

        const stop = autorun(() => seen.push(cache.entryOf(request('a.ts'))));

        reads.finish(request('b.ts'));
        await tick();
        expect(seen).toHaveLength(1);

        reads.finish(request('a.ts'));
        await tick();
        expect(seen.map(entry => entry?.status)).toEqual(['loading', 'ready']);

        stop();
    });
});

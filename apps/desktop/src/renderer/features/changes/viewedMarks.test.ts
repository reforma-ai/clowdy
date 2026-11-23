import { describe, expect, it, vi } from 'vitest';

import { TransportError } from '../../daemon/transport';
import { ViewedMarks, type ViewedTransport } from './viewedMarks';

import type { GitViewedMark } from '@clowdy/protocol';

const KEY = { projectId: 'p1', folderId: 'f1', workspaceId: 'w1' };
const PLACE = { folderId: 'f1', workspaceId: 'w1' };

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

/** A promise the test settles by hand, for a request that must stay on its way while something else is looked at. */
function deferred<T = void>() {
    let resolve: (value: T) => void = () => undefined;
    let reject: (reason: unknown) => void = () => undefined;
    const promise = new Promise<T>((done, fail) => {
        resolve = done;
        reject = fail;
    });

    return { promise, resolve, reject };
}

/** A transport that holds marks as the daemon would, and counts what it is asked. */
function daemon(initial: Record<string, GitViewedMark[]> = {}) {
    const held = new Map<string, Map<string, string>>(Object.entries(initial).map(([scope, marks]) => [scope, new Map(marks.map(mark => [mark.path, mark.revision]))]));
    const scope = (name: string) => {
        let marks = held.get(name);

        if (!marks) {
            marks = new Map();
            held.set(name, marks);
        }

        return marks;
    };
    const setReal = async (_project: string, _place: unknown, name: string, path: string, revision: string): Promise<GitViewedMark> => {
        scope(name).set(path, revision);

        return { path, revision };
    };
    const clearReal = async (_project: string, _place: unknown, name: string, path: string): Promise<void> => {
        scope(name).delete(path);
    };
    const transport = {
        getGitViewed: vi.fn(async (_project: string, _place: unknown, name: string) => [...scope(name)].map(([path, revision]) => ({ path, revision }))),
        setGitViewed: vi.fn(setReal),
        clearGitViewed: vi.fn(clearReal),
    };

    return {
        held,
        transport: transport as unknown as ViewedTransport & typeof transport,
        /** Holds the next request that sets a mark until the test lets it go: the daemon does what it is asked then, and not before. */
        holdSet() {
            const gate = deferred();

            transport.setGitViewed.mockImplementationOnce(async (...args) => {
                await gate.promise;

                return setReal(...args);
            });

            return gate;
        },
        /** Holds the next request that clears a mark in the same way. */
        holdClear() {
            const gate = deferred();

            transport.clearGitViewed.mockImplementationOnce(async (...args) => {
                await gate.promise;

                return clearReal(...args);
            });

            return gate;
        },
    };
}

const file = (path: string, revision = 'r1') => ({ path, revision });

describe('a file counts as viewed', () => {
    it('only while its revision is the one it was marked at, so an edit clears the mark with no read', async () => {
        const { transport } = daemon({ all: [{ path: 'a.ts', revision: 'r1' }] });
        const marks = new ViewedMarks(KEY, transport);

        expect(marks.isViewed('all', file('a.ts'))).toBe(false);

        await marks.read('all');
        expect(transport.getGitViewed).toHaveBeenCalledWith('p1', PLACE, 'all');
        expect(marks.isViewed('all', file('a.ts'))).toBe(true);
        // The same file, edited: another revision, and no request was made to find out.
        expect(marks.isViewed('all', file('a.ts', 'r2'))).toBe(false);
        expect(marks.isViewed('all', file('b.ts'))).toBe(false);
        expect(transport.getGitViewed).toHaveBeenCalledTimes(1);
        // It is viewed again when the edit is undone.
        expect(marks.isViewed('all', file('a.ts', 'r1'))).toBe(true);
    });

    it('in the scope it was marked in, and in no other', async () => {
        const { transport } = daemon({ all: [{ path: 'a.ts', revision: 'r1' }], uncommitted: [{ path: 'b.ts', revision: 'r1' }] });
        const marks = new ViewedMarks(KEY, transport);

        await marks.read('all');
        await marks.read('uncommitted');
        expect(marks.isViewed('all', file('a.ts'))).toBe(true);
        expect(marks.isViewed('all', file('b.ts'))).toBe(false);
        expect(marks.isViewed('uncommitted', file('a.ts'))).toBe(false);
        expect(marks.isViewed('uncommitted', file('b.ts'))).toBe(true);
        expect(marks.isViewed('branch', file('a.ts'))).toBe(false);
    });

    it('with the marks it had when a read fails, and says nothing of it', async () => {
        const { transport } = daemon({ all: [{ path: 'a.ts', revision: 'r1' }] });
        const marks = new ViewedMarks(KEY, transport);

        await marks.read('all');
        transport.getGitViewed.mockRejectedValueOnce(new TransportError('The daemon answered 503', 503));
        await marks.read('all');

        expect(marks.isViewed('all', file('a.ts'))).toBe(true);
        expect(marks.error).toBeUndefined();
    });

    it('as the daemon holds them after a later read, so a mark made in another window shows and one cleared there goes', async () => {
        const { held, transport } = daemon({ all: [{ path: 'a.ts', revision: 'r1' }] });
        const marks = new ViewedMarks(KEY, transport);

        await marks.read('all');
        held.get('all')!.set('b.ts', 'r1');
        held.get('all')!.delete('a.ts');
        await marks.read('all');

        expect(marks.isViewed('all', file('a.ts'))).toBe(false);
        expect(marks.isViewed('all', file('b.ts'))).toBe(true);
    });
});

describe('marking a file', () => {
    it('shows it as viewed at once, before the daemon has answered, and keeps it when it has', async () => {
        const { held, holdSet, transport } = daemon();
        const marks = new ViewedMarks(KEY, transport);
        const answer = holdSet();

        await marks.read('all');

        const done = marks.mark('all', file('a.ts'));

        expect(marks.isViewed('all', file('a.ts'))).toBe(true);
        expect(marks.revisionOf('all', 'a.ts')).toBe('r1');
        expect(transport.setGitViewed).toHaveBeenCalledWith('p1', PLACE, 'all', 'a.ts', 'r1');

        expect(held.get('all')?.has('a.ts')).toBe(false);

        answer.resolve();
        expect(await done).toBe(true);
        expect(marks.isViewed('all', file('a.ts'))).toBe(true);
        expect(held.get('all')!.get('a.ts')).toBe('r1');
        expect(marks.error).toBeUndefined();
    });

    it('takes it back when the daemon refuses, and says so with the daemon\'s reason', async () => {
        const { transport } = daemon();
        const marks = new ViewedMarks(KEY, transport);

        transport.setGitViewed.mockRejectedValueOnce(new TransportError('The worktree is missing', 503));

        const done = marks.mark('all', file('a.ts'));

        expect(marks.isViewed('all', file('a.ts'))).toBe(true);
        expect(await done).toBe(false);
        expect(marks.isViewed('all', file('a.ts'))).toBe(false);
        expect(marks.error).toBe('The worktree is missing');
    });

    it('replaces the mark of an edited file with the new revision, and the old revision is not viewed any more', async () => {
        const { held, transport } = daemon({ all: [{ path: 'a.ts', revision: 'r1' }] });
        const marks = new ViewedMarks(KEY, transport);

        await marks.read('all');
        await marks.mark('all', file('a.ts', 'r2'));

        expect(marks.isViewed('all', file('a.ts', 'r2'))).toBe(true);
        expect(marks.isViewed('all', file('a.ts', 'r1'))).toBe(false);
        expect(held.get('all')!.get('a.ts')).toBe('r2');
    });

    it('keeps a refused new mark from taking the old one away: the file is viewed at the revision the daemon still holds', async () => {
        const { transport } = daemon({ all: [{ path: 'a.ts', revision: 'r1' }] });
        const marks = new ViewedMarks(KEY, transport);

        await marks.read('all');
        transport.setGitViewed.mockRejectedValueOnce(new TransportError('no', 400));
        await marks.mark('all', file('a.ts', 'r2'));

        expect(marks.isViewed('all', file('a.ts', 'r1'))).toBe(true);
        expect(marks.isViewed('all', file('a.ts', 'r2'))).toBe(false);
    });
});

describe('clearing a mark', () => {
    it('shows the file as not viewed at once, and the daemon forgets it', async () => {
        const { held, holdClear, transport } = daemon({ all: [{ path: 'a.ts', revision: 'r1' }] });
        const marks = new ViewedMarks(KEY, transport);
        const answer = holdClear();

        await marks.read('all');

        const done = marks.unmark('all', 'a.ts');

        expect(marks.isViewed('all', file('a.ts'))).toBe(false);
        expect(transport.clearGitViewed).toHaveBeenCalledWith('p1', PLACE, 'all', 'a.ts');

        expect(held.get('all')!.has('a.ts')).toBe(true);

        answer.resolve();
        expect(await done).toBe(true);
        expect(marks.isViewed('all', file('a.ts'))).toBe(false);
        expect(held.get('all')!.has('a.ts')).toBe(false);
    });

    it('brings the mark back when the daemon refuses', async () => {
        const { transport } = daemon({ all: [{ path: 'a.ts', revision: 'r1' }] });
        const marks = new ViewedMarks(KEY, transport);

        await marks.read('all');
        transport.clearGitViewed.mockRejectedValueOnce(new TransportError('The daemon answered 502', 502));

        const done = marks.unmark('all', 'a.ts');

        expect(marks.isViewed('all', file('a.ts'))).toBe(false);
        expect(await done).toBe(false);
        expect(marks.isViewed('all', file('a.ts'))).toBe(true);
        expect(marks.error).toContain('502');
    });
});

describe('a refusal that was on show', () => {
    it('is let go of by the next write that the daemon takes, and by the next read of the place', async () => {
        const { transport } = daemon();
        const marks = new ViewedMarks(KEY, transport);

        transport.setGitViewed.mockRejectedValueOnce(new TransportError('no', 503));
        await marks.mark('all', file('a.ts'));
        expect(marks.error).toBe('no');
        await marks.mark('all', file('a.ts'));
        expect(marks.error).toBeUndefined();

        transport.clearGitViewed.mockRejectedValueOnce(new TransportError('no again', 503));
        await marks.unmark('all', 'a.ts');
        expect(marks.error).toBe('no again');
        await marks.read('all');
        expect(marks.error).toBeUndefined();
    });
});

describe('several choices about one file', () => {
    it('are sent one after the other, in the order they were made, and the last one is what stays', async () => {
        const { held, holdSet, transport } = daemon();
        const marks = new ViewedMarks(KEY, transport);
        const first = holdSet();

        await marks.read('all');

        const marked = marks.mark('all', file('a.ts'));
        const cleared = marks.unmark('all', 'a.ts');

        await tick();
        // The clear waits for the mark's answer, so the daemon cannot see them the other way round.
        expect(transport.setGitViewed).toHaveBeenCalledTimes(1);
        expect(transport.clearGitViewed).not.toHaveBeenCalled();
        expect(marks.isViewed('all', file('a.ts'))).toBe(false);

        first.resolve();
        expect(await Promise.all([marked, cleared])).toEqual([true, true]);
        expect(transport.clearGitViewed).toHaveBeenCalledTimes(1);
        expect(marks.isViewed('all', file('a.ts'))).toBe(false);
        expect(held.get('all')!.has('a.ts')).toBe(false);
    });

    it('do not undo each other when an earlier one fails after a later one was made', async () => {
        const { transport } = daemon({ all: [{ path: 'a.ts', revision: 'r1' }] });
        const marks = new ViewedMarks(KEY, transport);
        const first = deferred<GitViewedMark>();

        await marks.read('all');
        transport.setGitViewed.mockImplementationOnce(() => first.promise);

        const marked = marks.mark('all', file('a.ts', 'r2'));
        const cleared = marks.unmark('all', 'a.ts');

        first.reject(new TransportError('no', 503));
        expect(await marked).toBe(false);
        expect(await cleared).toBe(true);
        expect(marks.isViewed('all', file('a.ts', 'r1'))).toBe(false);
        expect(marks.isViewed('all', file('a.ts', 'r2'))).toBe(false);
    });

    it('go together for different files', async () => {
        const { holdSet, transport } = daemon();
        const marks = new ViewedMarks(KEY, transport);
        const slow = holdSet();

        await marks.read('all');

        const first = marks.mark('all', file('a.ts'));
        const second = marks.mark('all', file('b.ts'));

        await tick();
        expect(transport.setGitViewed).toHaveBeenCalledTimes(2);

        slow.resolve();
        await Promise.all([first, second]);
        expect(marks.isViewed('all', file('a.ts'))).toBe(true);
        expect(marks.isViewed('all', file('b.ts'))).toBe(true);
    });
});

describe('a read and a write that overlap', () => {
    it('leaves the mark just made on show when the read began before it and ended after: the answer of the read is older', async () => {
        const { transport } = daemon();
        const marks = new ViewedMarks(KEY, transport);
        const read = deferred<GitViewedMark[]>();

        transport.getGitViewed.mockImplementationOnce(() => read.promise);

        const reading = marks.read('all');
        const marking = marks.mark('all', file('a.ts'));

        // The read answers with a list from before the mark.
        read.resolve([{ path: 'old.ts', revision: 'r0' }]);
        await Promise.all([reading, marking]);
        await tick();

        expect(marks.isViewed('all', file('a.ts'))).toBe(true);
        // Nothing was known of the scope but what this window wrote, so the whole of it was read again once the write was over.
        expect(transport.getGitViewed).toHaveBeenCalledTimes(2);
    });

    it('does not read a scope again after a write when the scope was read before it', async () => {
        const { transport } = daemon();
        const marks = new ViewedMarks(KEY, transport);

        await marks.read('all');
        await marks.mark('all', file('a.ts'));
        await tick();

        expect(transport.getGitViewed).toHaveBeenCalledTimes(1);
    });
});

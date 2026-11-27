import { autorun } from 'mobx';
import { describe, expect, it } from 'vitest';

import { RELEASED_STREAMS_KEPT, StreamStore } from './StreamStore';

import type { StreamItem } from '@clowdy/protocol';
import type { StreamTarget, Transport } from '../daemon/transport';

const item = (seq: number, text: string, done = true): StreamItem => ({
    id: `i${seq}`,
    runId: 'r1',
    seq,
    at: seq,
    body: { kind: 'assistant', text, done },
});
const texts = (items: StreamItem[]) =>
    items.map(entry => (entry.body.kind === 'assistant' ? entry.body.text : entry.body.kind));

/** A transport whose item fetch the test releases by hand. */
function slowTransport(fetched: StreamItem[]) {
    let release: (items: StreamItem[]) => void = () => undefined;
    const calls: StreamTarget[] = [];
    const transport = {
        getItems: (target: StreamTarget) => {
            calls.push(target);

            return new Promise<StreamItem[]>(resolve => {
                release = resolve;
            });
        },
    } as unknown as Transport;

    return { transport, calls, finish: () => release(fetched) };
}

/** A transport that answers every item fetch at once and records the runs it was asked for. */
function countingTransport(items: () => StreamItem[]) {
    const calls: string[] = [];
    const transport = {
        getItems: async (target: StreamTarget) => {
            calls.push('runId' in target ? target.runId : target.chatId);

            return items();
        },
    } as unknown as Transport;

    return { transport, calls };
}

describe('StreamStore', () => {
    it('orders fetched items by seq', async () => {
        const store = new StreamStore({
            getItems: async () => [item(3, 'c'), item(1, 'a'), item(2, 'b')],
        } as unknown as Transport);
        const stream = store.of('r1');

        await stream.load();

        expect(stream.status).toBe('ready');
        expect(texts(stream.items)).toEqual(['a', 'b', 'c']);
    });

    it('updates an item in place when a live upsert has its id, and appends a new one at its seq', async () => {
        const store = new StreamStore({
            getItems: async () => [item(1, 'a'), item(2, 'partial', false)],
        } as unknown as Transport);
        const stream = store.of('r1');

        await stream.load();
        store.applyItem(item(2, 'partial text, now longer', false));
        store.applyItem(item(2, 'partial text, now longer and done'));
        store.applyItem(item(3, 'next'));

        expect(texts(stream.items)).toEqual(['a', 'partial text, now longer and done', 'next']);
        expect(stream.items).toHaveLength(3);
    });

    it('keeps live items that arrive while the fetch is in flight, over what the fetch returns', async () => {
        const { transport, finish } = slowTransport([item(1, 'a'), item(2, 'old version', false)]);
        const store = new StreamStore(transport);
        const stream = store.of('r1');
        const loading = stream.load();

        store.applyItem(item(2, 'newer version'));
        store.applyItem(item(3, 'brand new'));
        expect(stream.items).toEqual([]);

        finish();
        await loading;

        expect(texts(stream.items)).toEqual(['a', 'newer version', 'brand new']);
    });

    it('ignores items of a stream nobody opened, and fetches an opened stream only once', async () => {
        const { transport, calls, finish } = slowTransport([item(1, 'a')]);
        const store = new StreamStore(transport);

        store.applyItem(item(1, 'lost'));
        const stream = store.of('r1');
        const first = stream.load();
        const second = stream.load();

        finish();
        await Promise.all([first, second]);
        await stream.load();

        expect(calls).toEqual([{ runId: 'r1' }]);
        expect(texts(stream.items)).toEqual(['a']);
    });

    it('records a failed fetch and fetches again on the next load', async () => {
        let failing = true;
        const store = new StreamStore({
            getItems: async () => {
                if (failing) throw new Error('offline');

                return [item(1, 'a')];
            },
        } as unknown as Transport);
        const stream = store.of('r1');

        await stream.load();
        expect(stream.status).toBe('failed');
        expect(stream.error).toBe('offline');

        failing = false;
        await stream.load();
        expect(texts(stream.items)).toEqual(['a']);
    });

    it('puts a live item that arrives out of order at its seq', async () => {
        const store = new StreamStore({ getItems: async () => [item(1, 'a'), item(4, 'd')] } as unknown as Transport);
        const stream = store.of('r1');

        await stream.load();
        store.applyItem(item(3, 'c'));
        store.applyItem(item(2, 'b'));
        store.applyItem(item(5, 'e'));

        expect(texts(stream.items)).toEqual(['a', 'b', 'c', 'd', 'e']);
    });

    it('tells a reader of one item about that item only, and a reader of the ids only when an item comes or goes', async () => {
        const store = new StreamStore({
            getItems: async () => [item(1, 'a'), item(2, 'partial', false)],
        } as unknown as Transport);
        const stream = store.of('r1');
        const seen: string[] = [];
        const idLists: (readonly string[])[] = [];

        await stream.load();

        const stopItem = autorun(() => {
            const first = stream.item('i1');

            seen.push(first?.body.kind === 'assistant' ? first.body.text : '');
        });
        const stopIds = autorun(() => void idLists.push(stream.ids));

        store.applyItem(item(2, 'partial, longer', false));
        store.applyItem(item(1, 'a, edited'));
        store.applyItem(item(3, 'next'));
        stopItem();
        stopIds();

        expect({ seen, idLists }).toEqual({
            seen: ['a', 'a, edited'],
            idLists: [
                ['i1', 'i2'],
                ['i1', 'i2', 'i3'],
            ],
        });
    });

    it('fetches the held streams again after a resync and drops the others, which are fetched again when shown', async () => {
        let version = 'before';
        const { transport, calls } = countingTransport(() => [item(1, version)]);
        const store = new StreamStore(transport);
        const held = store.of('r1');
        const released = store.of('r2');

        store.hold(held);
        await Promise.all([held.load(), released.load()]);
        version = 'after';
        await store.reloadAll();

        const shownAgain = store.of('r2');

        await shownAgain.load();

        expect({
            held: texts(held.items),
            shownAgain: texts(shownAgain.items),
            replaced: shownAgain !== released,
            calls,
        }).toEqual({ held: ['after'], shownAgain: ['after'], replaced: true, calls: ['r1', 'r2', 'r1', 'r2'] });
    });

    it('keeps the streams let go last, up to its limit, current, and drops the older ones', async () => {
        const store = new StreamStore(countingTransport(() => []).transport);
        const streams = Array.from({ length: RELEASED_STREAMS_KEPT + 2 }, (_, index) => store.of(`r${index}`));
        const releases = streams.map(stream => store.hold(stream));

        await Promise.all(streams.map(stream => stream.load()));
        releases.forEach(release => release());
        streams.forEach(stream => store.applyItem({ ...item(1, 'live'), runId: stream.runId }));

        expect(streams.map(stream => stream.items.length)).toEqual([0, 0, ...Array(RELEASED_STREAMS_KEPT).fill(1)]);
    });

    it('keeps a stream current while any view holds it, and a release called twice counts once', async () => {
        const store = new StreamStore(countingTransport(() => []).transport);
        const shown = store.of('shown');
        const first = store.hold(shown);

        store.hold(shown);
        await shown.load();
        first();
        first();
        Array.from({ length: RELEASED_STREAMS_KEPT + 1 }, (_, index) => store.hold(store.of(`other${index}`))());
        store.applyItem({ ...item(1, 'live'), runId: 'shown' });

        expect(texts(shown.items)).toEqual(['live']);
    });

    it('gives every view of a run in one render the same stream, however many new streams that render asks for between them', async () => {
        const store = new StreamStore(countingTransport(() => []).transport);
        const firstView = store.of('r1');

        Array.from({ length: RELEASED_STREAMS_KEPT + 1 }, (_, index) => store.of(`other${index}`));

        const laterView = store.of('r1');

        store.hold(firstView);
        store.hold(laterView);
        await Promise.all([firstView.load(), laterView.load()]);
        store.applyItem(item(1, 'live'));

        expect({ first: texts(firstView.items), later: texts(laterView.items) }).toEqual({
            first: ['live'],
            later: ['live'],
        });
    });

    it('takes the answer of the latest fetch when an earlier one answers after it', async () => {
        const answers: Array<(items: StreamItem[]) => void> = [];
        const store = new StreamStore({
            getItems: () => new Promise<StreamItem[]>(resolve => answers.push(resolve)),
        } as unknown as Transport);
        const stream = store.of('r1');
        const firstLoad = stream.load();
        const resync = stream.reload();

        answers[1]!([item(1, 'after')]);
        await resync;
        store.applyItem(item(2, 'live'));
        answers[0]!([item(1, 'before')]);
        await firstLoad;

        expect({ status: stream.status, texts: texts(stream.items) }).toEqual({
            status: 'ready',
            texts: ['after', 'live'],
        });
    });

    describe('a truncation', () => {
        it('drops the items from its number on and keeps the rest, and the next item may take the freed number under a new id', async () => {
            const store = new StreamStore({
                getItems: async () => [item(1, 'a'), item(2, 'b'), item(3, 'c'), item(4, 'd')],
            } as unknown as Transport);
            const stream = store.of('r1');

            await stream.load();
            store.applyTruncation('r1', 3);

            expect(texts(stream.items)).toEqual(['a', 'b']);

            store.applyItem({ ...item(3, 'new'), id: 'i3-again' });
            store.applyItem(item(2, 'b, changed'));

            expect(stream.items.map(entry => [entry.seq, entry.id])).toEqual([
                [1, 'i1'],
                [2, 'i2'],
                [3, 'i3-again'],
            ]);
            expect(texts(stream.items)).toEqual(['a', 'b, changed', 'new']);
        });

        it('cuts nothing when the number is past the end, and everything when it is the first', async () => {
            const store = new StreamStore({
                getItems: async () => [item(1, 'a'), item(2, 'b')],
            } as unknown as Transport);
            const stream = store.of('r1');

            await stream.load();
            store.applyTruncation('r1', 3);
            expect(texts(stream.items)).toEqual(['a', 'b']);

            store.applyTruncation('r1', 1);
            expect(stream.items).toEqual([]);
            expect(stream.status).toBe('ready');
        });

        it('touches only the stream of its run, and none that nobody opened', async () => {
            const store = new StreamStore({
                getItems: async (target: StreamTarget) =>
                    'runId' in target && target.runId === 'r1'
                        ? [item(1, 'a'), item(2, 'b')]
                        : [
                              { ...item(1, 'other'), runId: 'r2', id: 'x1' },
                              { ...item(2, 'other 2'), runId: 'r2', id: 'x2' },
                          ],
            } as unknown as Transport);
            const first = store.of('r1');
            const second = store.of('r2');

            await Promise.all([first.load(), second.load()]);
            store.applyTruncation('r1', 2);
            store.applyTruncation('r3', 1);

            expect(texts(first.items)).toEqual(['a']);
            expect(texts(second.items)).toEqual(['other', 'other 2']);
        });

        it('replays a cut in arrival order over a fetch that was made before it: the old items go, the new ones that came after it stay', async () => {
            const { transport, finish } = slowTransport([item(1, 'a'), item(2, 'old b'), item(3, 'old c')]);
            const store = new StreamStore(transport);
            const stream = store.of('r1');
            const loading = stream.load();

            store.applyTruncation('r1', 2);
            store.applyItem({ ...item(2, 'new b'), id: 'i2-again' });
            expect(stream.items).toEqual([]);

            finish();
            await loading;

            expect(stream.items.map(entry => [entry.seq, entry.id])).toEqual([
                [1, 'i1'],
                [2, 'i2-again'],
            ]);
        });

        it('replays a cut over a fetch that was made after it: what came after the cut is re-added by its own events', async () => {
            const { transport, finish } = slowTransport([
                item(1, 'a'),
                { ...item(2, 'new b'), id: 'i2-again' },
                { ...item(3, 'new answer'), id: 'i3-again' },
            ]);
            const store = new StreamStore(transport);
            const stream = store.of('r1');
            const loading = stream.load();

            store.applyTruncation('r1', 2);
            store.applyItem({ ...item(2, 'new b'), id: 'i2-again' });
            store.applyItem({ ...item(3, 'new answer'), id: 'i3-again' });

            finish();
            await loading;

            expect(texts(stream.items)).toEqual(['a', 'new b', 'new answer']);
        });

        it("is gone after a resync that fetches the stream again, which shows the daemon's own state", async () => {
            let fetched = [item(1, 'a'), item(2, 'b'), item(3, 'c')];
            const store = new StreamStore({ getItems: async () => fetched } as unknown as Transport);
            const stream = store.of('r1');

            store.hold(stream);
            await stream.load();
            store.applyTruncation('r1', 2);
            // The feed dropped the event that carries the new message; the resync reads it.
            fetched = [item(1, 'a'), { ...item(2, 'new b'), id: 'i2-again' }];
            await store.reloadAll();

            expect(texts(stream.items)).toEqual(['a', 'new b']);
        });

        it("is ignored by a stream that failed to load: its next fetch is the daemon's state", async () => {
            let failing = true;
            const store = new StreamStore({
                getItems: async () => {
                    if (failing) throw new Error('offline');

                    return [item(1, 'a')];
                },
            } as unknown as Transport);
            const stream = store.of('r1');

            await stream.load();
            store.applyTruncation('r1', 1);
            failing = false;
            await stream.load();

            expect(texts(stream.items)).toEqual(['a']);
        });
    });
});

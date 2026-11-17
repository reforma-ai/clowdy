import { describe, expect, it } from 'vitest';

import { StreamStore } from './StreamStore';

import type { StreamItem } from '@clowdy/protocol';
import type { StreamTarget, Transport } from '../daemon/transport';

const item = (seq: number, text: string, done = true): StreamItem => ({ id: `i${ seq }`, runId: 'r1', seq, at: seq, body: { kind: 'assistant', text, done } });
const texts = (items: StreamItem[]) => items.map(entry => (entry.body.kind === 'assistant' ? entry.body.text : entry.body.kind));

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

describe('StreamStore', () => {
    it('orders fetched items by seq', async () => {
        const store = new StreamStore({ getItems: async () => [item(3, 'c'), item(1, 'a'), item(2, 'b')] } as unknown as Transport);
        const stream = store.of('r1');

        await stream.load();

        expect(stream.status).toBe('ready');
        expect(texts(stream.items)).toEqual(['a', 'b', 'c']);
    });

    it('updates an item in place when a live upsert has its id, and appends a new one at its seq', async () => {
        const store = new StreamStore({ getItems: async () => [item(1, 'a'), item(2, 'partial', false)] } as unknown as Transport);
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

    it('reloads every opened stream after a resync', async () => {
        let version = 'before';
        const store = new StreamStore({ getItems: async () => [item(1, version)] } as unknown as Transport);
        const stream = store.of('r1');

        await stream.load();
        version = 'after';
        await store.reloadAll();

        expect(texts(stream.items)).toEqual(['after']);
    });
});

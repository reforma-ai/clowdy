import { getItem, insertItem, nextSeq, updateItemBody } from '../db/items';
import { getRun } from '../db/runs';
import { notFound } from '../errors';
import { newId } from '../ids';

import type { StreamItem, StreamItemBody } from '@clowdy/protocol';
import type { Store } from '../store';

/** Appends an item to a run's stream and publishes it. */
export function appendItem(store: Store, runId: string, body: StreamItemBody): StreamItem {
    return store.tx(() => {
        const run = getRun(store.db, runId);

        if (!run) {
            throw notFound('Run', runId);
        }

        const item: StreamItem = { id: newId('itm'), runId, seq: nextSeq(store.db, runId), at: Date.now(), body };

        insertItem(store.db, item);
        store.emit(run.projectId, { type: 'stream.item', item });

        return item;
    });
}

/** Replaces the body of an existing item in place (streaming text, a tool changing state, an answered question). */
export function updateItem(store: Store, runId: string, seq: number, body: StreamItemBody): StreamItem {
    return store.tx(() => {
        const run = getRun(store.db, runId);
        const existing = getItem(store.db, runId, seq);

        if (!run || !existing) {
            throw notFound('Stream item', `${ runId }#${ seq }`);
        }

        updateItemBody(store.db, runId, seq, body);

        const item = { ...existing, body };

        store.emit(run.projectId, { type: 'stream.item', item });

        return item;
    });
}

import { deleteItemsFrom, getItem, insertItem, itemSeqOf, lastStorySeq, listItems, nextSeq, setItemRef, updateItemBody } from '../db/items';
import { deleteRuns, getRun, runsStartedAfter } from '../db/runs';
import { notFound } from '../errors';
import { newId } from '../ids';

import type { Run, StreamItem, StreamItemBody } from '@clowdy/protocol';
import type { Store } from '../store';

/**
 * Whether the items of `run` say what the app may offer on them (`canFork`, `canEdit`): only a chat's own orchestrator has messages of the person's to
 * edit and answers to fork (a sub-agent's stream is read-only), and only when its agent can fork at rewind points (`Store.forkable`).
 */
function offersRewind(store: Store, run: Run): boolean {
    return run.role === 'orchestrator' && run.chatId !== undefined && store.forkable(run.engine);
}

/** The items of a run's stream after `after`, as a client reads them: with the flags of what the agent behind the run can do with them. */
export function streamItems(store: Store, runId: string, after: number): StreamItem[] {
    const run = getRun(store.db, runId);

    return listItems(store.db, runId, after, run !== undefined && offersRewind(store, run));
}

/** One item of a run's stream by its id, as a client reads it (with its flags); `undefined` when the run has no such item. */
export function streamItem(store: Store, run: Run, itemId: string): StreamItem | undefined {
    const seq = itemSeqOf(store.db, run.id, itemId);

    return seq === undefined ? undefined : getItem(store.db, run.id, seq, offersRewind(store, run));
}

/**
 * Copies stored items (`listItemsWithRefs`) into another run's stream as new rows: new ids, the same `seq`, time and rewind point, and `rewrite` says what
 * each body becomes. The copies are not published: the run is new, and a client reads its stream when it opens it. Call it inside a transaction.
 */
export function copyItems(store: Store, items: readonly { item: StreamItem; ref?: string }[], toRunId: string, rewrite: (body: StreamItemBody) => StreamItemBody): void {
    for (const { item, ref } of items) {
        insertItem(store.db, { ...item, id: newId('itm'), runId: toRunId, body: rewrite(item.body) }, ref);
    }
}

/**
 * Drops the items of a run's stream from `fromSeq` on, and the sub-agent runs they started (the runs whose call is one of the dropped tool items, and the
 * ones no call is recorded for that began after the first dropped item, each with its own sub-agents and streams), and announces it as one event
 * (`stream.truncated`) in the same transaction. The next item of the stream takes `fromSeq` again. Returns the items as they were stored, so the caller can
 * see what went (the files of the messages among them). Call it inside a transaction.
 */
export function cutStream(store: Store, run: Run, fromSeq: number): StreamItem[] {
    return store.tx(() => {
        const items = listItems(store.db, run.id, fromSeq - 1);
        const calls = items.flatMap(item => item.body.kind === 'tool' ? [item.body.toolCallId] : []);
        const removedRunIds = items.length > 0 ? runsStartedAfter(store.db, run.id, calls, items[0].at) : [];

        deleteItemsFrom(store.db, run.id, fromSeq);
        deleteRuns(store.db, removedRunIds);
        store.emit(run.projectId, { type: 'stream.truncated', runId: run.id, fromSeq, removedRunIds });

        return items;
    });
}

/** Appends an item to a run's stream and publishes it. */
export function appendItem(store: Store, runId: string, body: StreamItemBody): StreamItem {
    return store.tx(() => {
        const run = getRun(store.db, runId);

        if (!run) {
            throw notFound('Run', runId);
        }

        const seq = nextSeq(store.db, runId);

        insertItem(store.db, { id: newId('itm'), runId, seq, at: Date.now(), body });

        // Read back, so the item goes out as a client reads it: a message of the person's that opens a turn says so.
        const item = getItem(store.db, runId, seq, offersRewind(store, run)) as StreamItem;

        store.emit(run.projectId, { type: 'stream.item', item });

        return item;
    });
}

/** Replaces the body of an existing item in place (streaming text, a tool changing state, an answered question). Its flags do not depend on its body. */
export function updateItem(store: Store, runId: string, seq: number, body: StreamItemBody): StreamItem {
    return store.tx(() => {
        const run = getRun(store.db, runId);
        const existing = run && getItem(store.db, runId, seq, offersRewind(store, run));

        if (!run || !existing) {
            throw notFound('Stream item', `${ runId }#${ seq }`);
        }

        updateItemBody(store.db, runId, seq, body);

        const item = { ...existing, body };

        store.emit(run.projectId, { type: 'stream.item', item });

        return item;
    });
}

/**
 * Keeps `ref`, the agent's own id of the message an `assistant` item says, as the rewind point of the turn that item ends, and publishes the item again
 * so a client sees what it can now offer. Only an item that ends the turn holds a point: it has to be the last of the stream's story (a note does not
 * count), since a point cuts the session after the message, and an item with a tool call or a steer after it would be cut in the middle of the turn.
 * Nothing happens for an item that holds no point after all.
 */
export function markRewindPoint(store: Store, runId: string, seq: number, ref: string): void {
    store.tx(() => {
        const run = getRun(store.db, runId);
        const existing = getItem(store.db, runId, seq);

        if (!run || existing?.body.kind !== 'assistant' || lastStorySeq(store.db, runId) !== seq) {
            return;
        }

        setItemRef(store.db, runId, seq, ref);

        // The point is not part of what a client reads; it changes what the item says only where the agent can fork.
        if (offersRewind(store, run)) {
            store.emit(run.projectId, { type: 'stream.item', item: getItem(store.db, runId, seq, true) as StreamItem });
        }
    });
}

import { makeAutoObservable, observableShallow, runInAction } from 'mobx';

import type { RunId, StreamItem } from '@clowdy/protocol';
import type { Transport } from '../daemon/transport';

export type StreamStatus = 'idle' | 'loading' | 'ready' | 'failed';

/**
 * The items of one run, from an initial fetch and live `stream.item` upserts, merged by item id and
 * shown in `seq` order. A `stream.truncated` event cuts the stream from a number on (an edit of a message
 * rewrote the chat there). A chat reads the stream of its orchestrator run.
 */
export class RunStream {
    status: StreamStatus = 'idle';
    error = '';
    byId = new Map<string, StreamItem>();
    /** Live items and cuts that arrived while the fetch was in flight, in arrival order; they are newer than, or equal to, what it returns. */
    #pending: Array<{ item: StreamItem } | { fromSeq: number }> = [];

    constructor(readonly runId: RunId, private readonly transport: Transport) {
        makeAutoObservable<RunStream, 'transport'>(this, { runId: false, transport: false, byId: observableShallow });
    }

    get items(): StreamItem[] {
        return [...this.byId.values()].sort((a, b) => a.seq - b.seq);
    }

    /** Fetches the items once; later calls do nothing unless the fetch failed. */
    async load(): Promise<void> {
        if (this.status === 'loading' || this.status === 'ready') return;

        await this.reload();
    }

    /** Fetches every item again, replacing what is shown, for a stream that may have missed events. */
    async reload(): Promise<void> {
        this.status = 'loading';
        this.#pending = [];

        try {
            const fetched = await this.transport.getItems({ runId: this.runId });

            runInAction(() => {
                this.byId = new Map(fetched.map(item => [item.id, item]));
                // Replayed in arrival order over the fetched state, so the newest version of an item wins and a cut takes what was cut after it.
                this.#pending.splice(0).forEach(change => ('item' in change ? this.byId.set(change.item.id, change.item) : this.#cut(change.fromSeq)));
                this.status = 'ready';
                this.error = '';
            });
        }
        catch (error) {
            runInAction(() => {
                this.status = 'failed';
                this.error = error instanceof Error ? error.message : String(error);
            });
        }
    }

    /** A live item: appended, or replacing the earlier version of the same item. */
    upsert(item: StreamItem): void {
        if (this.status === 'loading') this.#pending.push({ item });
        else if (this.status === 'ready') this.byId.set(item.id, item);
    }

    /** The daemon dropped every item from `fromSeq` on: they go, the rest stays. The next item may take `fromSeq` under a new id. */
    truncate(fromSeq: number): void {
        if (this.status === 'loading') this.#pending.push({ fromSeq });
        else if (this.status === 'ready') this.#cut(fromSeq);
    }

    #cut(fromSeq: number): void {
        for (const [id, item] of this.byId) {
            if (item.seq >= fromSeq) this.byId.delete(id);
        }
    }
}

/** The streams the UI has opened, by run id. */
export class StreamStore {
    readonly #streams = new Map<RunId, RunStream>();

    constructor(private readonly transport: Transport) {}

    /** The stream of a run. Creating it does not fetch: call `load()` (the `useRunStream` hook does). */
    of(runId: RunId): RunStream {
        let stream = this.#streams.get(runId);

        if (!stream) {
            stream = new RunStream(runId, this.transport);
            this.#streams.set(runId, stream);
        }

        return stream;
    }

    applyItem(item: StreamItem): void {
        this.#streams.get(item.runId)?.upsert(item);
    }

    applyTruncation(runId: RunId, fromSeq: number): void {
        this.#streams.get(runId)?.truncate(fromSeq);
    }

    /** Drops the streams of runs that no longer exist. */
    forget(runIds: readonly RunId[]): void {
        runIds.forEach(runId => this.#streams.delete(runId));
    }

    /** After a resync: every opened stream may have missed items. */
    async reloadAll(): Promise<void> {
        await Promise.all([...this.#streams.values()].filter(stream => stream.status !== 'idle').map(stream => stream.reload()));
    }
}

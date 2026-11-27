import { makeAutoObservable, observable, runInAction } from 'mobx';

import type { RunId, StreamItem } from '@clowdy/protocol';
import type { Transport } from '../daemon/transport';

export type StreamStatus = 'idle' | 'loading' | 'ready' | 'failed';

/** How many streams nobody shows are kept loaded, the latest let go kept: a chat opened again shortly is drawn at once. */
export const RELEASED_STREAMS_KEPT = 20;

/**
 * The items of one run, from an initial fetch and live `stream.item` upserts, merged by item id and
 * shown in `seq` order. A `stream.truncated` event cuts the stream from a number on (an edit of a message
 * rewrote the chat there). A chat reads the stream of its orchestrator run.
 *
 * An upsert costs the item, not the run: an update replaces its item, a new item goes in at its place in `seq` order. A view of the
 * whole list reads `items`; a view that draws each message on its own reads `ids` (a new list only when an item comes or goes) and
 * `item(id)` (one item), so a message that streams re-renders alone.
 */
export class RunStream {
    status: StreamStatus = 'idle';
    error = '';
    /** The item ids in `seq` order. */
    readonly #ids = observable.array<string>([], { deep: false });
    readonly #byId = observable.map<string, StreamItem>({}, { deep: false });
    /** Live items and cuts that arrived while the fetch was in flight, in arrival order; they are newer than, or equal to, what it returns. */
    #pending: Array<{ item: StreamItem } | { fromSeq: number }> = [];

    constructor(
        readonly runId: RunId,
        private readonly transport: Transport
    ) {
        makeAutoObservable<RunStream, 'transport'>(this, { runId: false, transport: false, item: false });
    }

    /** The ids of the items in `seq` order: a new list when an item comes or goes, the same one while items only change. */
    get ids(): readonly string[] {
        return this.#ids.slice();
    }

    /** The items in `seq` order: a new list on every change. */
    get items(): StreamItem[] {
        return this.#ids.map(id => this.#byId.get(id)!);
    }

    /** One item, by id: a reader of it re-renders when that item changes, not when another does. */
    item(id: string): StreamItem | undefined {
        return this.#byId.get(id);
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
                const sorted = [...fetched].sort((a, b) => a.seq - b.seq);

                this.#byId.replace(sorted.map(item => [item.id, item]));
                this.#ids.replace(sorted.map(item => item.id));
                // Replayed in arrival order over the fetched state, so the newest version of an item wins and a cut takes what was cut after it.
                this.#pending
                    .splice(0)
                    .forEach(change => ('item' in change ? this.#put(change.item) : this.#cut(change.fromSeq)));
                this.status = 'ready';
                this.error = '';
            });
        } catch (error) {
            runInAction(() => {
                this.status = 'failed';
                this.error = error instanceof Error ? error.message : String(error);
            });
        }
    }

    /** A live item: inserted at its place, or replacing the earlier version of the same item. */
    upsert(item: StreamItem): void {
        if (this.status === 'loading') this.#pending.push({ item });
        else if (this.status === 'ready') this.#put(item);
    }

    /** The daemon dropped every item from `fromSeq` on: they go, the rest stays. The next item may take `fromSeq` under a new id. */
    truncate(fromSeq: number): void {
        if (this.status === 'loading') this.#pending.push({ fromSeq });
        else if (this.status === 'ready') this.#cut(fromSeq);
    }

    #put(item: StreamItem): void {
        const known = this.#byId.get(item.id);

        if (known?.seq !== item.seq) {
            if (known) this.#ids.splice(this.#indexOf(known.seq), 1);

            this.#ids.splice(this.#indexOf(item.seq), 0, item.id);
        }

        this.#byId.set(item.id, item);
    }

    #cut(fromSeq: number): void {
        this.#ids.splice(this.#indexOf(fromSeq)).forEach(id => this.#byId.delete(id));
    }

    /** Where `seq` is, or goes, in `#ids`: the first place whose item's `seq` is not below it. */
    #indexOf(seq: number): number {
        let low = 0;
        let high = this.#ids.length;

        while (low < high) {
            const middle = (low + high) >>> 1;

            if (this.#byId.get(this.#ids[middle])!.seq < seq) low = middle + 1;
            else high = middle;
        }

        return low;
    }
}

/**
 * The streams the UI has opened, by run id. A view holds the stream it shows (`hold`, which `useRunStream` does); a stream nobody holds is kept
 * among the `RELEASED_STREAMS_KEPT` let go last and dropped after that, and a resync drops it at once instead of fetching it again. A dropped
 * stream is fetched again when it is shown again.
 */
export class StreamStore {
    readonly #streams = new Map<RunId, RunStream>();
    readonly #holds = new Map<RunStream, number>();
    /** The streams nobody holds, the one let go first first. */
    readonly #released = new Set<RunId>();

    constructor(private readonly transport: Transport) {}

    /** The stream of a run. Creating it does not fetch: call `load()` (the `useRunStream` hook does). */
    of(runId: RunId): RunStream {
        let stream = this.#streams.get(runId);

        if (!stream) {
            stream = new RunStream(runId, this.transport);
            this.#streams.set(runId, stream);
            this.#release(runId);
        }

        return stream;
    }

    /** Keeps a stream loaded and current while it is shown. Call the function it returns when it is not shown any more. */
    hold(stream: RunStream): () => void {
        const { runId } = stream;

        // A stream let go between the render that asked for it and this hold comes back.
        if (!this.#streams.has(runId)) this.#streams.set(runId, stream);

        this.#holds.set(stream, (this.#holds.get(stream) ?? 0) + 1);
        this.#released.delete(runId);

        let held = true;

        return () => {
            if (!held) return;

            held = false;

            const count = this.#holds.get(stream)! - 1;

            if (count > 0) return void this.#holds.set(stream, count);

            this.#holds.delete(stream);

            if (this.#streams.get(runId) === stream) this.#release(runId);
        };
    }

    applyItem(item: StreamItem): void {
        this.#streams.get(item.runId)?.upsert(item);
    }

    applyTruncation(runId: RunId, fromSeq: number): void {
        this.#streams.get(runId)?.truncate(fromSeq);
    }

    /** Drops the streams of runs that no longer exist. */
    forget(runIds: readonly RunId[]): void {
        for (const runId of runIds) {
            this.#streams.delete(runId);
            this.#released.delete(runId);
        }
    }

    /** After a resync: every held stream may have missed items and is fetched again; the rest are dropped. */
    async reloadAll(): Promise<void> {
        this.forget([...this.#released]);
        await Promise.all(
            [...this.#streams.values()].filter(stream => stream.status !== 'idle').map(stream => stream.reload())
        );
    }

    #release(runId: RunId): void {
        this.#released.delete(runId);
        this.#released.add(runId);

        for (const oldest of this.#released) {
            if (this.#released.size <= RELEASED_STREAMS_KEPT) break;

            this.forget([oldest]);
        }
    }
}

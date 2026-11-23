import { errorMessage } from '@clowdy/lib';
import { observable, runInAction } from 'mobx';

import type { GitFileSides, GitScope } from '@clowdy/protocol';

/** How many files' texts are read at the same time: the daemon runs a handful of `git` processes for each, so a screen of cards does not start them all at once. */
export const SIDES_CONCURRENCY = 4;

/** How many files' texts are kept. A text is at most 512 KB a side, and the ones that were read last are the ones kept. */
export const SIDES_CAPACITY = 150;

/** What a card asks for: one file in one scope, as its list has it (`from` and `revision` are the list's). */
export interface SidesRequest {
    scope: GitScope;
    path: string;
    /** The path before a rename. */
    oldPath?: string;
    /** `GitChangedFile.revision`: a file that is edited has another, so it is read again. */
    revision: string;
    /** `GitChanges.from` of the list the file is in. */
    from?: string;
}

/** Where a file's texts are: on their way, here, or not to be had. */
export type SidesEntry =
    | { status: 'loading' }
    | { status: 'ready'; sides: GitFileSides }
    | { status: 'error'; message: string };

/** What the cache reads a file's texts with. */
export type ReadSides = (request: SidesRequest) => Promise<GitFileSides>;

/** What a file's texts are kept under: the scope, the path and the revision, so a list that is read again asks only for the files that changed. */
export const sidesKey = ({ scope, path, revision }: SidesRequest): string => `${ scope }\n${ path }\n${ revision }`;

/**
 * The texts of the files of one place's changes, read when a card asks (`want`) and kept under the file's scope, path and revision. At most `SIDES_CONCURRENCY` reads run at
 * once and the rest wait in the order they were asked, so the cards near the top of a long list are read first; a card whose file is already read or on its way asks for nothing.
 * A file that is edited has another revision, which is another entry: the old one is not looked at again and goes when the cache is full (the entries that ended longest ago first).
 * A read that fails is an entry too, which `retry` replaces; `entryOf` is observable, so a card follows its own file's entry and nobody else's.
 */
export class SidesCache {
    readonly #entries = observable.map<string, SidesEntry>({}, { deep: false });
    /** The texts of each file in each scope as they were last read, whatever their revision: what a card keeps on show while the next revision is on its way. */
    readonly #latest = new Map<string, GitFileSides>();
    readonly #queue: SidesRequest[] = [];
    #running = 0;
    /** Bumped when the cache is cleared, so a read that was on its way does not put its answer in the new one. */
    #epoch = 0;

    constructor(
        private readonly read: ReadSides,
        private readonly concurrency = SIDES_CONCURRENCY,
        private readonly capacity = SIDES_CAPACITY
    ) {}

    /** Where the file's texts are, or nothing when nobody asked for them. */
    entryOf(request: SidesRequest): SidesEntry | undefined {
        return this.#entries.get(sidesKey(request));
    }

    /**
     * The texts of the file in the request's scope as they were last read, for any revision of it; nothing when none was. A card shows them while the revision it asks for is on its
     * way, and does not ask for it again when they are of that revision whether or not the cache still holds the entry.
     */
    latestOf({ scope, path }: Pick<SidesRequest, 'scope' | 'path'>): GitFileSides | undefined {
        return this.#latest.get(`${ scope }\n${ path }`);
    }

    /** Asks for a file's texts: nothing happens when they are here, on their way or waiting for their turn. */
    want(request: SidesRequest): void {
        const key = sidesKey(request);

        if (this.#entries.has(key)) return;

        runInAction(() => this.#entries.set(key, { status: 'loading' }));
        this.#queue.push(request);
        this.#pump();
    }

    /** Reads a file whose read failed again. */
    retry(request: SidesRequest): void {
        if (this.#entries.get(sidesKey(request))?.status !== 'error') return;

        runInAction(() => this.#entries.delete(sidesKey(request)));
        this.want(request);
    }

    /** Drops the reads that wait for their turn, except the ones `keep` says are still wanted: the list changed and a file they were for is not in it any more. */
    retainQueued(keep: (request: SidesRequest) => boolean): void {
        for (let index = this.#queue.length - 1; index >= 0; index--) {
            const request = this.#queue[index]!;

            if (keep(request)) continue;

            this.#queue.splice(index, 1);
            runInAction(() => this.#entries.delete(sidesKey(request)));
        }
    }

    /** Forgets everything, and the reads on their way are not kept when they end. */
    clear(): void {
        this.#epoch++;
        this.#queue.length = 0;
        this.#running = 0;
        this.#latest.clear();
        runInAction(() => this.#entries.clear());
    }

    #pump(): void {
        while (this.#running < this.concurrency && this.#queue.length > 0) {
            const request = this.#queue.shift()!;

            this.#running++;
            void this.#run(request);
        }
    }

    async #run(request: SidesRequest): Promise<void> {
        const epoch = this.#epoch;
        const key = sidesKey(request);
        let entry: SidesEntry;

        try {
            entry = { status: 'ready', sides: await this.read(request) };
        }
        catch (error) {
            entry = { status: 'error', message: errorMessage(error) };
        }

        // A cache that was cleared meanwhile counted this read out already.
        if (epoch !== this.#epoch) return;

        this.#running--;
        if (entry.status === 'ready') {
            const name = `${ request.scope }\n${ request.path }`;

            this.#latest.delete(name);
            this.#latest.set(name, entry.sides);

            // The files that were read longest ago are let go of, as the entries are.
            for (const [oldest] of [...this.#latest].slice(0, Math.max(0, this.#latest.size - this.capacity))) this.#latest.delete(oldest);
        }

        runInAction(() => {
            // Re-made, so that it stands last in the order the oldest go in.
            this.#entries.delete(key);
            this.#entries.set(key, entry);
            this.#evict();
        });
        this.#pump();
    }

    /** Past `capacity` read entries, the ones that ended first go; one that is waiting or on its way is never let go of, and does not count. */
    #evict(): void {
        let extra = [...this.#entries.values()].filter(entry => entry.status !== 'loading').length - this.capacity;

        for (const [key, entry] of this.#entries) {
            if (extra <= 0) break;

            if (entry.status === 'loading') continue;

            this.#entries.delete(key);
            extra--;
        }
    }
}

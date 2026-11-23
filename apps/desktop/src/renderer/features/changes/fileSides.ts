import { errorMessage } from '@clowdy/lib';
import { observable, runInAction } from 'mobx';

import type { GitFileSides, GitScope } from '@clowdy/protocol';

/** How many files' texts are read at the same time: the daemon runs a handful of `git` processes for each, so a screen of cards does not start them all at once. */
export const SIDES_CONCURRENCY = 4;

/** How many files' texts are kept, the ones that were read last. */
export const SIDES_CAPACITY = 150;

/**
 * How many characters of text are kept. A side is at most 512 KB (`MAX_GIT_SIDE_BYTES`), so an entry may hold a million characters, 1 to 2 MB in memory: the count alone would let
 * a place hold 150 of them, 300 MB, and the tab keeps four places. This bounds a place to about 16 to 32 MB; the files of an ordinary change (a few KB each) are far under it and
 * meet the count first.
 */
export const SIDES_MAX_CHARS = 16 * 1024 * 1024;

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

/** What a file is called whatever its revision: its scope and path. */
const fileKey = ({ scope, path }: Pick<SidesRequest, 'scope' | 'path'>): string => `${ scope }\n${ path }`;

/** How many characters of text a file's texts hold. */
const charsOf = (sides: GitFileSides): number => (sides.state === 'text' ? (sides.original?.length ?? 0) + (sides.modified?.length ?? 0) : 0);

/**
 * The texts of the files of one place's changes, read when a card asks (`want`) and kept under the file's scope, path and revision. At most `SIDES_CONCURRENCY` reads run at
 * once and the rest wait in the order they were asked, so the cards near the top of a long list are read first; a card whose file is already read or on its way asks for nothing.
 * A file that is edited has another revision, which is another entry: the old one is not looked at again and goes when the cache is full, by count or by the characters it holds
 * (the entries that ended longest ago first, never the one that just ended). A card that is shut, far from the screen or gone `drop`s its read when that still waits for its turn.
 * A read that fails is an entry too, which `retry` replaces; `entryOf` is observable, so a card follows its own file's entry and nobody else's.
 */
export class SidesCache {
    readonly #entries = observable.map<string, SidesEntry>({}, { deep: false });
    /** The texts of each file in each scope as they were last read, whatever their revision: what a card keeps on show while the next revision is on its way. They are the same objects the entries hold, and go with them. */
    readonly #latest = new Map<string, GitFileSides>();
    readonly #queue: SidesRequest[] = [];
    #running = 0;

    constructor(
        private readonly read: ReadSides,
        private readonly concurrency = SIDES_CONCURRENCY,
        private readonly capacity = SIDES_CAPACITY,
        private readonly maxChars = SIDES_MAX_CHARS
    ) {}

    /** Where the file's texts are, or nothing when nobody asked for them. */
    entryOf(request: SidesRequest): SidesEntry | undefined {
        return this.#entries.get(sidesKey(request));
    }

    /**
     * The texts of the file in the request's scope as they were last read, for any revision of it; nothing when none was. A card shows them while the revision it asks for is on its
     * way, and does not ask for it again when they are of that revision whether or not the cache still holds the entry.
     */
    latestOf(file: Pick<SidesRequest, 'scope' | 'path'>): GitFileSides | undefined {
        return this.#latest.get(fileKey(file));
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

    /** Lets go of a read that still waits for its turn: the card that asked is shut, far from the screen or gone. A read that has begun runs to its end and is kept. */
    drop(request: SidesRequest): void {
        const key = sidesKey(request);
        const index = this.#queue.findIndex(queued => sidesKey(queued) === key);

        if (index === -1) return;

        this.#queue.splice(index, 1);
        runInAction(() => this.#entries.delete(key));
    }

    #pump(): void {
        while (this.#running < this.concurrency && this.#queue.length > 0) {
            const request = this.#queue.shift()!;

            this.#running++;
            void this.#run(request);
        }
    }

    async #run(request: SidesRequest): Promise<void> {
        const key = sidesKey(request);
        let entry: SidesEntry;

        try {
            entry = { status: 'ready', sides: await this.read(request) };
        }
        catch (error) {
            entry = { status: 'error', message: errorMessage(error) };
        }

        this.#running--;

        if (entry.status === 'ready') this.#latest.set(fileKey(request), entry.sides);

        runInAction(() => {
            // Re-made, so that it stands last in the order the oldest go in.
            this.#entries.delete(key);
            this.#entries.set(key, entry);
            this.#evict(key);
        });
        this.#pump();
    }

    /**
     * Past `capacity` read entries or `maxChars` characters of text, the ones that ended first go, and with each the file's last texts when they are its. One that is waiting or on its
     * way is never let go of and does not count, and neither is `newest`, the one that just ended: a card would read it again at once, whatever its size.
     */
    #evict(newest: string): void {
        let count = 0;
        let chars = 0;

        for (const entry of this.#entries.values()) {
            if (entry.status === 'loading') continue;

            count++;

            if (entry.status === 'ready') chars += charsOf(entry.sides);
        }

        for (const [key, entry] of this.#entries) {
            if (count <= this.capacity && chars <= this.maxChars) break;

            if (entry.status === 'loading' || key === newest) continue;

            this.#entries.delete(key);
            count--;

            if (entry.status === 'ready') {
                chars -= charsOf(entry.sides);

                // The key is the file's, a newline and the revision, which has no newline in it.
                const file = key.slice(0, key.lastIndexOf('\n'));

                if (this.#latest.get(file) === entry.sides) this.#latest.delete(file);
            }
        }
    }
}

import { errorMessage } from '@clowdy/lib';
import { makeAutoObservable, observable, runInAction } from 'mobx';

import { placeRef, type GitPlaceKey } from './gitFacts';

import type { GitChangedFile, GitScope, GitViewedMark } from '@clowdy/protocol';
import type { Transport } from '../../daemon/transport';

/** What the marks are read and written with. */
export type ViewedTransport = Pick<Transport, 'getGitViewed' | 'setGitViewed' | 'clearGitViewed'>;

/** What the tab says when the daemon refused a mark: a phrase, quietly, in the summary line; the daemon's own reason is its tooltip. */
export const VIEWED_TEXT = {
    notSaved: 'Couldn\'t save the viewed mark',
} as const;

/** The marks of one scope: what the daemon holds, and what the person has chosen that it has not yet answered. */
class ScopeMarks {
    /** The revision each file was marked at, as the daemon holds it, by path. */
    readonly kept = observable.map<string, string>({}, { deep: false });
    /** The marks on their way: the revision being kept, or `null` for a mark being cleared. They are on show as soon as they are chosen. */
    readonly pending = observable.map<string, string | null>({}, { deep: false });
    /** A read has ended once, so `kept` is the daemon's whole answer and not only what this window wrote. */
    loaded = false;
    /** How many writes this window has started: a read that began before the last of them holds an older answer than the one on show. */
    writes = 0;

    constructor() {
        makeAutoObservable(this, { kept: false, pending: false, writes: false });
    }
}

/**
 * The files of one place that the person marked as viewed, for the scopes the tab has shown (`getGitViewed`, one read for each, again when the tab reads the place again). The daemon only
 * keeps the revision a file had when it was marked; a file counts as viewed only while the revision its list gives it is that one (`isViewed`), so an edit clears the mark with no read
 * and no timer. A mark that is set or cleared is on show at once and sent in the background: the writes of one file go one after the other, in the order they were made, and one the daemon
 * refuses is taken back (the file is as the daemon has it) with `error` set, which the tab says quietly. A read that fails keeps the marks as they were. Nothing here touches the texts
 * of the files: the optimistic state is its own.
 */
export class ViewedMarks {
    /** Why the daemon did not keep the last mark that was sent, until a write or a read succeeds. */
    error: string | undefined;
    readonly #scopes = new Map<GitScope, ScopeMarks>();
    /** The write each file waits for, by scope and path: the chain that keeps the writes of a file in order. */
    readonly #chains = new Map<string, Promise<unknown>>();

    constructor(
        private readonly key: GitPlaceKey,
        private readonly transport: ViewedTransport
    ) {
        makeAutoObservable<ViewedMarks, 'key' | 'transport'>(this, { key: false, transport: false });
    }

    /** The revision the file is marked at as of now, on show: what the person chose when the daemon has not answered, else what the daemon holds. */
    revisionOf(scope: GitScope, path: string): string | undefined {
        const marks = this.#marksOf(scope);

        return marks.pending.has(path) ? marks.pending.get(path) ?? undefined : marks.kept.get(path);
    }

    /** Whether the file is viewed: it is marked, and at the revision it has now. A file that was edited since it was marked is not. */
    isViewed(scope: GitScope, file: Pick<GitChangedFile, 'path' | 'revision'>): boolean {
        return this.revisionOf(scope, file.path) === file.revision;
    }

    /**
     * Reads the marks of a scope, which is what the tab does when it reads the place: a refusal that was on show is let go of when the read has an answer. A read that fails is not told to
     * anyone: the marks stay as they were, and the next read tries again.
     */
    async read(scope: GitScope): Promise<void> {
        const answered = await this.#readInto(scope);

        if (answered) {
            runInAction(() => {
                this.error = undefined;
            });
        }
    }

    /** Reads the marks of a scope into the ones on show; false when the read failed or was out of date by the time it ended. */
    async #readInto(scope: GitScope): Promise<boolean> {
        const marks = this.#marksOf(scope);
        const { projectId } = this.key;
        const started = marks.writes;
        let list: GitViewedMark[];

        try {
            list = await this.transport.getGitViewed(projectId, placeRef(this.key), scope);
        }
        catch {
            return false;
        }

        // A write begun since is newer than this answer; `#write` reads again when the first read was lost to one.
        if (marks.writes !== started) return false;

        runInAction(() => {
            marks.kept.replace(list.map(({ path, revision }) => [path, revision] as const));
            marks.loaded = true;
        });

        return true;
    }

    /** Marks the file as viewed at the revision its list gave it. Answers whether the daemon kept it; when it did not, the file is as it was. */
    mark(scope: GitScope, file: Pick<GitChangedFile, 'path' | 'revision'>): Promise<boolean> {
        return this.#write(scope, file.path, file.revision);
    }

    /** Clears the file's mark. Answers whether the daemon cleared it; when it did not, the file is as it was. */
    unmark(scope: GitScope, path: string): Promise<boolean> {
        return this.#write(scope, path, null);
    }

    #marksOf(scope: GitScope): ScopeMarks {
        let marks = this.#scopes.get(scope);

        if (!marks) {
            marks = new ScopeMarks();
            this.#scopes.set(scope, marks);
        }

        return marks;
    }

    async #write(scope: GitScope, path: string, revision: string | null): Promise<boolean> {
        const marks = this.#marksOf(scope);
        const chain = `${ scope }\n${ path }`;

        runInAction(() => {
            marks.pending.set(path, revision);
            marks.writes++;
        });

        const before = this.#chains.get(chain);
        // The first write of a file goes out at once; a later one waits for the one before it to be answered.
        const turn = before ? before.then(() => this.#send(marks, scope, path, revision)) : this.#send(marks, scope, path, revision);

        this.#chains.set(chain, turn);

        const kept = await turn;

        if (this.#chains.get(chain) === turn) this.#chains.delete(chain);

        // Marks of the scope this window never read are only what it wrote: the whole of them are read now.
        if (!marks.loaded) void this.#readInto(scope);

        return kept;
    }

    async #send(marks: ScopeMarks, scope: GitScope, path: string, revision: string | null): Promise<boolean> {
        const { projectId } = this.key;
        const place = placeRef(this.key);

        try {
            if (revision === null) {
                await this.transport.clearGitViewed(projectId, place, scope, path);
            }
            else {
                await this.transport.setGitViewed(projectId, place, scope, path, revision);
            }

            runInAction(() => {
                if (revision === null) {
                    marks.kept.delete(path);
                }
                else {
                    marks.kept.set(path, revision);
                }

                // A choice made after this one is still on its way and is not this one's to drop.
                if (marks.pending.has(path) && marks.pending.get(path) === revision) marks.pending.delete(path);

                this.error = undefined;
            });

            return true;
        }
        catch (error) {
            runInAction(() => {
                if (marks.pending.has(path) && marks.pending.get(path) === revision) marks.pending.delete(path);

                this.error = errorMessage(error);
            });

            return false;
        }
    }
}

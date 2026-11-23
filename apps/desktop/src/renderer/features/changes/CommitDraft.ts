import { errorMessage } from '@clowdy/lib';
import { makeAutoObservable, observable, runInAction } from 'mobx';

import { TransportError, type Transport } from '../../daemon/transport';
import { placeRef } from './gitFacts';

import type { GitChangedFile, GitCommitResult } from '@clowdy/protocol';
import type { PlaceChanges } from './PlaceChanges';

/** What the daemon said when the box could not do what it was asked: git's own line as the daemon gave it, and a hint beside it when it has one. */
export interface CommitFailure {
    /** What failed: the commit, or the request for a message. */
    what: 'commit' | 'generate';
    message: string;
    hint?: string;
}

/** What the box asks of the transport. */
export type CommitTransport = Pick<Transport, 'commitGit' | 'generateGitMessage'>;

/**
 * What the commit box holds for one place: which of its uncommitted files are ticked, the text of the message, and what the last commit or request for a message came to. It is kept for
 * the place as the Changes tab's model is (`commitDraftOf`), so a tab that is shut and opened again comes back with the ticks and the text the person left. All the files are ticked at
 * first: it keeps the files that were *un*ticked, so a file that appears is ticked, and one that goes (it was committed, or reverted) is forgotten when the list changes (`reconcile`).
 */
export class CommitDraft {
    /** The text of the message box; the first line is the subject. */
    message = '';
    /** The text Generate wrote, while the box still holds exactly that: Generate may replace it, and nothing the person typed is ever replaced. */
    generated: string | undefined;
    /** What is going on: a message is being written, or a commit is being made. One at a time. */
    busy: 'generate' | 'commit' | undefined;
    /** Why the last request failed, until the person acts again. */
    failure: CommitFailure | undefined;
    /** The commit the box just made, until the person acts again. */
    committed: GitCommitResult | undefined;
    readonly #unticked = observable.set<string>();

    constructor(
        readonly model: PlaceChanges,
        private readonly transport: CommitTransport,
        /** Asks for a new round of reads of the place (`GitFacts.refresh`): what a commit, or a commit that failed, may have changed. */
        private readonly refresh: () => void
    ) {
        makeAutoObservable<CommitDraft, 'transport' | 'refresh'>(this, { model: false, transport: false, refresh: false });
    }

    /** The place's uncommitted files, as the daemon lists them (new files included): what a commit can take. */
    get files(): readonly GitChangedFile[] {
        return this.model.uncommitted?.files ?? [];
    }

    /** Whether the list of the uncommitted files has been read, so the box knows the place is clean and does not only wait for it. */
    get known(): boolean {
        return this.model.uncommitted !== undefined;
    }

    /** The list holds only the first files of a larger one (the daemon cuts it at `MAX_GIT_CHANGED_FILES`): the rest cannot be ticked, so the box says so. */
    get truncated(): boolean {
        return this.model.uncommitted?.truncated === true;
    }

    isTicked(path: string): boolean {
        return !this.#unticked.has(path);
    }

    /** The files that will be committed, in the list's order. */
    get ticked(): readonly GitChangedFile[] {
        return this.files.filter(file => this.isTicked(file.path));
    }

    get allTicked(): boolean {
        return this.files.length > 0 && this.ticked.length === this.files.length;
    }

    get noneTicked(): boolean {
        return this.ticked.length === 0;
    }

    setTicked(path: string, on: boolean): void {
        if (on) {
            this.#unticked.delete(path);
        }
        else {
            this.#unticked.add(path);
        }

        this.#touched();
    }

    /** Ticks every file, or none. */
    setAll(on: boolean): void {
        this.#unticked.clear();

        if (!on) {
            for (const file of this.files) this.#unticked.add(file.path);
        }

        this.#touched();
    }

    /** Forgets the unticked files that the list no longer has, so one that comes back is ticked again as any new file is. Called when the list changes. */
    reconcile(): void {
        const present = new Set(this.files.map(file => file.path));

        for (const path of [...this.#unticked]) {
            if (!present.has(path)) this.#unticked.delete(path);
        }
    }

    setMessage(message: string): void {
        this.message = message;
        this.#touched();
    }

    /** Generate may write when something is ticked, nothing is going on and the box is empty or holds what Generate wrote before: typed text is never replaced. */
    get canGenerate(): boolean {
        return this.busy === undefined && !this.noneTicked && (this.message.trim() === '' || this.message === this.generated);
    }

    /** Why Generate is not offered right now, for its tooltip; nothing when it is. */
    get generateBlock(): string | undefined {
        if (this.noneTicked) return 'Tick a file first';

        return this.message.trim() !== '' && this.message !== this.generated ? 'Clear the message to have one written' : undefined;
    }

    get canCommit(): boolean {
        return this.busy === undefined && !this.noneTicked && this.message.trim() !== '';
    }

    /** What the person did to the box: the line about the last request is no longer about what they see. */
    #touched(): void {
        this.failure = undefined;
        this.committed = undefined;
    }

    /** Has the agent write the message for the ticked files. A failure leaves the box as it was. */
    async generate(): Promise<void> {
        if (!this.canGenerate) return;

        const { key } = this.model.facts;
        const paths = this.ticked.map(file => file.path);

        this.busy = 'generate';
        this.#touched();

        try {
            const { message } = await this.transport.generateGitMessage(key.projectId, placeRef(key), paths);

            runInAction(() => {
                // The person typed while it was written: what they typed stays.
                if (this.message.trim() === '' || this.message === this.generated) {
                    this.message = message;
                    this.generated = message;
                }
            });
        }
        catch (error) {
            runInAction(() => {
                this.failure = failureOf('generate', error);
            });
        }
        finally {
            runInAction(() => {
                this.busy = undefined;
            });
        }
    }

    /**
     * Commits the ticked files with the message. On success the box is clear and the place is read again; on failure it stays as it was, with git's own line, since what the person wrote is
     * theirs to keep. The place is read again either way: a commit that failed may still have changed it (a hook may edit files).
     */
    async commit(): Promise<void> {
        if (!this.canCommit) return;

        const { key } = this.model.facts;
        const paths = this.ticked.map(file => file.path);

        this.busy = 'commit';
        this.#touched();

        try {
            const result = await this.transport.commitGit(key.projectId, placeRef(key), paths, this.message);

            runInAction(() => {
                this.message = '';
                this.generated = undefined;
                this.committed = result;
            });
        }
        catch (error) {
            runInAction(() => {
                this.failure = failureOf('commit', error);
            });
        }
        finally {
            runInAction(() => {
                this.busy = undefined;
            });
            this.refresh();
        }
    }
}

function failureOf(what: CommitFailure['what'], error: unknown): CommitFailure {
    return { what, message: errorMessage(error), ...(error instanceof TransportError && error.hint !== undefined && { hint: error.hint }) };
}

const kept = new WeakMap<PlaceChanges, CommitDraft>();

/** What the commit box holds of a place, made when it is first asked for and kept as long as the place's `PlaceChanges` is (the latest few places). */
export function commitDraftOf(model: PlaceChanges, transport: CommitTransport, refresh: () => void): CommitDraft {
    let draft = kept.get(model);

    if (!draft) {
        draft = new CommitDraft(model, transport, refresh);
        kept.set(model, draft);
    }

    return draft;
}

import { errorMessage } from '@clowdy/lib';
import { makeAutoObservable, observable, runInAction } from 'mobx';

import { TransportError, type Transport } from '../../daemon/transport';
import { commitAndPushBlock, commitBlock, pushOrPublish } from './changesActions';
import { placeRef } from './gitFacts';

import type { GitChangedFile, GitCommitResult } from '@clowdy/protocol';
import type { PlaceChanges } from './PlaceChanges';
import type { RemoteActions } from './RemoteActions';

/** What the daemon said when the box could not do what it was asked: git's own line as the daemon gave it, and a hint beside it when it has one. */
export interface CommitFailure {
    /** What failed: the commit, the request for a message, or the push that came after a commit that was made (the commit stands, and the message says so). */
    what: 'commit' | 'generate' | 'push';
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
    /** What is going on: a message is being written, a commit is being made, or the branch is being sent after one (Commit & Push). One at a time. */
    busy: 'generate' | 'commit' | 'push' | undefined;
    /** Why the last request failed, until the person acts again. */
    failure: CommitFailure | undefined;
    /** The commit the box just made, until the person acts again. */
    committed: GitCommitResult | undefined;
    /** What was done with the branch after the commit (Commit & Push), until the person acts again: it was pushed, or published. */
    sent: 'push' | 'publish' | undefined;
    readonly #unticked = observable.set<string>();

    constructor(
        readonly model: PlaceChanges,
        private readonly transport: CommitTransport,
        /** Asks for a new round of reads of the place (`GitFacts.refresh`): what a commit, or a commit that failed, may have changed. */
        private readonly refresh: () => void,
        /** The place's moves to and from origin: what Commit & Push sends the branch with, and what it waits for. */
        private readonly remote: Pick<RemoteActions, 'run' | 'busy'>
    ) {
        makeAutoObservable<CommitDraft, 'transport' | 'refresh' | 'remote'>(this, { model: false, transport: false, refresh: false, remote: false });
    }

    /** The commit or its push is being made: the ticks and the message are held. */
    get writing(): boolean {
        return this.busy === 'commit' || this.busy === 'push';
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

    /**
     * Why Commit cannot be pressed, as GitHub Desktop's tooltips say it (`A commit summary is required to commit`, `Select one or more files to commit`); nothing when it can, and nothing
     * while the box is busy, since the button then says it is working and not that it is missing something.
     */
    get commitReason(): string | undefined {
        return this.busy === undefined ? commitBlock(this.message, this.ticked.length) : undefined;
    }

    /** Why Commit & Push is not offered right now, for its menu entry; nothing when it is. Another action running holds it, and so does a branch the push after the commit would not take. */
    get pushBlock(): string | undefined {
        return this.remote.busy ? 'An action is running' : commitAndPushBlock(this.model.facts.status.value);
    }

    get canCommitAndPush(): boolean {
        return this.canCommit && this.pushBlock === undefined;
    }

    /**
     * Fetches `origin` after a push that it turned down for commits the branch lacks (`! [rejected] ... (fetch first)`), as GitHub Desktop's `Newer Commits on Remote` offers. When the fetch
     * goes through, the line about that push goes: it was about a branch that stands otherwise now, and the sidebar's button says how (`Pull origin`, `Diverged`). The commit stands either way.
     */
    async fetchAfterRejection(): Promise<void> {
        const outcome = await this.remote.run('fetch');

        if (!outcome.ok) return;

        runInAction(() => {
            if (this.failure?.what === 'push') this.failure = undefined;
        });
    }

    /** What the person did to the box: the line about the last request is no longer about what they see. */
    #touched(): void {
        this.failure = undefined;
        this.committed = undefined;
        this.sent = undefined;
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
    async commit(andPush = false): Promise<void> {
        if (!(andPush ? this.canCommitAndPush : this.canCommit)) return;

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

            // The commit stands whatever the push comes to: the box is clear and the sidebar offers Push again if it failed.
            if (andPush) await this.#send(result);
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

    /**
     * Sends the branch after a commit that was made (a push, or its publishing when it is not on origin), and says so as the box does: a failed push is said with the commit, honestly, as
     * `Committed 1a2b3c4, push failed: <git's line>`, with the daemon's hint under it. The place's own moves hold their say (`report: false`), so the line is not told twice.
     */
    async #send(commit: GitCommitResult): Promise<void> {
        const action = pushOrPublish(this.model.facts.status.value);

        runInAction(() => {
            this.busy = 'push';
        });

        const outcome = await this.remote.run(action, { report: false });

        runInAction(() => {
            if (outcome.ok) {
                this.sent = action;
            }
            else {
                this.failure = { what: 'push', message: `Committed ${ commit.shortSha }, push failed: ${ outcome.failure.message }`, ...(outcome.failure.hint !== undefined && { hint: outcome.failure.hint }) };
            }
        });
    }
}

function failureOf(what: CommitFailure['what'], error: unknown): CommitFailure {
    return { what, message: errorMessage(error), ...(error instanceof TransportError && error.hint !== undefined && { hint: error.hint }) };
}

const kept = new WeakMap<PlaceChanges, CommitDraft>();

/** What the commit box holds of a place, made when it is first asked for and kept as long as the place's `PlaceChanges` is (the latest few places). */
export function commitDraftOf(model: PlaceChanges, transport: CommitTransport, refresh: () => void, remote: Pick<RemoteActions, 'run' | 'busy'>): CommitDraft {
    let draft = kept.get(model);

    if (!draft) {
        draft = new CommitDraft(model, transport, refresh, remote);
        kept.set(model, draft);
    }

    return draft;
}

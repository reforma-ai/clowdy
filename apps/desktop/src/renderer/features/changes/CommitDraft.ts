import { errorMessage } from '@clowdy/lib';
import { makeAutoObservable, observable, runInAction } from 'mobx';

import { type Transport, TransportError } from '../../daemon/transport';
import { branchOf, commitBlock, syncBlock } from './changesActions';
import { placeRef } from './gitFacts';
import { sourceControlPreferences } from './sourceControlPreferences';

import type { GitChangedFile, GitCommitResult, GitSyncProgress } from '@clowdy/protocol';
import type { PlaceChanges } from './PlaceChanges';
import type { RemoteActions } from './RemoteActions';

/** What the daemon said when the box could not do what it was asked: git's own line as the daemon gave it, and a hint beside it when it has one. */
export interface CommitFailure {
    /** What failed: the commit, the request for a message, or the sync that came after a commit that was made (the commit stands, and the message says so). */
    what: 'commit' | 'generate' | 'sync';
    message: string;
    hint?: string;
    syncBranch?: string;
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
    /** What is going on: a message is being written, a commit is being made, or the branch is syncing after one (Commit & Sync). One at a time. */
    busy: 'generate' | 'commit' | 'sync' | undefined;
    syncPhase: GitSyncProgress['phase'] | undefined;
    /** Why the last request failed, until the person acts again. */
    failure: CommitFailure | undefined;
    readonly #unticked = observable.set<string>();
    #generation?: AbortController;

    constructor(
        readonly model: PlaceChanges,
        private readonly transport: CommitTransport,
        /** Asks for a new round of reads of the place (`GitFacts.refresh`): what a commit, or a commit that failed, may have changed. */
        private readonly refresh: () => void,
        /** The place's moves to and from origin: what Commit & Sync sends the branch with, and what it waits for. */
        private readonly remote: Pick<RemoteActions, 'sync'>
    ) {
        makeAutoObservable<CommitDraft, 'transport' | 'refresh' | 'remote'>(this, {
            model: false,
            transport: false,
            refresh: false,
            remote: false,
        });
    }

    /** The commit or its sync is being made: the ticks and the message are held. */
    get writing(): boolean {
        return this.busy === 'commit' || this.busy === 'sync';
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
        } else {
            this.#unticked.add(path);
        }

        this.failure = undefined;
    }

    /** Ticks every file, or none. */
    setAll(on: boolean): void {
        this.#unticked.clear();

        if (!on) {
            for (const file of this.files) this.#unticked.add(file.path);
        }

        this.failure = undefined;
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
        this.failure = undefined;
    }

    /** Generate may write when something is ticked, nothing is going on and the box is empty or holds what Generate wrote before: typed text is never replaced. */
    get canGenerate(): boolean {
        return (
            this.busy === undefined &&
            !this.rebasing &&
            !this.noneTicked &&
            (this.message.trim() === '' || this.message === this.generated)
        );
    }

    /** Why Generate is not offered right now, for its tooltip; nothing when it is. */
    get generateBlock(): string | undefined {
        if (this.noneTicked) return 'Tick a file first';

        return this.message.trim() !== '' && this.message !== this.generated
            ? 'Clear the message to have one written'
            : undefined;
    }

    get merging() {
        const status = this.model.facts.status.value;

        return status?.isRepository === true ? status.merging : undefined;
    }

    get rebasing(): boolean {
        const status = this.model.facts.status.value;

        return status?.isRepository === true && status.rebasing === true;
    }

    /** A resolved merge can be committed without ticking files. */
    get concluding(): boolean {
        return this.merging?.conflicts === 0;
    }

    /** The message git prepared for the merge, when one is in progress and resolved. */
    get mergeSubject(): string | undefined {
        const merging = this.merging;

        return merging?.conflicts === 0 ? merging.subject : undefined;
    }

    /** Puts git's merge message in the box when the person has not written one. */
    prefill(subject: string): void {
        if (this.message.trim() !== '') return;

        this.message = subject;
    }

    get canCommit(): boolean {
        return (
            this.busy === undefined &&
            !this.model.facts.switching &&
            !this.rebasing &&
            (this.merging?.conflicts ?? 0) === 0 &&
            this.message.trim() !== '' &&
            (this.concluding || !this.noneTicked)
        );
    }

    /**
     * Why Commit cannot be pressed, as GitHub Desktop's tooltips say it (`A commit summary is required to commit`, `Select one or more files to commit`); nothing when it can, and nothing
     * while the box is busy, since the button then says it is working and not that it is missing something.
     */
    get commitReason(): string | undefined {
        if (this.busy !== undefined) return undefined;
        if (this.model.facts.switching) return 'The branch is being changed';
        if (this.rebasing) return 'Continue or abort the rebase first';

        if ((this.merging?.conflicts ?? 0) > 0) return 'Resolve the conflicts first';

        if (this.concluding) return this.message.trim() === '' ? 'A commit summary is required to commit' : undefined;

        return commitBlock(this.message, this.ticked.length);
    }

    /** Why Commit & Sync is unavailable, for the button and menu entry. */
    get syncBlock(): string | undefined {
        return syncBlock(this.model.facts.status.value);
    }

    get canCommitAndSync(): boolean {
        return this.canCommit && this.syncBlock === undefined;
    }

    get syncsByDefault(): boolean {
        return sourceControlPreferences.autoSync && syncBlock(this.model.facts.status.value) === undefined;
    }

    /** Start a fresh sync of the same branch when origin moved between fetch and push. */
    retrySync(): void {
        const branch = this.failure?.syncBranch;
        if (branch === undefined || this.model.facts.switching) return;

        this.failure = undefined;
        void this.remote.sync({ branch });
    }

    /** Has the agent write the message for the ticked files. A failure leaves the box as it was. */
    async generate(): Promise<void> {
        if (!this.canGenerate) return;

        const { key } = this.model.facts;
        const paths = this.ticked.map(file => file.path);
        const request = new AbortController();

        this.#generation = request;
        this.busy = 'generate';
        this.failure = undefined;

        try {
            const { message } = await this.transport.generateGitMessage(
                key.projectId,
                placeRef(key),
                paths,
                request.signal
            );

            if (request.signal.aborted) return;

            runInAction(() => {
                // The person typed while it was written: what they typed stays.
                if (this.message.trim() === '' || this.message === this.generated) {
                    this.message = message;
                    this.generated = message;
                }
            });
        } catch (error) {
            if (!request.signal.aborted)
                runInAction(() => {
                    this.failure = failureOf('generate', error);
                });
        } finally {
            if (this.#generation === request) {
                this.#generation = undefined;
                runInAction(() => {
                    this.busy = undefined;
                });
            }
        }
    }

    stopGenerating(): void {
        const request = this.#generation;
        if (!request) return;

        this.#generation = undefined;
        this.busy = undefined;
        request.abort();
    }

    /**
     * Commits the ticked files with the message. On success the box is clear and the place is read again; on failure it stays as it was, with git's own line, since what the person wrote is
     * theirs to keep. The place is read again either way: a commit that failed may still have changed it (a hook may edit files).
     */
    async commit(andSync = this.syncsByDefault): Promise<void> {
        if (!(andSync ? this.canCommitAndSync : this.canCommit)) return;

        const { key } = this.model.facts;
        const paths = this.ticked.map(file => file.path);
        const conclude = this.concluding;
        const status = this.model.facts.status.value;
        const branch = status?.isRepository ? branchOf(status) : undefined;

        this.busy = 'commit';
        this.failure = undefined;

        try {
            const result = conclude
                ? await this.transport.commitGit(key.projectId, placeRef(key), paths, this.message, {
                      conclude: true,
                  })
                : await this.transport.commitGit(key.projectId, placeRef(key), paths, this.message);

            runInAction(() => {
                this.message = '';
                this.generated = undefined;
            });

            // The commit stands if sync fails. The sidebar can run Sync again.
            if (andSync && branch !== undefined) await this.#sync(result, branch);
        } catch (error) {
            runInAction(() => {
                this.failure = failureOf('commit', error);
            });
        } finally {
            runInAction(() => {
                this.busy = undefined;
                this.syncPhase = undefined;
            });
            this.refresh();
        }
    }

    /** Synchronizes the new commit and keeps a sync failure separate from a commit failure. */
    async #sync(commit: GitCommitResult, branch: string): Promise<void> {
        runInAction(() => {
            this.busy = 'sync';
        });

        const outcome = await this.remote.sync(
            { branch, commit: commit.sha },
            {
                report: false,
                onProgress: ({ phase }) =>
                    runInAction(() => {
                        this.syncPhase = phase;
                    }),
            }
        );

        if (!outcome.ok) {
            runInAction(() => {
                this.failure = {
                    what: 'sync',
                    message: `Committed ${commit.shortSha}, sync failed: ${outcome.failure.message}`,
                    syncBranch: branch,
                    ...(outcome.failure.hint !== undefined && { hint: outcome.failure.hint }),
                };
            });
        }
    }
}

function failureOf(what: CommitFailure['what'], error: unknown): CommitFailure {
    return {
        what,
        message: errorMessage(error),
        ...(error instanceof TransportError && error.hint !== undefined && { hint: error.hint }),
    };
}

const kept = new WeakMap<PlaceChanges, CommitDraft>();

/** What the commit box holds of a place, made when it is first asked for and kept as long as the place's `PlaceChanges` is (the latest few places). */
export function commitDraftOf(
    model: PlaceChanges,
    transport: CommitTransport,
    refresh: () => void,
    remote: Pick<RemoteActions, 'sync'>
): CommitDraft {
    let draft = kept.get(model);

    if (!draft) {
        draft = new CommitDraft(model, transport, refresh, remote);
        kept.set(model, draft);
    }

    return draft;
}

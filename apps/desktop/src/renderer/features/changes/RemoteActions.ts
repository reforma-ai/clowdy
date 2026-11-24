import { errorMessage } from '@clowdy/lib';
import { makeAutoObservable, observable, runInAction } from 'mobx';

import { type Transport, TransportError } from '../../daemon/transport';
import { type RemoteActionId, remoteNotice, syncBlock } from './changesActions';
import { type PlaceFacts, placeRef } from './gitFacts';
import { sourceControlPreferences } from './sourceControlPreferences';

import type { GitRemoteResult, GitSyncProgress, GitSyncResult, GitSyncTarget } from '@clowdy/protocol';
import type { IObservableValue } from 'mobx';

/** What the actions ask of the transport. */
export type RemoteTransport = Pick<Transport, 'fetchGit' | 'pullGit' | 'syncGit' | 'updateGit' | 'abortGit'>;

/** How long a conflict notice stays under the button. A failure stays until the person acts again. */
export const NOTICE_MS = 6000;

/** What git or the daemon said when an action could not be done: git's own line as the daemon gave it, and a hint beside it when it has one. */
export interface RemoteFailure {
    action: RemoteActionId;
    message: string;
    hint?: string;
}

type Outcome<T> = { ok: true; result: T } | { ok: false; failure: RemoteFailure };

/** How an action ended, for a caller that tells it in its own words. */
export type RemoteOutcome = Outcome<GitRemoteResult>;
export type SyncOutcome = Outcome<GitSyncResult>;

type DirectAction = Exclude<RemoteActionId, 'sync'>;
type SyncPhase = IObservableValue<GitSyncProgress['phase'] | undefined>;
type PendingRequest =
    | { id: Exclude<DirectAction, 'update'>; fetching?: Promise<RemoteOutcome> }
    | { id: 'sync' | 'update'; phase: SyncPhase };

interface SyncOptions {
    report?: boolean;
    onProgress?: (progress: GitSyncProgress) => void;
}

/**
 * The sidebar and commit box share the pending writes of a place. The daemon runs those writes in order.
 * When each request ends, read the place again so the counts and pull request reflect what changed.
 */
export class RemoteActions {
    /** The conflict notice, until it goes. */
    notice: { words: string; tone?: 'warning' } | undefined;
    /** Why the last action failed, until the person acts again. */
    failure: RemoteFailure | undefined;
    #timer: ReturnType<typeof setTimeout> | undefined;
    readonly #requests = observable.array<PendingRequest>([], { deep: false });

    constructor(
        readonly facts: PlaceFacts,
        private readonly transport: RemoteTransport,
        /** Asks for a new round of reads of the place (`GitFacts.refresh`). */
        private readonly refresh: () => void
    ) {
        makeAutoObservable<RemoteActions, 'transport' | 'refresh'>(this, {
            facts: false,
            transport: false,
            refresh: false,
        });
    }

    /** The oldest pending action drives the sync button. */
    get running(): RemoteActionId | undefined {
        return this.#requests[0]?.id;
    }

    get syncPhase(): GitSyncProgress['phase'] | undefined {
        const first = this.#requests[0];
        return first && 'phase' in first ? first.phase.get() : undefined;
    }

    isPending(id: RemoteActionId): boolean {
        return this.#requests.some(request => request.id === id);
    }

    /** A write is pending or the checkout is switching branches. */
    get busy(): boolean {
        return this.running !== undefined || this.facts.switching;
    }

    /** Sends a direct action to the daemon's write queue. */
    run(id: DirectAction, { report = true }: { report?: boolean } = {}): Promise<RemoteOutcome> {
        if (this.facts.switching) return Promise.resolve(this.#switching(id));

        if (id === 'update') {
            const phase = observable.box<GitSyncProgress['phase'] | undefined>(undefined);
            return this.#track({ id, phase }, this.#update(phase, report));
        }

        if (id === 'fetch') {
            const pending = this.#requests.find(request => request.id === 'fetch');
            if (pending?.id === 'fetch' && pending.fetching) return pending.fetching;
        }

        const { key } = this.facts;
        const place = placeRef(key);
        const request: PendingRequest = { id };
        const outcome = this.#track(
            request,
            this.#perform(
                id,
                () => {
                    switch (id) {
                        case 'fetch':
                            return this.transport.fetchGit(key.projectId, place);
                        case 'pull':
                            return this.transport.pullGit(key.projectId, place);
                        case 'abort':
                            return this.transport.abortGit(key.projectId, place);
                    }
                },
                report
            )
        );
        if (id === 'fetch') request.fetching = outcome;
        return outcome;
    }

    /** An update that changed the local branch can sync exactly that result. Keep both steps under one UI pending state. */
    async #update(phase: SyncPhase, report: boolean): Promise<RemoteOutcome> {
        const { key, status } = this.facts;
        const place = placeRef(key);
        const autoSync = sourceControlPreferences.autoSync && syncBlock(status.value) === undefined;
        const outcome = await this.#perform('update', () => this.transport.updateGit(key.projectId, place), report);

        if (!autoSync || !outcome.ok || outcome.result.state !== 'done' || !outcome.result.pulled) return outcome;

        const target = outcome.result.updatedHead;
        if (!target) {
            if (report) {
                runInAction(() => {
                    this.failure = { action: 'sync', message: "Updated locally. Couldn't verify the branch for sync" };
                });
            }
            return outcome;
        }

        const synced = await this.#perform(
            'sync',
            () =>
                this.transport.syncGit(key.projectId, place, target, progress =>
                    runInAction(() => phase.set(progress.phase))
                ),
            report
        );
        if (report && !synced.ok) {
            runInAction(() => {
                this.failure = {
                    ...synced.failure,
                    message: `Updated locally, sync failed: ${synced.failure.message}`,
                };
            });
        }
        return outcome;
    }

    sync(target: GitSyncTarget, { report = true, onProgress }: SyncOptions = {}): Promise<SyncOutcome> {
        if (this.facts.switching) return Promise.resolve(this.#switching('sync'));

        const { key } = this.facts;
        const request = {
            id: 'sync' as const,
            phase: observable.box<GitSyncProgress['phase'] | undefined>(undefined),
        };
        return this.#track(
            request,
            this.#perform(
                'sync',
                () =>
                    this.transport.syncGit(key.projectId, placeRef(key), target, progress => {
                        runInAction(() => request.phase.set(progress.phase));
                        onProgress?.(progress);
                    }),
                report
            )
        );
    }

    #switching(action: RemoteActionId): Extract<RemoteOutcome, { ok: false }> {
        return { ok: false, failure: { action, message: 'The branch is being changed' } };
    }

    #track<T>(request: PendingRequest, outcome: Promise<Outcome<T>>): Promise<Outcome<T>> {
        this.#requests.push(request);
        return outcome.finally(() => {
            runInAction(() => this.#requests.remove(request));
            this.refresh();
        });
    }

    async #perform<T extends GitRemoteResult | GitSyncResult>(
        id: RemoteActionId,
        perform: () => Promise<T>,
        report: boolean
    ): Promise<Outcome<T>> {
        this.#forget();

        try {
            const result = await perform();
            const notice = report ? remoteNotice(result) : undefined;

            if (notice) runInAction(() => this.#say(notice));

            return { ok: true, result };
        } catch (error) {
            const failure: RemoteFailure = {
                action: id,
                message: errorMessage(error),
                ...(error instanceof TransportError && error.hint !== undefined && { hint: error.hint }),
            };

            runInAction(() => {
                if (report) this.failure = failure;
            });

            return { ok: false, failure };
        }
    }

    /** Clears what the last action said. */
    dismiss(): void {
        this.#forget();
    }

    #say(notice: { words: string; tone?: 'warning' }): void {
        this.notice = notice;
        clearTimeout(this.#timer);
        this.#timer = setTimeout(() => {
            runInAction(() => {
                this.notice = undefined;
            });
        }, NOTICE_MS);
    }

    #forget(): void {
        clearTimeout(this.#timer);
        this.#timer = undefined;
        this.notice = undefined;
        this.failure = undefined;
    }
}

const kept = new WeakMap<PlaceFacts, RemoteActions>();

/** What the app holds of a place's moves to and from `origin`, made when it is first asked for and kept as long as the place's facts are. */
export function remoteActionsOf(facts: PlaceFacts, transport: RemoteTransport, refresh: () => void): RemoteActions {
    let actions = kept.get(facts);

    if (!actions) {
        actions = new RemoteActions(facts, transport, refresh);
        kept.set(facts, actions);
    }

    return actions;
}

import { errorMessage } from '@clowdy/lib';
import { makeAutoObservable, observable, runInAction } from 'mobx';

import { type Transport, TransportError } from '../../daemon/transport';
import { type RemoteActionId, remoteCall, remoteNotice } from './changesActions';
import { type PlaceFacts, placeRef } from './gitFacts';

import type { GitPushRequest, GitRemoteResult } from '@clowdy/protocol';

/** What the actions ask of the transport. */
export type RemoteTransport = Pick<Transport, 'fetchGit' | 'pullGit' | 'pushGit' | 'updateGit' | 'abortGit'>;

/** How long a conflict notice stays under the button. A failure stays until the person acts again. */
export const NOTICE_MS = 6000;

/** What git or the daemon said when an action could not be done: git's own line as the daemon gave it, and a hint beside it when it has one. */
export interface RemoteFailure {
    action: RemoteActionId;
    message: string;
    hint?: string;
}

/** How an action ended, for a caller that tells it in its own words. */
export type RemoteOutcome = { ok: true; result: GitRemoteResult } | { ok: false; failure: RemoteFailure };

interface RemoteRequestOptions {
    report?: boolean;
    expectedHead?: GitPushRequest['expectedHead'];
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
    readonly #requests = observable.array<{ id: RemoteActionId; outcome: Promise<RemoteOutcome> }>([], {
        deep: false,
    });

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

    isPending(id: RemoteActionId): boolean {
        return this.#requests.some(request => remoteCall(request.id) === remoteCall(id));
    }

    /** A write is pending or the checkout is switching branches. */
    get busy(): boolean {
        return this.running !== undefined || this.facts.switching;
    }

    /**
     * Sends the action to the daemon's write queue. A merge picker can reuse a fetch already in that queue.
     * `report: false` leaves the notice and failure to the caller.
     */
    run(id: RemoteActionId, options: RemoteRequestOptions = {}): Promise<RemoteOutcome> {
        if (this.facts.switching)
            return Promise.resolve({ ok: false, failure: { action: id, message: 'The branch is being changed' } });

        if (id === 'fetch') {
            const fetch = this.#requests.find(request => request.id === 'fetch');
            if (fetch) return fetch.outcome;
        }

        this.#forget();
        const outcome = this.#perform(id, options).finally(() => {
            runInAction(() => this.#requests.remove(request));
            this.refresh();
        });
        const request = { id, outcome };
        this.#requests.push(request);
        return outcome;
    }

    async #perform(id: RemoteActionId, { report = true, expectedHead }: RemoteRequestOptions): Promise<RemoteOutcome> {
        const { key } = this.facts;
        const place = placeRef(key);
        const call = remoteCall(id);

        try {
            const result = await (call === 'fetch'
                ? this.transport.fetchGit(key.projectId, place)
                : call === 'pull'
                  ? this.transport.pullGit(key.projectId, place)
                  : call === 'update'
                    ? this.transport.updateGit(key.projectId, place)
                    : call === 'abort'
                      ? this.transport.abortGit(key.projectId, place)
                      : expectedHead === undefined
                        ? this.transport.pushGit(key.projectId, place)
                        : this.transport.pushGit(key.projectId, place, expectedHead));

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

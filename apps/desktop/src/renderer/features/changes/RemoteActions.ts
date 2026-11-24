import { errorMessage } from '@clowdy/lib';
import { makeAutoObservable, runInAction } from 'mobx';

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

/**
 * What the sidebar and the commit box hold of one place's moves to and from `origin`: which action is running (one at a time for the place, as the daemon runs them), a temporary conflict
 * notice and why the last action failed. It is kept for the place as the facts are (`remoteActionsOf`),
 * so the sidebar's menu and its Create PR are one: a push started in one shows as running in the other. The place's facts are read again when an action ends, either way: a push
 * that was rejected may still have moved something, and a fetch moves the counts the buttons are drawn from. The daemon forgets what it kept of the branch's pull request after an action,
 * so that read is the new one.
 */
export class RemoteActions {
    /** The action that is running. */
    running: RemoteActionId | undefined;
    /** The conflict notice, until it goes. */
    notice: { words: string; tone?: 'warning' } | undefined;
    /** Why the last action failed, until the person acts again. */
    failure: RemoteFailure | undefined;
    #timer: ReturnType<typeof setTimeout> | undefined;

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

    /** An action is running, or the place's branch is being changed: the daemon would run the action after the switch, on the new branch. */
    get busy(): boolean {
        return this.running !== undefined || this.facts.switching;
    }

    /**
     * Runs an action and says how it ended; it never rejects. One at a time: while one runs another is refused at once, with nothing sent. `report: false` leaves the notice and the failure
     * to the caller (Commit & Push words a failed push as part of the commit's own line).
     */
    async run(
        id: RemoteActionId,
        { report = true, expectedHead }: { report?: boolean; expectedHead?: GitPushRequest['expectedHead'] } = {}
    ): Promise<RemoteOutcome> {
        if (this.running !== undefined) return { ok: false, failure: { action: id, message: 'An action is running' } };

        if (this.facts.switching) return { ok: false, failure: { action: id, message: 'The branch is being changed' } };

        const { key } = this.facts;
        const place = placeRef(key);
        const call = remoteCall(id);

        this.running = id;
        this.#forget();

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
        } finally {
            runInAction(() => {
                this.running = undefined;
            });
            this.refresh();
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

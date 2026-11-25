import { errorMessage } from '@clowdy/lib';
import { makeAutoObservable, runInAction } from 'mobx';

import { type Transport, TransportError } from '../../daemon/transport';
import { type PlaceFacts, placeRef } from './gitFacts';

import type { GitSwitchRequest, GitSwitchResult } from '@clowdy/protocol';
import type { BranchListing } from './branchChoices';

/** What the switch asks of the transport. */
export type BranchTransport = Pick<Transport, 'getGitBranches' | 'switchGitBranch'> &
    Partial<Pick<Transport, 'createGitBranch'>>;

/** Why a switch was not made: the daemon's short reason as it gave it (`Commit or discard the changes first`, `Checked out in ~/work/app`), and the line it adds under it (`3 files changed`). */
export interface SwitchFailure {
    message: string;
    hint?: string;
}

/** How a switch ended, for a caller that closes its popover on a switch that was made. */
export type SwitchOutcome = { ok: true; result: GitSwitchResult } | { ok: false; failure: SwitchFailure };

/**
 * What the Changes sidebar's branch button holds of one place: the branches the popover lists (read each time it opens, since a branch changes in a terminal or by an agent), the switch that
 * is running (one at a time for the place, as the daemon runs its writes), and why the last one was refused, which stays until the person acts again. It is kept for the place as the facts are
 * (`branchSwitchOf`). **When a switch ends, win or lose, the place's facts and the folder's branch are read again** (`refresh`): the status, the changes and the Info rows come from the facts,
 * and the chats' folder chips from the folder's git; a refusal changed nothing, but a switch that timed out may have. After a failure the list is read again too, quietly, so a branch that has gone
 * is not offered a second time.
 */
export class BranchSwitch {
    /** The branches of the place, as of the last read; nothing until the first read, and after a switch (the marks of the old list would be wrong). */
    listing: BranchListing | undefined;
    /** The listing is on its way. */
    loading = false;
    /** Why the listing could not be read, when it could not. */
    listFailure: string | undefined;
    /** The branch a switch is making right now: the name that was asked for. */
    running: string | undefined;
    /** Why the last switch was refused or failed. */
    failure: SwitchFailure | undefined;
    /** What the daemon says of a switch that was made (a `post-checkout` hook that failed, the commits a detached HEAD left on no branch): the branch changed, and this is the one thing the person is told. */
    warning: { branch: string; line: string } | undefined;
    #latest = 0;

    constructor(
        readonly facts: PlaceFacts,
        private readonly transport: BranchTransport,
        /** Asks for a new round of reads of the place's facts and of the folder's branch. */
        private readonly refresh: () => void
    ) {
        makeAutoObservable<BranchSwitch, 'transport' | 'refresh'>(this, {
            facts: false,
            transport: false,
            refresh: false,
        });
    }

    /** A branch write is running, including a deletion without switch progress. */
    get busy(): boolean {
        return this.facts.switching;
    }

    /** Reads the branches of the place. An answer that comes after a newer read was started is dropped; a failed read keeps what was known and says why. */
    async load(): Promise<void> {
        const request = ++this.#latest;
        const { key } = this.facts;

        runInAction(() => {
            this.loading = true;
        });

        try {
            const answer = await this.transport.getGitBranches(key.projectId, placeRef(key));

            runInAction(() => {
                if (request !== this.#latest) return;

                this.listing = answer.isRepository ? answer : undefined;
                this.listFailure = undefined;
            });
        } catch (error) {
            runInAction(() => {
                if (request === this.#latest) this.listFailure = errorMessage(error);
            });
        } finally {
            runInAction(() => {
                if (request === this.#latest) this.loading = false;
            });
        }
    }

    /**
     * Switches the folder's checkout to a branch, or makes one (`create`) and switches to it, and says how it ended; it never rejects. One at a time: while one runs another is refused at once,
     * with nothing sent. The daemon judges everything (the tree, the runs, the name, the other worktrees); this only asks, and keeps the reason it gives.
     */
    async switchTo(branch: string, create?: GitSwitchRequest['create'], createOnly = false): Promise<SwitchOutcome> {
        if (this.busy) return { ok: false, failure: { message: 'A switch is running' } };

        const { key } = this.facts;

        this.#begin(branch);

        try {
            if (createOnly && (!create || !this.transport.createGitBranch))
                throw new Error('Branch creation is unavailable');
            const result =
                createOnly && create && this.transport.createGitBranch
                    ? await this.transport.createGitBranch(key.projectId, placeRef(key), branch, create)
                    : await this.transport.switchGitBranch(key.projectId, placeRef(key), branch, create);

            runInAction(() => {
                // The old list says the old branch is the current one.
                this.listing = undefined;

                if (result.warning !== undefined) this.warning = { branch, line: result.warning };
            });

            return { ok: true, result };
        } catch (error) {
            const failure: SwitchFailure = {
                message: errorMessage(error),
                ...(error instanceof TransportError && error.hint !== undefined && { hint: error.hint }),
            };

            runInAction(() => {
                this.failure = failure;
            });
            void this.load();

            return { ok: false, failure };
        } finally {
            this.#end();
        }
    }

    /**
     * Runs `run`, the making of a chat that switches the place's checkout itself (`chat.create` with `{ mode: 'main', branch }`, the new chat's pill), as a switch of the place: while it
     * is on its way the place is `running` and its facts are `switching`, so the Changes sidebar's button spins and the moves to and from `origin` are off, and when it ends, however it
     * ends, the list of branches is dropped and the facts and the folder's branch are read again (`refresh`). What `run` answers is handed back as it is, and what the daemon said of a
     * refusal is the caller's to keep. Pass no branch for a deletion, whose progress belongs in its own dialog. Another branch write that is running already (the daemon runs them
     * one at a time) is the one that marks the place: `run` is simply waited for.
     */
    async around<T>(branch: string | undefined, run: () => Promise<T>): Promise<T> {
        if (this.busy) return await run();

        this.#begin(branch);

        try {
            return await run();
        } finally {
            runInAction(() => {
                this.listing = undefined;
            });
            this.#end();
        }
    }

    /** A branch write starts: the place is busy and what the last one said is out of date. */
    #begin(branch: string | undefined): void {
        runInAction(() => {
            this.running = branch;
            this.facts.switching = true;
            this.failure = undefined;
            this.warning = undefined;
        });
    }

    /** The switch has ended, one way or the other: the place is free, and what changed is read again. */
    #end(): void {
        runInAction(() => {
            this.running = undefined;
            this.facts.switching = false;
        });
        this.refresh();
    }

    /** Clears what the last switch said, for a popover that opens again. */
    dismiss(): void {
        this.failure = undefined;
        this.warning = undefined;
    }
}

const kept = new WeakMap<PlaceFacts, BranchSwitch>();

/** What the app holds of a place's branch switch, made when it is first asked for and kept as long as the place's facts are. */
export function branchSwitchOf(facts: PlaceFacts, transport: BranchTransport, refresh: () => void): BranchSwitch {
    let model = kept.get(facts);

    if (!model) {
        model = new BranchSwitch(facts, transport, refresh);
        kept.set(facts, model);
    }

    return model;
}

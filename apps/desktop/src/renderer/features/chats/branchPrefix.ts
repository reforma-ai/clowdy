import { branchPrefixOf, branchPrefixProblem, DEFAULT_BRANCH_PREFIX } from '@clowdy/protocol';
import { makeAutoObservable } from 'mobx';

import { browserStorage, type KeyValueStorage, readStored, writeStored } from '../../stores/storage';

import type { ChatWorkspaceChoice } from '@clowdy/protocol';

const STORAGE_KEY = 'clowdy:branch-prefix';
const PENDING_KEY = 'clowdy:branch-prefix-pending';

/** What the daemon did with the prefix sent to it: kept it, refused it, or could not be reached. */
export type PrefixDelivery = 'ok' | 'refused' | 'unreachable';

/** The prefix chosen on this computer, synchronized with the daemon for thread worktrees. */
export class BranchPrefixPreference {
    value: string;
    readonly #storage: KeyValueStorage | undefined;
    #send: ((prefix: string) => Promise<PrefixDelivery>) | undefined;
    #sending = false;
    #pending = false;
    #revision = 0;

    constructor(storage: KeyValueStorage | undefined) {
        const stored = readStored(storage, STORAGE_KEY);

        this.#storage = storage;
        this.#pending = readStored(storage, PENDING_KEY) === true;
        this.value =
            typeof stored === 'string' && branchPrefixProblem(stored) === undefined
                ? branchPrefixOf(stored)
                : DEFAULT_BRANCH_PREFIX;
        makeAutoObservable(this);
    }

    /** Keeps `text` (empty: the default) and says nothing, or says why the daemon would refuse it and keeps what it had. */
    setValue(text: string): string | undefined {
        const problem = branchPrefixProblem(text);

        if (problem) return problem;

        this.#revision++;
        this.value = branchPrefixOf(text);
        writeStored(this.#storage, STORAGE_KEY, this.value);
        this.#setPending(true);
        void this.flush();

        return undefined;
    }

    /** Counts the edits made here: a snapshot asked for before an edit must not replace it. */
    get revision(): number {
        return this.#revision;
    }

    /**
     * Takes the daemon's durable prefix from its snapshot, or sends this computer's when the daemon has none (a daemon older than the setting
     * kept it in no other place), an edit is still waiting to be delivered, or one was made since the snapshot was asked for (`revision`).
     * A daemon without a prefix uses the default, so a default here is not sent.
     */
    async connect(
        prefix: string | undefined,
        send: (prefix: string) => Promise<PrefixDelivery>,
        revision = this.#revision
    ): Promise<void> {
        this.#send = send;

        const unknown = prefix === undefined && this.value !== DEFAULT_BRANCH_PREFIX;

        if (unknown || this.#pending || revision !== this.#revision) {
            this.#setPending(true);
            await this.flush();
        } else if (prefix !== undefined && !branchPrefixProblem(prefix)) {
            this.value = branchPrefixOf(prefix);
            writeStored(this.#storage, STORAGE_KEY, this.value);
        }
    }

    /**
     * Delivers a waiting edit. A daemon that cannot be reached is asked again when the feed connects (`RootStore` flushes then); a daemon that
     * refuses the command (one older than it) is not asked again, and the prefix still goes with every new worktree the app asks for.
     */
    async flush(): Promise<void> {
        if (this.#sending || !this.#send) return;

        this.#sending = true;

        try {
            while (this.#pending) {
                const value = this.value;

                if ((await this.#send(value)) === 'unreachable') return;

                // Kept or refused, this edit is done with; one made meanwhile goes next.
                if (this.value === value) this.#setPending(false);
            }
        } finally {
            this.#sending = false;
        }
    }

    #setPending(pending: boolean): void {
        this.#pending = pending;
        writeStored(this.#storage, PENDING_KEY, pending);
    }

    /**
     * The choice as `chat.create` carries it: a copy, with the prefix when the choice is a new worktree and the prefix is not the default (a daemon that is older
     * than the setting knows no such field, and the default is what it does without one).
     */
    withPrefix(choice: ChatWorkspaceChoice): ChatWorkspaceChoice {
        return choice.mode === 'new' && this.value !== DEFAULT_BRANCH_PREFIX
            ? { ...choice, branchPrefix: this.value }
            : { ...choice };
    }
}

export const branchPrefix = new BranchPrefixPreference(browserStorage());

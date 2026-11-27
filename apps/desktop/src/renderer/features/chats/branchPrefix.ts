import { branchPrefixOf, branchPrefixProblem, DEFAULT_BRANCH_PREFIX } from '@clowdy/protocol';
import { makeAutoObservable } from 'mobx';

import { browserStorage, type KeyValueStorage, readStored, writeStored } from '../../stores/storage';

import type { ChatWorkspaceChoice } from '@clowdy/protocol';

const STORAGE_KEY = 'clowdy:branch-prefix';
const PENDING_KEY = 'clowdy:branch-prefix-pending';

/** The prefix chosen on this computer, synchronized with the daemon for thread worktrees. */
export class BranchPrefixPreference {
    value: string;
    readonly #storage: KeyValueStorage | undefined;
    #send: ((prefix: string) => Promise<boolean>) | undefined;
    #sending = false;
    #pending = false;
    #revision = 0;
    #retry: ReturnType<typeof setTimeout> | undefined;

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
        this.#pending = true;
        writeStored(this.#storage, PENDING_KEY, true);
        void this.flush();

        return undefined;
    }

    /** Reconcile the saved renderer value on upgrade, or use the daemon's durable value. */
    get revision(): number {
        return this.#revision;
    }

    async connect(
        prefix: string | undefined,
        send: (prefix: string) => Promise<boolean>,
        revision = this.#revision
    ): Promise<void> {
        this.#send = send;
        if (prefix === undefined || this.#pending || revision !== this.#revision) {
            this.#pending = true;
            writeStored(this.#storage, PENDING_KEY, true);
            await this.flush();
        } else if (!branchPrefixProblem(prefix)) {
            this.value = branchPrefixOf(prefix);
            writeStored(this.#storage, STORAGE_KEY, this.value);
        }
    }

    async flush(): Promise<void> {
        if (this.#sending || !this.#send) return;
        this.#sending = true;
        clearTimeout(this.#retry);
        try {
            while (this.#pending) {
                const value = this.value;
                if (!(await this.#send(value))) {
                    this.#retry = setTimeout(() => void this.flush(), 2000);
                    return;
                }
                if (this.value === value) {
                    this.#pending = false;
                    writeStored(this.#storage, PENDING_KEY, false);
                }
            }
        } finally {
            this.#sending = false;
        }
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

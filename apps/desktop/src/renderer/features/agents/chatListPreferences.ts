import { makeAutoObservable } from 'mobx';

import { browserStorage, type KeyValueStorage, readStored, writeStored } from '../../stores/storage';

const FINISHED_KEY = 'clowdy:show-finished-threads';
const EXPAND_RUNNING_KEY = 'clowdy:expand-running-agents';

/**
 * Finished threads show in every project until the person hides them in Filters or Chat settings, and so do the agents that work: a folded chat lists the
 * threads and sub-agents below it that work, until the person turns that off in Filters.
 */
export class ChatListPreferences {
    showFinishedThreads: boolean;
    expandRunningAgents: boolean;
    readonly #storage: KeyValueStorage | undefined;

    constructor(storage: KeyValueStorage | undefined) {
        this.#storage = storage;
        this.showFinishedThreads = readStored(storage, FINISHED_KEY) !== false;
        this.expandRunningAgents = readStored(storage, EXPAND_RUNNING_KEY) !== false;
        makeAutoObservable(this);
    }

    setShowFinishedThreads(show: boolean): void {
        this.showFinishedThreads = show;
        writeStored(this.#storage, FINISHED_KEY, show);
    }

    setExpandRunningAgents(expand: boolean): void {
        this.expandRunningAgents = expand;
        writeStored(this.#storage, EXPAND_RUNNING_KEY, expand);
    }
}

export const chatListPreferences = new ChatListPreferences(browserStorage());

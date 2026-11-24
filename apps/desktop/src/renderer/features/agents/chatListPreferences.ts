import { makeAutoObservable } from 'mobx';

import { browserStorage, type KeyValueStorage, readStored, writeStored } from '../../stores/storage';

const FINISHED_KEY = 'clowdy:show-finished-threads';

/**
 * Finished threads show in every project until the person hides them in Filters or Chat settings.
 */
export class ChatListPreferences {
    showFinishedThreads: boolean;
    readonly #storage: KeyValueStorage | undefined;

    constructor(storage: KeyValueStorage | undefined) {
        this.#storage = storage;
        this.showFinishedThreads = readStored(storage, FINISHED_KEY) !== false;
        makeAutoObservable(this);
    }

    setShowFinishedThreads(show: boolean): void {
        this.showFinishedThreads = show;
        writeStored(this.#storage, FINISHED_KEY, show);
    }
}

export const chatListPreferences = new ChatListPreferences(browserStorage());

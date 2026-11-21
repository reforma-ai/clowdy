import { makeAutoObservable } from 'mobx';

import { browserStorage, readStored, writeStored, type KeyValueStorage } from '../../stores/storage';

const SORT_KEY = 'clowdy:chat-sort';
const FINISHED_KEY = 'clowdy:show-finished-threads';

/** The order of the chats in the Agents list, newest first: by the last thing that happened in the chat, or by when it was made. */
export type ChatSort = 'activity' | 'created';

/**
 * How the Agents list looks, a preference of this computer for every project (the heading's `⋯` menu and Settings > Chat edit the same values).
 * The order of the chats is the one they were made in, newest first, which keeps the list still while the agents work, until the person picks last
 * activity, where a chat that just got a message goes up to the top. Finished threads are listed until the person hides them: off, a thread whose run is over is hidden unless something below it still
 * works or it is the open chat.
 */
export class ChatListPreferences {
    sort: ChatSort;
    showFinishedThreads: boolean;
    readonly #storage: KeyValueStorage | undefined;

    constructor(storage: KeyValueStorage | undefined) {
        this.#storage = storage;
        this.sort = readStored(storage, SORT_KEY) === 'activity' ? 'activity' : 'created';
        this.showFinishedThreads = readStored(storage, FINISHED_KEY) !== false;
        makeAutoObservable(this);
    }

    setSort(sort: ChatSort): void {
        this.sort = sort;
        writeStored(this.#storage, SORT_KEY, sort);
    }

    setShowFinishedThreads(show: boolean): void {
        this.showFinishedThreads = show;
        writeStored(this.#storage, FINISHED_KEY, show);
    }
}

export const chatListPreferences = new ChatListPreferences(browserStorage());

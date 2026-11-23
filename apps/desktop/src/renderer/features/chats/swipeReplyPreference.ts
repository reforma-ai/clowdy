import { makeAutoObservable } from 'mobx';

import { browserStorage, type KeyValueStorage, readStored, writeStored } from '../../stores/storage';

const STORAGE_KEY = 'clowdy:swipe-to-reply';

/**
 * Whether a long swipe to the left over a message replies to it, a preference of this computer (Settings > Chat). On unless the person turned it off: a stored
 * value that is anything but `false` is the default.
 */
export class SwipeReplyPreference {
    enabled: boolean;
    readonly #storage: KeyValueStorage | undefined;

    constructor(storage: KeyValueStorage | undefined) {
        this.#storage = storage;
        this.enabled = readStored(storage, STORAGE_KEY) !== false;
        makeAutoObservable(this);
    }

    setEnabled(enabled: boolean): void {
        this.enabled = enabled;
        writeStored(this.#storage, STORAGE_KEY, enabled);
    }
}

export const swipeToReply = new SwipeReplyPreference(browserStorage());

import { makeAutoObservable } from 'mobx';

import { browserStorage, type KeyValueStorage, readStored, writeStored } from '../../stores/storage';

import type { QueuedMessageMode } from '@clowdy/protocol';

const STORAGE_KEY = 'clowdy:enter-while-busy';

/**
 * What Enter does with a message while the agent works, a preference of this computer (Settings > Chat): steer the turn in flight, or wait for the next
 * turn. Cmd/Ctrl+Enter does the other. The composer sends the mode with every message, so the daemon keeps no default of its own.
 */
export class BusyEnterPreference {
    mode: QueuedMessageMode;
    readonly #storage: KeyValueStorage | undefined;

    constructor(storage: KeyValueStorage | undefined) {
        this.#storage = storage;
        this.mode = readStored(storage, STORAGE_KEY) === 'queue' ? 'queue' : 'steer';
        makeAutoObservable(this);
    }

    setMode(mode: QueuedMessageMode): void {
        this.mode = mode;
        writeStored(this.#storage, STORAGE_KEY, mode);
    }
}

export const busyEnter = new BusyEnterPreference(browserStorage());

/** The mode of a message: Enter sends it the way the preference says, Cmd/Ctrl+Enter (`mod`) the other way. */
export function sendMode(preference: QueuedMessageMode, mod: boolean): QueuedMessageMode {
    if (!mod) return preference;

    return preference === 'steer' ? 'queue' : 'steer';
}

import { makeAutoObservable } from 'mobx';

import { browserStorage, type KeyValueStorage, readStored, writeStored } from '../../stores/storage';

const COLLAPSE_DIFFS_KEY = 'clowdy:collapse-diffs-by-default';
const AUTO_PUSH_KEY = 'clowdy:push-after-commit-and-merge';

/** Source Control preferences for this device, shared by all projects. */
export class SourceControlPreferences {
    collapseDiffs: boolean;
    autoPush: boolean;
    readonly #storage: KeyValueStorage | undefined;

    constructor(storage?: KeyValueStorage) {
        this.#storage = storage;
        this.collapseDiffs = readStored(storage, COLLAPSE_DIFFS_KEY) !== false;
        this.autoPush = readStored(storage, AUTO_PUSH_KEY) !== false;
        makeAutoObservable(this);
    }

    setCollapseDiffs(collapse: boolean): void {
        this.collapseDiffs = collapse;
        writeStored(this.#storage, COLLAPSE_DIFFS_KEY, collapse);
    }

    setAutoPush(enabled: boolean): void {
        this.autoPush = enabled;
        writeStored(this.#storage, AUTO_PUSH_KEY, enabled);
    }
}

export const sourceControlPreferences = new SourceControlPreferences(browserStorage());

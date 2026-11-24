import { makeAutoObservable } from 'mobx';

import { browserStorage, type KeyValueStorage, readStored, writeStored } from '../../stores/storage';

const COLLAPSE_DIFFS_KEY = 'clowdy:collapse-diffs-by-default';

/** Source Control preferences for this device, shared by all projects. */
export class SourceControlPreferences {
    collapseDiffs: boolean;
    readonly #storage: KeyValueStorage | undefined;

    constructor(storage?: KeyValueStorage) {
        this.#storage = storage;
        this.collapseDiffs = readStored(storage, COLLAPSE_DIFFS_KEY) !== false;
        makeAutoObservable(this);
    }

    setCollapseDiffs(collapse: boolean): void {
        this.collapseDiffs = collapse;
        writeStored(this.#storage, COLLAPSE_DIFFS_KEY, collapse);
    }
}

export const sourceControlPreferences = new SourceControlPreferences(browserStorage());

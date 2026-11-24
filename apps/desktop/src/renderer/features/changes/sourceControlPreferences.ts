import { makeAutoObservable } from 'mobx';

import { browserStorage, type KeyValueStorage, readStored, writeStored } from '../../stores/storage';

const COLLAPSE_DIFFS_KEY = 'clowdy:collapse-diffs-by-default';
// Keep the saved preference from the earlier Push after commit and merge setting.
const AUTO_SYNC_KEY = 'clowdy:push-after-commit-and-merge';

/** Source Control preferences for this device, shared by all projects. */
export class SourceControlPreferences {
    collapseDiffs: boolean;
    autoSync: boolean;
    readonly #storage: KeyValueStorage | undefined;

    constructor(storage?: KeyValueStorage) {
        this.#storage = storage;
        this.collapseDiffs = readStored(storage, COLLAPSE_DIFFS_KEY) !== false;
        this.autoSync = readStored(storage, AUTO_SYNC_KEY) !== false;
        makeAutoObservable(this);
    }

    setCollapseDiffs(collapse: boolean): void {
        this.collapseDiffs = collapse;
        writeStored(this.#storage, COLLAPSE_DIFFS_KEY, collapse);
    }

    setAutoSync(enabled: boolean): void {
        this.autoSync = enabled;
        writeStored(this.#storage, AUTO_SYNC_KEY, enabled);
    }
}

export const sourceControlPreferences = new SourceControlPreferences(browserStorage());

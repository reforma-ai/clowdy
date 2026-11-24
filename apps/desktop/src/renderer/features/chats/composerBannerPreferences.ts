import { makeAutoObservable } from 'mobx';

import { browserStorage, type KeyValueStorage, readStored, writeStored } from '../../stores/storage';

const TASKS_KEY = 'clowdy:show-composer-tasks';
const CHANGES_KEY = 'clowdy:show-composer-changes';

/** Visibility of the optional chat banners on this device. */
export class ComposerBannerPreferences {
    showTasks: boolean;
    showChanges: boolean;
    readonly #storage: KeyValueStorage | undefined;

    constructor(storage?: KeyValueStorage) {
        this.#storage = storage;
        this.showTasks = readStored(storage, TASKS_KEY) !== false;
        this.showChanges = readStored(storage, CHANGES_KEY) !== false;
        makeAutoObservable(this);
    }

    setShowTasks(show: boolean): void {
        this.showTasks = show;
        writeStored(this.#storage, TASKS_KEY, show);
    }

    setShowChanges(show: boolean): void {
        this.showChanges = show;
        writeStored(this.#storage, CHANGES_KEY, show);
    }
}

export const composerBannerPreferences = new ComposerBannerPreferences(browserStorage());

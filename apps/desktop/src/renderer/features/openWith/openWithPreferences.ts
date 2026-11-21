import { makeAutoObservable } from 'mobx';

import { browserStorage, readStored, writeStored, type KeyValueStorage } from '../../stores/storage';

const EDITOR_KEY = 'clowdy:default-editor';
const FILE_MANAGER_KEY = 'clowdy:default-file-manager';

const text = (value: unknown) => (typeof value === 'string' && value !== '' ? value : undefined);

/**
 * Which program opens a folder, a preference of this computer for every project (Settings > Files). Until the person picks one, the first
 * editor the computer has (the catalog puts the most used first) and its system's file manager do it, so nothing is saved for them. A saved
 * program that is no longer installed is not an error: the choice falls back the same way (`chosenApp`) and the saved one comes back
 * if the program does.
 */
export class OpenWithPreferences {
    editor: string | undefined;
    fileManager: string | undefined;
    readonly #storage: KeyValueStorage | undefined;

    constructor(storage: KeyValueStorage | undefined) {
        this.#storage = storage;
        this.editor = text(readStored(storage, EDITOR_KEY));
        this.fileManager = text(readStored(storage, FILE_MANAGER_KEY));
        makeAutoObservable(this);
    }

    setEditor(id: string): void {
        this.editor = id;
        writeStored(this.#storage, EDITOR_KEY, id);
    }

    setFileManager(id: string): void {
        this.fileManager = id;
        writeStored(this.#storage, FILE_MANAGER_KEY, id);
    }
}

export const openWithPreferences = new OpenWithPreferences(browserStorage());

import { toast } from '@clowdy/components/Toast';
import { FileManager, type TabsSnapshot } from '@clowdy/file-manager';
import { errorMessage } from '@clowdy/lib';
import { makeAutoObservable, reaction } from 'mobx';

import { readStored, writeStored, type KeyValueStorage } from '../../stores/storage';

import type { FolderId, ProjectId } from '@clowdy/protocol';
import type { Transport } from '../../daemon/transport';

/** What the tree never shows, and what it shows only when asked to ("Show hidden files"). Git's own folder and the system's litter are noise; the rest is real but is rarely what a person came for. */
const EXCLUDE = ['**/.git', '**/.DS_Store'];
const HIDDEN = ['**/node_modules', '.clowdy'];

const tabsKey = (projectId: ProjectId, folderId: FolderId) => `clowdy:files:${ projectId }:${ folderId }`;

function storedTabs(storage: KeyValueStorage | undefined, key: string): TabsSnapshot | undefined {
    const stored = readStored(storage, key) as Partial<TabsSnapshot> | undefined;

    if (!stored || !Array.isArray(stored.paths)) return undefined;

    return { paths: stored.paths.filter(path => typeof path === 'string'), active: typeof stored.active === 'string' ? stored.active : null };
}

/**
 * The files of the project's folders as the window shows them: a file manager for each folder, made when the folder is first asked for and kept for as long
 * as the app runs, so the tabs open in a folder and what is typed in them are still there when another chat or another folder has been on show. The
 * tabs open in a folder are kept between runs.
 */
export class FilesStore {
    readonly #managers = new Map<string, FileManager>();
    readonly #disposers: Array<() => void> = [];
    #disposed = false;

    constructor(readonly transport: Pick<Transport, 'fileSystem'>, readonly storage?: KeyValueStorage) {
        makeAutoObservable<FilesStore, 'transport' | 'storage'>(this, { transport: false, storage: false });
    }

    /** The file manager of a folder of a project. */
    managerOf(projectId: ProjectId, folderId: FolderId): FileManager {
        const key = tabsKey(projectId, folderId);
        let manager = this.#managers.get(key);

        if (!manager) {
            manager = this.#open(key, projectId, folderId);
            this.#managers.set(key, manager);
        }

        return manager;
    }

    /** Stops every watch the folders hold. */
    dispose(): void {
        this.#disposed = true;

        for (const stop of this.#disposers.splice(0)) stop();

        for (const manager of this.#managers.values()) manager.dispose();

        this.#managers.clear();
    }

    #open(key: string, projectId: ProjectId, folderId: FolderId): FileManager {
        const manager = new FileManager({
            provider: this.transport.fileSystem(projectId, folderId),
            exclude: EXCLUDE,
            hidden: HIDDEN,
            notify: (message, error) => void toast.error({ title: message, message: error === undefined ? undefined : errorMessage(error) }),
        });
        const saved = storedTabs(this.storage, key);

        // The tabs are kept as they change, from the moment they are reopened: a reopened tab that no longer has a file is dropped from what is kept.
        void manager.start().then(() => (saved ? manager.restore(saved) : undefined)).then(() => {
            // A store that was disposed while the folder was still being listed has nobody left to keep the tabs for.
            if (this.#disposed) return;

            this.#disposers.push(reaction(() => manager.snapshot(), snapshot => writeStored(this.storage, key, snapshot)));
        });

        return manager;
    }
}

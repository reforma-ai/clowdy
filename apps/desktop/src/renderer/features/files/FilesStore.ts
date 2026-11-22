import { toast } from '@clowdy/components/Toast';
import { FileManager, type TabsSnapshot } from '@clowdy/file-manager';
import { errorMessage } from '@clowdy/lib';
import { makeAutoObservable, reaction } from 'mobx';

import { readStored, writeStored, type KeyValueStorage } from '../../stores/storage';
import { HIDDEN_GLOBS } from './hidden';
import { clipboardOf } from './systemClipboard';

import type { FolderId, ProjectId } from '@clowdy/protocol';
import type { Transport } from '../../daemon/transport';

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
    /** Settles when a folder's manager has listed the folder and brought its tabs back. */
    readonly #started = new Map<string, Promise<void>>();
    readonly #disposers: Array<() => void> = [];
    #disposed = false;

    /**
     * `folderPath` says where a folder is on the disk, for the desktop app's clipboard to copy files to and from it; without it (or in a page that is not the desktop
     * app) the tree has no Copy and no Paste.
     */
    constructor(readonly transport: Pick<Transport, 'fileSystem'>, readonly storage?: KeyValueStorage, readonly folderPath?: (projectId: ProjectId, folderId: FolderId) => string | undefined) {
        makeAutoObservable<FilesStore, 'transport' | 'storage' | 'folderPath'>(this, { transport: false, storage: false, folderPath: false });
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

    /**
     * The file manager of a folder once it has listed the folder and reopened the tabs it had: a file opened before that is a tab the reopening then
     * takes the focus from. For whoever opens a file as soon as a manager is made.
     */
    async startedManagerOf(projectId: ProjectId, folderId: FolderId): Promise<FileManager> {
        const manager = this.managerOf(projectId, folderId);

        await this.#started.get(tabsKey(projectId, folderId));

        return manager;
    }

    /** Stops every watch the folders hold. */
    dispose(): void {
        this.#disposed = true;

        for (const stop of this.#disposers.splice(0)) stop();

        for (const manager of this.#managers.values()) manager.dispose();

        this.#managers.clear();
        this.#started.clear();
    }

    #open(key: string, projectId: ProjectId, folderId: FolderId): FileManager {
        const files = this.transport.fileSystem(projectId, folderId);
        const manager = new FileManager({
            provider: files,
            search: files.search?.bind(files),
            hidden: HIDDEN_GLOBS,
            clipboard: clipboardOf(this.folderPath?.(projectId, folderId)),
            notify: (message, error) => void toast.error({ title: message, message: error === undefined ? undefined : errorMessage(error) }),
        });
        const saved = storedTabs(this.storage, key);

        // The tabs are kept as they change, from the moment they are reopened: a reopened tab that no longer has a file is dropped from what is kept.
        const started = manager.start().then(() => (saved ? manager.restore(saved) : undefined)).then(() => {
            // A store that was disposed while the folder was still being listed has nobody left to keep the tabs for.
            if (this.#disposed) return;

            this.#disposers.push(reaction(() => manager.snapshot(), snapshot => writeStored(this.storage, key, snapshot)));
        });

        this.#started.set(key, started.catch(() => undefined));
        void started;

        return manager;
    }
}

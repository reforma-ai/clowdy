import { toast } from '@clowdy/components/Toast';
import { FileManager, type TabsSnapshot } from '@clowdy/file-manager';
import { errorMessage } from '@clowdy/lib';
import { makeAutoObservable, reaction } from 'mobx';

import { readStored, writeStored, type KeyValueStorage } from '../../stores/storage';
import { placeKey, placePath, placeRef, type Place } from '../sidePanel/currentPlace';
import { HIDDEN_GLOBS } from './hidden';
import { clipboardOf } from './systemClipboard';

import type { ProjectId } from '@clowdy/protocol';
import type { Transport } from '../../daemon/transport';

/** The two sets of tabs a place has: the files the person opened, and the documents. The Docs tab is the Files view with a tree of its own and tabs of its own. */
export type FilesKind = 'files' | 'docs';

/** Where a place's tabs are kept: under the worktree's id for a chat's worktree, the folder's for its own checkout, so the one never shows the other's tabs. */
const tabsKey = (projectId: ProjectId, place: Place, kind: FilesKind) => `clowdy:${ kind }:${ projectId }:${ placeKey(placeRef(place)) }`;

function storedTabs(storage: KeyValueStorage | undefined, key: string): TabsSnapshot | undefined {
    const stored = readStored(storage, key) as Partial<TabsSnapshot> | undefined;

    if (!stored || !Array.isArray(stored.paths)) return undefined;

    return { paths: stored.paths.filter(path => typeof path === 'string'), active: typeof stored.active === 'string' ? stored.active : null };
}

/**
 * The files of the project's places as the window shows them: a file manager for each place (a folder's own checkout, or the worktree of a chat), made when the place is
 * first asked for and kept for as long as the app runs, so the tabs open in a place and what is typed in them are still there when another chat or another place has been
 * on show. A worktree has a manager of its own, shared by the chats that work in it, and its own watch. The tabs open in a place are kept between runs. A place has
 * two managers, the Files tab's and the Docs tab's: the view is the same, but each has its own tabs, so a document opened in the Docs tab is not a tab of the Files tab,
 * and a TypeScript file opened there never shows up among the documents. A worktree that is not made yet has no manager: ask for the place once it is (`isPlaceReady`).
 */
export class FilesStore {
    readonly #managers = new Map<string, FileManager>();
    /** Settles when a folder's manager has listed the folder and brought its tabs back. */
    readonly #started = new Map<string, Promise<void>>();
    readonly #disposers: Array<() => void> = [];
    #disposed = false;

    /** In the desktop app the tree has the system's clipboard, for the files of the place's own path (the worktree's, for a worktree); in a page that is not the desktop app it has no Copy and no Paste. */
    constructor(readonly transport: Pick<Transport, 'fileSystem'>, readonly storage?: KeyValueStorage) {
        makeAutoObservable<FilesStore, 'transport' | 'storage'>(this, { transport: false, storage: false });
    }

    /** The file manager of a place of a project, the Files tab's or the Docs tab's. */
    managerOf(projectId: ProjectId, place: Place, kind: FilesKind = 'files'): FileManager {
        const key = tabsKey(projectId, place, kind);
        let manager = this.#managers.get(key);

        if (!manager) {
            manager = this.#open(key, projectId, place);
            this.#managers.set(key, manager);
        }

        return manager;
    }

    /**
     * The file manager of a place once it has listed the place and reopened the tabs it had: a file opened before that is a tab the reopening then
     * takes the focus from. For whoever opens a file as soon as a manager is made.
     */
    async startedManagerOf(projectId: ProjectId, place: Place, kind: FilesKind = 'files'): Promise<FileManager> {
        const manager = this.managerOf(projectId, place, kind);

        await this.#started.get(tabsKey(projectId, place, kind));

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

    #open(key: string, projectId: ProjectId, place: Place): FileManager {
        const files = this.transport.fileSystem(projectId, place.folder.id, place.workspace?.id);
        const manager = new FileManager({
            provider: files,
            search: files.search?.bind(files),
            hidden: HIDDEN_GLOBS,
            clipboard: clipboardOf(placePath(place)),
            notify: (message, error) => void toast.error({ title: message, message: error === undefined ? undefined : errorMessage(error) }),
        });
        const saved = storedTabs(this.storage, key);

        // The tabs are kept as they change, from the moment they are reopened: a reopened tab that no longer has a file is dropped from what is kept.
        const started = manager.start().then(() => (saved ? manager.restore(saved) : undefined)).then(() => {
            // A store that was disposed while the place was still being listed has nobody left to keep the tabs for.
            if (this.#disposed) return;

            this.#disposers.push(reaction(() => manager.snapshot(), snapshot => writeStored(this.storage, key, snapshot)));
        });

        this.#started.set(key, started.catch(() => undefined));
        void started;

        return manager;
    }
}

import { useRootStore } from '../../stores';
import { browserStorage } from '../../stores/storage';
import { FilesStore } from './FilesStore';

import type { RootStore } from '../../stores';

const stores = new WeakMap<RootStore, FilesStore>();

/** The files store of the app: made on first use, so the file manager's code is not loaded until the Files tab is (or a search that opens a file, which imports this module when it needs it). */
export function filesStoreOf(root: RootStore): FilesStore {
    let store = stores.get(root);

    if (!store) {
        store = new FilesStore(root.transport, browserStorage());
        stores.set(root, store);
    }

    return store;
}

/** The files store of the app. */
export function useFilesStore(): FilesStore {
    return filesStoreOf(useRootStore());
}

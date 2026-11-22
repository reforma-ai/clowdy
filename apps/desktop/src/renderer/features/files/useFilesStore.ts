import { useRootStore } from '../../stores';
import { browserStorage } from '../../stores/storage';
import { FilesStore } from './FilesStore';

import type { Transport } from '../../daemon/transport';

const stores = new WeakMap<Transport, FilesStore>();

/** The files store of a transport: made on first use, so the file manager's code is not loaded until the Files tab is (or a search that opens a file, which imports this module when it needs it). */
export function filesStoreOf(transport: Transport): FilesStore {
    let store = stores.get(transport);

    if (!store) {
        store = new FilesStore(transport, browserStorage());
        stores.set(transport, store);
    }

    return store;
}

/** The files store of the app's transport. */
export function useFilesStore(): FilesStore {
    return filesStoreOf(useRootStore().transport);
}

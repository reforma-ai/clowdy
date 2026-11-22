import { useRootStore } from '../../stores';
import { browserStorage } from '../../stores/storage';
import { FilesStore } from './FilesStore';

import type { Transport } from '../../daemon/transport';

const stores = new WeakMap<Transport, FilesStore>();

/** The files store of the app's transport: made on first use, so the file manager's code is not loaded until the Files tab is. */
export function useFilesStore(): FilesStore {
    const { transport } = useRootStore();
    let store = stores.get(transport);

    if (!store) {
        store = new FilesStore(transport, browserStorage());
        stores.set(transport, store);
    }

    return store;
}

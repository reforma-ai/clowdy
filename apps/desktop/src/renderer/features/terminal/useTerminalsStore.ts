import { useRootStore } from '../../stores';
import { TerminalsStore } from './TerminalsStore';

import type { Transport } from '../../daemon/transport';

const stores = new WeakMap<Transport, TerminalsStore>();

/** The terminals of a transport: made on first use, and kept for as long as the app runs, so a shell shown once is still there, scrollback and all, when the tab comes back. */
export function terminalsStoreOf(transport: Transport): TerminalsStore {
    let store = stores.get(transport);

    if (!store) {
        store = new TerminalsStore(transport);
        stores.set(transport, store);
    }

    return store;
}

/** The terminals of the app's transport. */
export function useTerminalsStore(): TerminalsStore {
    return terminalsStoreOf(useRootStore().transport);
}

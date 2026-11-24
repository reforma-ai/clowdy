import { makeAutoObservable } from 'mobx';

import { browserStorage, type KeyValueStorage, readStored, writeStored } from '../../stores/storage';
import { SIDE_PANEL_TABS } from '../../stores/UiStore';

import type { SidePanelTab } from '../../stores/UiStore';

const KEY = 'clowdy:side-panel-order';

/** Accept old or damaged preferences and append any tabs added by a later version. */
function normalized(value: unknown): SidePanelTab[] {
    const order: SidePanelTab[] = [];
    if (Array.isArray(value)) {
        for (const item of value) {
            const tab = SIDE_PANEL_TABS.find(candidate => candidate === item);
            if (tab && !order.includes(tab)) order.push(tab);
        }
    }
    for (const tab of SIDE_PANEL_TABS) if (!order.includes(tab)) order.push(tab);
    return order;
}

/** One panel order for all projects on this computer. */
export class PanelOrder {
    order: SidePanelTab[];
    readonly #storage: KeyValueStorage | undefined;

    constructor(storage?: KeyValueStorage) {
        this.#storage = storage;
        this.order = normalized(readStored(storage, KEY));
        makeAutoObservable(this);
    }

    setOrder(order: readonly SidePanelTab[]): void {
        this.order = normalized(order);
        writeStored(this.#storage, KEY, this.order);
    }

    reset(): void {
        this.setOrder(SIDE_PANEL_TABS);
    }
}
export const panelOrder = new PanelOrder(browserStorage());

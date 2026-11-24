import { makeAutoObservable } from 'mobx';

import { browserStorage, type KeyValueStorage, readStored, writeStored } from '../../stores/storage';
import { CHANGES_SIDEBAR_DEFAULT_WIDTH, CHANGES_SIDEBAR_MIN_WIDTH } from './layout';

const OPEN_KEY = 'clowdy:changes-sidebar-open';
const WIDTH_KEY = 'clowdy:changes-sidebar-width';

const clampWidth = (width: number) => Math.max(CHANGES_SIDEBAR_MIN_WIDTH, Math.round(width));
const isSize = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** Sidebar visibility and width, shared by all projects and places in the window. */
export class ChangesSidebarLayout {
    open: boolean;
    width: number;

    constructor(private readonly storage?: KeyValueStorage) {
        const open = readStored(storage, OPEN_KEY);
        const width = readStored(storage, WIDTH_KEY);

        this.open = open !== false;
        this.width = isSize(width) ? clampWidth(width) : CHANGES_SIDEBAR_DEFAULT_WIDTH;
        makeAutoObservable<ChangesSidebarLayout, 'storage'>(this, { storage: false });
    }

    toggle(): void {
        this.open = !this.open;
        writeStored(this.storage, OPEN_KEY, this.open);
    }

    setWidth(width: number): void {
        this.width = clampWidth(width);
        writeStored(this.storage, WIDTH_KEY, this.width);
    }
}

/** The sidebar's layout of this window, kept in this computer's storage. */
export const changesSidebarLayout = new ChangesSidebarLayout(browserStorage());

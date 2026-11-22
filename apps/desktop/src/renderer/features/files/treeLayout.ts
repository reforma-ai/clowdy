import { makeAutoObservable } from 'mobx';

import { browserStorage, readStored, writeStored, type KeyValueStorage } from '../../stores/storage';

/** The edge the person drags between the editor and the file tree: how narrow the tree can be, and the width it opens at. */
export const TREE_MIN_WIDTH = 160;
export const TREE_DEFAULT_WIDTH = 240;

const OPEN_KEY = 'clowdy:files-tree-open';
const WIDTH_KEY = 'clowdy:files-tree-width';
const HIDDEN_KEY = 'clowdy:files-show-hidden';

const clampWidth = (width: number) => Math.max(TREE_MIN_WIDTH, Math.round(width));

/**
 * How the file tree is shown, one choice for the whole window whichever project or folder is on show: whether it is beside the editor and how wide, and whether
 * it shows the hidden files (the names that start with a dot, and `node_modules`). The last is also a switch in Settings > Files and a key (`filesCommands`).
 */
export class TreeLayout {
    open: boolean;
    width: number;
    showHidden: boolean;

    constructor(private readonly storage?: KeyValueStorage) {
        const open = readStored(storage, OPEN_KEY);
        const width = readStored(storage, WIDTH_KEY);

        this.open = open !== false;
        this.width = typeof width === 'number' && Number.isFinite(width) ? clampWidth(width) : TREE_DEFAULT_WIDTH;
        this.showHidden = readStored(storage, HIDDEN_KEY) === true;
        makeAutoObservable<TreeLayout, 'storage'>(this, { storage: false });
    }

    toggle(): void {
        this.open = !this.open;
        writeStored(this.storage, OPEN_KEY, this.open);
    }

    setWidth(width: number): void {
        this.width = clampWidth(width);
        writeStored(this.storage, WIDTH_KEY, this.width);
    }

    setShowHidden(show: boolean): void {
        this.showHidden = show;
        writeStored(this.storage, HIDDEN_KEY, show);
    }
}

/** The tree's layout of this window, kept in this computer's storage. */
export const treeLayout = new TreeLayout(browserStorage());

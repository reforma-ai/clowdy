import { makeAutoObservable } from 'mobx';

import { useRootStore } from '../../stores';
import { browserStorage, readStored, writeStored, type KeyValueStorage } from '../../stores/storage';

/** The edge the person drags between the editor and the file tree: how narrow the tree can be, and the width it opens at. */
export const TREE_MIN_WIDTH = 160;
export const TREE_DEFAULT_WIDTH = 240;

const OPEN_KEY = 'clowdy:files-tree-open';
const WIDTH_KEY = 'clowdy:files-tree-width';

const clampWidth = (width: number) => Math.max(TREE_MIN_WIDTH, Math.round(width));

/** Whether the file tree is shown beside the editor, and how wide: one choice for the whole window, whichever project or folder is on show. */
export class TreeLayout {
    open: boolean;
    width: number;

    constructor(private readonly storage?: KeyValueStorage) {
        const open = readStored(storage, OPEN_KEY);
        const width = readStored(storage, WIDTH_KEY);

        this.open = open !== false;
        this.width = typeof width === 'number' && Number.isFinite(width) ? clampWidth(width) : TREE_DEFAULT_WIDTH;
        makeAutoObservable<TreeLayout, 'storage'>(this, { storage: false });
    }

    toggle(): void {
        this.open = !this.open;
        writeStored(this.storage, OPEN_KEY, this.open);
    }

    /** Shows the tree if it is hidden. */
    show(): void {
        if (!this.open) this.toggle();
    }

    setWidth(width: number): void {
        this.width = clampWidth(width);
        writeStored(this.storage, WIDTH_KEY, this.width);
    }
}

const layouts = new WeakMap<object, TreeLayout>();

/** The tree's layout for this window. */
export function useTreeLayout(): TreeLayout {
    const root = useRootStore();
    let layout = layouts.get(root);

    if (!layout) {
        layout = new TreeLayout(browserStorage());
        layouts.set(root, layout);
    }

    return layout;
}

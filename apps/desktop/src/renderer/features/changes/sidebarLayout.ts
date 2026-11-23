import { makeAutoObservable } from 'mobx';

import { browserStorage, type KeyValueStorage, readStored, removeStored, writeStored } from '../../stores/storage';
import {
    CHANGES_COMMITS_DEFAULT_ROWS,
    CHANGES_COMMITS_DEFAULT_SHARE,
    CHANGES_COMMITS_MIN_HEIGHT,
    CHANGES_SIDEBAR_DEFAULT_WIDTH,
    CHANGES_SIDEBAR_MIN_WIDTH,
    commitListHeight,
} from './layout';

const OPEN_KEY = 'clowdy:changes-sidebar-open';
const WIDTH_KEY = 'clowdy:changes-sidebar-width';
const COMMITS_OPEN_KEY = 'clowdy:changes-commits-open';
const COMMITS_HEIGHT_KEY = 'clowdy:changes-commits-height';

const clampWidth = (width: number) => Math.max(CHANGES_SIDEBAR_MIN_WIDTH, Math.round(width));
const clampHeight = (height: number) => Math.max(CHANGES_COMMITS_MIN_HEIGHT, Math.round(height));
const isSize = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/**
 * The height the commits' box opens at until the person drags it: as many rows as the branch has commits, two at the least and five at the most, and never more than a share of
 * the column it is in (`available`, 0 while it is not measured).
 */
export function defaultCommitsHeight(commits: number, available: number): number {
    const rows = Math.min(Math.max(commits, 2), CHANGES_COMMITS_DEFAULT_ROWS);
    const wanted = commitListHeight(rows);

    return available > 0
        ? Math.max(CHANGES_COMMITS_MIN_HEIGHT, Math.min(wanted, Math.floor(available * CHANGES_COMMITS_DEFAULT_SHARE)))
        : wanted;
}

/**
 * A height for the commits' box that fits: at least two rows, and no more than the column leaves once the files and the commit box have what they need (`reserved`), so the box is
 * never dragged over them. The least wins in a column too short for both.
 */
export function fitCommitsHeight(height: number, available: number, reserved: number): number {
    const most = available > 0 ? available - reserved : Number.POSITIVE_INFINITY;

    return Math.max(CHANGES_COMMITS_MIN_HEIGHT, Math.min(Math.round(height), most));
}

/**
 * How the Changes tab's sidebar is shown, one choice for the whole window whichever project or place is on show, as the file tree's is (`TreeLayout`): whether it is beside the
 * diffs, and how wide when it is; and, at its foot, whether the commits of the branch are open and how tall their box was dragged (none until it is, so the box opens at its
 * default).
 */
export class ChangesSidebarLayout {
    open: boolean;
    width: number;
    commitsOpen: boolean;
    commitsHeight: number | undefined;

    constructor(private readonly storage?: KeyValueStorage) {
        const open = readStored(storage, OPEN_KEY);
        const width = readStored(storage, WIDTH_KEY);
        const commitsOpen = readStored(storage, COMMITS_OPEN_KEY);
        const commitsHeight = readStored(storage, COMMITS_HEIGHT_KEY);

        this.open = open !== false;
        this.width = isSize(width) ? clampWidth(width) : CHANGES_SIDEBAR_DEFAULT_WIDTH;
        this.commitsOpen = commitsOpen === true;
        this.commitsHeight = isSize(commitsHeight) ? clampHeight(commitsHeight) : undefined;
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

    toggleCommits(): void {
        this.commitsOpen = !this.commitsOpen;
        writeStored(this.storage, COMMITS_OPEN_KEY, this.commitsOpen);
    }

    setCommitsHeight(height: number): void {
        this.commitsHeight = clampHeight(height);
        writeStored(this.storage, COMMITS_HEIGHT_KEY, this.commitsHeight);
    }

    /** Back to the height the box opens at by default, which follows the column again. */
    resetCommitsHeight(): void {
        this.commitsHeight = undefined;
        removeStored(this.storage, COMMITS_HEIGHT_KEY);
    }
}

/** The sidebar's layout of this window, kept in this computer's storage. */
export const changesSidebarLayout = new ChangesSidebarLayout(browserStorage());

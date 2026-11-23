import { type KeyValueStorage, readStored, writeStored } from '../stores/storage';

/** How narrow and how wide the left column of a screen can be dragged, in pixels. */
export const SIDEBAR_MIN_WIDTH = 220;
export const SIDEBAR_MAX_WIDTH = 480;

/** What the page beside the column keeps (the chat), so a wide column cannot squeeze it out. */
export const MAIN_MIN_WIDTH = 350;

const storageKey = (screen: string) => `clowdy:sidebar-width:${screen}`;

const clamp = (width: number) => Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width));

/** The width the person left the screen's column at, or `fallback`. A stored value from before the range changed is brought into it. */
export function readSidebarWidth(storage: KeyValueStorage | undefined, screen: string, fallback: number): number {
    const stored = readStored(storage, storageKey(screen));

    return typeof stored === 'number' && Number.isFinite(stored) ? clamp(Math.round(stored)) : fallback;
}

export function writeSidebarWidth(storage: KeyValueStorage | undefined, screen: string, width: number): void {
    writeStored(storage, storageKey(screen), clamp(Math.round(width)));
}

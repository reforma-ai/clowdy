import { readStored, writeStored, type KeyValueStorage } from '../../stores/storage';

/** How narrow and how wide the side panel can be dragged, in pixels, and the width it opens at until the person drags it. */
export const SIDE_PANEL_MIN_WIDTH = 280;
export const SIDE_PANEL_MAX_WIDTH = 720;
export const SIDE_PANEL_DEFAULT_WIDTH = 420;

const STORAGE_KEY = 'clowdy:side-panel-width';

const clamp = (width: number) => Math.min(SIDE_PANEL_MAX_WIDTH, Math.max(SIDE_PANEL_MIN_WIDTH, width));

/** The width the person left the panel at, one for the whole window, or the default. A stored value from before the range changed is brought into it. */
export function readSidePanelWidth(storage: KeyValueStorage | undefined): number {
    const stored = readStored(storage, STORAGE_KEY);

    return typeof stored === 'number' && Number.isFinite(stored) ? clamp(Math.round(stored)) : SIDE_PANEL_DEFAULT_WIDTH;
}

export function writeSidePanelWidth(storage: KeyValueStorage | undefined, width: number): void {
    writeStored(storage, STORAGE_KEY, clamp(Math.round(width)));
}

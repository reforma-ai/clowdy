import { readStored, writeStored, type KeyValueStorage } from '../../stores/storage';

/**
 * How narrow the side panel can be dragged, in pixels, and the width it opens at until the person drags it. There is no widest: the panel can take all that the
 * left part of the window does not need (`SidePanelLayout` keeps that part at its least), so a wide window can give it as much as the person wants.
 */
export const SIDE_PANEL_MIN_WIDTH = 280;
export const SIDE_PANEL_DEFAULT_WIDTH = 600;

const STORAGE_KEY = 'clowdy:side-panel-width';

const clamp = (width: number) => Math.max(SIDE_PANEL_MIN_WIDTH, width);

/** The width the person left the panel at, one for the whole window, or the default. A window too narrow for it gives the panel less, and the width is kept for a wider one. */
export function readSidePanelWidth(storage: KeyValueStorage | undefined): number {
    const stored = readStored(storage, STORAGE_KEY);

    return typeof stored === 'number' && Number.isFinite(stored) ? clamp(Math.round(stored)) : SIDE_PANEL_DEFAULT_WIDTH;
}

export function writeSidePanelWidth(storage: KeyValueStorage | undefined, width: number): void {
    writeStored(storage, STORAGE_KEY, clamp(Math.round(width)));
}

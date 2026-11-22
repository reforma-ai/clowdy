import { FILE_MANAGER_MIN_WIDTH } from '@clowdy/file-manager/layout';

import { MAIN_MIN_WIDTH, SIDEBAR_MIN_WIDTH } from '../../shared/sidebarWidth';
import { readStored, writeStored, type KeyValueStorage } from '../../stores/storage';

/**
 * How narrow the side panel can be dragged, in pixels, and the width it opens at until the person drags it. There is no widest: the panel can take all that the
 * left part of the window does not need (`SidePanelLayout` keeps that part at its least), so a wide window can give it as much as the person wants. A tab with a tree beside
 * a view needs more than this (`TREE_PANEL_MIN_WIDTH`).
 */
export const SIDE_PANEL_MIN_WIDTH = 280;
export const SIDE_PANEL_DEFAULT_WIDTH = 600;

/** The rail at the window's right edge: `--side-rail-width` of `Shell.module.css`. */
export const SIDE_RAIL_WIDTH = 56;

/** What the window's plate takes around the list and the chat: the room at its left edge, its own borders and the list's, and half the gap to the panel's plate. Measured in the window, not drawn from the stylesheet. */
const PAGE_FRAME_WIDTH = 10;

/** What the panel's plate takes around its view: its borders and the other half of the gap. */
const PANEL_FRAME_WIDTH = 4;

/** The least the left part of the window can be: the list and the chat at their narrowest, so dragging the panel wide cannot squeeze them out. The rails are outside the layout. */
export const WINDOW_MIN_WIDTH = SIDEBAR_MIN_WIDTH + MAIN_MIN_WIDTH + PAGE_FRAME_WIDTH;

/** The least the panel can be while it shows a tree beside a view (Files and Docs): the file manager at its narrowest, in the panel's plate. */
export const TREE_PANEL_MIN_WIDTH = FILE_MANAGER_MIN_WIDTH + PANEL_FRAME_WIDTH;

/**
 * The window's width from which the panel with a tree fits beside the chat: the rail, the left part and the panel, each at its least (1140). Under it Files and Docs
 * are in the chat's place, as the Tasks tab always is (`ProjectUi.sidePanelTabIsFull`). The other tabs are narrow enough to fit beside the chat in any window: the window
 * itself is not narrower than the rail, the left part and `SIDE_PANEL_MIN_WIDTH`.
 */
export const HALF_MIN_WINDOW_WIDTH = SIDE_RAIL_WIDTH + WINDOW_MIN_WIDTH + TREE_PANEL_MIN_WIDTH;

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

import { FILE_MANAGER_MIN_WIDTH, SIDEBAR_MIN_WIDTH as FILE_TREE_MIN_WIDTH } from '@clowdy/file-manager/layout';
import { describe, expect, it } from 'vitest';

import { SIDEBAR_MIN_WIDTH } from '../../shared/sidebarWidth';
import { CHANGES_MIN_WIDTH, CHANGES_READING_MIN_WIDTH, CHANGES_SIDEBAR_MIN_WIDTH } from '../changes/layout';
import {
    HALF_MIN_WINDOW_WIDTH,
    readSidePanelWidth,
    SIDE_PANEL_DEFAULT_WIDTH,
    SIDE_PANEL_MIN_WIDTH,
    SIDE_RAIL_WIDTH,
    TREE_PANEL_MIN_WIDTH,
    WINDOW_MIN_WIDTH,
    writeSidePanelWidth,
} from './panelWidth';

import type { KeyValueStorage } from '../../stores/storage';

function memory(initial: Record<string, string> = {}): KeyValueStorage {
    const values = new Map(Object.entries(initial));

    return { getItem: key => values.get(key) ?? null, setItem: (key, value) => void values.set(key, value) };
}

describe('side panel width', () => {
    it('opens at the default width when nothing is stored, or storage is not there', () => {
        expect(readSidePanelWidth(memory())).toBe(SIDE_PANEL_DEFAULT_WIDTH);
        expect(readSidePanelWidth(undefined)).toBe(SIDE_PANEL_DEFAULT_WIDTH);
    });

    it('remembers the width the person left it at', () => {
        const storage = memory();

        writeSidePanelWidth(storage, 500.4);

        expect(readSidePanelWidth(storage)).toBe(500);
    });

    it('has no widest, so a wide window can give the panel what it was left at, and keeps it from being narrower than its least', () => {
        expect(readSidePanelWidth(memory({ 'clowdy:side-panel-width': '2000' }))).toBe(2000);
        expect(readSidePanelWidth(memory({ 'clowdy:side-panel-width': '10' }))).toBe(SIDE_PANEL_MIN_WIDTH);
    });

    it('ignores what is not a width', () => {
        expect(readSidePanelWidth(memory({ 'clowdy:side-panel-width': '"wide"' }))).toBe(SIDE_PANEL_DEFAULT_WIDTH);
        expect(readSidePanelWidth(memory({ 'clowdy:side-panel-width': 'not json' }))).toBe(SIDE_PANEL_DEFAULT_WIDTH);
    });
});

describe('the least widths of the window', () => {
    it("keeps the list of chats at 220 and the chat at 350, with the frame of the window's plate around them", () => {
        expect(WINDOW_MIN_WIDTH).toBe(580);
    });

    it("holds a 220px sidebar and a 350px view, with the panel's plate around them", () => {
        expect(TREE_PANEL_MIN_WIDTH).toBe(574);
        expect(TREE_PANEL_MIN_WIDTH).toBeGreaterThan(SIDE_PANEL_MIN_WIDTH);
    });

    it('gives the file tree and Source Control the same minimum width as the chat list', () => {
        expect(CHANGES_READING_MIN_WIDTH).toBe(350);
        expect(CHANGES_SIDEBAR_MIN_WIDTH).toBe(SIDEBAR_MIN_WIDTH);
        expect(FILE_TREE_MIN_WIDTH).toBe(SIDEBAR_MIN_WIDTH);
        expect(CHANGES_MIN_WIDTH).toBe(CHANGES_READING_MIN_WIDTH + CHANGES_SIDEBAR_MIN_WIDTH);
        expect(TREE_PANEL_MIN_WIDTH).toBeGreaterThanOrEqual(CHANGES_MIN_WIDTH);
        expect(TREE_PANEL_MIN_WIDTH).toBeGreaterThanOrEqual(FILE_MANAGER_MIN_WIDTH);
    });

    it("gives the window's width from which a tree fits beside the chat: the rail, the left part and the panel, each at its least", () => {
        expect(HALF_MIN_WINDOW_WIDTH).toBe(SIDE_RAIL_WIDTH + WINDOW_MIN_WIDTH + TREE_PANEL_MIN_WIDTH);
        expect(HALF_MIN_WINDOW_WIDTH).toBe(1210);
    });
});

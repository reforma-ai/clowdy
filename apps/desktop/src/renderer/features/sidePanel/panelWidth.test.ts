import { describe, expect, it } from 'vitest';

import { readSidePanelWidth, SIDE_PANEL_DEFAULT_WIDTH, SIDE_PANEL_MIN_WIDTH, writeSidePanelWidth } from './panelWidth';

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

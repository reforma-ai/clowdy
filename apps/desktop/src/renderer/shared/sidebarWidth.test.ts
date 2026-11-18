import { describe, expect, it } from 'vitest';

import { readSidebarWidth, SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH, writeSidebarWidth } from './sidebarWidth';

import type { KeyValueStorage } from '../stores/storage';

function memory(initial: Record<string, string> = {}): KeyValueStorage & { values: Map<string, string> } {
    const values = new Map(Object.entries(initial));

    return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => void values.set(key, value) };
}

describe('sidebar width', () => {
    it('falls back when nothing is stored, or storage is not there', () => {
        expect(readSidebarWidth(memory(), 'docs', 330)).toBe(330);
        expect(readSidebarWidth(undefined, 'docs', 330)).toBe(330);
    });

    it('remembers a width for each screen', () => {
        const storage = memory();

        writeSidebarWidth(storage, 'docs', 360.4);
        writeSidebarWidth(storage, 'agents', 250);

        expect(readSidebarWidth(storage, 'docs', 330)).toBe(360);
        expect(readSidebarWidth(storage, 'agents', 270)).toBe(250);
        expect(readSidebarWidth(storage, 'settings', 270)).toBe(270);
    });

    it('keeps a stored width inside the range', () => {
        const storage = memory({ 'clowdy:sidebar-width:docs': '900', 'clowdy:sidebar-width:agents': '12' });

        expect(readSidebarWidth(storage, 'docs', 330)).toBe(SIDEBAR_MAX_WIDTH);
        expect(readSidebarWidth(storage, 'agents', 270)).toBe(SIDEBAR_MIN_WIDTH);
    });

    it('ignores what is not a width', () => {
        const storage = memory({ 'clowdy:sidebar-width:docs': '"wide"', 'clowdy:sidebar-width:agents': 'not json' });

        expect(readSidebarWidth(storage, 'docs', 330)).toBe(330);
        expect(readSidebarWidth(storage, 'agents', 270)).toBe(270);
    });

    it('does not throw when storage does', () => {
        const blocked: KeyValueStorage = {
            getItem: () => {
                throw new Error('blocked');
            },
            setItem: () => {
                throw new Error('blocked');
            },
        };

        expect(readSidebarWidth(blocked, 'docs', 330)).toBe(330);
        expect(() => writeSidebarWidth(blocked, 'docs', 300)).not.toThrow();
    });
});

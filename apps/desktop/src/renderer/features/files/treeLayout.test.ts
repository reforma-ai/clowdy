import { describe, expect, it } from 'vitest';

import { TREE_DEFAULT_WIDTH, TREE_MIN_WIDTH, TreeLayout } from './treeLayout';

const memory = (initial: Record<string, string> = {}) => {
    const data = new Map(Object.entries(initial));

    return { data, getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => void data.set(key, value) };
};

describe('TreeLayout', () => {
    it('shows the tree at its default width until the person changes either, and keeps what they choose', () => {
        const storage = memory();
        const layout = new TreeLayout(storage);

        expect(layout.open).toBe(true);
        expect(layout.width).toBe(TREE_DEFAULT_WIDTH);

        expect(layout.showHidden).toBe(false);

        layout.toggle();
        layout.setWidth(301.4);
        layout.setShowHidden(true);

        const next = new TreeLayout(storage);

        expect(next.open).toBe(false);
        expect(next.width).toBe(301);
        expect(next.showHidden).toBe(true);
    });

    it('shows a hidden tree when asked to, and leaves a shown one as it is', () => {
        const storage = memory();
        const layout = new TreeLayout(storage);

        layout.show();

        expect(layout.open).toBe(true);

        layout.toggle();
        layout.show();

        expect(layout.open).toBe(true);
        expect(new TreeLayout(storage).open).toBe(true);
    });

    it('never makes the tree narrower than it can be drawn, and ignores what is damaged in storage', () => {
        const layout = new TreeLayout(memory());

        layout.setWidth(10);

        expect(layout.width).toBe(TREE_MIN_WIDTH);
        expect(new TreeLayout(memory({ 'clowdy:files-tree-width': '"wide"', 'clowdy:files-tree-open': '1' })).width).toBe(TREE_DEFAULT_WIDTH);
        expect(new TreeLayout(undefined).open).toBe(true);
    });
});

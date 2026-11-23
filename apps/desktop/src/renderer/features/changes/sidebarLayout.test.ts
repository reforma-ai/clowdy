import { describe, expect, it } from 'vitest';

import { CHANGES_COMMITS_MIN_HEIGHT, commitListHeight } from './layout';
import { ChangesSidebarLayout, defaultCommitsHeight, fitCommitsHeight } from './sidebarLayout';

import type { KeyValueStorage } from '../../stores/storage';

/** A storage in memory, as `localStorage` holds its values: as text. */
function memoryStorage(values: Record<string, string> = {}): KeyValueStorage & { values: Record<string, string> } {
    return {
        values,
        getItem: key => values[key] ?? null,
        setItem: (key, value) => {
            values[key] = value;
        },
        removeItem: key => {
            delete values[key];
        },
    };
}

describe('the commits at the foot of the sidebar', () => {
    it('are shut and at their default height until the person says otherwise', () => {
        const layout = new ChangesSidebarLayout(memoryStorage());

        expect(layout.commitsOpen).toBe(false);
        expect(layout.commitsHeight).toBeUndefined();
    });

    it('keep whether they are open and the height they were dragged to for the window', () => {
        const storage = memoryStorage();
        const layout = new ChangesSidebarLayout(storage);

        layout.toggleCommits();
        layout.setCommitsHeight(212.6);

        expect(storage.values).toEqual({
            'clowdy:changes-commits-open': 'true',
            'clowdy:changes-commits-height': '213',
        });

        const next = new ChangesSidebarLayout(storage);

        expect(next.commitsOpen).toBe(true);
        expect(next.commitsHeight).toBe(213);

        next.toggleCommits();
        next.resetCommitsHeight();

        expect(storage.values).toEqual({ 'clowdy:changes-commits-open': 'false' });
        expect(new ChangesSidebarLayout(storage).commitsOpen).toBe(false);
    });

    it('are never kept shorter than two rows', () => {
        const storage = memoryStorage();
        const layout = new ChangesSidebarLayout(storage);

        layout.setCommitsHeight(10);

        expect(layout.commitsHeight).toBe(CHANGES_COMMITS_MIN_HEIGHT);
        expect(new ChangesSidebarLayout(memoryStorage({ 'clowdy:changes-commits-height': '12' })).commitsHeight).toBe(
            CHANGES_COMMITS_MIN_HEIGHT
        );
    });

    it('read what is stored defensively: a value that is not a size, or no storage at all, is the default', () => {
        for (const value of ['"tall"', 'null', '{', '"NaN"', 'true']) {
            expect(
                new ChangesSidebarLayout(memoryStorage({ 'clowdy:changes-commits-height': value })).commitsHeight
            ).toBeUndefined();
        }

        expect(new ChangesSidebarLayout(memoryStorage({ 'clowdy:changes-commits-open': '"yes"' })).commitsOpen).toBe(
            false
        );

        const broken: KeyValueStorage = {
            getItem: () => {
                throw new Error('blocked');
            },
            setItem: () => {
                throw new Error('blocked');
            },
            removeItem: () => {
                throw new Error('blocked');
            },
        };
        const layout = new ChangesSidebarLayout(broken);

        expect(layout.commitsOpen).toBe(false);
        // A storage that throws loses the choice, and nothing else.
        layout.toggleCommits();
        layout.setCommitsHeight(200);
        layout.resetCommitsHeight();
        expect(layout.commitsOpen).toBe(true);

        expect(new ChangesSidebarLayout(undefined).commitsHeight).toBeUndefined();
    });
});

describe('defaultCommitsHeight', () => {
    it('shows as many rows as the branch has commits, two at the least and five at the most', () => {
        expect(defaultCommitsHeight(1, 0)).toBe(commitListHeight(2));
        expect(defaultCommitsHeight(3, 0)).toBe(commitListHeight(3));
        expect(defaultCommitsHeight(100, 0)).toBe(commitListHeight(5));
        expect(commitListHeight(5)).toBe(5 * 49 + 4 * 2 + 8);
    });

    it('is never more than 40% of the column, nor less than two rows', () => {
        expect(defaultCommitsHeight(100, 500)).toBe(200);
        expect(defaultCommitsHeight(100, 2000)).toBe(commitListHeight(5));
        expect(defaultCommitsHeight(100, 100)).toBe(CHANGES_COMMITS_MIN_HEIGHT);
    });
});

describe('fitCommitsHeight', () => {
    it('leaves the files and the commit box what they need above the commits', () => {
        expect(fitCommitsHeight(400, 800, 300)).toBe(400);
        expect(fitCommitsHeight(600, 800, 300)).toBe(500);
        expect(fitCommitsHeight(250.4, 800, 300)).toBe(250);
    });

    it('is two rows at the least, even in a column too short for both', () => {
        expect(fitCommitsHeight(20, 800, 300)).toBe(CHANGES_COMMITS_MIN_HEIGHT);
        expect(fitCommitsHeight(300, 350, 300)).toBe(CHANGES_COMMITS_MIN_HEIGHT);
    });

    it('takes the height as it is while the column is not measured', () => {
        expect(fitCommitsHeight(900, 0, 300)).toBe(900);
    });
});

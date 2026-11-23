import { describe, expect, it } from 'vitest';

import { aheadBehindCounts, aheadBehindWords, CHANGE_KIND_VIEW, splitPath } from './gitSummary';

import type { GitBase, GitChangeKind } from '@clowdy/protocol';

const base = (ahead: number, behind: number): GitBase => ({
    state: 'ready',
    name: 'origin/main',
    commit: 'a'.repeat(40),
    mergeBase: 'b'.repeat(40),
    ahead,
    behind,
    commits: [],
});

describe('how far the branch is from its base', () => {
    it('says it without naming the base, for the sidebar, where the base is named beside it', () => {
        expect(aheadBehindCounts(base(3, 1))).toBe('3 ahead, 1 behind');
        expect(aheadBehindCounts(base(2, 0))).toBe('2 ahead');
        expect(aheadBehindCounts(base(0, 4))).toBe('4 behind');
        expect(aheadBehindCounts(base(0, 0))).toBe('Even');
    });

    it('says nothing without a base to compare with', () => {
        expect(aheadBehindCounts(undefined)).toBeUndefined();
        expect(aheadBehindCounts({ state: 'unborn' })).toBeUndefined();
        expect(aheadBehindCounts({ state: 'no_base' })).toBeUndefined();
    });

    it('keeps the words Info has, which name the base', () => {
        expect(aheadBehindWords(base(3, 1))).toBe('3 ahead, 1 behind origin/main');
        expect(aheadBehindWords(base(0, 0))).toBe('Even with origin/main');
    });
});

describe('a changed file', () => {
    it('has a letter, a name and a colour for each thing that can happen to it', () => {
        const kinds: GitChangeKind[] = [
            'added',
            'modified',
            'deleted',
            'renamed',
            'copied',
            'typechange',
            'conflicted',
        ];

        expect(kinds.map(kind => CHANGE_KIND_VIEW[kind].glyph)).toEqual(['A', 'M', 'D', 'R', 'C', 'T', 'U']);
        expect(CHANGE_KIND_VIEW.added.color).toBe('success');
        expect(CHANGE_KIND_VIEW.deleted.color).toBe('danger');
        expect(CHANGE_KIND_VIEW.conflicted.color).toBe('danger');
        expect(new Set(kinds.map(kind => CHANGE_KIND_VIEW[kind].label)).size).toBe(kinds.length);
    });

    it('has its path split into a folder, with its slash, and a name', () => {
        expect(splitPath('src/booking/price.ts')).toEqual({ folder: 'src/booking/', name: 'price.ts' });
        expect(splitPath('README.md')).toEqual({ folder: '', name: 'README.md' });
        expect(splitPath('a/b')).toEqual({ folder: 'a/', name: 'b' });
    });
});

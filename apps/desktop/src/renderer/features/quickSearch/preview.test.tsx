import { describe, expect, it } from 'vitest';

import { visiblePreview, wordRanges } from './preview';

describe('the preview of a line', () => {
    it('drops the indentation', () => {
        expect(visiblePreview({ preview: '        const total = 1;', ranges: [{ start: 14, end: 19 }] })).toEqual({ text: 'const total = 1;', ranges: [{ start: 6, end: 11 }] });
    });

    it('starts a little before a match far into a line, with an ellipsis, and keeps the match in place', () => {
        const preview = `${ 'x'.repeat(60) }needle${ 'y'.repeat(20) }`;
        const { text, ranges } = visiblePreview({ preview, ranges: [{ start: 60, end: 66 }] });

        expect(text.startsWith('…')).toBe(true);
        expect(text.slice(ranges[0]!.start, ranges[0]!.end)).toBe('needle');
    });
});

describe('the words of a query in a name', () => {
    it('finds each word once, ignoring case, in order', () => {
        expect(wordRanges('README.md', 'readm')).toEqual([{ start: 0, end: 5 }]);
        expect(wordRanges('BookingForm.tsx', 'form book')).toEqual([{ start: 0, end: 4 }, { start: 7, end: 11 }]);
    });

    it('joins words that overlap, and skips the ones that are not there', () => {
        expect(wordRanges('price.test.ts', 'price ice zzz')).toEqual([{ start: 0, end: 5 }]);
        expect(wordRanges('a.ts', '  ')).toEqual([]);
    });
});

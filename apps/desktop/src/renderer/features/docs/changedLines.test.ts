import { describe, expect, it } from 'vitest';

import { changedLines } from './changedLines';

describe('changedLines', () => {
    it('flags nothing for equal texts', () => {
        expect(changedLines('a\nb', 'a\nb')).toEqual({ mine: [false, false], theirs: [false, false] });
    });

    it('flags a changed line on both sides and keeps the lines around it', () => {
        const { mine, theirs } = changedLines('# Title\n\nold line\n\nend\n', '# Title\n\nnew line\n\nend\n');

        expect(mine).toEqual([false, false, true, false, false, false]);
        expect(theirs).toEqual([false, false, true, false, false, false]);
    });

    it('flags an inserted line only on the side that has it', () => {
        const { mine, theirs } = changedLines('one\ntwo\nthree', 'one\ntwo\nextra\nthree');

        expect(mine).toEqual([false, false, false]);
        expect(theirs).toEqual([false, false, true, false]);
    });

    it('does not treat a moved line as unchanged', () => {
        const { mine, theirs } = changedLines('a\nb\nc', 'c\na\nb');

        expect(mine.filter(Boolean)).toHaveLength(1);
        expect(theirs.filter(Boolean)).toHaveLength(1);
        expect(mine[2]).toBe(true);
        expect(theirs[0]).toBe(true);
    });

    it('flags every line when one side is empty', () => {
        expect(changedLines('', 'x\ny')).toEqual({ mine: [true], theirs: [true, true] });
    });

    it('flags the whole middle of a huge difference instead of building a table for it', () => {
        const mine = Array.from({ length: 2000 }, (_, index) => `mine ${ index }`).join('\n');
        const theirs = Array.from({ length: 2000 }, (_, index) => `theirs ${ index }`).join('\n');
        const result = changedLines(mine, theirs);

        expect(result.mine.every(Boolean)).toBe(true);
        expect(result.theirs.every(Boolean)).toBe(true);
    });
});

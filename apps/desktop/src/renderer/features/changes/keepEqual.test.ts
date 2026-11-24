import { describe, expect, it } from 'vitest';

import { keepEqual } from './keepEqual';

const file = (path: string, revision = 'r1') => ({ path, kind: 'modified', revision });

describe('an answer read again', () => {
    it('is the last one itself when it says the same', () => {
        const previous = { isRepository: true, files: [file('a.ts'), file('b.ts')], from: 'abc' };
        const next = structuredClone(previous);

        expect(keepEqual(previous, next)).toBe(previous);
    });

    it('is new where it changed and keeps the objects of every part that did not', () => {
        const previous = { files: [file('a.ts'), file('b.ts'), file('c.ts')], from: 'abc' };
        const next = { files: [file('a.ts'), file('b.ts', 'r2'), file('c.ts')], from: 'abc' };
        const kept = keepEqual(previous, next);

        expect(kept).toEqual(next);
        expect(kept).not.toBe(previous);
        expect(kept.files[0]).toBe(previous.files[0]);
        expect(kept.files[1]).not.toBe(previous.files[1]);
        expect(kept.files[2]).toBe(previous.files[2]);
    });

    it('matches the files of a list by path, so a file that came or went does not make the others new', () => {
        const previous = [file('a.ts'), file('c.ts')];
        const added = keepEqual(previous, [file('a.ts'), file('b.ts'), file('c.ts')]);

        expect(added.map(item => item.path)).toEqual(['a.ts', 'b.ts', 'c.ts']);
        expect(added[0]).toBe(previous[0]);
        expect(added[2]).toBe(previous[1]);

        const removed = keepEqual(previous, [file('c.ts')]);

        expect(removed).toEqual([file('c.ts')]);
        expect(removed[0]).toBe(previous[1]);
    });

    it('is new when a key came or went, or a value changed its kind', () => {
        const previous: Record<string, unknown> = { a: 1, b: [1, 2] };

        expect(keepEqual(previous, { a: 1 })).toEqual({ a: 1 });
        expect(keepEqual(previous, { a: 1, b: [1, 2], c: undefined })).not.toBe(previous);
        expect(keepEqual(previous, { a: 1, b: { 0: 1, 1: 2 } })).toEqual({ a: 1, b: { 0: 1, 1: 2 } });
        expect(keepEqual<unknown>(null, { a: 1 })).toEqual({ a: 1 });
        expect(keepEqual<unknown>({ a: 1 }, null)).toBeNull();
    });

    it('says what the new answer says when a path is listed twice or a key is one every object inherits', () => {
        const previous = [file('a.ts', 'r1'), file('a.ts', 'r2')];
        const next = [file('a.ts', 'r2'), file('a.ts', 'r1'), file('a.ts', 'r3')];

        expect(keepEqual(previous, next)).toEqual(next);
        expect(keepEqual<Record<string, unknown>>({}, { constructor: 'main' })).toEqual({ constructor: 'main' });
    });
});

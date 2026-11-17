import { describe, expect, it } from 'vitest';

import { deepFreeze } from '../src/objects';

describe('deepFreeze', () => {
    it('freezes nested objects and arrays', () => {
        const value = deepFreeze({
            a: 1,
            nested: { b: 2 },
            list: [{ c: 3 }],
        });

        expect(Object.isFrozen(value)).toBe(true);
        expect(Object.isFrozen(value.nested)).toBe(true);
        expect(Object.isFrozen(value.list)).toBe(true);
        expect(Object.isFrozen(value.list[0])).toBe(true);
    });

    it('returns already-frozen values unchanged', () => {
        const frozen = Object.freeze({ x: 1 });

        expect(deepFreeze(frozen)).toBe(frozen);
    });
});

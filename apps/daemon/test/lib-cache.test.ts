import { describe, expect, test } from 'bun:test';

import { TtlCache } from '../src/lib/cache';

describe('TtlCache', () => {
    test('keeps an answer that is undefined for its time, as it keeps any other', async () => {
        let now = 0;
        let loads = 0;
        const cache = new TtlCache<string | undefined>({ now: () => now });
        const load = async () => {
            loads++;

            return { value: undefined, keepMs: 1000 };
        };

        await cache.get('gh', load);
        now = 999;
        await cache.get('gh', load);

        const whileKept = loads;

        now = 1000;
        await cache.get('gh', load);

        expect([whileKept, loads]).toEqual([1, 2]);
    });
});

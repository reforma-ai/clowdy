import { describe, expect, it } from 'vitest';

import { contextFill, formatTokens } from './contextUsage';

describe('formatTokens', () => {
    it('writes a count under a thousand as it is', () => {
        expect(formatTokens(0)).toBe('0');
        expect(formatTokens(7)).toBe('7');
        expect(formatTokens(999)).toBe('999');
    });

    it('writes thousands with one decimal and drops a trailing .0', () => {
        expect(formatTokens(1_000)).toBe('1K');
        expect(formatTokens(1_500)).toBe('1.5K');
        expect(formatTokens(53_000)).toBe('53K');
        expect(formatTokens(92_300)).toBe('92.3K');
        expect(formatTokens(92_340)).toBe('92.3K');
        expect(formatTokens(200_000)).toBe('200K');
        expect(formatTokens(999_900)).toBe('999.9K');
    });

    it('writes millions as 1M or 1.2M', () => {
        expect(formatTokens(1_000_000)).toBe('1M');
        expect(formatTokens(1_200_000)).toBe('1.2M');
        expect(formatTokens(2_040_000)).toBe('2M');
    });

    it('carries a rounding over to the next unit instead of reading 1000K', () => {
        expect(formatTokens(999_949)).toBe('999.9K');
        expect(formatTokens(999_960)).toBe('1M');
        expect(formatTokens(999.6)).toBe('1K');
    });

    it('takes what is not a count for nothing', () => {
        expect(formatTokens(-5)).toBe('0');
        expect(formatTokens(Number.NaN)).toBe('0');
        expect(formatTokens(Number.POSITIVE_INFINITY)).toBe('0');
    });
});

describe('contextFill', () => {
    const at = (percent: number) => contextFill({ used: percent * 1_000, size: 100_000 });

    it('reads the percent full, the tokens and the window', () => {
        expect(contextFill({ used: 53_000, size: 250_000 })).toEqual({ percent: 21, tone: 'normal', used: '~53K', size: '250K', label: '21% full' });
        expect(contextFill({ used: 92_300, size: 200_000 })).toMatchObject({ percent: 46, used: '~92.3K', size: '200K', label: '46% full' });
        expect(contextFill({ used: 640, size: 1_000_000 })).toMatchObject({ percent: 0, used: '~640', size: '1M', label: '0% full' });
    });

    it('rounds the percent to the nearest whole number', () => {
        expect(contextFill({ used: 4_949, size: 10_000 }).percent).toBe(49);
        expect(contextFill({ used: 4_950, size: 10_000 }).percent).toBe(50);
    });

    it('turns to the warning tone from 80% and to the danger tone from 90%, as the usage bars do', () => {
        expect([0, 79, 80, 89, 90, 100].map(percent => at(percent).tone)).toEqual(['normal', 'normal', 'warning', 'warning', 'danger', 'danger']);
        expect(at(79).percent).toBe(79);
        expect(at(80).percent).toBe(80);
        expect(at(89).percent).toBe(89);
        expect(at(90).percent).toBe(90);
        expect(at(100).percent).toBe(100);
    });

    it('tones the percent it shows: 79.6% is shown as 80% and is a warning', () => {
        expect(contextFill({ used: 79_600, size: 100_000 })).toMatchObject({ percent: 80, tone: 'warning' });
    });

    it('keeps the percent at 100 over a full window, and still says the real tokens', () => {
        expect(contextFill({ used: 250_000, size: 200_000 })).toMatchObject({ percent: 100, tone: 'danger', used: '~250K', size: '200K', label: '100% full' });
    });

    it('is empty for a window with no size, and for a reading below zero', () => {
        expect(contextFill({ used: 5_000, size: 0 })).toMatchObject({ percent: 0, tone: 'normal', used: '~5K', size: '0', label: '0% full' });
        expect(contextFill({ used: 5_000, size: -10 }).percent).toBe(0);
        expect(contextFill({ used: -5_000, size: 200_000 })).toMatchObject({ percent: 0, used: '~0' });
    });
});

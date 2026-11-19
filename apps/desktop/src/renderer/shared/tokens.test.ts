import { describe, expect, it } from 'vitest';

import { formatTokens } from './tokens';

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

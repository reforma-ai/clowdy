import { describe, expect, it } from 'vitest';

import { isVersionAheadOf, parseVersion } from '../src/semver';

describe('parseVersion', () => {
    it('parses major-only, minor, and patch versions', () => {
        expect(parseVersion('1')).toEqual({ major: 1, minor: 0, patch: 0 });
        expect(parseVersion('1.1')).toEqual({ major: 1, minor: 1, patch: 0 });
        expect(parseVersion('1.1.1')).toEqual({ major: 1, minor: 1, patch: 1 });
        expect(parseVersion('4.12')).toEqual({ major: 4, minor: 12, patch: 0 });
    });

    it('rejects unknown ids', () => {
        expect(parseVersion('legacy')).toBeNull();
        expect(parseVersion('')).toBeNull();
    });
});

describe('isVersionAheadOf', () => {
    it('is true when checkpoint is later than current checkout', () => {
        expect(isVersionAheadOf('18.4', '18')).toBe(true);
        expect(isVersionAheadOf('18.4', '18.1')).toBe(true);
        expect(isVersionAheadOf('19.1', '18.4')).toBe(true);
        expect(isVersionAheadOf('18.1', '18')).toBe(true);
        expect(isVersionAheadOf('1.1.2', '1.1.1')).toBe(true);
    });

    it('is false when checkpoint matches or is behind current checkout', () => {
        expect(isVersionAheadOf('18', '19')).toBe(false);
        expect(isVersionAheadOf('18.4', '18.4')).toBe(false);
        expect(isVersionAheadOf('18.1', '18.4')).toBe(false);
        expect(isVersionAheadOf('18', '18.1')).toBe(false);
        expect(isVersionAheadOf('18.4', null)).toBe(false);
        expect(isVersionAheadOf('bad', '18.1')).toBe(false);
    });
});

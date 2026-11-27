import { describe, expect, it } from 'vitest';

import { tokenLabel } from './skillView';

describe('tokenLabel', () => {
    it('writes tokens with a thousands separator', () => {
        expect(tokenLabel(39)).toBe('39 tokens');
        expect(tokenLabel(1234)).toBe('1,234 tokens');
    });
});

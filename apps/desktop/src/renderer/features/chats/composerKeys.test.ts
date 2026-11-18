import { describe, expect, it } from 'vitest';

import { isSendKey } from './composerKeys';

describe('isSendKey', () => {
    it('sends on Enter', () => {
        expect(isSendKey({ key: 'Enter', shiftKey: false, isComposing: false })).toBe(true);
    });

    it('keeps Shift+Enter for a new line', () => {
        expect(isSendKey({ key: 'Enter', shiftKey: true, isComposing: false })).toBe(false);
    });

    it('lets an input method confirm its candidate with Enter without sending', () => {
        expect(isSendKey({ key: 'Enter', shiftKey: false, isComposing: true })).toBe(false);
    });

    it('ignores other keys', () => {
        expect(isSendKey({ key: 'a', shiftKey: false, isComposing: false })).toBe(false);
    });
});

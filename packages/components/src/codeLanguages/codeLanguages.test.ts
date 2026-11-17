import { describe, expect, it } from 'vitest';

import { codeLanguage } from './codeLanguages';

describe('codeLanguage', () => {
    it('should load a language once and return it synchronously after that, for any of its names', async() => {
        const pending = codeLanguage('ts');

        expect(pending).toBeInstanceOf(Promise);

        const support = await pending;

        expect(support).not.toBeNull();
        expect(codeLanguage('TS')).toBe(support);
        expect(codeLanguage('typescript')).toBe(support);
    });

    it('should return null for plain text and for names that only exist on objects', () => {
        expect(codeLanguage('')).toBeNull();
        expect(codeLanguage('txt')).toBeNull();
        expect(codeLanguage('constructor')).toBeNull();
    });
});

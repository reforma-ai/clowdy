import { describe, expect, it } from 'vitest';

import { pathVariants, tildePath } from './displayPath';

describe('tildePath', () => {
    it('writes the home folder as ~ where a path starts in it, and the folder itself as ~', () => {
        expect(tildePath('/Users/me/WORK/Reforma/plugins', '/Users/me')).toBe('~/WORK/Reforma/plugins');
        expect(tildePath('/Users/me', '/Users/me')).toBe('~');
        expect(tildePath('/Users/me/', '/Users/me')).toBe('~/');
    });

    it('takes a trailing separator of the home folder for none', () => {
        expect(tildePath('/Users/me/code', '/Users/me/')).toBe('~/code');
    });

    it('leaves a path elsewhere, or one that only starts with the same letters, as it is', () => {
        expect(tildePath('/opt/tools/x', '/Users/me')).toBe('/opt/tools/x');
        expect(tildePath('/Users/mel/code', '/Users/me')).toBe('/Users/mel/code');
        expect(tildePath('/Users/other/code', '/Users/me')).toBe('/Users/other/code');
    });

    it('leaves every path as it is while the home folder is not known, or is the root', () => {
        expect(tildePath('/Users/me/code', undefined)).toBe('/Users/me/code');
        expect(tildePath('/Users/me/code', '')).toBe('/Users/me/code');
        expect(tildePath('/Users/me/code', '/')).toBe('/Users/me/code');
    });

    it('does the same for a Windows path, whatever the case of the drive and the names', () => {
        expect(tildePath('C:\\Users\\Me\\code\\app', 'C:\\Users\\Me')).toBe('~\\code\\app');
        expect(tildePath('c:\\users\\me\\code', 'C:\\Users\\Me')).toBe('~\\code');
        expect(tildePath('C:\\Users\\Mel\\code', 'C:\\Users\\Me')).toBe('C:\\Users\\Mel\\code');
        expect(tildePath('D:\\work', 'C:\\Users\\Me')).toBe('D:\\work');
    });
});

describe('pathVariants', () => {
    it('starts with the whole path, then leaves out the middle names by whole names, the longest form first', () => {
        expect(pathVariants('~/Foo/bar/baz/foo')).toEqual([
            '~/Foo/bar/baz/foo',
            '~/Foo/…/baz/foo',
            '~/…/baz/foo',
            '~/…/foo',
            '…/foo',
        ]);
    });

    it('keeps the start with its first name while two names are kept at the end', () => {
        expect(pathVariants('~/a/b/c/d/e/f')).toEqual([
            '~/a/b/c/d/e/f',
            '~/a/…/c/d/e/f',
            '~/a/…/d/e/f',
            '~/a/…/e/f',
            '~/…/e/f',
            '~/…/f',
            '…/f',
        ]);
    });

    it('does the same for a path outside the home folder, with the root as its start', () => {
        expect(pathVariants('/Users/other/WORK/Reforma/plugins')).toEqual([
            '/Users/other/WORK/Reforma/plugins',
            '/Users/…/WORK/Reforma/plugins',
            '/Users/…/Reforma/plugins',
            '/…/Reforma/plugins',
            '/…/plugins',
            '…/plugins',
        ]);
    });

    it('does the same for a Windows path', () => {
        expect(pathVariants('C:\\Users\\me\\code\\app\\src')).toEqual([
            'C:\\Users\\me\\code\\app\\src',
            'C:\\Users\\…\\code\\app\\src',
            'C:\\Users\\…\\app\\src',
            'C:\\…\\app\\src',
            'C:\\…\\src',
            '…\\src',
        ]);
    });

    it('has few forms for a short path, and one for a single name', () => {
        expect(pathVariants('~/foo')).toEqual(['~/foo', '…/foo']);
        expect(pathVariants('~/a/foo')).toEqual(['~/a/foo', '~/…/foo', '…/foo']);
        expect(pathVariants('~')).toEqual(['~']);
        expect(pathVariants('')).toEqual(['']);
    });

    it('never makes a form longer than the one before the last: each is made of the same names', () => {
        for (const path of ['~/Foo/bar/baz/foo', '/Users/other/a/b/c/d', 'C:\\Users\\me\\a\\b\\c']) {
            const forms = pathVariants(path);

            expect(new Set(forms).size).toBe(forms.length);
            expect(forms.every(form => form.length <= path.length)).toBe(true);
        }
    });
});

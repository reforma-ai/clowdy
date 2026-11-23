import { describe, expect, it } from 'vitest';

import { isFilePathLike, parseCodeFenceInfo } from './codeCitation';

describe('isFilePathLike', () => {
    it('returns true for slash paths and extension-only names', () => {
        expect(isFilePathLike('apps/abc/foo/bar/baz.ts')).toBe(true);
        expect(isFilePathLike('page.tsx')).toBe(true);
        expect(isFilePathLike('src\\foo\\bar.ts')).toBe(true);
    });

    it('returns true for image paths', () => {
        expect(isFilePathLike('/generated/corgi-meadow.png')).toBe(true);
        expect(isFilePathLike('public/hero.webp')).toBe(true);
        expect(isFilePathLike('@assets/logo.svg')).toBe(true);
    });

    it('returns true for @-prefixed file paths', () => {
        expect(isFilePathLike('@app/page.tsx')).toBe(true);
        expect(isFilePathLike('@page.tsx')).toBe(true);
    });

    it('returns false for workspace-root references', () => {
        expect(isFilePathLike('/')).toBe(false);
        expect(isFilePathLike('./')).toBe(false);
        expect(isFilePathLike('@/')).toBe(false);
    });

    it('returns true for directory paths', () => {
        expect(isFilePathLike('app/components/')).toBe(true);
    });

    it('returns false for slash paths without extension or trailing slash', () => {
        expect(isFilePathLike('file/never/exist')).toBe(false);
    });

    it('returns false for commands that mention a path', () => {
        expect(isFilePathLike('ls node_modules/@plausible-analytics/')).toBe(false);
        expect(isFilePathLike('grep plausible package.json')).toBe(false);
        expect(isFilePathLike('cat src/app/page.tsx')).toBe(false);
    });

    it('returns false for an address, which is not a file of the project', () => {
        expect(isFilePathLike('http://localhost:5173/main.ts')).toBe(false);
        expect(isFilePathLike('https://example.com/logo.svg')).toBe(false);
        expect(isFilePathLike('C:\\work\\main.ts')).toBe(true);
    });

    it('returns false for plain words and language tags', () => {
        expect(isFilePathLike('npm run test')).toBe(false);
        expect(isFilePathLike('undefined')).toBe(false);
        expect(isFilePathLike('typescript')).toBe(false);
        expect(isFilePathLike('foo')).toBe(false);
        expect(isFilePathLike('.')).toBe(false);
        expect(isFilePathLike('..')).toBe(false);
        expect(isFilePathLike('...')).toBe(false);
    });

    it('returns false for glob path masks', () => {
        expect(isFilePathLike('*.ts')).toBe(false);
        expect(isFilePathLike('**/*.ts')).toBe(false);
        expect(isFilePathLike('.next/dev/types/**/*.ts')).toBe(false);
        expect(isFilePathLike('src/**/*.{ts,tsx}')).toBe(false);
    });
});

describe('parseCodeFenceInfo', () => {
    it('parses ranged file citations', () => {
        expect(parseCodeFenceInfo('language-203:209:app/page.tsx')).toEqual({
            kind: 'file',
            path: 'app/page.tsx',
            startLine: 203,
            endLine: 209,
        });
    });

    it('parses path-only file citations', () => {
        expect(parseCodeFenceInfo('language-app/page.tsx')).toEqual({
            kind: 'file',
            path: 'app/page.tsx',
        });
    });

    it('parses path-only file citations with @ prefix', () => {
        expect(parseCodeFenceInfo('language-@app/page.tsx')).toEqual({
            kind: 'file',
            path: 'app/page.tsx',
        });
    });

    it('parses ranged file citations with @ prefix on path', () => {
        expect(parseCodeFenceInfo('language-203:209:@app/page.tsx')).toEqual({
            kind: 'file',
            path: 'app/page.tsx',
            startLine: 203,
            endLine: 209,
        });
    });

    it('parses language tags', () => {
        expect(parseCodeFenceInfo('language-typescript')).toEqual({
            kind: 'language',
            language: 'typescript',
        });
        expect(parseCodeFenceInfo('language-json')).toEqual({
            kind: 'language',
            language: 'json',
        });
    });

    it('defaults missing className to plain text', () => {
        expect(parseCodeFenceInfo(undefined)).toEqual({
            kind: 'language',
            language: 'text',
        });
    });
});

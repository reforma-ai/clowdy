import { describe, expect, it } from 'vitest';

import {
    extractExtension,
    getLanguageFromPath,
    isKnownFileExtension,
    replaceHomeDir,
    resolveImportSpecifier,
    resolveRelativeImport,
} from '../src/path';

describe('replaceHomeDir', () => {
    it('should replace the home folder at the start of each path', () => {
        expect(replaceHomeDir('at /Users/ann/app/x.ts:1 and /Users/ann', '/Users/ann/'))
            .toBe('at ~/app/x.ts:1 and ~');
        expect(replaceHomeDir('cd "/root/app" (/root/x) HOME=/root:/root/bin file:///root/y', '/root'))
            .toBe('cd "~/app" (~/x) HOME=~:~/bin file://~/y');
        expect(replaceHomeDir('C:\\Users\\ann\\app and C:/Users/ann/app', 'C:\\Users\\ann')).toBe('~\\app and ~/app');
    });

    it('should leave a longer sibling folder alone', () => {
        expect(replaceHomeDir('/Users/anna/app', '/Users/ann')).toBe('/Users/anna/app');
    });

    it('should leave the home name inside another path alone', () => {
        for (const text of ['/var/root/x', 'https://github.com/root/repo']) {
            expect(replaceHomeDir(text, '/root')).toBe(text);
        }
    });

    it('should leave the text alone for a blank or root home', () => {
        for (const home of ['', ' ', '/', 'C:\\']) {
            expect(replaceHomeDir('/usr/bin/git', home)).toBe('/usr/bin/git');
        }
    });
});

describe('resolveRelativeImport', () => {
    it('resolves ./ and ../ against the usage file', () => {
        expect(resolveRelativeImport('src/App.tsx', './components/Card')).toBe('src/components/Card');
        expect(resolveRelativeImport('src/pages/Home.tsx', '../components/Button')).toBe('src/components/Button');
    });
});

describe('resolveImportSpecifier', () => {
    it('resolves relative, @/, ~/, and absolute specifiers', () => {
        expect(resolveImportSpecifier('app/page.tsx', './ui/Button')).toBe('app/ui/Button');
        expect(resolveImportSpecifier('app/page.tsx', '@/components/ui/button')).toBe('components/ui/button');
        expect(resolveImportSpecifier('app/page.tsx', '~/components/Card')).toBe('components/Card');
        expect(resolveImportSpecifier('app/page.tsx', '/lib/utils')).toBe('lib/utils');
        expect(resolveImportSpecifier('app/page.tsx', 'src/App.tsx')).toBe('src/App.tsx');
    });
});

describe('extractExtension', () => {
    it('should read the last dotted suffix', () => {
        expect(extractExtension('App.tsx')).toBe('tsx');
        expect(extractExtension('src/app/page.tsx')).toBe('tsx');
        expect(extractExtension('https://cdn.example.com/a/b/icon.SVG?v=1')).toBe('svg');
    });

    it('should ignore editor cursor suffixes on chip labels', () => {
        // `page.tsx:14` otherwise parses as URL protocol `page.tsx:` + path `14`.
        expect(extractExtension('page.tsx:14')).toBe('tsx');
        expect(extractExtension('app/page.tsx:14')).toBe('tsx');
        expect(extractExtension('App.tsx:12:1-20:5')).toBe('tsx');
    });
});

describe('isKnownFileExtension', () => {
    it('returns true for mapped extensions', () => {
        expect(isKnownFileExtension('page.tsx')).toBe(true);
        expect(isKnownFileExtension('apps/foo/bar.ts')).toBe(true);
        expect(isKnownFileExtension('foo.bar.ts')).toBe(true);
    });

    it('returns true for image and document extensions', () => {
        expect(isKnownFileExtension('generated/corgi-meadow.png')).toBe(true);
        expect(isKnownFileExtension('/assets/hero.jpg')).toBe(true);
        expect(isKnownFileExtension('docs/guide.pdf')).toBe(true);
    });

    it('returns false for language tags and plain words', () => {
        expect(isKnownFileExtension('typescript')).toBe(false);
        expect(isKnownFileExtension('undefined')).toBe(false);
        expect(isKnownFileExtension('npm run test')).toBe(false);
    });
});

describe('getLanguageFromPath', () => {
    it('maps known extensions', () => {
        expect(getLanguageFromPath('app/page.tsx')).toBe('tsx');
        expect(getLanguageFromPath('data.json')).toBe('json');
        expect(getLanguageFromPath('README.md')).toBe('markdown');
    });

    it('uses last extension segment', () => {
        expect(getLanguageFromPath('foo.bar.ts')).toBe('typescript');
    });

    it('falls back to html for unknown extensions', () => {
        expect(getLanguageFromPath('file.xyz')).toBe('html');
        expect(getLanguageFromPath('noext')).toBe('html');
    });
});

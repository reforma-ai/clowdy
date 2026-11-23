import { describe, expect, it } from 'vitest';

import { compileChangeFilter, compileGlob, filterChanged } from './changeFilter';

const PATHS = [
    'README.md',
    'docs/guide.md',
    'docs/api/Reference.MD',
    'src/booking/price.ts',
    'src/booking/price.test.ts',
    'src/booking/weekend.ts',
    'src/index.test.ts',
    'src/ui/Button.tsx',
    '.github/workflows/ci.yml',
    '.env.example',
    'packages/docs/readme.md',
    'assets/logo.png',
];

/** The paths a filter text lets through, in order. */
const shown = (text: string) => filterChanged(PATHS.map(path => ({ path })), text).map(item => item.path);

describe('the filter text', () => {
    it('shows every file when nothing is typed, or only separators and spaces', () => {
        for (const text of ['', ' ', ',', ' , ,, ', '!', ' ! ,']) {
            expect(shown(text)).toEqual(PATHS);
            expect(compileChangeFilter(text).isEmpty).toBe(true);
        }
    });

    it('gives back the same list, not a copy, when it filters nothing', () => {
        const files = PATHS.map(path => ({ path }));

        expect(filterChanged(files, '')).toBe(files);
    });

    it('takes a pattern with no glob character as a piece of the path, whatever its case', () => {
        expect(shown('price')).toEqual(['src/booking/price.ts', 'src/booking/price.test.ts']);
        expect(shown('BOOKING/Weekend')).toEqual(['src/booking/weekend.ts']);
        expect(shown('button')).toEqual(['src/ui/Button.tsx']);
        // A folder is a piece of the path too, and so is a slash.
        expect(shown('docs/')).toEqual(['docs/guide.md', 'docs/api/Reference.MD', 'packages/docs/readme.md']);
        expect(shown('.test.')).toEqual(['src/booking/price.test.ts', 'src/index.test.ts']);
    });

    it('matches a glob with no slash against the name of the file, wherever the file is', () => {
        expect(shown('*.md')).toEqual(['README.md', 'docs/guide.md', 'docs/api/Reference.MD', 'packages/docs/readme.md']);
        expect(shown('*.test.ts')).toEqual(['src/booking/price.test.ts', 'src/index.test.ts']);
        expect(shown('price.*')).toEqual(['src/booking/price.ts', 'src/booking/price.test.ts']);
        expect(shown('price.?s')).toEqual(['src/booking/price.ts']);
        // The name alone: a folder called like the glob does not make its files match.
        expect(shown('docs*')).toEqual([]);
    });

    it('matches a glob with a slash against the path from its start', () => {
        expect(shown('docs/**')).toEqual(['docs/guide.md', 'docs/api/Reference.MD']);
        expect(shown('docs/*')).toEqual(['docs/guide.md']);
        expect(shown('src/**/*.test.ts')).toEqual(['src/booking/price.test.ts', 'src/index.test.ts']);
        expect(shown('src/*/price.ts')).toEqual(['src/booking/price.ts']);
        expect(shown('**/workflows/*.yml')).toEqual(['.github/workflows/ci.yml']);
        // From the start: a folder deeper in the tree is not `docs/`.
        expect(shown('docs/guide.md')).toEqual(['docs/guide.md']);
        expect(shown('packages/**/readme.md')).toEqual(['packages/docs/readme.md']);
    });

    it('lets `**/` stand for no folder at all, and `**` for any run of characters', () => {
        expect(shown('src/**/index.test.ts')).toEqual(['src/index.test.ts']);
        // Case apart, `**/` finds the file at the top and in any folder.
        expect(shown('**/README.md')).toEqual(['README.md', 'packages/docs/readme.md']);
        expect(shown('src/**.ts')).toEqual(['src/booking/price.ts', 'src/booking/price.test.ts', 'src/booking/weekend.ts', 'src/index.test.ts']);
        expect(shown('src/***/price.ts')).toEqual(['src/booking/price.ts']);
    });

    it('includes the files whose names start with a dot, and does not mind the case of a glob', () => {
        expect(shown('.*')).toEqual(['.env.example']);
        expect(shown('.github/**')).toEqual(['.github/workflows/ci.yml']);
        expect(shown('*.example')).toEqual(['.env.example']);
        expect(shown('*.md')).toContain('docs/api/Reference.MD');
        expect(shown('SRC/BOOKING/*.TS')).toEqual(['src/booking/price.ts', 'src/booking/price.test.ts', 'src/booking/weekend.ts']);
    });

    it('reads a set of characters, a negated one, and a backslash', () => {
        expect(shown('*.[tj]s')).toEqual(['src/booking/price.ts', 'src/booking/price.test.ts', 'src/booking/weekend.ts', 'src/index.test.ts']);
        expect(shown('*.[!t]s*')).toEqual([]);
        expect(shown('[a-p]rice.ts')).toEqual(['src/booking/price.ts']);
        expect(shown('[!a-o]rice.ts')).toEqual(['src/booking/price.ts']);
        expect(shown('price\\.t?')).toEqual(['src/booking/price.ts']);
        expect(shown('\\*.md')).toEqual([]);
        // An escaped star or question mark is that character, and not a run of the one before it.
        expect(filterChanged([{ path: 'a/x*.txt' }, { path: 'a/x.txt' }, { path: 'a/xx.txt' }], 'x\\*.txt').map(item => item.path)).toEqual(['a/x*.txt']);
        expect(filterChanged([{ path: 'a/x?.txt' }, { path: 'a/xy.txt' }], 'x\\?.txt').map(item => item.path)).toEqual(['a/x?.txt']);
        // A `[` that nothing closes is a bracket.
        expect(shown('[x*')).toEqual([]);
        expect(filterChanged([{ path: 'a/[x.txt' }, { path: 'a/x.txt' }], '*[x*').map(item => item.path)).toEqual(['a/[x.txt']);
    });

    it('takes every character that is not a glob character as itself, and keeps a slash between folders', () => {
        const matches = (glob: string, path: string) => compileGlob(glob)!(path);

        for (const special of ['.', '+', '^', '$', '{', '}', '(', ')', '|', ']', '-', '/']) {
            expect(matches(`a${ special }*`, `a${ special }b`)).toBe(true);
            expect(matches(`a${ special }*`, `ax${ special }b`)).toBe(false);
        }

        expect(matches('src/*', 'src/a/b.ts')).toBe(false);
        expect(matches('src/**', 'src/a/b.ts')).toBe(true);
        expect(matches('a/**/b', 'a/b')).toBe(true);
        expect(matches('a/**/b', 'a/x/y/b')).toBe(true);
        expect(matches('a/**/b', 'a/xb')).toBe(false);
        expect(matches('a?b', 'a/b')).toBe(false);
        // A path that starts or ends with the characters a path may.
        expect(matches('.github/*/*.yml', '.github/workflows/ci.yml')).toBe(true);
        expect(matches('src/(app)/*', 'src/(app)/page.tsx')).toBe(true);
    });

    it('answers in the time of the path whatever the pattern, so a long path and many stars do not stop the window', () => {
        const flat = 'a'.repeat(2000);
        const deep = `${ 'a/'.repeat(1000) }x`;

        // Each of these made a regular expression backtrack for seconds to minutes; they are a few steps for each character here.
        expect(compileChangeFilter('a*a*a*a*b').matches(flat)).toBe(false);
        expect(compileChangeFilter('*a*a*a*a*a*b').matches(flat)).toBe(false);
        expect(compileChangeFilter('**/**/**/*b').matches(deep)).toBe(false);
        expect(compileChangeFilter('a/**/**/**/**/**/y').matches(deep)).toBe(false);
        expect(compileChangeFilter('**a**a**a**a**b').matches(flat)).toBe(false);
        expect(compileChangeFilter('a*a*a*a*a').matches(flat)).toBe(true);
        expect(compileChangeFilter('**/**/**/*').matches(deep)).toBe(true);
        expect(compileChangeFilter('a/**/**/**/x').matches(deep)).toBe(true);
    });

    it('falls back to the text itself for a glob that is no expression', () => {
        expect(compileGlob('[z-a]')).toBeUndefined();
        expect(filterChanged([{ path: 'a/[z-a].txt' }, { path: 'a/z.txt' }], '[z-a]').map(item => item.path)).toEqual(['a/[z-a].txt']);
    });

    it('leaves out what a pattern with a bang matches', () => {
        expect(shown('!*.md')).toEqual(PATHS.filter(path => !/\.md$/i.test(path)));
        expect(shown('!docs/**')).toEqual(PATHS.filter(path => !path.startsWith('docs/')));
        expect(shown('!price')).toEqual(PATHS.filter(path => !path.includes('price')));
        expect(shown('! *.md')).toEqual(shown('!*.md'));
    });

    it('takes some pattern to include and every bang to leave out', () => {
        expect(shown('src/**, !*.test.ts')).toEqual(['src/booking/price.ts', 'src/booking/weekend.ts', 'src/ui/Button.tsx']);
        expect(shown('*.md, *.png')).toEqual(['README.md', 'docs/guide.md', 'docs/api/Reference.MD', 'packages/docs/readme.md', 'assets/logo.png']);
        expect(shown('*.md, !docs/**, !packages/**')).toEqual(['README.md']);
        // A bang names what it leaves out whatever its place in the list.
        expect(shown('!*.test.ts, src/**')).toEqual(shown('src/**, !*.test.ts'));
    });

    it('ignores the empty parts of a list, a trailing comma included', () => {
        expect(shown('price,')).toEqual(shown('price'));
        expect(shown(',price,,')).toEqual(shown('price'));
        expect(shown('*.md,!docs/**,')).toEqual(['README.md', 'packages/docs/readme.md']);
        expect(shown('price, ')).toEqual(shown('price'));
    });

    it('is a filter of paths only, and keeps the order and the other fields of what it gets', () => {
        const files = [{ path: 'b.md', kind: 'added' }, { path: 'a.ts', kind: 'modified' }, { path: 'c.md', kind: 'deleted' }];

        expect(filterChanged(files, '*.md')).toEqual([{ path: 'b.md', kind: 'added' }, { path: 'c.md', kind: 'deleted' }]);
    });

    it('says whether a path passes, for a filter built once', () => {
        const filter = compileChangeFilter('src/**, !*.test.ts');

        expect(filter.isEmpty).toBe(false);
        expect(filter.matches('src/a.ts')).toBe(true);
        expect(filter.matches('src/a.test.ts')).toBe(false);
        expect(filter.matches('docs/a.ts')).toBe(false);
    });
});

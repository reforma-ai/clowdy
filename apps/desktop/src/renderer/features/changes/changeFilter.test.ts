import { describe, expect, it } from 'vitest';

import { compileChangeFilter, filterChanged } from './changeFilter';

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
const shown = (text: string) =>
    filterChanged(
        PATHS.map(path => ({ path })),
        text
    ).map(item => item.path);

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
        expect(shown('*.md')).toEqual([
            'README.md',
            'docs/guide.md',
            'docs/api/Reference.MD',
            'packages/docs/readme.md',
        ]);
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

    it('lets `**/` stand for no folder at all, and a `**` of its own for any folders', () => {
        expect(shown('src/**/index.test.ts')).toEqual(['src/index.test.ts']);
        // Case apart, `**/` finds the file at the top and in any folder.
        expect(shown('**/README.md')).toEqual(['README.md', 'packages/docs/readme.md']);
        expect(shown('src/***/price.ts')).toEqual(['src/booking/price.ts']);
        // A `**` that shares its part of the path with other characters is a `*`, as in every glob: it does not cross a slash.
        expect(shown('src/**.ts')).toEqual(['src/index.test.ts']);
        expect(shown('src/**/**.ts')).toEqual([
            'src/booking/price.ts',
            'src/booking/price.test.ts',
            'src/booking/weekend.ts',
            'src/index.test.ts',
        ]);
    });

    it('includes the files whose names start with a dot, and does not mind the case of a glob', () => {
        expect(shown('.*')).toEqual(['.env.example']);
        expect(shown('.github/**')).toEqual(['.github/workflows/ci.yml']);
        expect(shown('*.example')).toEqual(['.env.example']);
        expect(shown('*.md')).toContain('docs/api/Reference.MD');
        expect(shown('SRC/BOOKING/*.TS')).toEqual([
            'src/booking/price.ts',
            'src/booking/price.test.ts',
            'src/booking/weekend.ts',
        ]);
    });

    it('reads a set of characters, a negated one, and a backslash', () => {
        expect(shown('*.[tj]s')).toEqual([
            'src/booking/price.ts',
            'src/booking/price.test.ts',
            'src/booking/weekend.ts',
            'src/index.test.ts',
        ]);
        expect(shown('*.[!t]s*')).toEqual([]);
        expect(shown('[a-p]rice.ts')).toEqual(['src/booking/price.ts']);
        expect(shown('[!a-o]rice.ts')).toEqual(['src/booking/price.ts']);
        expect(shown('price\\.t?')).toEqual(['src/booking/price.ts']);
        expect(shown('\\*.md')).toEqual([]);
        // An escaped star or question mark is that character, and not a run of the one before it.
        expect(
            filterChanged([{ path: 'a/x*.txt' }, { path: 'a/x.txt' }, { path: 'a/xx.txt' }], 'x\\*.txt').map(
                item => item.path
            )
        ).toEqual(['a/x*.txt']);
        expect(filterChanged([{ path: 'a/x?.txt' }, { path: 'a/xy.txt' }], 'x\\?.txt').map(item => item.path)).toEqual([
            'a/x?.txt',
        ]);
        // A `[` that nothing closes is a bracket.
        expect(shown('[x*')).toEqual([]);
        expect(filterChanged([{ path: 'a/[x.txt' }, { path: 'a/x.txt' }], '*[x*').map(item => item.path)).toEqual([
            'a/[x.txt',
        ]);
    });

    it('takes every character that is not a glob character as itself, and keeps a slash between folders', () => {
        const matches = (glob: string, path: string) => compileChangeFilter(glob).matches(path);

        for (const special of ['.', '+', '^', '$', '{', '}', '(', ')', '|', ']', '-', '/']) {
            expect(matches(`a${special}*`, `a${special}b`)).toBe(true);
            expect(matches(`a${special}*`, `ax${special}b`)).toBe(false);
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

    it('reads no braces, no extended patterns and no leading `!` or `#` of a glob: they are their own characters', () => {
        const names = (text: string) =>
            filterChanged(
                [
                    { path: 'a/{x,y}.ts' },
                    { path: 'a/x.ts' },
                    { path: 'a/+(x|y).ts' },
                    { path: 'a/#x.ts' },
                    { path: 'a/!x.ts' },
                ],
                text
            ).map(item => item.path);

        expect(names('{x,y}.*')).toEqual(['a/{x,y}.ts']);
        expect(names('+(x|y).*')).toEqual(['a/+(x|y).ts']);
        expect(names('#x.*')).toEqual(['a/#x.ts']);
        // The first `!` is the filter's, and a second one is a character of the glob.
        expect(names('!!x.*')).toEqual(['a/{x,y}.ts', 'a/x.ts', 'a/+(x|y).ts', 'a/#x.ts']);
        expect(names('!x.*')).toEqual(['a/{x,y}.ts', 'a/+(x|y).ts', 'a/#x.ts', 'a/!x.ts']);
    });

    it('takes a glob that is a character set that cannot match as a set that matches nothing', () => {
        expect(filterChanged([{ path: 'a/[z-a].txt' }, { path: 'a/z.txt' }], '[z-a]').map(item => item.path)).toEqual(
            []
        );
        expect(
            filterChanged([{ path: 'a/[z-a].txt' }, { path: 'a/z.txt' }], '*[z-a].txt').map(item => item.path)
        ).toEqual([]);
    });

    describe('answers in good time whatever is typed and however long the path is, so the window does not stop', () => {
        // The longest name a file system has, and a path of folders of that length, 2049 characters in all.
        const longName = 'a'.repeat(255);
        const longPath = `${`${longName}/`.repeat(8)}x`;
        const flat = 'a'.repeat(2000);
        const deep = `${'a/'.repeat(1000)}x`;
        const alternating = `${'a/c/'.repeat(500)}b`;
        // Each of these made the regular expression of the first version take seconds to minutes (`*a*a*a*a*a*b` on 100 characters: 4.6 s; `a*a*a*a*b` on 2000: over 8 s;
        // `**/**/**/*b` on 2000 characters of folders: 1.6 s); the automaton after it took 1 to 8 ms; `minimatch` alone takes 2 s for the first and more than a minute for the second.
        const cases: Array<[text: string, path: string, matches: boolean]> = [
            // More than three runs of stars in a part of the path: the glob is read as a piece of the path, which is not in the path.
            ['*a*a*a*a*a*b', 'a'.repeat(100), false],
            ['a*a*a*a*b', flat, false],
            ['*a*a*a*a*a*b', flat, false],
            ['**a**a**a**a**b', flat, false],
            ['a*a*a*a*a', flat, false],
            ['a*a*a*a*a*a*a*a*a*b', flat, false],
            ['a/*a*a*a*a*b', `a/${longName}`, false],
            // Three runs of stars or fewer, on the longest name a file system has, and two on a name that no file system has.
            ['a*a*a*b', longName, false],
            ['*a*a*b', longName, false],
            ['a*a*a*', longName, true],
            ['a*a*b', flat, false],
            ['*a*a*', flat, true],
            ['a*a*a*b/a*a*a*b/a*a*a*b/a*a*a*b/a*a*a*b/a*a*a*b/a*a*a*b/a*a*a*b/x', longPath, false],
            ['a*a*a*/a*a*a*/a*a*a*/a*a*a*/a*a*a*/a*a*a*/a*a*a*/a*a*a*/x', longPath, true],
            // Folders: a `**` of its own is no run of stars, and many of them do not make `minimatch` try the path again.
            ['**/**/**/*b', deep, false],
            ['a/**/**/**/**/**/y', deep, false],
            ['**/**/**/*', deep, true],
            ['a/**/**/**/x', deep, true],
            ['a/**/a/**/a/**/a/**/a/**/a/**/a/**/a/**/c/x', deep, false],
            ['**/a/**/c/**/a/**/c/**/a/**/c/**/a/**/c/**/x/b', alternating, false],
            ['**/c/**/c/**/c/**/c/**/c/**/c/**/c/**/c/**/c/**/b', alternating, true],
            ['**/a/*/**/a/*/**/a/*/**/a/*/**/a/*/**/x/b', alternating, false],
        ];

        it.each(cases)('%j is answered in under 250 ms (case %#)', (text, path, expected) => {
            const start = performance.now();
            const result = compileChangeFilter(text).matches(path);
            const took = performance.now() - start;

            expect(result).toBe(expected);
            expect(took).toBeLessThan(250);
        });

        it('reads a glob with more than three runs of stars in a part of the path as a piece of the path', () => {
            const names = (text: string) =>
                filterChanged(
                    [{ path: 'src/a*b*c*d*e.ts' }, { path: 'src/abcde.ts' }, { path: 'src/ABCDE.ts' }],
                    text
                ).map(item => item.path);

            // Four runs: the text itself, stars and all.
            expect(names('a*b*c*d*e')).toEqual(['src/a*b*c*d*e.ts']);
            expect(names('*b*c*d*')).toEqual(['src/a*b*c*d*e.ts']);
            // Three runs are a glob.
            expect(names('*b*c*')).toEqual(['src/a*b*c*d*e.ts', 'src/abcde.ts', 'src/ABCDE.ts']);
            expect(names('a*c*e.ts')).toEqual(['src/a*b*c*d*e.ts', 'src/abcde.ts', 'src/ABCDE.ts']);
        });

        it('counts the runs of stars of each part of the path alone', () => {
            const found = (text: string) =>
                filterChanged([{ path: 'src/abc/x.ts' }, { path: 'src/ac/x.ts' }, { path: 'lib/abc/y.js' }], text).map(
                    item => item.path
                );

            expect(found('src/*b*c*/*.ts')).toEqual(['src/abc/x.ts']);
            expect(found('*/*b*c*/*.*')).toEqual(['src/abc/x.ts', 'lib/abc/y.js']);
        });
    });

    it('leaves out what a pattern with a bang matches', () => {
        expect(shown('!*.md')).toEqual(PATHS.filter(path => !/\.md$/i.test(path)));
        expect(shown('!docs/**')).toEqual(PATHS.filter(path => !path.startsWith('docs/')));
        expect(shown('!price')).toEqual(PATHS.filter(path => !path.includes('price')));
        expect(shown('! *.md')).toEqual(shown('!*.md'));
    });

    it('takes some pattern to include and every bang to leave out', () => {
        expect(shown('src/**, !*.test.ts')).toEqual([
            'src/booking/price.ts',
            'src/booking/weekend.ts',
            'src/ui/Button.tsx',
        ]);
        expect(shown('*.md, *.png')).toEqual([
            'README.md',
            'docs/guide.md',
            'docs/api/Reference.MD',
            'packages/docs/readme.md',
            'assets/logo.png',
        ]);
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
        const files = [
            { path: 'b.md', kind: 'added' },
            { path: 'a.ts', kind: 'modified' },
            { path: 'c.md', kind: 'deleted' },
        ];

        expect(filterChanged(files, '*.md')).toEqual([
            { path: 'b.md', kind: 'added' },
            { path: 'c.md', kind: 'deleted' },
        ]);
    });

    it('says whether a path passes, for a filter built once', () => {
        const filter = compileChangeFilter('src/**, !*.test.ts');

        expect(filter.isEmpty).toBe(false);
        expect(filter.matches('src/a.ts')).toBe(true);
        expect(filter.matches('src/a.test.ts')).toBe(false);
        expect(filter.matches('docs/a.ts')).toBe(false);
    });
});

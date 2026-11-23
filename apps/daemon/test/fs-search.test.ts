import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_FS_QUERY_LENGTH, MAX_FS_SEARCH_LINES_PER_FILE, MAX_FS_SEARCH_MATCHES } from '@clowdy/protocol';

import { loadConfig } from '../src/config';
import { CommandError } from '../src/errors';
import { ContentSearch } from '../src/fs/search';
import { Collector } from '../src/fs/search-collect';
import { RipgrepLocator } from '../src/fs/search-ripgrep';
import { PathFilter, queryMatcher } from '../src/fs/search-rules';
import { scanSearch } from '../src/fs/search-scan';
import { openFolder, put } from './fs-helpers';
import { cleanTempDirs, git, Harness, startHarness, tempDir, waitFor } from './helpers';

import type { FsSearchRequest, FsSearchResult } from '@clowdy/protocol';

afterAll(cleanTempDirs);

const RG = Bun.which('rg');
const POSIX = process.platform !== 'win32';

type Engine = 'scan' | 'ripgrep';
type Query = Omit<FsSearchRequest, 'folderId'>;

/** A folder of real files, by its real path (a search is given the path the daemon resolved). */
function folder(files: Record<string, string | Uint8Array> = {}): string {
    const dir = realpathSync(tempDir('search'));

    put(dir, files);

    return dir;
}

/** Shell programs that stand in for ripgrep. */
function script(body: string): string {
    const path = join(tempDir('fake-rg'), 'rg');

    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);

    return path;
}

const SUMMARY = '{"type":"summary","data":{}}';
const matchEvent = (
    root: string,
    path: string,
    line: number,
    text: string,
    submatches: Array<{ start: number; end: number }>
) =>
    JSON.stringify({
        type: 'match',
        data: { path: { text: join(root, path) }, lines: { text }, line_number: line, absolute_offset: 0, submatches },
    });

/** A program that prints these lines of output (one `printf` each, so nothing is read as a format) and exits with `code`. */
const printing = (lines: string[], code = 0) =>
    script(`${lines.map(line => `printf '%s\\n' '${line.replaceAll("'", "'\\''")}'`).join('\n')}\nexit ${code}`);

async function refused(promise: Promise<unknown>): Promise<CommandError> {
    const error = await promise.then(
        () => undefined,
        (caught: unknown) => caught
    );

    expect(error).toBeInstanceOf(CommandError);

    return error as CommandError;
}

const lineNumbers = (result: FsSearchResult) =>
    result.files.map(file => [file.path, file.matches.map(match => match.line)] as const);
const paths = (result: FsSearchResult) => result.files.map(file => file.path);
const count = (result: FsSearchResult) => result.files.reduce((total, file) => total + file.matches.length, 0);

function engineSuite(engine: Engine) {
    const find = async (root: string, query: Query): Promise<FsSearchResult> => {
        const search = new ContentSearch({ ripgrep: engine === 'scan' ? false : undefined });
        const result = await search.search(root, query);

        // The test is about the engine it says: a ripgrep that was not used would pass for it.
        expect(search.lastEngine).toBe(engine);

        return result;
    };

    test('finds the literal text with its line, column, preview and ranges; files in path order, lines in file order', async () => {
        const root = folder({
            'b.txt': 'nothing\nthe Needle and the needle\n',
            'a/z.txt': 'needle first\n',
            'a.txt': 'x\n\nneedle\n',
            'a/b/deep.txt': 'a needle\nno\nneedle needle\n',
        });
        const result = await find(root, { query: 'needle' });

        expect(result.truncated).toBe(false);
        // A folder comes before the files whose names it is the start of, as in the listing.
        expect(lineNumbers(result)).toEqual([
            ['a/b/deep.txt', [1, 3]],
            ['a/z.txt', [1]],
            ['a.txt', [3]],
            ['b.txt', [2]],
        ]);
        expect(result.files[2]!.matches[0]).toEqual({
            line: 3,
            column: 1,
            preview: 'needle',
            ranges: [{ start: 0, end: 6 }],
        });
        expect(result.files[0]!.matches[1]).toEqual({
            line: 3,
            column: 1,
            preview: 'needle needle',
            ranges: [
                { start: 0, end: 6 },
                { start: 7, end: 13 },
            ],
        });
        expect(result.files[3]!.matches[0]).toEqual({
            line: 2,
            column: 5,
            preview: 'the Needle and the needle',
            ranges: [
                { start: 4, end: 10 },
                { start: 19, end: 25 },
            ],
        });
    });

    test('answers nothing for text that is not there, and for a folder with no files', async () => {
        expect(await find(folder({ 'a.txt': 'abc' }), { query: 'zzz' })).toEqual({ files: [], truncated: false });
        expect(await find(folder(), { query: 'zzz' })).toEqual({ files: [], truncated: false });
    });

    test('ignores case unless asked to match it', async () => {
        const root = folder({ 'a.txt': 'Hello\nhello\nHELLO\n' });

        expect(lineNumbers(await find(root, { query: 'hello' }))).toEqual([['a.txt', [1, 2, 3]]]);
        expect(lineNumbers(await find(root, { query: 'hello', matchCase: false }))).toEqual([['a.txt', [1, 2, 3]]]);
        expect(lineNumbers(await find(root, { query: 'hello', matchCase: true }))).toEqual([['a.txt', [2]]]);
        expect(lineNumbers(await find(root, { query: 'Hello', matchCase: true }))).toEqual([['a.txt', [1]]]);
    });

    test('folds case the Unicode way, and counts a letter with an accent as part of a word', async () => {
        const root = folder({ 'a.txt': 'schön ÄÖÜ äöü\nwörlds wörld\nwörld\n' });
        const folded = await find(root, { query: 'äöü' });

        expect(folded.files[0]!.matches[0]!.ranges).toEqual([
            { start: 6, end: 9 },
            { start: 10, end: 13 },
        ]);
        expect(await find(root, { query: 'ÄÖÜ', matchCase: true })).toMatchObject({
            files: [{ matches: [{ ranges: [{ start: 6, end: 9 }] }] }],
        });

        const words = await find(root, { query: 'wörld', wholeWord: true });

        expect(words.files[0]!.matches.map(match => [match.line, match.ranges])).toEqual([
            [2, [{ start: 7, end: 12 }]],
            [3, [{ start: 0, end: 5 }]],
        ]);
        // `rld` follows the letter ö, which is a word character here.
        expect(await find(root, { query: 'rld', wholeWord: true })).toEqual({ files: [], truncated: false });
    });

    test('matches whole words only with wholeWord', async () => {
        const root = folder({ 'a.txt': 'cat\nconcat\ncats\na cat.\ncat_x\nthe-cat-sat\n(cat)\n' });

        expect(lineNumbers(await find(root, { query: 'cat' }))).toEqual([['a.txt', [1, 2, 3, 4, 5, 6, 7]]]);
        expect(lineNumbers(await find(root, { query: 'cat', wholeWord: true }))).toEqual([['a.txt', [1, 4, 6, 7]]]);
        expect(lineNumbers(await find(root, { query: 'CAT', wholeWord: true, matchCase: true }))).toEqual([]);
    });

    test('takes the query literally, special characters included', async () => {
        const root = folder({ 'a.txt': 'a.*(b\nplain\n[x] a|b $5 \\d+ ^start ?\nfoo(bar)\n(\n' });
        const lines = async (query: string, options: Partial<Query> = {}) =>
            (await find(root, { query, ...options })).files.flatMap(file => file.matches.map(match => match.line));

        expect(await lines('.*(')).toEqual([1]);
        expect(await lines('[x]')).toEqual([3]);
        expect(await lines('a|b')).toEqual([3]);
        expect(await lines('$5')).toEqual([3]);
        expect(await lines('\\d+')).toEqual([3]);
        expect(await lines('^start')).toEqual([3]);
        expect(await lines('(')).toEqual([1, 4, 5]);
        expect(await lines('foo(bar)', { wholeWord: true })).toEqual([4]);
        // A pattern would find `plain`.
        expect(await lines('pl.in')).toEqual([]);
        expect(await lines('a.b')).toEqual([]);
    });

    test('a query that starts with a dash is text, not a flag', async () => {
        const root = folder({ 'a.txt': 'run --help now\n-x here\n--version\n-e\n' });
        const lines = async (query: string) =>
            (await find(root, { query })).files.flatMap(file => file.matches.map(match => match.line));

        expect(await lines('-x')).toEqual([2]);
        expect(await lines('--help')).toEqual([1]);
        expect(await lines('--version')).toEqual([3]);
        expect(await lines('-e')).toEqual([4]);
        expect(await lines('-')).toEqual([1, 2, 3, 4]);
    });

    test('keeps a hundred lines of a file and says so when it had more', async () => {
        const hundred = Array.from({ length: MAX_FS_SEARCH_LINES_PER_FILE }, (_, index) => `needle ${index + 1}`).join(
            '\n'
        );
        const cut = await find(folder({ 'a.txt': `${hundred}\nneedle 101\nneedle 102\n`, 'b.txt': 'needle\n' }), {
            query: 'needle',
        });

        expect(cut.truncated).toBe(true);
        expect(cut.files.map(file => file.matches.length)).toEqual([MAX_FS_SEARCH_LINES_PER_FILE, 1]);
        expect(cut.files[0]!.matches.map(match => match.line)).toEqual(
            Array.from({ length: MAX_FS_SEARCH_LINES_PER_FILE }, (_, index) => index + 1)
        );

        // A file with exactly that many is not cut, and a line with several matches counts once.
        const exact = await find(folder({ 'a.txt': `${hundred}\n`, 'b.txt': 'needle needle needle\n' }), {
            query: 'needle',
        });

        expect(exact.truncated).toBe(false);
        expect(exact.files.map(file => file.matches.length)).toEqual([MAX_FS_SEARCH_LINES_PER_FILE, 1]);
    });

    test('stops at the cap of matches over all files, keeping the first files, and says so', async () => {
        const full = Array.from({ length: MAX_FS_SEARCH_LINES_PER_FILE }, () => 'needle').join('\n');
        const files = (many: number) =>
            Object.fromEntries(
                Array.from({ length: many }, (_, index) => [`f${String(index + 1).padStart(3, '0')}.txt`, `${full}\n`])
            );
        const filesFull = MAX_FS_SEARCH_MATCHES / MAX_FS_SEARCH_LINES_PER_FILE;
        const cut = await find(folder(files(filesFull + 1)), { query: 'needle' });

        expect(cut.truncated).toBe(true);
        expect(count(cut)).toBe(MAX_FS_SEARCH_MATCHES);
        expect(paths(cut)).toEqual(Object.keys(files(filesFull)));

        const exact = await find(folder(files(filesFull)), { query: 'needle' });

        expect(exact.truncated).toBe(false);
        expect(count(exact)).toBe(MAX_FS_SEARCH_MATCHES);
    });

    test('never looks in .git, node_modules, .clowdy, lock files, minified files and source maps; it does in dotfiles', async () => {
        const root = folder(
            Object.fromEntries(
                [
                    'a.txt',
                    '.env',
                    '.config/settings',
                    'app.min.jsx',
                    'min.js',
                    'gitx',
                    'notes.lock',
                    '.git/config',
                    'node_modules/pkg/index.js',
                    'src/node_modules/x.js',
                    'sub/.git/config',
                    '.clowdy/doc.md',
                    '.clowdy/deep/doc.md',
                    'sub/.clowdy/doc.md',
                    'bun.lock',
                    'package-lock.json',
                    'yarn.lock',
                    'pnpm-lock.yaml',
                    'npm-shrinkwrap.json',
                    'sub/yarn.lock',
                    'app.min.js',
                    'x/app.min.css',
                    'app.js.map',
                    'x/y.css.map',
                ].map(path => [path, 'a needle\n'])
            )
        );

        expect(paths(await find(root, { query: 'needle' }))).toEqual([
            '.config/settings',
            '.env',
            'a.txt',
            'app.min.jsx',
            'gitx',
            'min.js',
            'notes.lock',
        ]);
    });

    test("leaves out the request's excludes: globs of files and folders, anywhere or from the top", async () => {
        const root = folder(
            Object.fromEntries(
                [
                    'src/a.ts',
                    'src/b.log',
                    'src/deep/c.ts',
                    'dist/out.js',
                    'a/dist/out.js',
                    'docs/readme.md',
                    'notes/docs/readme.md',
                    'keep.txt',
                    'logs.txt',
                    'gen/x.ts',
                    'src/gen/y.ts',
                    'file/gen',
                ].map(path => [path, 'needle\n'])
            )
        );
        const all = [
            'a/dist/out.js',
            'dist/out.js',
            'docs/readme.md',
            'file/gen',
            'gen/x.ts',
            'keep.txt',
            'logs.txt',
            'notes/docs/readme.md',
            'src/a.ts',
            'src/b.log',
            'src/deep/c.ts',
            'src/gen/y.ts',
        ];
        const rest = async (exclude: string[]) => paths(await find(root, { query: 'needle', exclude }));
        const without = (...gone: string[]) => all.filter(path => !gone.includes(path));

        expect(await rest([])).toEqual(all);
        expect(await rest(['*.log'])).toEqual(without('src/b.log'));
        expect(await rest(['dist'])).toEqual(without('dist/out.js', 'a/dist/out.js'));
        expect(await rest(['/dist'])).toEqual(without('dist/out.js'));
        expect(await rest(['/docs'])).toEqual(without('docs/readme.md'));
        expect(await rest(['docs/'])).toEqual(without('docs/readme.md', 'notes/docs/readme.md'));
        expect(await rest(['src/*.ts'])).toEqual(without('src/a.ts'));
        expect(await rest(['src/**'])).toEqual(without('src/a.ts', 'src/b.log', 'src/deep/c.ts', 'src/gen/y.ts'));
        expect(await rest(['**/gen'])).toEqual(without('gen/x.ts', 'src/gen/y.ts', 'file/gen'));
        expect(await rest(['gen/'])).toEqual(without('gen/x.ts', 'src/gen/y.ts'));
        expect(await rest(['{keep,logs}.txt'])).toEqual(without('keep.txt', 'logs.txt'));
        expect(await rest(['READMe.md'])).toEqual(all);
        expect(await rest(['*.log', 'dist', '/docs', 'gen/'])).toEqual(
            without('src/b.log', 'dist/out.js', 'a/dist/out.js', 'docs/readme.md', 'gen/x.ts', 'src/gen/y.ts')
        );
    });

    test('reads .gitignore in a repository, and searches what git does not know yet', async () => {
        const root = folder({
            '.gitignore': 'ignored.txt\nbuild/\n*.tmp\n!keep.tmp\n',
            'tracked.txt': 'needle\n',
            'ignored.txt': 'needle\n',
            'build/out.js': 'needle\n',
            'sub/build/out.js': 'needle\n',
            'x.tmp': 'needle\n',
            'sub/new.txt': 'needle\n',
        });

        git(root, 'init', '-q');
        git(root, 'add', 'tracked.txt', '.gitignore');
        writeFileSync(join(root, 'late.txt'), 'needle\n');

        expect(paths(await find(root, { query: 'needle' }))).toEqual(['late.txt', 'sub/new.txt', 'tracked.txt']);
    });

    test('searches a repository inside the folder, which git lists as one entry', async () => {
        const root = folder({
            'a.txt': 'needle\n',
            'vendor/lib/x.txt': 'needle\n',
            'vendor/lib/node_modules/y.txt': 'needle\n',
            'vendor/lib/.clowdy/z.txt': 'needle\n',
        });

        git(root, 'init', '-q');
        git(join(root, 'vendor', 'lib'), 'init', '-q');

        expect(paths(await find(root, { query: 'needle' }))).toEqual(['a.txt', 'vendor/lib/x.txt']);
    });

    test('keeps a long line to the part around its first match, with the ranges that fall in it', async () => {
        const long = `${'x'.repeat(500)}NEEDLE${'y'.repeat(100)}needle${'z'.repeat(600)}needle`;
        const result = await find(folder({ 'a.txt': `${long}\n`, 'b.txt': `short NEEDLE and ${'q'.repeat(300)}\n` }), {
            query: 'needle',
        });
        const [a, b] = result.files.map(file => file.matches[0]!);

        expect(a!.column).toBe(501);
        expect(a!.preview).toHaveLength(250);
        expect(a!.preview).toBe(long.slice(460, 710));
        // The second match is in the preview, the third is not.
        expect(a!.ranges).toEqual([
            { start: 40, end: 46 },
            { start: 146, end: 152 },
        ]);
        expect(a!.preview.slice(40, 46)).toBe('NEEDLE');
        expect(b!.preview).toBe(`short NEEDLE and ${'q'.repeat(300)}`.slice(0, 250));
        expect(b!.ranges).toEqual([{ start: 6, end: 12 }]);

        // A match longer than the preview ends where the preview does.
        const wide = 'w'.repeat(300);
        const [onWide] = (
            await find(folder({ 'a.txt': `${'p'.repeat(200)}${wide}${'p'.repeat(300)}\n` }), { query: wide })
        ).files[0]!.matches;

        expect(onWide!.column).toBe(201);
        expect(onWide!.ranges).toEqual([{ start: 40, end: 250 }]);
    });

    test('never cuts a long line inside an emoji', async () => {
        // The first cut would fall between the halves of the first emoji, the second between the halves of the other.
        const text = `${'x'.repeat(59)}😀${'y'.repeat(39)}needle${'z'.repeat(203)}😀${'z'.repeat(100)}`;
        const [match] = (await find(folder({ 'a.txt': `${text}\n` }), { query: 'needle' })).files[0]!.matches;

        expect(text.charCodeAt(60)).toBeGreaterThanOrEqual(0xdc00);
        expect(text.charCodeAt(309)).toBeLessThan(0xdc00);
        // Text with half of an emoji cannot be encoded.
        expect(() => encodeURIComponent(match!.preview)).not.toThrow();
        expect(match).toMatchObject({ column: 101, ranges: [{ start: 41, end: 47 }] });
        expect(match!.preview).toBe(text.slice(59, 309));
        expect(match!.preview.slice(41, 47)).toBe('needle');
    });

    test('counts columns and ranges in characters of the line, not bytes', async () => {
        const result = await find(folder({ 'a.txt': 'héllo wörld 日本語 😀 Needle straße\n' }), { query: 'needle' });
        const [match] = result.files[0]!.matches;

        // The emoji is two UTF-16 units, as a string of the client counts it.
        expect(match).toEqual({
            line: 1,
            column: 20,
            preview: 'héllo wörld 日本語 😀 Needle straße',
            ranges: [{ start: 19, end: 25 }],
        });
        expect(match!.preview.slice(19, 25)).toBe('Needle');
    });

    test('skips files that are binary, not UTF-8 or over a megabyte; reads the lines that are text in the rest', async () => {
        const megabyte = 1024 * 1024;
        const root = folder({
            'text.txt': 'needle\n',
            'binary.bin': Buffer.from('needle one\nsecond\n\0\nneedle after\n'),
            'nul-first.bin': Buffer.from('\0needle\n'),
            'mixed.txt': Buffer.concat([
                Buffer.from('needle ok\nbad '),
                Buffer.from([0xff, 0xfe]),
                Buffer.from(' needle\nneedle again\n'),
            ]),
            'exact.txt': `needle${'a'.repeat(megabyte - 7)}\n`,
            'over.txt': `needle${'a'.repeat(megabyte - 6)}\n`,
        });
        const result = await find(root, { query: 'needle' });

        expect(lineNumbers(result)).toEqual([
            ['exact.txt', [1]],
            ['mixed.txt', [1, 3]],
            ['text.txt', [1]],
        ]);
        expect(readFileSync(join(root, 'exact.txt')).length).toBe(megabyte);
    });

    test('does not read the line ending, and skips a byte order mark', async () => {
        const root = folder({
            'crlf.txt': 'needle\r\nsecond needle\r\nlast needle\r',
            'bom.txt': Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('needle bom\nneedle\n')]),
        });
        const result = await find(root, { query: 'needle' });

        expect(
            result.files.map(file => [file.path, file.matches.map(match => [match.line, match.column, match.preview])])
        ).toEqual([
            [
                'bom.txt',
                [
                    [1, 1, 'needle bom'],
                    [2, 1, 'needle'],
                ],
            ],
            // A last line that has no line break keeps its own carriage return.
            [
                'crlf.txt',
                [
                    [1, 1, 'needle'],
                    [2, 8, 'second needle'],
                    [3, 6, 'last needle\r'],
                ],
            ],
        ]);
    });

    test('does not follow links', async () => {
        const outside = folder({ 'secret.txt': 'needle\n', 'dir/more.txt': 'needle\n' });
        const root = folder({ 'real.txt': 'needle\n' });

        symlinkSync(join(outside, 'secret.txt'), join(root, 'link.txt'));
        symlinkSync(join(outside, 'dir'), join(root, 'linked-dir'));
        symlinkSync(join(root, 'real.txt'), join(root, 'inner-link.txt'));

        expect(paths(await find(root, { query: 'needle' }))).toEqual(['real.txt']);
    });

    test('finds files as soon as they are written, not as a cached listing has them', async () => {
        const root = folder({ 'a.txt': 'needle\n' });

        expect(paths(await find(root, { query: 'needle' }))).toEqual(['a.txt']);

        put(root, { 'b.txt': 'needle\n' });
        rmSync(join(root, 'a.txt'));

        expect(paths(await find(root, { query: 'needle' }))).toEqual(['b.txt']);
    });
}

describe("content search, the daemon's own scan", () => {
    engineSuite('scan');

    test('stops reading files when the signal fires', async () => {
        const root = folder(
            Object.fromEntries(
                Array.from({ length: 40 }, (_, index) => [`f${String(index).padStart(2, '0')}.txt`, 'needle\n'])
            )
        );
        const collector = new Collector();
        let checks = 0;
        // Fires on the sixth look: the scan looks before every file.
        const signal = Object.defineProperty({} as AbortSignal, 'aborted', { get: () => ++checks > 5 });

        await scanSearch(root, queryMatcher('needle', false, false), new PathFilter([]), collector, signal);

        expect(collector.result().files).toHaveLength(5);
    });

    test('a search aborted before it began answers nothing and does not read the folder', async () => {
        const root = folder({ 'a.txt': 'needle\n' });
        const controller = new AbortController();

        controller.abort();

        const search = new ContentSearch({ ripgrep: false });

        expect(await search.search(root, { query: 'needle' }, controller.signal)).toEqual({
            files: [],
            truncated: true,
        });
        expect(search.active).toBe(0);
    });

    test('a search aborted on the way answers what it has found, cut', async () => {
        const root = folder(
            Object.fromEntries(
                Array.from({ length: 300 }, (_, index) => [`f${String(index).padStart(3, '0')}.txt`, 'needle\n'])
            )
        );
        const search = new ContentSearch({ ripgrep: false });
        const controller = new AbortController();
        const running = search.search(root, { query: 'needle' }, controller.signal);

        // The folder is still being listed.
        setTimeout(() => controller.abort(), 0);

        const result = await running;

        expect(result.truncated).toBe(true);
        expect(count(result)).toBeLessThan(300);
        expect(search.active).toBe(0);
    });
});

describe(
    RG ? 'content search with ripgrep' : 'content search with ripgrep (skipped: there is no rg on the PATH)',
    () => {
        if (!RG) {
            test.skip('needs rg on the PATH', () => undefined);

            return;
        }

        engineSuite('ripgrep');

        test('refuses an exclude glob that ripgrep cannot parse', async () => {
            const search = new ContentSearch();
            const error = await refused(
                search.search(folder({ 'a.txt': 'needle' }), { query: 'needle', exclude: ['['] })
            );

            expect(error.code).toBe('invalid');
            expect(error.message).toMatch(/glob/);
            expect(error.message).not.toMatch(/\.$/);
        });

        test('is not thrown off by a ripgrep configuration file of the person', async () => {
            const config = join(tempDir('rg-config'), 'rgrc');

            writeFileSync(config, '--case-sensitive\n--no-ignore\n--max-count=1\n');
            process.env.RIPGREP_CONFIG_PATH = config;

            try {
                const search = new ContentSearch();
                const result = await search.search(folder({ 'a.txt': 'Needle\nneedle\n' }), { query: 'needle' });

                expect(lineNumbers(result)).toEqual([['a.txt', [1, 2]]]);
            } finally {
                delete process.env.RIPGREP_CONFIG_PATH;
            }
        });
    }
);

describe('both engines answer alike', () => {
    test.skipIf(!RG)('on a tree with a bit of everything (ripgrep skipped without rg on the PATH)', async () => {
        const root = folder({
            'a.txt': 'Needle here\nand needle there\nNEEDLEs\n',
            'src/app.ts': 'const needle = 1; // needle\n',
            'src/deep/er/x.ts': `${'n'.repeat(400)} needle\n`,
            'docs/ünï.md': 'Ünïcode needle ünï\n',
            '.hidden/h.txt': 'needle\n',
            'big.txt': `${Array.from({ length: 150 }, (_, index) => `needle ${index}`).join('\n')}\n`,
            'node_modules/x/y.js': 'needle\n',
            'a.min.js': 'needle\n',
            'blob.bin': Buffer.from([0, 1, 2, 110, 101, 101, 100, 108, 101]),
        });

        for (const query of [
            { query: 'needle' },
            { query: 'needle', matchCase: true },
            { query: 'needle', wholeWord: true },
            { query: 'ünï' },
            { query: 'Ünï', matchCase: true },
            { query: 'needle', exclude: ['docs', '*.ts'] },
        ]) {
            const scan = await new ContentSearch({ ripgrep: false }).search(root, query);
            const ripgrep = await new ContentSearch().search(root, query);

            expect(scan).toEqual(ripgrep);
            expect(count(scan)).toBeGreaterThan(0);
        }
    });
});

describe('content search requests', () => {
    const search = new ContentSearch({ ripgrep: false });
    const root = folder({ 'a.txt': 'needle' });
    const problem = async (query: Query) => (await refused(search.search(root, query))).message;

    test('are checked: the text is one line, not empty and not over the limit', async () => {
        expect((await refused(search.search(root, { query: '' }))).code).toBe('invalid');
        expect(await problem({ query: '' })).toBe('The search text is empty');
        expect(await problem({ query: 'a'.repeat(MAX_FS_QUERY_LENGTH + 1) })).toBe(
            `The search text is over ${MAX_FS_QUERY_LENGTH} characters`
        );
        expect(await problem({ query: 'one\ntwo' })).toBe('The search text must be one line of text');
        expect(await problem({ query: 'one\rtwo' })).toBe('The search text must be one line of text');
        expect(await problem({ query: 'one\0two' })).toBe('The search text must be one line of text');
        expect(paths(await search.search(root, { query: 'n'.repeat(1) }))).toEqual(['a.txt']);
        expect(await search.search(root, { query: 'a'.repeat(MAX_FS_QUERY_LENGTH) })).toEqual({
            files: [],
            truncated: false,
        });
        // Spaces are text.
        expect(await search.search(root, { query: ' ' })).toEqual({ files: [], truncated: false });
    });

    test('are checked: an exclude glob is not empty, not over 500 characters, without NUL and not a negation', async () => {
        expect((await refused(search.search(root, { query: 'n', exclude: [''] }))).code).toBe('invalid');
        expect(await problem({ query: 'n', exclude: ['ok', ''] })).toBe('An exclude glob is empty');
        expect(await problem({ query: 'n', exclude: ['  '] })).toBe('An exclude glob is empty');
        expect(await problem({ query: 'n', exclude: ['a'.repeat(501)] })).toBe(
            'An exclude glob is over 500 characters'
        );
        expect(await problem({ query: 'n', exclude: ['a\0b'] })).toBe('An exclude glob has a NUL character');
        expect(await problem({ query: 'n', exclude: ['!keep'] })).toBe('An exclude glob cannot start with !');
        expect(await problem({ query: 'n', exclude: Array.from({ length: 201 }, (_, index) => `g${index}`) })).toBe(
            'At most 200 exclude globs'
        );
        expect(await problem({ query: 'n', exclude: Array.from({ length: 50 }, () => 'a'.repeat(500)) })).toBe(
            'The exclude globs are over 20000 characters together'
        );
        expect(paths(await search.search(root, { query: 'n', exclude: ['a'.repeat(500), '\\!x'] }))).toEqual(['a.txt']);
    });
});

describe.skipIf(!POSIX)('content search with a ripgrep of its own', () => {
    test('runs the program without a shell: the query follows -e and the folder follows --', async () => {
        const record = join(tempDir('args'), 'args.txt');
        const program = script(
            `for a in "$@"; do printf '%s\\n' "$a" >> '${record}'; done\nprintf '%s\\n' '${SUMMARY}'`
        );
        const root = folder();
        const search = new ContentSearch({ ripgrep: program });

        await search.search(root, { query: '-x $(touch pwned) `id` "q"', wholeWord: true, exclude: ['dist', 'a b'] });

        const args = readFileSync(record, 'utf8').split('\n').slice(0, -1);

        expect(search.lastEngine).toBe('ripgrep');
        expect(args.slice(-4)).toEqual(['-e', '-x $(touch pwned) `id` "q"', '--', root]);
        expect(args).toContain('-F');
        expect(args).toContain('-i');
        expect(args).toContain('-w');
        expect(args).toContain('--hidden');
        expect(args).toContain('--json');
        expect(args).toContain('--no-config');
        expect(args.slice(args.indexOf('--max-filesize'), args.indexOf('--max-filesize') + 2)).toEqual([
            '--max-filesize',
            '1M',
        ]);
        expect(args.slice(args.indexOf('--max-count'), args.indexOf('--max-count') + 2)).toEqual([
            '--max-count',
            String(MAX_FS_SEARCH_LINES_PER_FILE + 1),
        ]);
        expect(args.filter((_arg, index) => args[index - 1] === '-g')).toEqual([
            '!.git',
            '!node_modules',
            '!.clowdy',
            '!bun.lock',
            '!package-lock.json',
            '!yarn.lock',
            '!pnpm-lock.yaml',
            '!npm-shrinkwrap.json',
            '!*.min.js',
            '!*.min.css',
            '!*.map',
            '!dist',
            '!a b',
        ]);
        expect(existsSync(join(process.cwd(), 'pwned'))).toBe(false);

        await search.search(root, { query: 'x', matchCase: true });

        const next = readFileSync(record, 'utf8').split('\n').slice(0, -1).slice(args.length);

        expect(next).toContain('-s');
        expect(next).not.toContain('-i');
        expect(next).not.toContain('-w');
    });

    test('runs where the folder is, so the globs are read from it', async () => {
        const marker = join(tempDir('cwd'), 'cwd.txt');
        const program = script(`pwd -P > '${marker}'\nprintf '%s\\n' '${SUMMARY}'`);
        const root = folder();

        await new ContentSearch({ ripgrep: program }).search(root, { query: 'x' });

        expect(readFileSync(marker, 'utf8').trim()).toBe(root);
    });

    test('turns the events it prints into the result: byte offsets into characters, paths relative with / separators', async () => {
        const root = folder();
        const program = printing([
            matchEvent(root, 'b/y.txt', 2, 'héllo wörld 😀 wörld\n', [
                { start: 7, end: 13 },
                { start: 19, end: 25 },
            ]),
            matchEvent(root, 'b/y.txt', 5, 'line\r\n', [{ start: 0, end: 4 }]),
            matchEvent(root, 'a.txt', 1, 'first needle', [{ start: 6, end: 12 }]),
            SUMMARY,
        ]);
        const result = await new ContentSearch({ ripgrep: program }).search(root, { query: 'x' });

        expect(result).toEqual({
            files: [
                {
                    path: 'a.txt',
                    matches: [{ line: 1, column: 7, preview: 'first needle', ranges: [{ start: 6, end: 12 }] }],
                },
                {
                    path: 'b/y.txt',
                    matches: [
                        {
                            line: 2,
                            column: 7,
                            preview: 'héllo wörld 😀 wörld',
                            ranges: [
                                { start: 6, end: 11 },
                                { start: 15, end: 20 },
                            ],
                        },
                        { line: 5, column: 1, preview: 'line', ranges: [{ start: 0, end: 4 }] },
                    ],
                },
            ],
            truncated: false,
        });
    });

    test('skips lines and paths that ripgrep gives as bytes, and paths outside the folder', async () => {
        const root = folder();
        const bytes = {
            type: 'match',
            data: {
                path: { text: join(root, 'bytes.txt') },
                lines: { bytes: '/w==' },
                line_number: 1,
                submatches: [{ start: 0, end: 1 }],
            },
        };
        const oddPath = {
            type: 'match',
            data: {
                path: { bytes: '/w==' },
                lines: { text: 'x\n' },
                line_number: 1,
                submatches: [{ start: 0, end: 1 }],
            },
        };
        const program = printing([
            JSON.stringify(bytes),
            JSON.stringify(oddPath),
            matchEvent('/elsewhere', 'out.txt', 1, 'x\n', [{ start: 0, end: 1 }]),
            'not json',
            matchEvent(root, 'ok.txt', 1, 'x\n', [{ start: 0, end: 1 }]),
            SUMMARY,
        ]);

        expect(paths(await new ContentSearch({ ripgrep: program }).search(root, { query: 'x' }))).toEqual(['ok.txt']);
    });

    test('keeps what ripgrep found when some files could not be read (exit 2 after the summary)', async () => {
        const root = folder();
        const program = printing([matchEvent(root, 'a.txt', 1, 'x\n', [{ start: 0, end: 1 }]), SUMMARY], 2);

        expect(await new ContentSearch({ ripgrep: program }).search(root, { query: 'x' })).toEqual({
            files: [{ path: 'a.txt', matches: [{ line: 1, column: 1, preview: 'x', ranges: [{ start: 0, end: 1 }] }] }],
            truncated: false,
        });
    });

    test('says invalid when ripgrep refuses the request before it printed anything', async () => {
        const program = script(
            "echo \"rg: error parsing glob '[': unclosed character class; missing ']'.\" >&2\nexit 2"
        );
        const error = await refused(
            new ContentSearch({ ripgrep: program }).search(folder(), { query: 'x', exclude: ['['] })
        );

        expect(error.code).toBe('invalid');
        expect(error.message).toBe(
            "The search was refused: error parsing glob '[': unclosed character class; missing ']'"
        );
    });

    test('keeps what it found when ripgrep dies on the way, and says unavailable when it died before saying anything', async () => {
        const root = folder();
        const died = printing([matchEvent(root, 'a.txt', 1, 'x\n', [{ start: 0, end: 1 }])], 137);
        const result = await new ContentSearch({ ripgrep: died }).search(root, { query: 'x' });

        expect(paths(result)).toEqual(['a.txt']);
        expect(result.truncated).toBe(true);
        expect(
            (await refused(new ContentSearch({ ripgrep: script('exit 137') }).search(root, { query: 'x' }))).code
        ).toBe('unavailable');
    });

    test('falls back to its own scan when the program cannot be started, and tries it again the next time', async () => {
        const root = folder({ 'a.txt': 'needle\n' });
        const program = script('true');

        // A program that names an interpreter which is not there cannot be started.
        writeFileSync(program, '#!/nonexistent/interpreter\n');

        const search = new ContentSearch({ ripgrep: program });

        expect(paths(await search.search(root, { query: 'needle' }))).toEqual(['a.txt']);
        expect(search.lastEngine).toBe('scan');

        writeFileSync(
            program,
            `#!/bin/sh\nprintf '%s\\n' '${matchEvent(root, 'a.txt', 1, 'needle\n', [{ start: 0, end: 6 }])}' '${SUMMARY}'\n`
        );

        expect(paths(await search.search(root, { query: 'needle' }))).toEqual(['a.txt']);
        expect(search.lastEngine).toBe('ripgrep');
    });

    test('uses CLOWDY_RG only when it is an executable file, else the rg on the PATH, else the scan', () => {
        const program = script('true');
        const folderOnly = tempDir('not-a-file');
        const plain = join(folderOnly, 'rg');

        writeFileSync(plain, '#!/bin/sh\n');

        expect(new RipgrepLocator(program).find()).toBe(program);
        expect(new RipgrepLocator(false).find()).toBeNull();
        expect(new RipgrepLocator(folderOnly).find()).toBe(Bun.which('rg') ?? null);
        expect(new RipgrepLocator(plain).find()).toBe(Bun.which('rg') ?? null);
        expect(new RipgrepLocator(join(folderOnly, 'missing')).find()).toBe(Bun.which('rg') ?? null);
        expect(new RipgrepLocator().find()).toBe(Bun.which('rg') ?? null);
    });

    test('keeps the answer of the locator, and looks again after a run that could not start', () => {
        const dir = tempDir('locator');
        const path = join(dir, 'rg');
        const locator = new RipgrepLocator(path);

        // Not there yet: the PATH answers (and is believed for a while).
        const first = locator.find();

        writeFileSync(path, '#!/bin/sh\n');
        chmodSync(path, 0o755);

        expect(locator.find()).toBe(first);

        locator.forget();

        expect(locator.find()).toBe(path);

        rmSync(path);

        expect(locator.find()).toBe(path);

        locator.forget();

        expect(locator.find()).toBe(Bun.which('rg') ?? null);
    });

    describe('that does not end', () => {
        const hang = () => {
            const pidFile = join(tempDir('pid'), 'pid.txt');

            return { pidFile, program: script(`echo $$ > '${pidFile}'\nexec sleep 30`) };
        };
        const alive = (pid: number) => {
            try {
                process.kill(pid, 0);

                return true;
            } catch {
                return false;
            }
        };
        const pidOf = (file: string) =>
            waitFor(
                () =>
                    existsSync(file) && readFileSync(file, 'utf8').trim() !== '' && Number(readFileSync(file, 'utf8')),
                'the program to start'
            );

        test('is killed when the search is aborted', async () => {
            const { pidFile, program } = hang();
            const search = new ContentSearch({ ripgrep: program });
            const controller = new AbortController();
            const running = search.search(folder(), { query: 'x' }, controller.signal);
            const pid = await pidOf(pidFile);

            expect(search.active).toBe(1);
            expect(alive(pid)).toBe(true);

            controller.abort();

            expect(await running).toEqual({ files: [], truncated: true });
            expect(search.active).toBe(0);
            await waitFor(() => !alive(pid), 'the program to be killed');
        });

        test('is killed when the time is up, and the search answers what it had, cut', async () => {
            const root = folder();
            const pidFile = join(tempDir('pid'), 'pid.txt');
            const program = script(
                `echo $$ > '${pidFile}'\nprintf '%s\\n' '${matchEvent(root, 'a.txt', 1, 'x\n', [{ start: 0, end: 1 }])}'\nexec sleep 30`
            );
            const search = new ContentSearch({ ripgrep: program });

            // A program that was just written takes its time to start the first time on some systems.
            search.timeLimitMs = 1500;

            const started = Date.now();
            const result = await search.search(root, { query: 'x' });

            expect(Date.now() - started).toBeLessThan(3000);
            expect(paths(result)).toEqual(['a.txt']);
            expect(result.truncated).toBe(true);
            await waitFor(() => !alive(Number(readFileSync(pidFile, 'utf8'))), 'the program to be killed');
        });

        test('is killed when the daemon stops', async () => {
            const { pidFile, program } = hang();
            const search = new ContentSearch({ ripgrep: program });
            const running = search.search(folder(), { query: 'x' });
            const pid = await pidOf(pidFile);

            search.stop();

            expect((await running).truncated).toBe(true);
            await waitFor(() => !alive(pid), 'the program to be killed');
        });

        test('is stopped when the result is full, before it ends by itself', async () => {
            const root = folder();
            const events = Array.from({ length: MAX_FS_SEARCH_MATCHES + 1 }, (_, index) =>
                matchEvent(root, `f${String(index).padStart(4, '0')}.txt`, 1, 'x\n', [{ start: 0, end: 1 }])
            );
            const pidFile = join(tempDir('pid'), 'pid.txt');
            const program = script(`echo $$ > '${pidFile}'\ncat <<'EOF'\n${events.join('\n')}\nEOF\nexec sleep 30`);
            const result = await new ContentSearch({ ripgrep: program }).search(root, { query: 'x' });

            expect(result.truncated).toBe(true);
            expect(count(result)).toBe(MAX_FS_SEARCH_MATCHES);
            await waitFor(() => !alive(Number(readFileSync(pidFile, 'utf8'))), 'the program to be killed');
        });
    });

    describe('the line of searches waiting for a place', () => {
        const slow = (ms: number) => script(`sleep ${ms / 1000}\nprintf '%s\\n' '${SUMMARY}'`);

        test('lets a few run at once, queues the next ones and refuses past that', async () => {
            const search = new ContentSearch({ ripgrep: slow(400) });

            search.maxRunning = 1;
            search.maxWaiting = 1;

            const root = folder();
            const first = search.search(root, { query: 'x' });
            const second = search.search(root, { query: 'x' });

            await waitFor(() => search.active === 1, 'the first search to run');

            const error = await refused(search.search(root, { query: 'x' }));

            expect(error.code).toBe('unavailable');
            expect(error.message).toBe('Too many searches are running, try again in a moment');
            expect(search.active).toBe(1);
            expect(await first).toEqual({ files: [], truncated: false });
            expect(await second).toEqual({ files: [], truncated: false });
            expect(search.active).toBe(0);
        });

        test('lets one that is aborted while it waits leave the line, and the next one in', async () => {
            const search = new ContentSearch({ ripgrep: slow(300) });

            search.maxRunning = 1;
            search.maxWaiting = 1;

            const root = folder();
            const first = search.search(root, { query: 'x' });
            const controller = new AbortController();
            const waiting = search.search(root, { query: 'x' }, controller.signal);

            await waitFor(() => search.active === 1, 'the first search to run');
            controller.abort();

            expect(await waiting).toEqual({ files: [], truncated: true });
            expect(search.active).toBe(1);

            // The line has a place again.
            const third = search.search(root, { query: 'x' });

            expect(await first).toEqual({ files: [], truncated: false });
            expect(await third).toEqual({ files: [], truncated: false });
            expect(search.active).toBe(0);
        });

        test('runs the searches of the allowed number at once', async () => {
            const search = new ContentSearch({ ripgrep: slow(300) });
            const root = folder();

            search.maxRunning = 3;

            const running = Array.from({ length: 3 }, () => search.search(root, { query: 'x' }));

            await waitFor(() => search.active === 3, 'three searches to run at once');
            await Promise.all(running);
        });
    });
});

describe('CLOWDY_RG', () => {
    test('is an absolute path, off, or absent', () => {
        expect(loadConfig({}, 'linux').ripgrep).toBeUndefined();
        expect(loadConfig({ CLOWDY_RG: '' }, 'linux').ripgrep).toBeUndefined();
        expect(loadConfig({ CLOWDY_RG: '/opt/clowdy/rg' }, 'linux').ripgrep).toBe('/opt/clowdy/rg');
        expect(loadConfig({ CLOWDY_RG: 'off' }, 'linux').ripgrep).toBe(false);
        expect(() => loadConfig({ CLOWDY_RG: 'rg' }, 'linux')).toThrow(/CLOWDY_RG/);
        expect(() => loadConfig({ CLOWDY_RG: './rg' }, 'linux')).toThrow(/CLOWDY_RG/);
    });
});

describe('POST fs/search', () => {
    let h: Harness;

    const request = (folderValue: { project: { id: string } }, body: unknown, init: RequestInit = {}) =>
        h.fetch(`/v1/projects/${folderValue.project.id}/fs/search`, {
            method: 'POST',
            body: typeof body === 'string' ? body : JSON.stringify(body),
            headers: { 'content-type': 'application/json' },
            ...init,
        });
    const failureOf = async (response: Response) => {
        const body = (await response.json()) as { ok: false; error: { code: string; message: string } };

        expect(body.ok).toBe(false);

        return body.error;
    };

    beforeEach(async () => {
        h = await startHarness({ ripgrep: false });
    });

    afterEach(async () => {
        await h.stop();
    });

    test('answers the lines of the files that hold the text', async () => {
        const place = openFolder(h, {
            'a.txt': 'one\nNeedle two\n',
            'src/b.ts': 'needle\n',
            'node_modules/c.js': 'needle\n',
            'skip.log': 'needle\n',
        });
        const response = await request(place, { folderId: place.folderId, query: 'needle', exclude: ['*.log'] });

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
            files: [
                {
                    path: 'a.txt',
                    matches: [{ line: 2, column: 1, preview: 'Needle two', ranges: [{ start: 0, end: 6 }] }],
                },
                {
                    path: 'src/b.ts',
                    matches: [{ line: 1, column: 1, preview: 'needle', ranges: [{ start: 0, end: 6 }] }],
                },
            ],
            truncated: false,
        });

        const exact = await request(place, {
            folderId: place.folderId,
            query: 'needle',
            matchCase: true,
            wholeWord: true,
        });

        expect(((await exact.json()) as FsSearchResult).files.map(file => file.path)).toEqual(['skip.log', 'src/b.ts']);
    });

    test.skipIf(!RG)('answers the same through ripgrep (skipped without rg on the PATH)', async () => {
        await h.stop();
        h = await startHarness({ ripgrep: RG! });

        const place = openFolder(h, { 'a.txt': 'one\nNeedle two\n', 'src/b.ts': 'needle\n' });
        const response = await request(place, { folderId: place.folderId, query: 'needle' });

        expect(response.status).toBe(200);
        expect(((await response.json()) as FsSearchResult).files.map(file => file.path)).toEqual(['a.txt', 'src/b.ts']);
        expect(h.daemon.services.fs.contentSearch.lastEngine).toBe('ripgrep');
    });

    test('is behind the token', async () => {
        const place = openFolder(h, { 'a.txt': 'needle' });

        for (const headers of [{}, { authorization: 'Bearer wrong' }] as Array<Record<string, string>>) {
            const response = await fetch(`${h.url}/v1/projects/${place.project.id}/fs/search`, {
                method: 'POST',
                headers,
                body: JSON.stringify({ folderId: place.folderId, query: 'needle' }),
            });

            expect(response.status).toBe(401);
        }
    });

    test('is a POST: a GET of the route is 405', async () => {
        const place = openFolder(h);
        const response = await h.fetch(`/v1/projects/${place.project.id}/fs/search?folderId=${place.folderId}&query=x`);

        expect(response.status).toBe(405);
        expect(response.headers.get('allow')).toBe('POST');
    });

    test('refuses a request that is not valid with 400 and a message', async () => {
        const place = openFolder(h, { 'a.txt': 'needle' });
        const bodies: Array<[unknown, string]> = [
            ['not json', 'The body is not valid JSON'],
            [{ folderId: place.folderId }, 'The request is not valid'],
            [{ folderId: place.folderId, query: 5 }, 'The request is not valid'],
            [{ folderId: place.folderId, query: 'x', matchCase: 'yes' }, 'The request is not valid'],
            [{ folderId: place.folderId, query: 'x', exclude: 'dist' }, 'The request is not valid'],
            [{ query: 'x' }, 'The request is not valid'],
            [{ folderId: '', query: 'x' }, 'The folder is not given'],
            [{ folderId: place.folderId, query: '' }, 'The search text is empty'],
            [
                { folderId: place.folderId, query: 'a'.repeat(MAX_FS_QUERY_LENGTH + 1) },
                `The search text is over ${MAX_FS_QUERY_LENGTH} characters`,
            ],
            [{ folderId: place.folderId, query: 'a\nb' }, 'The search text must be one line of text'],
            [{ folderId: place.folderId, query: 'x', exclude: [''] }, 'An exclude glob is empty'],
            [
                { folderId: place.folderId, query: 'x', exclude: ['a'.repeat(501)] },
                'An exclude glob is over 500 characters',
            ],
            [{ folderId: place.folderId, query: 'x', exclude: ['a\0b'] }, 'An exclude glob has a NUL character'],
        ];

        for (const [body, message] of bodies) {
            const response = await request(place, body);

            expect(response.status).toBe(400);
            expect(await failureOf(response)).toMatchObject({ code: 'invalid', message });
        }
    });

    test('answers 404 for a project or a folder that does not exist, and 503 for one that is gone from the disk', async () => {
        const place = openFolder(h, { 'a.txt': 'needle' });
        const unknownProject = await h.fetch('/v1/projects/prj_nope/fs/search', {
            method: 'POST',
            body: JSON.stringify({ folderId: place.folderId, query: 'x' }),
        });

        expect(unknownProject.status).toBe(404);
        expect((await failureOf(unknownProject)).code).toBe('not_found');

        const unknownFolder = await request(place, { folderId: 'fld_nope', query: 'x' });

        expect(unknownFolder.status).toBe(404);
        expect((await failureOf(unknownFolder)).code).toBe('not_found');

        rmSync(place.dir, { recursive: true });

        const gone = await request(place, { folderId: place.folderId, query: 'x' });

        expect(gone.status).toBe(503);
        expect(await failureOf(gone)).toMatchObject({
            code: 'unavailable',
            message: `The folder ${place.dir} is missing`,
        });
    });

    describe.skipIf(!POSIX)('with a search that does not end', () => {
        test('stops it when the client drops the request', async () => {
            const pidFile = join(tempDir('pid'), 'pid.txt');

            await h.stop();
            h = await startHarness({ ripgrep: script(`echo $$ > '${pidFile}'\nexec sleep 30`) });

            const place = openFolder(h, { 'a.txt': 'needle' });
            const search = h.daemon.services.fs.contentSearch;
            const controller = new AbortController();
            const response = request(
                place,
                { folderId: place.folderId, query: 'needle' },
                { signal: controller.signal }
            ).catch((error: Error) => error.name);
            const pid = await waitFor(
                () => existsSync(pidFile) && Number(readFileSync(pidFile, 'utf8')),
                'the search to start'
            );

            expect(search.active).toBe(1);

            controller.abort();

            expect(await response).toBe('AbortError');
            await waitFor(() => search.active === 0, 'the search to stop');
            await waitFor(() => {
                try {
                    process.kill(pid, 0);

                    return false;
                } catch {
                    return true;
                }
            }, 'the program to be killed');
        });

        test('answers 503 when too many searches are going on', async () => {
            await h.stop();
            h = await startHarness({ ripgrep: script('sleep 0.4\nprintf \'%s\\n\' \'{"type":"summary","data":{}}\'') });

            const place = openFolder(h, { 'a.txt': 'needle' });
            const search = h.daemon.services.fs.contentSearch;

            search.maxRunning = 1;
            search.maxWaiting = 0;

            const first = request(place, { folderId: place.folderId, query: 'needle' });

            await waitFor(() => search.active === 1, 'the first search to run');

            const second = await request(place, { folderId: place.folderId, query: 'needle' });

            expect(second.status).toBe(503);
            expect(await failureOf(second)).toMatchObject({
                code: 'unavailable',
                message: 'Too many searches are running, try again in a moment',
            });
            expect((await first).status).toBe(200);
        });
    });
});

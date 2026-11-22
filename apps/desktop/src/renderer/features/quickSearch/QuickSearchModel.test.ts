import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ALL_FILE_ROWS, ALL_LINE_ROWS, FILE_ROWS, QuickSearchModel, TYPING_DELAY, type Found, type QuickSearchSource } from './QuickSearchModel';

import type { SearchResult } from '@clowdy/file-manager/provider';

const line = (n: number) => ({ line: n, column: 1, preview: `line ${ n }`, ranges: [{ start: 0, end: 4 }] });
const result = (...files: Array<[string, number[]]>): SearchResult => ({ files: files.map(([path, lines]) => ({ path, matches: lines.map(line) })), truncated: false });

interface Deferred<T> {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
    const out = {} as Deferred<T>;

    out.promise = new Promise<T>((resolve, reject) => Object.assign(out, { resolve, reject }));

    return out;
}

function source(overrides: Partial<QuickSearchSource> = {}) {
    const found = {
        files: vi.fn(async (query: string) => [`${ query }.ts`, 'docs/guide.md']),
        text: vi.fn(async () => result(['src/a.ts', [3, 9]], ['src/b.ts', [1]])),
        open: vi.fn<(found: Found) => void>(),
        dispose: vi.fn(),
        ...overrides,
    };

    return found;
}

const settle = () => vi.advanceTimersByTimeAsync(TYPING_DELAY);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('searching as the person types', () => {
    it('waits for a pause in typing, and searches what the tab shows: the names for Files, the content for Text, both for All', async () => {
        const all = source();
        const model = new QuickSearchModel(all);

        model.setQuery('a');
        model.setQuery('ab');
        await vi.advanceTimersByTimeAsync(TYPING_DELAY - 1);

        expect(all.files).not.toHaveBeenCalled();

        await settle();

        expect(all.files).toHaveBeenCalledExactlyOnceWith('ab');
        expect(all.text).toHaveBeenCalledExactlyOnceWith('ab');

        const files = source();
        const onlyFiles = new QuickSearchModel(files, 'files');

        onlyFiles.setQuery('ab');
        await settle();

        expect(files.files).toHaveBeenCalledOnce();
        expect(files.text).not.toHaveBeenCalled();

        const text = source();
        const onlyText = new QuickSearchModel(text, 'text');

        onlyText.setQuery('ab');
        await settle();

        expect(text.text).toHaveBeenCalledOnce();
        expect(text.files).not.toHaveBeenCalled();
    });

    it('searches what is typed in a blank palette at once, and nothing for blank text', async () => {
        const quick = source();
        const model = new QuickSearchModel(quick, 'files', 'price');

        await vi.advanceTimersByTimeAsync(0);

        expect(quick.files).toHaveBeenCalledExactlyOnceWith('price');

        model.setQuery('   ');
        await settle();

        expect(quick.files).toHaveBeenCalledOnce();
        expect(model.blank).toBe(true);
        expect(model.rows).toEqual([]);
    });

    it('lists the files and then the lines, each as its own search comes in', async () => {
        const names = deferred<string[]>();
        const model = new QuickSearchModel(source({ files: () => names.promise }));

        model.setQuery('ab');
        await settle();

        expect(model.pending).toBe(true);
        expect(model.sections.map(({ id }) => id)).toEqual(['text']);

        names.resolve(['ab.ts']);
        await vi.advanceTimersByTimeAsync(0);

        expect(model.pending).toBe(false);
        expect(model.sections.map(({ id }) => id)).toEqual(['files', 'text']);
        expect(model.rows.map(({ id }) => id)).toEqual(['file:ab.ts', 'line:src/a.ts:3', 'line:src/a.ts:9', 'line:src/b.ts:1']);
    });

    it('drops the answer of a search that is not the latest', async () => {
        const first = deferred<string[]>();
        const quick = source({ files: vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(['second.ts']) });
        const model = new QuickSearchModel(quick, 'files');

        model.setQuery('one');
        await settle();
        model.setQuery('two');
        await settle();

        expect(model.rows.map(({ path }) => path)).toEqual(['second.ts']);

        first.resolve(['first.ts']);
        await vi.advanceTimersByTimeAsync(0);

        expect(model.rows.map(({ path }) => path)).toEqual(['second.ts']);
    });

    it('clears what was found when the text is emptied, and ignores an answer that is still on its way', async () => {
        const late = deferred<string[]>();
        const model = new QuickSearchModel(source({ files: () => late.promise }), 'files');

        model.setQuery('ab');
        await settle();
        model.setQuery('');
        late.resolve(['ab.ts']);
        await vi.advanceTimersByTimeAsync(0);

        expect(model.rows).toEqual([]);
        expect(model.pending).toBe(false);
    });

    it('says why there is nothing when the search failed, and does not call a failed search an empty one', async () => {
        const model = new QuickSearchModel(source({ text: async () => Promise.reject(new Error('rg crashed')) }), 'text');

        model.setQuery('ab');
        await settle();

        expect(model.error).toBe('rg crashed');
        expect(model.answered).toBe(false);
        expect(model.rows).toEqual([]);

        model.setQuery('abc');
        await settle();

        expect(model.error).toBe('rg crashed');
    });

    it('keeps a list that came while the other kind failed, since there is something to show', async () => {
        const model = new QuickSearchModel(source({ text: async () => Promise.reject(new Error('rg crashed')) }));

        model.setQuery('ab');
        await settle();

        expect(model.rows.map(({ kind }) => kind)).toEqual(['file', 'file']);
        expect(model.error).toBeNull();
    });
});

describe('the tabs', () => {
    it('search what the new tab needs at once, and only that', async () => {
        const quick = source();
        const model = new QuickSearchModel(quick, 'files');

        model.setQuery('ab');
        await settle();

        expect(quick.text).not.toHaveBeenCalled();

        model.setTab('text');
        await vi.advanceTimersByTimeAsync(0);

        expect(quick.text).toHaveBeenCalledExactlyOnceWith('ab');
        expect(model.sections.map(({ id }) => id)).toEqual(['text']);

        model.setTab('all');
        await vi.advanceTimersByTimeAsync(0);

        expect(quick.files).toHaveBeenCalledOnce();
        expect(quick.text).toHaveBeenCalledOnce();
        expect(model.sections.map(({ id }) => id)).toEqual(['files', 'text']);
    });

    it('go round with Tab and back with Shift+Tab', () => {
        const model = new QuickSearchModel(source());

        model.stepTab(1);
        expect(model.tab).toBe('files');
        model.stepTab(1);
        expect(model.tab).toBe('text');
        model.stepTab(1);
        expect(model.tab).toBe('all');
        model.stepTab(-1);
        expect(model.tab).toBe('text');
    });

    it('list a few of each kind in All and all they have in their own', async () => {
        const many = Array.from({ length: 80 }, (_, index) => `f${ index }.ts`);
        const lines = result(['big.ts', Array.from({ length: 300 }, (_, index) => index + 1)]);
        const quick = source({ files: async () => many, text: async () => lines });
        const model = new QuickSearchModel(quick);

        model.setQuery('f');
        await settle();

        expect(model.sections.map(({ items }) => items.length)).toEqual([ALL_FILE_ROWS, ALL_LINE_ROWS]);

        model.setTab('files');
        expect(model.rows).toHaveLength(FILE_ROWS);

        model.setTab('text');
        expect(model.rows).toHaveLength(200);
    });
});

describe('the row the keys are on', () => {
    async function listed() {
        const quick = source();
        const model = new QuickSearchModel(quick, 'files');

        model.setQuery('ab');
        await settle();

        return { quick, model };
    }

    it('is the first, moves with the arrows round to the other end, and is the first again for a new answer', async () => {
        const { model } = await listed();

        expect(model.active?.path).toBe('ab.ts');

        model.move(1);
        expect(model.active?.path).toBe('docs/guide.md');

        model.move(1);
        expect(model.active?.path).toBe('ab.ts');

        model.move(-1);
        expect(model.active?.path).toBe('docs/guide.md');

        model.setQuery('abc');
        await settle();

        expect(model.active?.path).toBe('abc.ts');
    });

    it('follows the pointer', async () => {
        const { model } = await listed();

        model.activate(model.rows[1]!);

        expect(model.active?.path).toBe('docs/guide.md');
    });

    it('opens the row it is on, or the one it is given, and reports that there was none', async () => {
        const { quick, model } = await listed();

        model.move(1);

        expect(model.open()).toBe(true);
        expect(quick.open).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'file', path: 'docs/guide.md' }));

        expect(model.open(model.rows[0])).toBe(true);
        expect(quick.open).toHaveBeenLastCalledWith(expect.objectContaining({ path: 'ab.ts' }));

        model.setQuery('');
        expect(model.open()).toBe(false);
        expect(quick.open).toHaveBeenCalledTimes(2);
    });

    it('has nowhere to move while nothing is listed', () => {
        const model = new QuickSearchModel(source());

        model.move(1);

        expect(model.active).toBeUndefined();
    });
});

describe('closing', () => {
    it('stops the searches to come and the ones on their way, and lets the source go', async () => {
        const late = deferred<string[]>();
        const quick = source({ files: vi.fn(() => late.promise) });
        const model = new QuickSearchModel(quick, 'files');

        model.setQuery('ab');
        await settle();
        model.setQuery('abc');
        model.dispose();
        late.resolve(['ab.ts']);
        await vi.advanceTimersByTimeAsync(TYPING_DELAY * 2);

        expect(quick.files).toHaveBeenCalledOnce();
        expect(model.rows).toEqual([]);
        expect(quick.dispose).toHaveBeenCalledOnce();
    });
});

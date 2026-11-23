// @vitest-environment happy-dom
import { language } from '@codemirror/language';
import { getChunks } from '@codemirror/merge';
import { EditorView, ViewPlugin } from '@codemirror/view';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, createElement, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DiffView } from '../src/react/diff/DiffView';
import { estimateDiffLines } from '../src/react/diff/estimateDiffLines';

import type { Extension } from '@codemirror/state';
import type { Root } from 'react-dom/client';
import type { DiffViewProps } from '../src/react/diff/DiffView';

let host: HTMLDivElement;
let root: Root;

/** Stands in for the browser's observer: the test decides when the view comes into sight. */
class FakeIntersectionObserver {
    static all: FakeIntersectionObserver[] = [];

    /** CodeMirror watches its own visibility through the same global, so a test picks the observers of the lazy views by their margin. */
    static get lazy(): FakeIntersectionObserver[] {
        return FakeIntersectionObserver.all.filter(observer => observer.options?.rootMargin);
    }

    readonly targets: Element[] = [];
    disconnected = false;

    constructor(
        private readonly callback: IntersectionObserverCallback,
        readonly options?: IntersectionObserverInit
    ) {
        FakeIntersectionObserver.all.push(this);
    }

    observe(target: Element) {
        this.targets.push(target);
    }

    unobserve() {}

    disconnect() {
        this.disconnected = true;
    }

    takeRecords(): IntersectionObserverEntry[] {
        return [];
    }

    show(isIntersecting: boolean) {
        const entries = this.targets.map(target => ({ isIntersecting, target }) as IntersectionObserverEntry);

        this.callback(entries, this as unknown as IntersectionObserver);
    }
}

function render(props: Partial<DiffViewProps> = {}, strict = false) {
    return act(async() => {
        const diff = createElement(DiffView, { path: 'notes.txt', original: 'a\nb\nc', modified: 'a\nB\nc', ...props });

        root.render(strict ? createElement(StrictMode, null, diff) : diff);
    });
}

/** Lets the language pack of a path finish loading. */
function settle() {
    return act(async() => {
        await new Promise(resolve => setTimeout(resolve, 20));
    });
}

const editorDom = () => host.querySelector<HTMLElement>('.cm-editor');
const view = () => EditorView.findFromDOM(editorDom()!)!;
const texts = (selector: string) => [...host.querySelectorAll(selector)].map(node => node.textContent);

/** An extension a host would add: it records the view it was given and when it was let go. */
function spy() {
    const log = { views: [] as EditorView[], destroyed: 0 };
    const extension: Extension = ViewPlugin.define((editor) => {
        log.views.push(editor);

        return {
            destroy() {
                log.destroyed += 1;
            },
        };
    });

    return { log, extension };
}

beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    FakeIntersectionObserver.all = [];
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
});

afterEach(async() => {
    await act(async() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
});

describe('DiffView', () => {
    it('should show the changed line and the line it replaces', async() => {
        await render();

        expect(view().state.doc.toString()).toBe('a\nB\nc');
        expect(texts('.cm-changedLine')).toEqual(['B']);
        expect(texts('.cm-deletedChunk .cm-deletedLine')).toEqual(['b']);
        expect(host.querySelector('.cm-lineNumbers')).not.toBeNull();
    });

    it('should fold the unchanged lines around a change and open them on a click', async() => {
        const lines = Array.from({ length: 30 }, (_, index) => `line ${ index + 1 }`);

        await render({ original: lines.join('\n'), modified: lines.map(line => (line === 'line 15' ? 'edited' : line)).join('\n') });

        // Three lines of context stay on each side of line 15: lines 1 to 11 and 19 to 30 fold.
        expect(texts('.cm-collapsedLines')).toEqual(['11 unchanged lines', '12 unchanged lines']);
        expect(texts('.cm-changedLine')).toEqual(['edited']);

        await act(async() => {
            host.querySelector<HTMLElement>('.cm-collapsedLines')!.click();
        });

        expect(texts('.cm-collapsedLines')).toHaveLength(1);
    });

    it('should show every line as added when the file has no earlier text', async() => {
        await render({ original: null, modified: 'one\ntwo' });

        expect(texts('.cm-changedLine')).toEqual(['one', 'two']);
        expect(host.querySelector('.cm-deletedLine')).toBeNull();
        // A new file is new as a whole: no word inside it is marked.
        expect(host.querySelector('.cm-changedText')).toBeNull();
    });

    it('should not count the line break at the end of a new file as a line', async() => {
        await render({ original: '', modified: 'one\ntwo\n' });

        expect(texts('.cm-changedLine')).toEqual(['one', 'two']);
        expect(host.querySelector('.cm-deletedLine')).toBeNull();
    });

    it('should show every line as removed when the file is gone', async() => {
        await render({ original: 'one\ntwo', modified: null });

        expect(view().state.doc.length).toBe(0);
        expect(texts('.cm-deletedChunk .cm-deletedLine')).toEqual(['one', 'two']);
        expect(host.querySelector('.cm-lineNumbers')).toBeNull();
        expect(host.querySelector('.cm-changedLine')).toBeNull();
    });

    it('should show the lines of a file that is gone without a blank one for its last line break', async() => {
        await render({ original: 'one\ntwo\n', modified: null });

        expect(texts('.cm-deletedChunk .cm-deletedLine')).toEqual(['one', 'two']);
    });

    it('should show nothing for a file with no text on either side', async() => {
        await render({ original: null, modified: null });

        expect(editorDom()).not.toBeNull();
        expect(host.querySelector('.cm-changedLine')).toBeNull();
        expect(host.querySelector('.cm-deletedChunk')).toBeNull();
    });

    it('should not show buttons that accept or reject a change', async() => {
        await render();

        expect(host.querySelector('.cm-chunkButtons')).toBeNull();
        expect(host.querySelector('button')).toBeNull();
    });

    it('should be read-only', async() => {
        await render();

        expect(view().state.readOnly).toBe(true);
    });

    it('should show the new texts in the same editor when the props change', async() => {
        await render({ original: 'a\nb', modified: 'a\nB' });

        const first = view();

        await render({ original: 'x\ny', modified: 'x\nY\nz' });

        expect(host.querySelectorAll('.cm-editor')).toHaveLength(1);
        expect(view()).toBe(first);
        expect(first.state.doc.toString()).toBe('x\nY\nz');
        expect(texts('.cm-changedLine')).toEqual(['Y', 'z']);
        expect(texts('.cm-deletedChunk .cm-deletedLine')).toEqual(['y']);
    });

    it('should leave the editor alone when the props change to the same texts', async() => {
        await render();

        const first = view();

        first.dispatch({ selection: { anchor: 1, head: 3 } });
        await render({ original: 'a\nb\nc', modified: 'a\nB\nc' });

        expect(view()).toBe(first);
        expect(first.state.selection.main.from).toBe(1);
        expect(first.state.selection.main.to).toBe(3);
    });

    it('should destroy its editor when it goes', async() => {
        const { log, extension } = spy();

        await render({ extensions: extension });

        expect(log.views).toHaveLength(1);
        expect(log.destroyed).toBe(0);

        await act(async() => root.render(null));

        expect(log.destroyed).toBe(1);
        expect(host.querySelector('.cm-editor')).toBeNull();
    });

    it('should add the host extensions and swap them without building the editor again', async() => {
        const first = spy();
        const second = spy();

        await render({ extensions: first.extension });

        const editor = view();

        expect(first.log.views).toEqual([editor]);

        await render({ extensions: second.extension });

        expect(view()).toBe(editor);
        expect(first.log.destroyed).toBe(1);
        expect(second.log.views).toEqual([editor]);

        await render({ extensions: undefined });

        expect(second.log.destroyed).toBe(1);
        expect(view()).toBe(editor);
    });

    it('should keep the host extensions when the texts change', async() => {
        const { log, extension } = spy();

        await render({ extensions: extension });
        await render({ original: 'p', modified: 'q', extensions: extension });

        // The plugin of the first state goes with it and the new state starts it again, on the one editor.
        expect(new Set(log.views).size).toBe(1);
        expect(log.views.length).toBe(log.destroyed + 1);
    });

    it('should keep the selection when the host extensions change', async() => {
        const first = spy();

        await render({ original: 'alpha\nbeta', modified: 'alpha\nbeta\ngamma', extensions: first.extension });

        const editor = view();

        editor.dispatch({ selection: { anchor: 3, head: 10 } });
        await render({ original: 'alpha\nbeta', modified: 'alpha\nbeta\ngamma', extensions: spy().extension });

        const { from, to } = view().state.selection.main;

        expect(view()).toBe(editor);
        expect(view().state.sliceDoc(from, to)).toBe('ha\nbeta');
    });

    it('should show an ordinary change in a long file as the lines that changed', async() => {
        // The merge package's own limit on the diff turns this into one chunk of the whole file.
        const lines = Array.from({ length: 1000 }, (_, index) => `  const value${ index } = compute(${ index }, "item-${ index }");`);
        const edited = lines.map((line, index) => (index % 40 === 0 ? `${ line } // edited` : line));

        await render({ original: lines.join('\n'), modified: edited.join('\n') });

        const chunks = getChunks(view().state)!.chunks;

        expect(chunks).toHaveLength(25);
        expect(chunks.every(chunk => chunk.toB - chunk.fromB < 100)).toBe(true);
    });

    it('should see no change in a text with lone carriage returns that is the same on both sides', async() => {
        const text = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].join('\r');

        await render({ original: text, modified: text });

        expect(getChunks(view().state)!.chunks).toHaveLength(0);
    });

    it('should show a text with Windows line breaks against the same one with Unix ones as unchanged', async() => {
        await render({ original: 'a\nb\nc\nd\ne\nf\ng', modified: 'a\r\nb\r\nc\r\nd\r\ne\r\nf\r\ng' });

        expect(getChunks(view().state)!.chunks).toHaveLength(0);
        expect(texts('.cm-collapsedLines')).toEqual(['7 unchanged lines']);
    });

    it('should keep one editor and let go of every one it made under StrictMode', async() => {
        const { log, extension } = spy();

        await render({ extensions: extension }, true);

        expect(host.querySelectorAll('.cm-editor')).toHaveLength(1);

        await act(async() => root.render(null));

        expect(host.querySelector('.cm-editor')).toBeNull();
        expect(log.destroyed).toBe(log.views.length);
    });

    it('should use the language of the path', async() => {
        await render({ path: 'src/app.ts', original: 'const a = 1', modified: 'const a = 2' });

        expect(editorDom()).toBeNull();

        await settle();

        expect(view().state.facet(language)).toBeTruthy();
    });

    it('should show plain text for a path with no language', async() => {
        await render({ path: 'notes.txt' });

        expect(view().state.facet(language)).toBeFalsy();
    });

    it('should keep the editor while the language of a changed path loads', async() => {
        await render({ path: 'notes.txt' });

        const editor = view();

        await render({ path: 'styles.css' });

        expect(view()).toBe(editor);

        await settle();

        expect(view()).toBe(editor);
        expect(editor.state.facet(language)).toBeTruthy();
    });

    it('should label the text with the name of the file', async() => {
        await render({ path: 'a/b/notes.txt' });

        expect(host.querySelector('.cm-content')!.getAttribute('aria-label')).toBe('Changes in notes.txt');
    });

    describe('lazy', () => {
        beforeEach(() => {
            vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
        });

        it('should hold a box of the estimated height and wait for the observer', async() => {
            await render({ lazy: true, original: 'a\nb', modified: 'a\nc', estimatedLines: 7 });

            const [observer] = FakeIntersectionObserver.lazy;

            expect(editorDom()).toBeNull();
            expect(observer.targets).toEqual([host.firstElementChild]);
            expect(observer.options?.rootMargin).toMatch(/\dpx/);
            expect((host.firstElementChild as HTMLElement).style.minHeight).toContain('7 *');
            expect((host.firstElementChild as HTMLElement).dataset.state).toBe('idle');

            await act(async() => observer.show(false));

            expect(editorDom()).toBeNull();

            await act(async() => observer.show(true));

            expect(editorDom()).not.toBeNull();
            expect((host.firstElementChild as HTMLElement).dataset.state).toBe('ready');
            expect((host.firstElementChild as HTMLElement).style.minHeight).toBe('');
            expect(observer.disconnected).toBe(true);
        });

        it('should keep the editor once it is built and not observe the view again', async() => {
            await render({ lazy: true });

            await act(async() => FakeIntersectionObserver.lazy[0].show(true));

            const built = view();

            await render({ lazy: true, modified: 'a\nbb\nc' });

            expect(FakeIntersectionObserver.lazy).toHaveLength(1);
            expect(view()).toBe(built);
            expect(built.state.doc.toString()).toBe('a\nbb\nc');
        });

        it('should measure against the scroll container the view is in, so the margin reaches past its edge', async() => {
            // The observer's own viewport root ignores a margin for a view clipped by a scroll container.
            host.style.overflowY = 'auto';
            Object.defineProperty(host, 'scrollHeight', { value: 2000 });
            Object.defineProperty(host, 'clientHeight', { value: 400 });

            await render({ lazy: true });

            expect(FakeIntersectionObserver.lazy[0].options?.root).toBe(host);
        });

        it('should measure against the viewport when the view is in no scroll container', async() => {
            await render({ lazy: true });

            expect(FakeIntersectionObserver.lazy[0].options?.root ?? null).toBeNull();
        });

        it('should let go of the observer when it goes before it was ever near', async() => {
            await render({ lazy: true });

            const [observer] = FakeIntersectionObserver.lazy;

            await act(async() => root.render(null));

            expect(observer.disconnected).toBe(true);
            expect(host.querySelector('.cm-editor')).toBeNull();
        });

        it('should not observe a view that is not lazy', async() => {
            await render();

            expect(FakeIntersectionObserver.lazy).toHaveLength(0);
            expect(editorDom()).not.toBeNull();
        });

        it('should not load a language before the view is near', async() => {
            await render({ lazy: true, path: 'src/app.ts' });
            await settle();

            expect(editorDom()).toBeNull();

            await act(async() => FakeIntersectionObserver.lazy[0].show(true));
            await settle();

            expect(view().state.facet(language)).toBeTruthy();
        });
    });
});

describe('DiffView styles', () => {
    const css = readFileSync(join(import.meta.dirname, '../src/react/diff/DiffView.module.css'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '');

    it('should take every color from the tokens, in the light theme and the dark one', () => {
        expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|\b(rgb|rgba|hsl|hsla|oklch|hwb)\(/i);
        expect(css).toContain('var(--color-success');
        expect(css).toContain('var(--color-danger');
    });

    it('should be flat, with no shadow', () => {
        expect(css).not.toMatch(/shadow/i);
    });
});

describe('estimateDiffLines', () => {
    it('should take every line of a text that has one side', () => {
        expect(estimateDiffLines(null, 'a\nb\nc')).toBe(3);
        expect(estimateDiffLines('a\nb', null)).toBe(2);
        expect(estimateDiffLines('', 'a\nb')).toBe(2);
    });

    it('should cap a text with one side so a huge file does not make a huge box', () => {
        expect(estimateDiffLines(null, Array.from({ length: 5000 }, () => 'x').join('\n'))).toBe(200);
    });

    it('should guess a short run of lines for two sides, whose unchanged lines fold away', () => {
        expect(estimateDiffLines('a\nb', 'a\nc')).toBe(2);
        expect(estimateDiffLines(Array.from({ length: 500 }, () => 'x').join('\n'), 'y')).toBe(16);
    });

    it('should hold one line for a file with no text on either side', () => {
        expect(estimateDiffLines(null, null)).toBe(1);
    });
});

// @vitest-environment happy-dom
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, runScopeHandlers, showTooltip } from '@codemirror/view';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DiffView } from '../src/react/diff/DiffView';
import { selectedLines, selectionAction } from '../src/react/editor/selectionAction';

import type { Extension } from '@codemirror/state';
import type { Root } from 'react-dom/client';
import type { SelectedLines } from '../src/react/editor/selectionAction';

let host: HTMLDivElement;
let views: EditorView[];

const DOC = 'alpha\nbeta\ngamma\ndelta';

function stand(extensions: Extension, doc = DOC): EditorView {
    const view = new EditorView({ parent: host, state: EditorState.create({ doc, extensions }) });

    views.push(view);

    return view;
}

/** Selects `from` to `to` (characters of the document) the way a drag does, and lets the tooltip's button be drawn. */
const select = (view: EditorView, from: number, to: number) => act(async () => view.dispatch({ selection: { anchor: from, head: to } }));

/** The key as the editor sees it: `Mod` is Cmd on a Mac and Ctrl elsewhere. */
function modI(view: EditorView): boolean {
    const mac = /Mac/.test(navigator.platform);

    return runScopeHandlers(view, new KeyboardEvent('keydown', { key: 'i', code: 'KeyI', ...(mac ? { metaKey: true } : { ctrlKey: true }) }), 'editor');
}

const button = () => host.querySelector<HTMLButtonElement>('.cm-tooltip button');

const press = () => act(async () => button()!.click());

/** Lets the tooltip's React root, which is unmounted after the editor's update, go. */
const settle = () => act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
});

beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.append(host);
    views = [];
});

afterEach(async() => {
    await act(async () => views.forEach(view => view.destroy()));
    host.remove();
});

describe('selectedLines', () => {
    const lines = (from: number, to: number, doc = DOC) => selectedLines(EditorState.create({ doc, selection: { anchor: from, head: to } }));

    it('is nothing for a caret', () => {
        expect(lines(3, 3)).toBeUndefined();
    });

    it('counts the lines a partial selection touches and gives the words as written', () => {
        // "pha\nbe": from inside the first line to inside the second.
        expect(lines(2, 8)).toEqual({ from: 1, to: 2, text: 'pha\nbe' });
        // One line, from the end towards the start: the direction of the drag does not matter.
        expect(lines(10, 7)).toEqual({ from: 2, to: 2, text: 'eta' });
    });

    it('ends whole lines on the last one selected, not on the line after it', () => {
        // Line 2 and the line break after it: the selection ends at the start of line 3.
        expect(lines(6, 11)).toEqual({ from: 2, to: 2, text: 'beta' });
        // Lines 2 and 3 whole.
        expect(lines(6, 17)).toEqual({ from: 2, to: 3, text: 'beta\ngamma' });
    });

    it('starts on the line after one whose end the drag began past', () => {
        // From the end of line 1 into line 3: the first line holds no selected words.
        expect(lines(5, 13)).toEqual({ from: 2, to: 3, text: 'beta\nga' });
    });

    it('keeps the indentation of what was selected', () => {
        expect(lines(0, 16, '  indented\n    deeper')).toEqual({ from: 1, to: 2, text: '  indented\n    d' });
    });

    it('is nothing for blank space alone', () => {
        expect(lines(5, 6)).toBeUndefined();
        expect(lines(0, 3, '   \nx')).toBeUndefined();
    });

    it('works for a selection in the last line, with or without a line break at the end', () => {
        expect(lines(17, 22)).toEqual({ from: 4, to: 4, text: 'delta' });
        expect(lines(17, 23, `${ DOC }\n`)).toEqual({ from: 4, to: 4, text: 'delta' });
    });
});

describe('selectionAction', () => {
    it('shows nothing until something is selected', async () => {
        const view = stand(selectionAction({ label: 'Add to chat', onAction: vi.fn() }));

        await settle();
        expect(host.querySelector('.cm-tooltip')).toBeNull();

        await select(view, 2, 8);
        expect(button()).not.toBeNull();

        await select(view, 4, 4);
        await settle();
        expect(host.querySelector('.cm-tooltip')).toBeNull();
    });

    it('draws the button with the label, a name and the key hint', async () => {
        const view = stand(selectionAction({ label: 'Add to chat', onAction: vi.fn() }));

        await select(view, 2, 8);

        expect(button()!.textContent).toContain('Add to chat');
        expect(button()!.getAttribute('aria-label')).toBe('Add to chat');
        expect(button()!.querySelector('kbd')?.textContent).toMatch(/^(?:⌘|Ctrl) I$/);
    });

    it('stands under the end of the selection, and under the last line selected of whole lines', async () => {
        const view = stand(selectionAction({ label: 'Add to chat', onAction: vi.fn() }));

        await select(view, 6, 11);

        const tooltips = view.state.facet(showTooltip).filter(tooltip => tooltip !== null);

        // The line break after "beta" is the last character selected, not the start of "gamma".
        expect(tooltips.map(tooltip => tooltip.pos)).toEqual([10]);
    });

    it('hands the host the lines and the words when the button is pressed, and clears the selection', async () => {
        const onAction = vi.fn<(selected: SelectedLines) => void>();
        const view = stand(selectionAction({ label: 'Add to chat', onAction }));

        await select(view, 2, 8);
        await press();

        expect(onAction).toHaveBeenCalledExactlyOnceWith({ from: 1, to: 2, text: 'pha\nbe' });
        expect(view.state.selection.main.empty).toBe(true);

        await settle();
        expect(host.querySelector('.cm-tooltip')).toBeNull();
    });

    it('does the same on Mod-i', async () => {
        const onAction = vi.fn<(selected: SelectedLines) => void>();
        const view = stand(selectionAction({ label: 'Add to chat', onAction }));

        await select(view, 6, 17);

        expect(await act(async () => modI(view))).toBe(true);
        expect(onAction).toHaveBeenCalledExactlyOnceWith({ from: 2, to: 3, text: 'beta\ngamma' });
        expect(view.state.selection.main.empty).toBe(true);
    });

    it('takes Mod-i from a binding the editor has, which a host\'s extension comes after', async () => {
        const onAction = vi.fn();
        const own = vi.fn(() => true);
        // The editor's own keymap first, as `CodeEditor` has it (`defaultKeymap` binds `Mod-i` to select the parent syntax), then the host's extension.
        const view = stand([keymap.of([{ key: 'Mod-i', run: own }]), selectionAction({ label: 'Add to chat', onAction })]);

        await select(view, 5, 8);
        await act(async () => modI(view));

        expect(onAction).toHaveBeenCalledOnce();
        expect(own).not.toHaveBeenCalled();
    });

    it('leaves Mod-i to the editor while nothing is selected', async () => {
        const onAction = vi.fn();
        const own = vi.fn(() => true);
        const view = stand([keymap.of([{ key: 'Mod-i', run: own }]), selectionAction({ label: 'Add to chat', onAction })]);

        await select(view, 6, 6);

        expect(modI(view)).toBe(true);
        expect(own).toHaveBeenCalledOnce();
        expect(onAction).not.toHaveBeenCalled();
    });

    it('adds nothing without a host callback: no button, and Mod-i is the editor\'s', async () => {
        const own = vi.fn(() => true);
        const view = stand([keymap.of([{ key: 'Mod-i', run: own }]), selectionAction({ label: 'Add to chat' })]);

        await select(view, 5, 8);
        await settle();

        expect(host.querySelector('.cm-tooltip')).toBeNull();
        expect(modI(view)).toBe(true);
        expect(own).toHaveBeenCalledOnce();
    });

    it('does not take the key for a selection of blank space', async () => {
        const onAction = vi.fn();
        const view = stand(selectionAction({ label: 'Add to chat', onAction }), 'a\n   \nb');

        await select(view, 2, 5);

        expect(modI(view)).toBe(false);
        expect(onAction).not.toHaveBeenCalled();
    });

    it('moves the same button along with the selection', async () => {
        const view = stand(selectionAction({ label: 'Add to chat', onAction: vi.fn() }));

        await select(view, 2, 8);

        const first = button();

        await select(view, 7, 15);

        expect(button()).toBe(first);
    });

    it('does not take the focus when the button is pressed with the mouse', async () => {
        const view = stand(selectionAction({ label: 'Add to chat', onAction: vi.fn() }));

        await select(view, 2, 8);

        const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });

        button()!.dispatchEvent(down);

        expect(down.defaultPrevented).toBe(true);
    });
});

describe('selectionAction in a diff card', () => {
    let root: Root;

    beforeEach(() => {
        root = createRoot(host);
    });

    afterEach(async () => {
        await act(async () => root.unmount());
    });

    it('quotes the lines of the new text, with the removed ones left out of the count', async () => {
        const onAction = vi.fn<(selected: SelectedLines) => void>();
        const extension = selectionAction({ label: 'Add to chat', onAction });

        await act(async () => {
            root.render(createElement(DiffView, { path: 'notes.txt', original: 'a\nb\nc\nd', modified: 'a\nB\nc\nd', extensions: extension }));
        });
        await act(async () => {
            await new Promise(resolve => setTimeout(resolve, 20));
        });

        const editor = EditorView.findFromDOM(host.querySelector<HTMLElement>('.cm-editor')!)!;

        // The removed line "b" is drawn above "B" but is no part of the document: line 2 of the new text is "B".
        expect(editor.state.doc.toString()).toBe('a\nB\nc\nd');

        await select(editor, 2, 5);
        await press();

        expect(onAction).toHaveBeenCalledExactlyOnceWith({ from: 2, to: 3, text: 'B\nc' });
    });

    it('is added and taken away with the host\'s extensions, without losing the selection', async () => {
        const onAction = vi.fn();
        const render = (extensions?: Extension) => act(async () => {
            root.render(createElement(DiffView, { path: 'notes.txt', original: 'a\nb\nc', modified: 'a\nB\nc', extensions }));
        });

        await render();
        await act(async () => {
            await new Promise(resolve => setTimeout(resolve, 20));
        });

        const editor = EditorView.findFromDOM(host.querySelector<HTMLElement>('.cm-editor')!)!;

        await select(editor, 2, 3);
        expect(button()).toBeNull();

        // A chat opens while the words are selected: the button is there at once.
        await render(selectionAction({ label: 'Add to chat', onAction }));
        expect(button()).not.toBeNull();
        expect(editor.state.selection.main.from).toBe(2);

        await render();
        await settle();
        expect(button()).toBeNull();
    });
});

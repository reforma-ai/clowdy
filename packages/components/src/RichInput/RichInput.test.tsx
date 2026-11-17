import { undoDepth } from '@tiptap/pm/history';
// @vitest-environment happy-dom
import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RichInput } from './RichInput';

import type { Editor } from '@tiptap/core';
import type { RichInputHandle } from './types';

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
});

afterEach(() => {
    act(() => root.unmount());
    host.remove();
});

describe('RichInput', () => {
    it('should keep the editor and focus when the placeholder changes', async() => {
        const ref = createRef<RichInputHandle>();
        const onChange = vi.fn();

        await act(async() => root.render(<RichInput ref={ ref } placeholder="Ask anything" onChange={ onChange } />));
        const editable = host.querySelector<HTMLElement>('[contenteditable="true"]')!;
        const editor = (editable as HTMLElement & { editor: Editor }).editor;

        await act(async() => {
            ref.current!.focus();
            await new Promise(requestAnimationFrame);
        });
        expect(editor.isFocused).toBe(true);
        expect(editable.querySelector('[data-placeholder]')?.getAttribute('data-placeholder')).toBe('Ask anything');

        onChange.mockClear();
        const before = editor.state;

        await act(async() => root.render(<RichInput ref={ ref } placeholder="Queue a follow-up" onChange={ onChange } />));

        expect(host.querySelector('[contenteditable="true"]')).toBe(editable);
        expect((editable as HTMLElement & { editor: Editor }).editor).toBe(editor);
        expect(editor.isDestroyed).toBe(false);
        expect(editor.isFocused).toBe(true);
        expect(editable.querySelector('[data-placeholder]')?.getAttribute('data-placeholder')).toBe('Queue a follow-up');
        // The redraw is an empty transaction: no draft write, no undo step, caret in place.
        expect(onChange).not.toHaveBeenCalled();
        expect(undoDepth(editor.state)).toBe(undoDepth(before));
        expect(editor.state.selection.eq(before.selection)).toBe(true);
    });

    it('should insert a suggestion clicked with the mouse', async() => {
        const items = ['hero.tsx', 'page.tsx'].map(name => ({ value: `file:${ name }`, label: name, kind: 'file' as const }));
        const ref = createRef<RichInputHandle>();

        await act(async() => root.render(
            <RichInput ref={ ref } triggers={ [{ char: '@', accessibilityLabel: 'Mention', onSearch: () => items }] } />
        ));
        const editor = (host.querySelector('[contenteditable="true"]') as HTMLElement & { editor: Editor }).editor;

        await act(async() => {
            ref.current!.focus();
            editor.commands.insertContent('@');
            await new Promise(requestAnimationFrame);
        });
        const page = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(option => option.textContent?.includes('page.tsx'))!;

        await act(async() => {
            const pointer = { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', button: 0, width: 1, height: 1, pressure: 0.5, detail: 1 };

            page.dispatchEvent(new PointerEvent('pointerdown', pointer));
            page.dispatchEvent(new PointerEvent('pointerup', pointer));
            page.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, detail: 1 }));
        });

        expect(ref.current!.getDoc().content?.[0]?.content).toEqual([
            expect.objectContaining({ type: 'composerMention', attrs: expect.objectContaining({ id: 'file:page.tsx', label: 'page.tsx' }) }),
            expect.anything(),
        ]);
        expect(document.querySelector('[role="option"]')).toBeNull();
    });
});

// @vitest-environment happy-dom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DescriptionField } from './DescriptionField';

import type { Editor } from '@tiptap/core';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/*
 * The description field with the real Markdown editor (TipTap runs in happy-dom: the editor's own tests do), against a host that plays the project: a save the host
 * takes becomes the value the field is given, a moment later, as the daemon's event does.
 */

const CHECKLIST = 'Steps:\n\n- [ ] one\n- [ ] two\n- [ ] three';

let container: HTMLDivElement;
let root: Root;
let saves: string[];
let settle: (taken: boolean) => void;
/** Whether the host holds saves until the test settles them. */
let isHolding: boolean;
let setStored: (value: string) => void;

function Host({ initial }: { initial: string }) {
    const [stored, setStoredState] = useState(initial);

    setStored = setStoredState;

    return (
        <DescriptionField
            value={ stored }
            onSave={ async (description) => {
                saves.push(description);

                if (isHolding) {
                    const taken = await new Promise<boolean>(resolve => void (settle = resolve));

                    if (taken) setStoredState(description);

                    return taken;
                }

                setStoredState(description);

                return true;
            } }
        />
    );
}

const mount = (initial: string) => act(async () => root.render(<Host initial={ initial } />));

const prose = () => container.querySelector<HTMLElement>('[contenteditable]')!;
const editor = () => (prose() as HTMLElement & { editor: Editor }).editor;
const checkboxes = () => [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];

/** Types at the end of the document, as a person does. */
const type = (text: string) => act(async () => void editor().chain().focus('end').insertContent(text).run());

const tick = (index: number) => act(async () => checkboxes()[index].click());

/** Focus leaves the editor for the page: React hears it as `focusout`. */
const leave = (to: Element | null = null) => act(async () => void prose().dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: to })));

beforeEach(() => {
    saves = [];
    isHolding = false;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
});

describe('the description field', () => {
    it('shows the description as a Markdown editor, a checklist line a checkbox', async () => {
        await mount(CHECKLIST);

        expect(prose().getAttribute('contenteditable')).toBe('true');
        expect(prose().getAttribute('aria-label')).toBe('Description');
        expect(checkboxes().map(box => box.checked)).toEqual([false, false, false]);
    });

    it('says "Add a description" in an empty one, and drops it once something is typed, without writing it into the text', async () => {
        await mount('');

        expect(container.querySelector('p.is-editor-empty')?.getAttribute('data-placeholder')).toBe('Add a description');
        expect(editor().getMarkdown()).toBe('');

        await type('Steps.');
        await leave();

        expect(container.querySelector('p.is-editor-empty')).toBeNull();
        expect(saves).toEqual(['Steps.']);
    });

    it('shows no hint over a description that has text', async () => {
        await mount(CHECKLIST);

        expect(container.querySelector('[data-placeholder]')).toBeNull();
    });

    it('saves typing when the editor loses focus, and not before', async () => {
        await mount('Steps for the form.');
        await type(' More.');

        expect(saves).toEqual([]);

        await leave();

        expect(saves).toEqual(['Steps for the form. More.']);
    });

    it('saves nothing when the editor loses focus with the text as it was', async () => {
        await mount(CHECKLIST);
        await leave();

        expect(saves).toEqual([]);
    });

    it('does not save when the focus only moves to the toolbar inside the field', async () => {
        await mount('Steps.');
        await type(' More.');
        await leave(container.querySelector('[role="toolbar"] button'));

        expect(saves).toEqual([]);
    });

    it('saves a tick at once, with the checkbox ticked in the text', async () => {
        await mount(CHECKLIST);
        await tick(1);

        expect(saves).toEqual(['Steps:\n\n- [ ] one\n- [x] two\n- [ ] three']);
        expect(checkboxes().map(box => box.checked)).toEqual([false, true, false]);
    });

    it('saves a tick together with the text typed before it that was not saved yet', async () => {
        await mount(CHECKLIST);
        await type(' And more.');

        expect(saves).toEqual([]);

        await tick(0);

        expect(saves).toEqual(['Steps:\n\n- [x] one\n- [ ] two\n- [ ] three And more.']);
    });

    it('does not send the same text again when the focus leaves right after a tick', async () => {
        await mount(CHECKLIST);
        await tick(0);
        await leave();

        expect(saves).toHaveLength(1);
    });

    it('saves several ticks in the order they were made, one at a time, and sends only the newest of those that came while one was on its way', async () => {
        isHolding = true;
        await mount(CHECKLIST);

        await tick(0);
        await tick(1);
        await tick(2);

        // The first is on its way; the others wait behind it.
        expect(saves).toHaveLength(1);

        await act(async () => settle(true));

        expect(saves).toEqual(['Steps:\n\n- [x] one\n- [ ] two\n- [ ] three', 'Steps:\n\n- [x] one\n- [x] two\n- [x] three']);

        await act(async () => settle(true));

        expect(checkboxes().map(box => box.checked)).toEqual([true, true, true]);
    });

    it('puts the stored text back when the daemon refuses a save', async () => {
        isHolding = true;
        await mount(CHECKLIST);
        await tick(0);

        expect(checkboxes()[0].checked).toBe(true);

        await act(async () => settle(false));

        expect(checkboxes().map(box => box.checked)).toEqual([false, false, false]);
    });

    it('shows a change that comes from outside, an agent ticking a line, at once', async () => {
        await mount(CHECKLIST);
        await act(async () => setStored('Steps:\n\n- [x] one\n- [x] two\n- [ ] three'));

        expect(checkboxes().map(box => box.checked)).toEqual([true, true, false]);
        expect(saves).toEqual([]);
    });

    it('keeps text the person has not saved when a change comes from outside, and saves it when they leave', async () => {
        await mount('First.');
        await type(' Mine.');
        await act(async () => setStored('First. Written by an agent.'));

        expect(prose().textContent).toBe('First. Mine.');

        await leave();

        expect(saves).toEqual(['First. Mine.']);
    });

    it('saves what was typed when the panel goes away under the editor', async () => {
        await mount('Steps.');
        await type(' More.');
        await act(async () => root.render(null));

        expect(saves).toEqual(['Steps. More.']);
    });
});

describe('a description the editor cannot write back', () => {
    const HTML = '<div align="center">Logo</div>\n';

    it('shows it read only with the editor\'s reason, and Edit as text swaps in the plain text field', async () => {
        await mount(HTML);

        expect(prose().getAttribute('contenteditable')).toBe('false');
        expect(container.textContent).toContain('can only be edited in source mode');

        const button = [...container.querySelectorAll('button')].find(candidate => candidate.textContent === 'Edit as text')!;

        await act(async () => button.click());

        expect(container.querySelector('[contenteditable]')).toBeNull();

        const field = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Description"]')!;

        expect(field.value).toBe(HTML);

        // It saves the way it did before the editor: on blur, as the field has it.
        await act(async () => {
            Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, '<div>Logo</div>');
            field.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await act(async () => void field.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));

        expect(saves).toEqual(['<div>Logo</div>']);
    });

    it('does not put the old text back over what was edited as plain text, when the panel goes away', async () => {
        await mount(HTML);
        await act(async () => [...container.querySelectorAll('button')].find(candidate => candidate.textContent === 'Edit as text')!.click());

        const field = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Description"]')!;

        await act(async () => {
            Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, 'Plain words.');
            field.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await act(async () => void field.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));

        expect(saves).toEqual(['Plain words.']);

        await act(async () => root.render(null));

        expect(saves).toEqual(['Plain words.']);
    });

    it('edits a description over 256 KB as plain text at once, and says why', async () => {
        await mount('a'.repeat(256 * 1024 + 1));

        expect(container.querySelector('[contenteditable]')).toBeNull();
        expect(container.querySelector('textarea[aria-label="Description"]')).not.toBeNull();
        expect(container.textContent).toContain('This description is too big for the visual editor');
        // The editor's reason, said as the interface says one sentence: without the period.
        expect(container.textContent).toContain('The file is larger than 256 KB');
        expect(container.textContent).not.toContain('256 KB.');
    });

    it('stays plain text once chosen, whatever the text becomes', async () => {
        await mount(HTML);
        await act(async () => [...container.querySelectorAll('button')].find(candidate => candidate.textContent === 'Edit as text')!.click());
        await act(async () => setStored('Plain words now.'));

        expect(container.querySelector('[contenteditable]')).toBeNull();
        expect(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Description"]')!.value).toBe('Plain words now.');
    });
});

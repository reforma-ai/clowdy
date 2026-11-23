// @vitest-environment happy-dom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { installDispatcher } from '../hotkeys/dispatcher';
import { createRegistry } from '../hotkeys/registry';
import { PickerPopover, type PickerOption } from './PickerPopover';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const OPTIONS: PickerOption[] = [
    { id: 'todo', label: 'To do' },
    { id: 'active', label: 'In progress' },
    { id: 'review', label: 'In review', description: 'Needs a look' },
    { id: 'done', label: 'Done' },
];

let container: HTMLDivElement;
let root: Root;
let opener: HTMLButtonElement;
let picks: string[];
let closes: number;

/** The owner of a picker: renders it while it is open, as a screen does. */
function Owner({ selectedIds = [], anchor = true, options = OPTIONS }: { selectedIds?: string[]; anchor?: boolean; options?: PickerOption[] }) {
    const [isOpen, setIsOpen] = useState(true);

    return (
        isOpen && (
            <PickerPopover
                anchor={ anchor ? opener : null }
                options={ options }
                selectedIds={ selectedIds }
                aria-label="Change status"
                placeholder="Change status…"
                onPick={ id => picks.push(id) }
                onClose={ () => {
                    closes++;
                    setIsOpen(false);
                } }
            />
        )
    );
}

async function open(props: Parameters<typeof Owner>[0] = {}) {
    // The button is what has focus when the picker opens, and what it opens beside.
    opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();

    await act(async () => root.render(<Owner { ...props } />));

    // The popover places itself on the next frame, and the search field takes focus after 50 ms.
    await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 80));
    });
}

const search = () => document.querySelector<HTMLInputElement>('input[type="text"]')!;
// The empty state is a row too, without a key.
const rows = () => [...document.querySelectorAll<HTMLElement>('[role="option"][data-key]')];
const labels = () => rows().map(row => row.textContent);

async function type(text: string) {
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(search(), text);
        search().dispatchEvent(new Event('input', { bubbles: true }));
    });
}

async function press(key: string, target: Element = search(), init: KeyboardEventInit = {}) {
    await act(async () => {
        target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
    });
}

beforeEach(() => {
    picks = [];
    closes = 0;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = '';
});

describe('PickerPopover', () => {
    it('lists the options and puts the search field in focus', async () => {
        await open();

        expect(labels()).toEqual(['To do', 'In progress', 'In review' + 'Needs a look', 'Done']);
        expect(document.activeElement).toBe(search());
    });

    it('filters as the person types, on every word in any order, and says so when nothing is left', async () => {
        await open();
        await type('in');

        expect(labels()).toEqual(['In progress', 'In review' + 'Needs a look']);

        await type('review in');

        expect(labels()).toEqual(['In review' + 'Needs a look']);

        await type('zzz');

        expect(rows()).toHaveLength(0);
        expect(document.body.textContent).toContain('Nothing found');
    });

    it('marks the current options', async () => {
        await open({ selectedIds: ['active'] });

        const marked = rows().filter(row => row.querySelector('[aria-label="Current"]'));

        expect(marked.map(row => row.textContent)).toEqual(['In progress']);
    });

    it('picks the highlighted row on Enter, and closes', async () => {
        await open();
        await press('ArrowDown');
        await press('ArrowDown');
        await press('Enter');

        expect(picks).toEqual(['active']);
        expect(closes).toBe(1);
        expect(document.querySelector('[role="listbox"]')).toBeNull();
    });

    it('picks the first row that matches when nothing is highlighted', async () => {
        await open();
        await type('don');
        await press('Enter');

        expect(picks).toEqual(['done']);
    });

    it('picks a row that is already current, so a list that toggles can take a link off', async () => {
        await open({ selectedIds: ['review'] });
        await type('review');
        await press('Enter');

        expect(picks).toEqual(['review']);
    });

    it('picks once when a row is pressed', async () => {
        await open();
        await act(async () => rows()[1].click());

        expect(picks).toEqual(['active']);
        expect(closes).toBe(1);
    });

    it('closes on Escape without picking, even with text in the field', async () => {
        await open();
        await type('prog');
        await press('Escape');

        expect(picks).toEqual([]);
        expect(closes).toBe(1);
        expect(document.querySelector('[role="listbox"]')).toBeNull();
    });

    it('does not pick on the Enter that ends an IME composition', async () => {
        await open();
        await type('don');
        await press('Enter', search(), { isComposing: true, keyCode: 229 });

        expect(picks).toEqual([]);
        expect(closes).toBe(0);

        await press('Enter');

        expect(picks).toEqual(['done']);
    });

    it('does nothing on Enter when no row matches', async () => {
        await open();
        await type('zzz');
        await press('Enter');

        expect(picks).toEqual([]);
        expect(closes).toBe(0);
    });

    it('gives focus back to the element that had it', async () => {
        await open();

        expect(document.activeElement).toBe(search());

        await press('Escape');

        expect(document.activeElement).toBe(opener);
    });

    it('opens without an anchor, near the top of the window', async () => {
        await open({ anchor: false });

        expect(labels()).toHaveLength(4);
        expect(document.querySelector('[data-modal-clickout-layer]')).not.toBeNull();
    });
});

describe('PickerPopover with options that are off', () => {
    const WITH_OFF: PickerOption[] = [
        { id: 'held', label: 'Held branch', isDisabled: true, stacked: true, description: 'Checked out in ~/work/app' },
        { id: 'free', label: 'Free branch' },
        { id: 'held-too', label: 'Held again', isDisabled: true },
    ];

    it('draws an option that is off dimmed with its reason, and the arrows pass it by', async () => {
        await open({ options: WITH_OFF });

        expect(labels()).toEqual(['Held branch' + 'Checked out in ~/work/app', 'Free branch', 'Held again']);
        expect(rows()[0].getAttribute('aria-disabled')).toBe('true');
        expect(rows()[1].getAttribute('aria-disabled')).toBeNull();

        await press('ArrowDown');
        await press('Enter');

        expect(picks).toEqual(['free']);
    });

    it('does not pick an option that is off, pressed or on Enter as the first row that matches, and stays open', async () => {
        await open({ options: WITH_OFF });
        await act(async () => rows()[0].click());

        expect(picks).toEqual([]);

        await type('held');
        await press('Enter');

        expect(picks).toEqual([]);
        expect(closes).toBe(0);
        expect(document.querySelector('[role="listbox"]')).not.toBeNull();
    });
});

describe('PickerPopover and the hotkey dispatcher', () => {
    let registry: ReturnType<typeof createRegistry>;
    let uninstall: () => void;
    let handler: Mock<(event: KeyboardEvent) => void>;

    beforeEach(() => {
        registry = createRegistry('darwin');
        handler = vi.fn<(event: KeyboardEvent) => void>();
        registry.defineCommand({ id: 'tasks.x', title: 'X', group: 'Tasks', keys: ['x', 'ArrowDown', 'Enter', 'Escape'], scope: 'app', handler });
        uninstall = installDispatcher(registry);
    });

    afterEach(() => uninstall());

    it('is an overlay: no command of the page runs for a key typed in it', async () => {
        await open();

        await press('x');
        await press('Escape');

        expect(handler).not.toHaveBeenCalled();
    });

    it('stops being one when it closes', async () => {
        await open();
        await press('Escape');
        await press('x', opener);

        expect(handler).toHaveBeenCalledTimes(1);
    });
});

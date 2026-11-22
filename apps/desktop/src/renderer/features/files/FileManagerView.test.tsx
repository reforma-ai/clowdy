// @vitest-environment happy-dom
import { FileManager } from '@clowdy/file-manager';
import { MemoryFileSystem } from '@clowdy/file-manager/memory';
import { FileManagerView } from '@clowdy/file-manager/react';
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// happy-dom has no layout: the tree measures its host to know how many rows to draw, so it is told a size. The view measures its own box too, and a test can take the width away.
const box = vi.hoisted(() => ({ width: 240, height: 320 }));

vi.mock('use-resize-observer', () => ({ default: () => ({ ref: () => undefined, width: box.width, height: box.height }) }));

let container: HTMLDivElement;
let root: Root;
let manager: FileManager;

const draw = (props: Partial<ComponentProps<typeof FileManagerView>> = {}) => act(() => root.render(<><div id="foreign" draggable="true" /><FileManagerView manager={ manager } { ...props } /></>));

const settle = () => act(async () => {
    await new Promise(resolve => setTimeout(resolve, 20));
});

/** A drag event with a data transfer that records what the handlers set on it, as the browser's own would. */
function dragEvent(type: string, types: string[]) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    const dataTransfer = { types, files: [], items: [], dropEffect: 'none', effectAllowed: 'uninitialized', getData: () => '', setData: () => undefined, setDragImage: () => undefined };

    Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });

    return { event, dataTransfer };
}

beforeEach(async () => {
    box.width = 240;
    box.height = 320;
    manager = new FileManager({ provider: new MemoryFileSystem({ 'a.ts': '', 'b.ts': '' }) });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await manager.start();
    draw();
    await settle();
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
    manager.dispose();
});

describe('the layout of the view', () => {
    it('builds the editor and the tree once its box has a width, not before: a group built in an unsized box leaves the tree at its narrowest', async () => {
        act(() => root.unmount());
        root = createRoot(container);
        box.width = 0;
        draw();
        await settle();

        expect(container.querySelector('[role="treeitem"]')).toBeNull();
        expect(container.querySelector('[aria-label="Resize the file tree"]')).toBeNull();

        // The view is memoized: a changed prop is what makes it measure again, as the observer's own update would.
        box.width = 600;
        draw({ className: 'measured' });
        await settle();

        expect(container.querySelectorAll('[role="treeitem"]').length).toBe(2);
        expect(container.querySelector('[aria-label="Resize the file tree"]')).not.toBeNull();
    });
});

describe('the rows of the tree', () => {
    it('are drawn once the tree\'s host has a height, not before: a list built with none could be asked to scroll to a row and end up out of step with its element', async () => {
        act(() => root.unmount());
        root = createRoot(container);
        box.height = 0;
        draw();
        await settle();

        expect(container.querySelector('[aria-label="Resize the file tree"]')).not.toBeNull();
        expect(container.querySelector('[role="treeitem"]')).toBeNull();

        // The view and the tree are memoized: a changed prop is what makes them measure again, as the observer's own update would.
        box.height = 320;
        draw({ className: 'measured', menuItems: () => [] });
        await settle();

        expect(container.querySelectorAll('[role="treeitem"]').length).toBe(2);
    });
});

describe('the file tree\'s drag and drop', () => {
    it('is on the tree, which has its rows to drag', () => {
        expect(container.querySelectorAll('[role="treeitem"]').length).toBe(2);
        expect(container.querySelector('[role="treeitem"] [draggable="true"]')).not.toBeNull();
    });

    it('leaves a drag that starts outside the tree alone: the window\'s other screens (the task board) drag natively', () => {
        const foreign = container.querySelector('#foreign')!;
        const start = dragEvent('dragstart', ['application/x-clowdy-task']);

        foreign.addEventListener('dragover', (event) => {
            (event as unknown as { dataTransfer: { dropEffect: string } }).dataTransfer.dropEffect = 'move';
        });
        foreign.dispatchEvent(start.event);

        expect(start.event.defaultPrevented).toBe(false);

        const over = dragEvent('dragover', ['application/x-clowdy-task']);

        foreign.dispatchEvent(over.event);

        expect(over.dataTransfer.dropEffect).toBe('move');
    });
});

describe('the button that shows and hides the file tree', () => {
    const buttons = () => [...container.querySelectorAll<HTMLButtonElement>('button[aria-label="File tree"]')];
    const press = (target: HTMLElement) => act(async () => {
        target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse', button: 0, isPrimary: true }));
        target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
        target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'mouse', button: 0, isPrimary: true }));
        target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
        target.click();
    });

    it('is not there when the host gives no way to toggle the tree', () => {
        expect(buttons()).toHaveLength(0);
    });

    it('is one button, pressed in the sidebar\'s header while the tree shows, and in the editor\'s strip while it is hidden, which has it with no file open too', async () => {
        const onSidebarToggle = vi.fn();

        draw({ onSidebarToggle });
        await settle();

        expect(buttons()).toHaveLength(1);
        expect(buttons()[0]!.getAttribute('aria-pressed')).toBe('true');
        expect(buttons()[0]!.closest('aside')).not.toBeNull();

        await press(buttons()[0]!);

        expect(onSidebarToggle).toHaveBeenCalledTimes(1);

        draw({ onSidebarToggle, sidebarOpen: false });
        await settle();

        expect(buttons()).toHaveLength(1);
        expect(buttons()[0]!.getAttribute('aria-pressed')).toBe('false');
        expect(buttons()[0]!.closest('aside')).toBeNull();
        expect(container.querySelector('[role="tree"]')).toBeNull();
    });
});

describe('the menu of a row', () => {
    const press = (target: HTMLElement) => act(async () => {
        target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse', button: 0, isPrimary: true }));
        target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
        target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'mouse', button: 0, isPrimary: true }));
        target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
        target.click();
    });
    const rightClick = (target: HTMLElement) => act(async () => {
        target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }));
    });
    const menuItems = () => [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    const menuItem = (text: string) => menuItems().find(item => item.textContent === text);

    it('draws the items a host adds, and one that has children as a submenu, whose child runs and shuts the menu', async () => {
        const open = vi.fn();
        const copy = vi.fn();
        const parent = vi.fn();

        draw({
            menuItems: targets => (targets.length === 1
                ? [
                    { id: 'open-in', label: 'Open in…', onAction: parent, children: [{ id: 'editor', label: 'Open in Cursor', onAction: open }] },
                    { id: 'copy-path', label: 'Copy path', onAction: copy },
                ]
                : []),
        });
        await settle();
        await rightClick(container.querySelector<HTMLElement>('[role="treeitem"] [draggable="true"]')!);

        // The host's items are after the explorer's own; the one with children is a row that opens a menu, with no child shown yet.
        expect(menuItem('Open in…')?.getAttribute('aria-haspopup')).toBe('menu');
        expect(menuItem('Copy path')).not.toBeUndefined();
        expect(menuItem('Open in Cursor')).toBeUndefined();

        await press(menuItem('Open in…')!);

        expect(menuItem('Open in Cursor')).not.toBeUndefined();

        await press(menuItem('Open in Cursor')!);

        expect(open).toHaveBeenCalledOnce();
        expect(parent).not.toHaveBeenCalled();
        expect(copy).not.toHaveBeenCalled();
        expect(menuItems()).toHaveLength(0);
    });

    it('runs a flat item of the host as before', async () => {
        const copy = vi.fn();

        draw({ menuItems: () => [{ id: 'copy-path', label: 'Copy path', onAction: copy }] });
        await settle();
        await rightClick(container.querySelector<HTMLElement>('[role="treeitem"] [draggable="true"]')!);
        await press(menuItem('Copy path')!);

        expect(copy).toHaveBeenCalledOnce();
        expect(menuItems()).toHaveLength(0);
    });
});

describe('the filter in the header of the file tree', () => {
    const field = () => container.querySelector<HTMLInputElement>('input[aria-label="Filter files"]')!;

    function type(value: string) {
        act(() => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field(), value);
            field().dispatchEvent(new Event('input', { bubbles: true }));
        });
    }

    it('is the header\'s title, in place of a name for it, with the button that hides the tree after it', async () => {
        draw({ onSidebarToggle: () => undefined });
        await settle();

        const toggle = container.querySelector('button[aria-label="File tree"]')!;

        expect(field().closest('aside')).not.toBeNull();
        expect(field().placeholder).toBe('Filter files');
        expect(field().compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(container.querySelector('aside [role="tablist"]')).toBeNull();
    });

    it('filters the tree by name as it is typed, and shows the whole tree again when it is emptied', async () => {
        type('a.');
        await settle();

        expect(manager.filterQuery).toBe('a.');
        expect([...container.querySelectorAll('[role="treeitem"]')].map(row => row.textContent)).toEqual(['a.ts']);

        type('');
        await settle();

        expect(container.querySelectorAll('[role="treeitem"]')).toHaveLength(2);
    });

    it('opens the first file it shows on Enter', async () => {
        type('b.t');
        await settle();
        act(() => void field().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
        await settle();

        expect(manager.tabs.active?.path).toBe('b.ts');
    });
});

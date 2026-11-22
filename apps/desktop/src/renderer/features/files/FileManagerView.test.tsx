// @vitest-environment happy-dom
import { FileManager } from '@clowdy/file-manager';
import { MemoryFileSystem } from '@clowdy/file-manager/memory';
import { FileManagerView } from '@clowdy/file-manager/react';
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// happy-dom has no layout: the tree measures its host to know how many rows to draw, so it is told a size.
vi.mock('use-resize-observer', () => ({ default: () => ({ ref: () => undefined, width: 240, height: 320 }) }));

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

describe('the shortcuts of the view', () => {
    // Both modifiers, so it is the shortcut's key whichever platform the test window takes itself for.
    const press = (code: string, shiftKey = false) => act(() => {
        container.querySelector('[role="tablist"]')!.dispatchEvent(new KeyboardEvent('keydown', { code, shiftKey, metaKey: true, ctrlKey: true, bubbles: true, cancelable: true }));
    });

    it('asks the host to show the sidebar when the filter or the search is wanted while it is hidden', async () => {
        const onSidebarRequest = vi.fn();

        draw({ sidebarOpen: false, onSidebarRequest });
        await settle();

        expect(container.querySelector('[role="tree"]')).toBeNull();

        // The tab strip shows once a file is open, and the keys come from the editor's side.
        await manager.open('a.ts');
        await settle();
        await press('KeyP');

        expect(onSidebarRequest).toHaveBeenCalledTimes(1);
        expect(manager.filterOpen).toBe(true);

        await press('KeyF', true);

        expect(onSidebarRequest).toHaveBeenCalledTimes(2);
        expect(manager.panel).toBe('search');
    });

    it('does not ask while the sidebar shows', async () => {
        const onSidebarRequest = vi.fn();

        draw({ onSidebarRequest });
        await manager.open('a.ts');
        await settle();
        await press('KeyP');

        expect(manager.filterOpen).toBe(true);
        expect(onSidebarRequest).not.toHaveBeenCalled();
    });
});

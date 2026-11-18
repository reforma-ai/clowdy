// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChatDropZone } from './ChatDropZone';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
});

const zone = () => container.firstElementChild as HTMLElement;
const veil = () => container.textContent?.includes('Drop files');

/** An event the way a browser makes it while files are dragged: the transfer lists `Files`. */
function dragEvent(type: string, files: File[] = []) {
    const event = new Event(type, { bubbles: true, cancelable: true });

    Object.defineProperty(event, 'dataTransfer', { value: { types: ['Files'], files, items: [], dropEffect: 'none' } });

    return event;
}

describe('ChatDropZone', () => {
    it('shows the veil while files are dragged over, and hands the dropped files over', async () => {
        const onFiles = vi.fn();
        const file = new File(['a'], 'a.txt');

        await act(async () => root.render(<ChatDropZone onFiles={ onFiles }><p>chat</p></ChatDropZone>));

        expect(veil()).toBe(false);

        await act(async () => void zone().dispatchEvent(dragEvent('dragenter')));

        expect(veil()).toBe(true);

        await act(async () => void zone().dispatchEvent(dragEvent('drop', [file])));

        expect(veil()).toBe(false);
        expect(onFiles).toHaveBeenCalledWith([file]);
    });

    it('lets go of the veil when the drag leaves', async () => {
        await act(async () => root.render(<ChatDropZone onFiles={ vi.fn() }><p>chat</p></ChatDropZone>));
        await act(async () => void zone().dispatchEvent(dragEvent('dragenter')));
        await act(async () => void zone().dispatchEvent(dragEvent('dragleave')));

        expect(veil()).toBe(false);
    });

    it('takes files pasted into it, and leaves a paste of text alone', async () => {
        const onFiles = vi.fn();
        const file = new File(['a'], 'shot.png', { type: 'image/png' });

        await act(async () => root.render(<ChatDropZone onFiles={ onFiles }><p>chat</p></ChatDropZone>));

        const paste = (files: File[]) => {
            const event = new Event('paste', { bubbles: true, cancelable: true });

            Object.defineProperty(event, 'clipboardData', { value: { files, items: [], types: files.length > 0 ? ['Files'] : ['text/plain'] } });
            act(() => void zone().dispatchEvent(event));

            return event;
        };

        expect(paste([]).defaultPrevented).toBe(false);
        expect(onFiles).not.toHaveBeenCalled();
        expect(paste([file]).defaultPrevented).toBe(true);
        expect(onFiles).toHaveBeenCalledWith([file]);
    });
});

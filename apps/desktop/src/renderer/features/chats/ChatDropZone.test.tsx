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

    it('takes nothing while it is disabled: no veil, no files from a drop or a paste', async () => {
        const onFiles = vi.fn();
        const file = new File(['a'], 'a.txt');

        await act(async () => root.render(<ChatDropZone disabled onFiles={ onFiles }><p>chat</p></ChatDropZone>));
        await act(async () => void zone().dispatchEvent(dragEvent('dragenter')));

        expect(veil()).toBe(false);

        const drop = dragEvent('drop', [file]);
        const paste = new Event('paste', { bubbles: true, cancelable: true });

        Object.defineProperty(paste, 'clipboardData', { value: { files: [file], items: [], types: ['Files'] } });
        await act(async () => void zone().dispatchEvent(drop));
        await act(async () => void zone().dispatchEvent(paste));

        expect(onFiles).not.toHaveBeenCalled();
        expect(drop.defaultPrevented).toBe(false);
        expect(paste.defaultPrevented).toBe(false);
    });

    it('listens on the document once however often it is switched, and not any more when it is gone', async () => {
        const added = vi.spyOn(document, 'addEventListener');
        const removed = vi.spyOn(document, 'removeEventListener');
        const count = (spy: typeof added, type: string) => spy.mock.calls.filter(([name]) => name === type).length;

        await act(async () => root.render(<ChatDropZone onFiles={ vi.fn() }><p>chat</p></ChatDropZone>));
        await act(async () => root.render(<ChatDropZone disabled onFiles={ vi.fn() }><p>chat</p></ChatDropZone>));
        await act(async () => root.render(<ChatDropZone onFiles={ vi.fn() }><p>chat</p></ChatDropZone>));

        expect(count(added, 'dragend')).toBe(1);
        expect(count(removed, 'dragend')).toBe(0);

        await act(async () => root.render(<p>other</p>));

        expect(count(removed, 'dragend')).toBe(1);

        added.mockRestore();
        removed.mockRestore();
    });

    it('takes files again when it is enabled again, and lets go of a veil that was up when it was switched off', async () => {
        const onFiles = vi.fn();
        const file = new File(['a'], 'a.txt');

        await act(async () => root.render(<ChatDropZone onFiles={ onFiles }><p>chat</p></ChatDropZone>));
        await act(async () => void zone().dispatchEvent(dragEvent('dragenter')));

        expect(veil()).toBe(true);

        await act(async () => root.render(<ChatDropZone disabled onFiles={ onFiles }><p>chat</p></ChatDropZone>));

        expect(veil()).toBe(false);

        await act(async () => root.render(<ChatDropZone onFiles={ onFiles }><p>chat</p></ChatDropZone>));

        // A drag that was cut short by the switch must not leave a veil behind once the zone takes files again.
        expect(veil()).toBe(false);

        await act(async () => void zone().dispatchEvent(dragEvent('drop', [file])));

        expect(onFiles).toHaveBeenCalledWith([file]);
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

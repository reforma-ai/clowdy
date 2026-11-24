// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { useFileDragHover } from './useFileDragHover';

const open = vi.fn();
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function Example() {
    useFileDragHover(element => element.closest<HTMLElement>('[data-key]')?.dataset.key, open);
    return (
        <>
            <div data-key="chat">
                <span>Chat</span>
            </div>
            <div data-key="files">Files</div>
            <div>Outside</div>
        </>
    );
}

function drag(element: Element, type: string, types = ['Files']) {
    const event = new Event(type, { bubbles: true });
    Object.defineProperty(event, 'dataTransfer', { value: { types } });
    element.dispatchEvent(event);
}

beforeEach(() => {
    vi.useFakeTimers();
    open.mockReset();
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() => root.render(<Example />));
});

afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.useRealTimers();
});

it('opens a file destination after one second and only once while staying there', () => {
    const chat = host.querySelector('[data-key="chat"]')!;
    drag(chat, 'dragover');
    vi.advanceTimersByTime(700);
    drag(chat.querySelector('span')!, 'dragover');
    vi.advanceTimersByTime(299);
    expect(open).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(open).toHaveBeenCalledExactlyOnceWith('chat');
    drag(chat, 'dragover');
    vi.advanceTimersByTime(2000);
    expect(open).toHaveBeenCalledTimes(1);
});

it('cancels on moving away, dropping, ending the drag, and other drag types', () => {
    const chat = host.querySelector('[data-key="chat"]')!;
    const files = host.querySelector('[data-key="files"]')!;
    drag(chat, 'dragover');
    vi.advanceTimersByTime(500);
    drag(files, 'dragover');
    vi.advanceTimersByTime(500);
    expect(open).not.toHaveBeenCalled();
    drag(files, 'drop');
    vi.advanceTimersByTime(1000);
    drag(chat, 'dragover');
    drag(chat, 'dragend');
    vi.advanceTimersByTime(1000);
    drag(chat, 'dragover', ['application/x-chat']);
    vi.advanceTimersByTime(1000);
    expect(open).not.toHaveBeenCalled();
    drag(files, 'dragover');
    vi.advanceTimersByTime(1000);
    expect(open).toHaveBeenCalledExactlyOnceWith('files');
});

it('cancels when the drag leaves the window or the destination unmounts', () => {
    const chat = host.querySelector('[data-key="chat"]')!;
    drag(chat, 'dragover');
    drag(document.documentElement, 'dragleave');
    vi.advanceTimersByTime(1000);
    expect(open).not.toHaveBeenCalled();
    drag(chat, 'dragover');
    act(() => root.unmount());
    vi.advanceTimersByTime(1000);
    expect(open).not.toHaveBeenCalled();
    root = createRoot(host);
});

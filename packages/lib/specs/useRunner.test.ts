// @vitest-environment happy-dom
import { act, createElement, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useRunner, type UseRunnerOptions } from '../src/useRunner';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let onChange: ReturnType<typeof vi.fn<(value: number) => void>>;

function Probe(props: Partial<UseRunnerOptions>) {
    const ref = useRef<HTMLDivElement>(null);

    useRunner(ref, { value: 100, onChange, allowFakeCursor: false, step: 1, shiftStep: 10, ...props });

    return createElement('div', { ref, 'data-testid': 'runner' });
}

function mount(props: Partial<UseRunnerOptions> = {}) {
    act(() => root.render(createElement(Probe, props)));
}

const field = () => container.querySelector('[data-testid="runner"]') as HTMLElement;
// The drag overlay is the only element the hook appends to the body.
const overlay = () => document.body.lastElementChild as HTMLElement;

const pointer = (type: string, init: PointerEventInit) => new PointerEvent(type, { bubbles: true, cancelable: true, ...init });
const key = (type: 'keydown' | 'keyup', shiftKey: boolean) => new KeyboardEvent(type, { key: 'Shift', shiftKey, bubbles: true });

function down(init: PointerEventInit = {}) {
    act(() => {
        field().dispatchEvent(pointer('pointerdown', { clientX: 0, clientY: 0, ...init }));
    });
}

function move(clientX: number, init: PointerEventInit = {}) {
    act(() => {
        overlay().dispatchEvent(pointer('pointermove', { clientX, clientY: 0, ...init }));
    });
}

function press(event: KeyboardEvent) {
    act(() => {
        window.dispatchEvent(event);
    });
}

beforeEach(() => {
    onChange = vi.fn();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.replaceChildren();
});

describe('useRunner modifier keys', () => {
    it('steps by `step` while Shift is up and by `shiftStep` when the pointer event carries Shift', () => {
        mount();
        down();
        move(5);
        expect(onChange).toHaveBeenLastCalledWith(105);

        move(5, { shiftKey: true });
        expect(onChange).toHaveBeenLastCalledWith(150);
    });

    it('starts with the step of Shift held on pointerdown', () => {
        mount();
        down({ shiftKey: true });
        move(2, { shiftKey: true });

        expect(onChange).toHaveBeenLastCalledWith(120);
    });

    it('re-applies the step when Shift toggles without pointer movement, and ignores repeats', () => {
        mount();
        down();
        move(3);
        expect(onChange).toHaveBeenLastCalledWith(103);

        press(key('keydown', true));
        expect(onChange).toHaveBeenLastCalledWith(130);

        const calls = onChange.mock.calls.length;

        press(key('keydown', true));
        expect(onChange).toHaveBeenCalledTimes(calls);

        press(key('keyup', false));
        expect(onChange).toHaveBeenLastCalledWith(103);
    });

    it('stops following Shift once the drag ends', () => {
        mount();
        down();
        move(3);
        act(() => {
            overlay().dispatchEvent(pointer('pointerup', { clientX: 3 }));
        });

        const calls = onChange.mock.calls.length;

        press(key('keydown', true));
        expect(onChange).toHaveBeenCalledTimes(calls);
    });

    it('runs an option drag only when pointerdown carries Alt', () => {
        mount({ option: true });
        down();
        expect(document.body.children).toHaveLength(1);

        down({ altKey: true });
        move(4);
        expect(onChange).toHaveBeenLastCalledWith(104);
    });

    it('passes the pointerdown event to shouldRun', () => {
        const shouldRun = vi.fn((_target: HTMLElement, event: PointerEvent) => event.altKey);

        mount({ shouldRun });
        down();
        move(4);
        expect(onChange).not.toHaveBeenCalled();

        down({ altKey: true });
        move(4);
        expect(shouldRun).toHaveBeenCalledTimes(2);
        expect(onChange).toHaveBeenLastCalledWith(104);
    });
});

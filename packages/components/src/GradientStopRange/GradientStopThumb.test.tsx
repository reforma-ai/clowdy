// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GradientStopThumb, type GradientStopThumbProps } from './GradientStopThumb';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const actions = () => ({
    onActiveStopChange: vi.fn(),
    onStopPreview: vi.fn(),
    onStopCommit: vi.fn(),
    onStopCancel: vi.fn(),
    onStopRemove: vi.fn(),
});

function draw(props: Partial<GradientStopThumbProps> & { actions: GradientStopThumbProps['actions'] }) {
    act(() =>
        root.render(
            <GradientStopThumb
                stop={{ id: 'a', color: '#f00', position: 0.5 }}
                index={0}
                ariaLabel="Fill"
                trackRef={{ current: container }}
                options={{ min: 0, max: 1, step: 0.01, shiftStep: 0.1 }}
                {...props}
            />
        )
    );

    return container.querySelector<HTMLElement>('[role="slider"]')!;
}

const press = (thumb: HTMLElement, key: string) =>
    act(() => {
        thumb.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    });

beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
});

describe('GradientStopThumb', () => {
    it('moves a step with an arrow key as one drag: previews it, then commits it', () => {
        const calls = actions();
        const onDraggingChange = vi.fn();
        const thumb = draw({ actions: calls, onDraggingChange });

        press(thumb, 'ArrowRight');

        expect(calls.onActiveStopChange).toHaveBeenCalledWith('a');
        expect(calls.onStopPreview).toHaveBeenCalledWith('a', 0.51);
        expect(calls.onStopCommit).toHaveBeenCalledExactlyOnceWith('a', 0.51);
        expect(onDraggingChange.mock.calls).toEqual([[true], [false]]);
    });

    it('moves to the end with End: previews and commits the same position once', () => {
        const calls = actions();
        const thumb = draw({ actions: calls });

        press(thumb, 'End');

        expect(calls.onActiveStopChange).toHaveBeenCalledWith('a');
        expect(calls.onStopPreview).toHaveBeenCalledExactlyOnceWith('a', 1);
        expect(calls.onStopCommit).toHaveBeenCalledExactlyOnceWith('a', 1);
    });

    it('cancels with Escape and ends the drag', () => {
        const calls = actions();
        const onDraggingChange = vi.fn();
        const thumb = draw({ actions: calls, onDraggingChange });

        press(thumb, 'Escape');

        expect(calls.onStopCancel).toHaveBeenCalledExactlyOnceWith('a');
        expect(onDraggingChange).toHaveBeenCalledExactlyOnceWith(false);
        expect(calls.onStopCommit).not.toHaveBeenCalled();
    });

    it('removes its stop with Delete unless another stop is the active one', () => {
        const calls = actions();
        const thumb = draw({ actions: calls });

        press(thumb, 'Delete');
        expect(calls.onStopRemove).toHaveBeenCalledExactlyOnceWith('a');

        calls.onStopRemove.mockClear();
        press(draw({ actions: calls, activeStopId: 'b' }), 'Delete');
        expect(calls.onStopRemove).not.toHaveBeenCalled();
    });

    it('moves nothing when read-only, and does nothing at all when disabled', () => {
        const calls = actions();
        const readOnly = draw({ actions: calls, isReadOnly: true });

        press(readOnly, 'End');
        press(readOnly, 'ArrowRight');
        expect(calls.onStopCommit).not.toHaveBeenCalled();

        press(readOnly, 'Escape');
        expect(calls.onStopCancel).toHaveBeenCalledTimes(1);

        const disabled = draw({ actions: calls, isDisabled: true });

        press(disabled, 'Escape');
        expect(calls.onStopCancel).toHaveBeenCalledTimes(1);
    });
});

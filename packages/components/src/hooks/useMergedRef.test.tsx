// @vitest-environment happy-dom
import { act, createRef, type Ref } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useMergedRef } from './useMergedRef';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function Host({ first, second }: { first?: Ref<HTMLDivElement>; second?: Ref<HTMLDivElement> }) {
    return <div ref={ useMergedRef(first, second) } data-host />;
}

const draw = (first?: Ref<HTMLDivElement>, second?: Ref<HTMLDivElement>) => act(() => root.render(<Host first={ first } second={ second } />));
const node = () => container.querySelector('[data-host]');

beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
});

describe('useMergedRef', () => {
    it('hands the node to an object ref and to a function ref, and takes it back on unmount', () => {
        const object = createRef<HTMLDivElement>();
        const callback = vi.fn();

        draw(object, callback);

        expect(node()).not.toBeNull();
        expect(object.current).toBe(node());
        expect(callback).toHaveBeenLastCalledWith(node());

        act(() => root.render(null));

        expect(object.current).toBeNull();
        expect(callback).toHaveBeenLastCalledWith(null);
    });

    it('works when one ref or both are missing', () => {
        const object = createRef<HTMLDivElement>();

        draw(undefined, object);
        expect(object.current).toBe(node());

        draw(null, null);
        expect(object.current).toBeNull();
        expect(node()).not.toBeNull();
    });

    it('does not detach and reattach the node while the refs stay the same', () => {
        const object = createRef<HTMLDivElement>();
        const callback = vi.fn();

        draw(object, callback);
        draw(object, callback);
        draw(object, callback);

        expect(callback).toHaveBeenCalledTimes(1);
    });

    it('moves the node to the new ref when a ref changes', () => {
        const before = createRef<HTMLDivElement>();
        const after = createRef<HTMLDivElement>();
        const kept = createRef<HTMLDivElement>();

        draw(kept, before);
        draw(kept, after);

        expect(before.current).toBeNull();
        expect(after.current).toBe(node());
        expect(kept.current).toBe(node());
    });
});

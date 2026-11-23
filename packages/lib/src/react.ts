import React from 'react';
import { createRoot, type Root } from 'react-dom/client';

import type { ComponentType, Ref } from 'react';

/** Reuse roots across HMR re-entry so we never createRoot() twice on the same node. */
const roots = new WeakMap<HTMLElement, Root>();

/**
 * Mounts a React component to a DOM element
 *
 * @param component - React component to mount
 * @param container - DOM element or selector string (e.g., '#root' or '.app')
 * @throws Error if container is not found
 *
 * @example
 * ```tsx
 * import { mount } from '@clowdy/lib/react';
 * import MyComponent from './MyComponent';
 *
 * mount(MyComponent, '#root');
 * ```
 */
export function mount<T extends Record<string, unknown> = Record<string, never>>(
    component: ComponentType<T>,
    container: HTMLElement | string
): void {
    const element = typeof container === 'string' ? document.querySelector<HTMLElement>(container) : container;

    if (!element) {
        throw new Error(`Container not found: ${typeof container === 'string' ? container : 'provided element'}`);
    }

    let root = roots.get(element);

    if (!root) {
        root = createRoot(element);
        roots.set(element, root);
    }

    root.render(React.createElement(component));
}

/**
 * Merges multiple refs into a single ref callback.
 * Useful when you need to forward a ref while also maintaining an internal ref.
 *
 * @param refs - Array of refs to merge (can include RefObject, callback refs, or null)
 * @returns A callback ref that updates all provided refs
 *
 * @example
 * ```tsx
 * import { mergeRefs } from '@clowdy/lib/react';
 *
 * function MyComponent({ ref, ...props }) {
 *   const internalRef = useRef(null);
 *   const mergedRef = mergeRefs([ref, internalRef]);
 *
 *   return <input ref={mergedRef} {...props} />;
 * }
 * ```
 */
export function mergeRefs<T>(...refs: Array<Ref<T> | null | undefined>): Ref<T> {
    return (value: T | null) => {
        refs.flat().forEach(ref => {
            if (typeof ref === 'function') {
                ref(value);
            } else if (ref != null && 'current' in ref) {
                (ref as { current: T | null }).current = value;
            }
        });
    };
}

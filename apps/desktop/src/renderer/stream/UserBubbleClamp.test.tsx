// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { UserBubble } from './UserBubble';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
/** What the clamp measures: the height of its content, and the height it is allowed. */
let layout = { scrollHeight: 0, clientHeight: 0 };

beforeEach(() => {
    layout = { scrollHeight: 0, clientHeight: 0 };
    vi.stubGlobal(
        'ResizeObserver',
        class {
            observe = () => undefined;
            disconnect = () => undefined;
            unobserve = () => undefined;
        }
    );
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
        configurable: true,
        get: () => layout.scrollHeight,
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
        configurable: true,
        get: () => layout.clientHeight,
    });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(HTMLElement.prototype, 'scrollHeight');
    Reflect.deleteProperty(HTMLElement.prototype, 'clientHeight');
});

const draw = (text: string) => act(async () => root.render(<UserBubble text={text} at={0} />));
const toggle = () => [...container.querySelectorAll('button')].find(button => button.textContent?.includes('Show'));
const long = 'word '.repeat(200);

describe('UserBubble clamp', () => {
    it('offers the whole of a long message that does not fit', async () => {
        layout = { scrollHeight: 600, clientHeight: 250 };
        await draw(long);

        expect(toggle()?.textContent).toBe('Show full message');
        expect(toggle()?.getAttribute('aria-expanded')).toBe('false');

        await act(async () => toggle()!.click());

        expect(toggle()?.textContent).toBe('Show less');
        expect(toggle()?.getAttribute('aria-expanded')).toBe('true');
    });

    it('offers nothing when a long message fits anyway', async () => {
        layout = { scrollHeight: 200, clientHeight: 250 };
        await draw(long);

        expect(toggle()).toBeUndefined();
    });

    it('leaves a short message without a clamp', async () => {
        layout = { scrollHeight: 600, clientHeight: 250 };
        await draw('Fix the form');

        expect(toggle()).toBeUndefined();
    });
});

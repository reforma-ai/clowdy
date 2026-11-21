// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AssistantMessage } from './AssistantMessage';
import { MessageActions } from './MessageActions';
import { UserBubble } from './UserBubble';

// Streamdown highlights code with Shiki, whose WebAssembly cannot load under happy-dom; the words and the row are what is checked here.
vi.mock('./Markdown', () => ({ Markdown: ({ text }: { text: string }) => <div data-testid="rendered">{ text.replaceAll('**', '') }</div> }));
vi.mock('@clowdy/components/Toast', () => ({ toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn(), info: vi.fn(), show: vi.fn() } }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
    // Pins "today" so the time is the same on every day the test runs.
    vi.spyOn(Date, 'now').mockReturnValue(new Date(2026, 10, 20, 12, 0).getTime());
    writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

const at = new Date(2025, 10, 19, 22, 54).getTime();
const copyButton = () => container.querySelector<HTMLButtonElement>('button[aria-label="Copy message"]');

describe('MessageActions', () => {
    it('copies the message as it was written, Markdown included, and not the words as they are drawn', async () => {
        const source = 'Make the **title** bigger\n\n- one\n- two\n\n```ts\nconst a = 1;\n```';

        await act(async () => root.render(<UserBubble text={ source } at={ at } actions="hover" />));

        expect(container.querySelector('[data-testid="rendered"]')?.textContent).not.toContain('**');

        await act(async () => copyButton()!.click());

        expect(writeText).toHaveBeenCalledExactlyOnceWith(source);
    });

    it('copies the source Markdown of an answer too', async () => {
        const source = '## Done\n\nFixed `form.tsx` in **two** places.';

        await act(async () => root.render(<AssistantMessage text={ source } at={ at } actions="hover" />));
        await act(async () => copyButton()!.click());

        expect(writeText).toHaveBeenCalledExactlyOnceWith(source);
    });

    it('shows Copied on the button once the text is on the clipboard', async () => {
        await act(async () => root.render(<MessageActions text="Hello" at={ at } align="end" show="hover" />));

        expect(copyButton()?.querySelector('[data-copied]')).toBeNull();

        await act(async () => copyButton()!.click());

        expect(copyButton()?.querySelector('[data-copied]')).not.toBeNull();
    });

    it('writes the time as a time element with the whole date on its tooltip', async () => {
        await act(async () => root.render(<MessageActions text="Hello" at={ at } align="start" show="hover" />));

        const time = container.querySelector('time');

        expect(time?.textContent).toMatch(/^19 Nov 2025, 22:54$/);
        expect(time?.getAttribute('datetime')).toBe(new Date(at).toISOString());
        expect(time?.getAttribute('title')).toMatch(/Wednesday,? 19 November 2025,? (at )?22:54/);
    });

    it('has no Copy for a message of files alone, and keeps its time', async () => {
        await act(async () => root.render(<UserBubble text="" attachments={ [{ id: 'a-1', name: 'shot.png', mediaType: 'image/png', size: 10 }] } at={ at } actions="hover" />));

        expect(copyButton()).toBeNull();
        expect(container.querySelector('time')).not.toBeNull();
    });

    it('tells the stylesheet whether it always shows, and on which side it sits', async () => {
        await act(async () => root.render(<MessageActions text="Hello" at={ at } align="end" show="always" />));

        const row = container.querySelector<HTMLElement>('time')!.parentElement!;

        expect(row.dataset.show).toBe('always');
        expect(row.dataset.align).toBe('end');
    });
});

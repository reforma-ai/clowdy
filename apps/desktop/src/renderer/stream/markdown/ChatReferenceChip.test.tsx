// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

import { Markdown } from '../Markdown';
import { StreamLinksContext } from '../StreamLinks';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it('renders a known chat reference as a button that opens the chat and leaves a missing reference as code', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const onOpenChat = vi.fn();
    const draw = async (title: string) =>
        act(async () =>
            root.render(
                <StreamLinksContext
                    value={{
                        chatOfId: id => (id === 'cht_1' ? { id, title } : undefined),
                        onOpenChat,
                    }}
                >
                    <Markdown text={'See `chat:cht_1` and `chat:missing`'} fromPerson />
                </StreamLinksContext>
            )
        );
    try {
        await draw('Review the API');
        const chip = container.querySelector('button')!;
        expect(chip.textContent).toBe('Review the API');
        expect(container.querySelector('code')?.textContent).toBe('chat:missing');
        act(() => chip.click());
        expect(onOpenChat).toHaveBeenCalledWith('cht_1');
        await draw('Review the new API');
        expect(container.querySelector('button')?.textContent).toBe('Review the new API');
    } finally {
        act(() => root.unmount());
        container.remove();
    }
});

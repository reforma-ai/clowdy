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

        await act(async () => root.render(<UserBubble text={ source } at={ at } actions={ { show: 'hover' } } />));

        expect(container.querySelector('[data-testid="rendered"]')?.textContent).not.toContain('**');

        await act(async () => copyButton()!.click());

        expect(writeText).toHaveBeenCalledExactlyOnceWith(source);
    });

    it('copies the source Markdown of an answer too', async () => {
        const source = '## Done\n\nFixed `form.tsx` in **two** places.';

        await act(async () => root.render(<AssistantMessage text={ source } at={ at } actions={ { show: 'hover' } } />));
        await act(async () => copyButton()!.click());

        expect(writeText).toHaveBeenCalledExactlyOnceWith(source);
    });

    it('shows Copied on the button once the text is on the clipboard', async () => {
        await act(async () => root.render(<MessageActions text="Hello" at={ at } align="end" actions={ { show: 'hover' } } />));

        expect(copyButton()?.querySelector('[data-copied]')).toBeNull();

        await act(async () => copyButton()!.click());

        expect(copyButton()?.querySelector('[data-copied]')).not.toBeNull();
    });

    it('writes the time as a time element with the whole date on its tooltip', async () => {
        await act(async () => root.render(<MessageActions text="Hello" at={ at } align="start" actions={ { show: 'hover' } } />));

        const time = container.querySelector('time');

        expect(time?.textContent).toMatch(/^19 Nov 2025, 22:54$/);
        expect(time?.getAttribute('datetime')).toBe(new Date(at).toISOString());
        expect(time?.getAttribute('title')).toMatch(/Wednesday,? 19 November 2025,? (at )?22:54/);
    });

    it('has no Copy for a message of files alone, and keeps its time', async () => {
        await act(async () => root.render(<UserBubble text="" attachments={ [{ id: 'a-1', name: 'shot.png', mediaType: 'image/png', size: 10 }] } at={ at } actions={ { show: 'hover' } } />));

        expect(copyButton()).toBeNull();
        expect(container.querySelector('time')).not.toBeNull();
    });

    it('tells the stylesheet whether it always shows, and on which side it sits', async () => {
        await act(async () => root.render(<MessageActions text="Hello" at={ at } align="end" actions={ { show: 'always' } } />));

        const row = container.querySelector<HTMLElement>('time')!.parentElement!;

        expect(row.dataset.show).toBe('always');
        expect(row.dataset.align).toBe('end');
    });
    describe('Reply', () => {
        const replyButton = () => container.querySelector<HTMLButtonElement>('button[aria-label="Reply"]');
        const order = () => [...container.querySelectorAll('time, button')].map(node => (node.tagName === 'TIME' ? 'time' : node.getAttribute('aria-label')));

        it('quotes the person\'s message as it was written, Markdown included, and not the words as they are drawn', async () => {
            const onReply = vi.fn();
            const source = 'Make the **title** bigger\n\n- one\n- two';

            await act(async () => root.render(<UserBubble text={ source } at={ at } actions={ { show: 'hover', onReply } } />));
            await act(async () => replyButton()!.click());

            expect(onReply).toHaveBeenCalledExactlyOnceWith(source);
        });

        it('quotes the source Markdown of an answer too', async () => {
            const onReply = vi.fn();
            const source = '## Done\n\nFixed `form.tsx` in **two** places.';

            await act(async () => root.render(<AssistantMessage text={ source } at={ at } actions={ { show: 'hover', onReply } } />));
            await act(async () => replyButton()!.click());

            expect(onReply).toHaveBeenCalledExactlyOnceWith(source);
        });

        it('is drawn only where a handler is given', async () => {
            await act(async () => root.render(<MessageActions text="Hello" at={ at } align="end" actions={ { show: 'hover' } } />));

            expect(replyButton()).toBeNull();
            expect(copyButton()).not.toBeNull();
        });

        it('has none for a message of files alone, which has nothing to quote', async () => {
            await act(async () => root.render(<UserBubble text="" attachments={ [{ id: 'a-1', name: 'shot.png', mediaType: 'image/png', size: 10 }] } at={ at } actions={ { show: 'hover', onReply: vi.fn() } } />));

            expect(replyButton()).toBeNull();
            expect(container.querySelector('time')).not.toBeNull();
        });

        it('sits before Copy, with the time first on the person\'s side and last on an agent\'s, so the tab order is the reading order', async () => {
            await act(async () => root.render(<MessageActions text="Hello" at={ at } align="end" actions={ { show: 'hover', onReply: vi.fn() } } />));

            expect(order()).toEqual(['time', 'Reply', 'Copy message']);

            await act(async () => root.render(<MessageActions text="Hello" at={ at } align="start" actions={ { show: 'hover', onReply: vi.fn() } } />));

            expect(order()).toEqual(['Reply', 'Copy message', 'time']);
        });

        it('keeps the message root marked for the selection toolbar, with the row inside it', async () => {
            await act(async () => root.render(<UserBubble text="Hello" at={ at } actions={ { show: 'hover' } } />));

            expect(container.querySelector('[data-message]')?.querySelector('time')).not.toBeNull();

            await act(async () => root.render(<AssistantMessage text="Hello" at={ at } actions={ { show: 'hover' } } />));

            expect(container.querySelector('[data-message]')?.querySelector('time')).not.toBeNull();
        });
    });

    describe('Fork', () => {
        const forkButton = () => container.querySelector<HTMLButtonElement>('button[aria-label="Fork"]');
        const order = () => [...container.querySelectorAll('time, button')].map(node => (node.tagName === 'TIME' ? 'time' : node.getAttribute('aria-label')));
        const menu = () => document.body.querySelector('[role="menu"][aria-label="Fork"]');
        const items = () => [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')];
        const itemNamed = (name: string) => items().find(item => item.textContent?.startsWith(name))!;
        const agents = [{ id: 'codex', name: 'Codex' }, { id: 'cursor', name: 'Cursor' }];

        /** A press with a mouse: what React Aria opens a menu on and picks an item with. */
        const press = (target: HTMLElement) => act(async () => {
            target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse', button: 0, isPrimary: true }));
            target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
            target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'mouse', button: 0, isPrimary: true }));
            target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
            target.click();
        });

        /** A key on the focused element, as the keyboard sends it. */
        const key = (target: Element, name: string) => act(async () => {
            target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
            target.dispatchEvent(new KeyboardEvent('keyup', { key: name, bubbles: true, cancelable: true }));
        });

        it('is drawn only where a handler is given', async () => {
            await act(async () => root.render(<AssistantMessage text="Done." at={ at } actions={ { show: 'hover' } } />));

            expect(forkButton()).toBeNull();

            await act(async () => root.render(<AssistantMessage text="Done." at={ at } actions={ { show: 'hover', onFork: vi.fn() } } />));

            expect(forkButton()).not.toBeNull();
        });

        it('opens a menu on a press and not on hover, and Fork in it calls the handler once', async () => {
            const onFork = vi.fn();

            await act(async () => root.render(<AssistantMessage text="Done." at={ at } actions={ { show: 'hover', onFork } } />));
            await act(async () => {
                forkButton()!.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true, pointerType: 'mouse' }));
                forkButton()!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
            });

            expect(menu()).toBeNull();
            expect(onFork).not.toHaveBeenCalled();

            await press(forkButton()!);

            expect(menu()).not.toBeNull();
            expect(onFork).not.toHaveBeenCalled();

            await press(itemNamed('Fork'));

            expect(onFork).toHaveBeenCalledOnce();
            expect(menu()).toBeNull();
        });

        it('has the one item where there is no hand-off, and a second where there is', async () => {
            await act(async () => root.render(<MessageActions text="Done." at={ at } align="start" actions={ { show: 'hover', onFork: vi.fn() } } />));
            await press(forkButton()!);

            expect(items().map(item => item.textContent)).toEqual(['Fork']);

            await act(async () => root.render(<MessageActions text="Done." at={ at } align="start" actions={ { show: 'hover', onFork: vi.fn(), onHandoff: vi.fn(), handoffAgents: agents } } />));

            expect(items().map(item => item.textContent)).toEqual(['Fork', 'Fork to another agent…']);
        });

        it('lists the other agents under Fork to another agent… and hands the conversation to the one picked', async () => {
            const onFork = vi.fn();
            const onHandoff = vi.fn();

            await act(async () => root.render(<MessageActions text="Done." at={ at } align="start" actions={ { show: 'hover', onFork, onHandoff, handoffAgents: agents } } />));
            await press(forkButton()!);
            await press(itemNamed('Fork to another agent'));

            expect(document.body.querySelector('[role="menu"][aria-label="Fork to another agent"]')).not.toBeNull();
            expect([...document.body.querySelectorAll('[role="menu"][aria-label="Fork to another agent"] [role="menuitem"]')].map(item => item.textContent)).toEqual(['Codex', 'Cursor']);

            await press(itemNamed('Cursor'));

            expect(onHandoff).toHaveBeenCalledExactlyOnceWith('cursor');
            expect(onFork).not.toHaveBeenCalled();
            // The whole menu goes once an agent is picked.
            expect(items()).toEqual([]);
        });

        it('says it is open while the menu is (the row stays drawn on it), and Escape shuts it with the focus back on the button', async () => {
            await act(async () => root.render(<MessageActions text="Done." at={ at } align="start" actions={ { show: 'hover', onFork: vi.fn(), onHandoff: vi.fn(), handoffAgents: agents } } />));

            expect(forkButton()!.getAttribute('aria-expanded')).toBe('false');

            await press(forkButton()!);

            expect(forkButton()!.getAttribute('aria-expanded')).toBe('true');

            await key(document.activeElement ?? document.body, 'Escape');

            expect(menu()).toBeNull();
            expect(forkButton()!.getAttribute('aria-expanded')).toBe('false');
            expect(document.activeElement).toBe(forkButton());
        });

        it('opens the agents with the arrow key, hands the conversation to the one chosen with Enter, and gives the focus back to the button', async () => {
            const onHandoff = vi.fn();

            await act(async () => root.render(<MessageActions text="Done." at={ at } align="start" actions={ { show: 'hover', onFork: vi.fn(), onHandoff, handoffAgents: agents } } />));
            await press(forkButton()!);

            const other = itemNamed('Fork to another agent');

            expect(other.getAttribute('aria-haspopup')).toBe('menu');

            await act(async () => other.focus());
            await key(other, 'ArrowRight');

            const codex = itemNamed('Codex');

            await act(async () => codex.focus());
            await key(codex, 'Enter');

            expect(onHandoff).toHaveBeenCalledExactlyOnceWith('codex');
            expect(items()).toEqual([]);
            expect(document.activeElement).toBe(forkButton());
        });

        it('turns Fork to another agent… off, and says why under it, when there is no other agent', async () => {
            const onHandoff = vi.fn();

            await act(async () => root.render(<MessageActions text="Done." at={ at } align="start" actions={ { show: 'hover', onFork: vi.fn(), onHandoff, handoffAgents: [] } } />));
            await press(forkButton()!);

            expect(itemNamed('Fork to another agent').getAttribute('aria-disabled')).toBe('true');
            expect(itemNamed('Fork to another agent').textContent).toContain('No other agent is ready');

            await press(itemNamed('Fork to another agent'));

            expect(document.body.querySelector('[role="menu"][aria-label="Fork to another agent"]')).toBeNull();
            expect(onHandoff).not.toHaveBeenCalled();
        });

        it('sits after Copy and before the time on an answer, so the tab order is the reading order', async () => {
            await act(async () => root.render(<MessageActions text="Done." at={ at } align="start" actions={ { show: 'hover', onReply: vi.fn(), onFork: vi.fn() } } />));

            expect(order()).toEqual(['Reply', 'Copy message', 'Fork', 'time']);
        });

        it('spins and opens no menu while its fork is being made', async () => {
            const onFork = vi.fn();

            await act(async () => root.render(<MessageActions text="Done." at={ at } align="start" actions={ { show: 'hover', onFork, forkState: 'pending' } } />));

            expect(forkButton()?.hasAttribute('data-pending')).toBe(true);

            await press(forkButton()!);

            expect(menu()).toBeNull();
            expect(onFork).not.toHaveBeenCalled();
        });

        it('is off, without a spinner, while another answer is being forked', async () => {
            const onFork = vi.fn();

            await act(async () => root.render(<MessageActions text="Done." at={ at } align="start" actions={ { show: 'hover', onFork, forkState: 'blocked' } } />));

            expect(forkButton()?.disabled).toBe(true);
            expect(forkButton()?.hasAttribute('data-pending')).toBe(false);

            await press(forkButton()!);

            expect(menu()).toBeNull();
            expect(onFork).not.toHaveBeenCalled();
        });

        it('is not drawn for a message of files alone', async () => {
            await act(async () => root.render(<UserBubble text="" attachments={ [{ id: 'a-1', name: 'shot.png', mediaType: 'image/png', size: 10 }] } at={ at } actions={ { show: 'hover', onFork: vi.fn() } } />));

            expect(forkButton()).toBeNull();
        });
    });

    describe('Edit', () => {
        const editButton = () => container.querySelector<HTMLButtonElement>('button[aria-label="Edit message"]');
        const order = () => [...container.querySelectorAll('time, button')].map(node => (node.tagName === 'TIME' ? 'time' : node.getAttribute('aria-label')));

        it('is drawn only where a handler is given, and calls it when pressed', async () => {
            const onEdit = vi.fn();

            await act(async () => root.render(<MessageActions text="Hello" at={ at } align="end" actions={ { show: 'hover' } } />));

            expect(editButton()).toBeNull();

            await act(async () => root.render(<MessageActions text="Hello" at={ at } align="end" actions={ { show: 'hover', onEdit } } />));
            await act(async () => editButton()!.click());

            expect(onEdit).toHaveBeenCalledOnce();
        });

        it('sits between Reply and Copy, with the time first on the person\'s side, so the tab order is the reading order', async () => {
            await act(async () => root.render(<MessageActions text="Hello" at={ at } align="end" actions={ { show: 'hover', onEdit: vi.fn(), onReply: vi.fn() } } />));

            expect(order()).toEqual(['time', 'Reply', 'Edit message', 'Copy message']);
        });

        it('stays for a message of files alone, which can be given words: only Copy and Reply have nothing to work on', async () => {
            const files = [{ id: 'a-1', name: 'shot.png', mediaType: 'image/png', size: 10 }];

            await act(async () => root.render(<UserBubble text="" attachments={ files } at={ at } actions={ { show: 'hover', onEdit: vi.fn(), onReply: vi.fn() } } />));

            expect(order()).toEqual(['time', 'Edit message']);
        });

        it('is a plain button with its own tooltip when the agent is at rest', async () => {
            await act(async () => root.render(<MessageActions text="Hello" at={ at } align="end" actions={ { show: 'hover', onEdit: vi.fn() } } />));

            expect(editButton()?.disabled).toBe(false);
        });
    });
});

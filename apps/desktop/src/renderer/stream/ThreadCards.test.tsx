// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StreamView } from './StreamView';
import { turnMarks } from './turnMarks';

import type { StreamItem, StreamItemBody, ThreadNotice } from '@clowdy/protocol';
import type { StreamLinks } from './StreamLinks';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
/** What the clamp of a notice measures: the height of its content, and the height it is allowed. */
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

const item = (n: number, body: StreamItemBody): StreamItem => ({
    id: `i-${n}`,
    runId: 'r',
    seq: n,
    at: n * 20_000,
    body,
});
const message = item(0, {
    kind: 'user',
    text: 'Use the **staging** keys',
    from: { kind: 'thread', chatId: 'c-parent', title: 'Ship the checkout' },
});
const notices: ThreadNotice[] = [
    { chatId: 'c-a', title: 'Write the refund tests', outcome: 'finished', text: '14 cases, all passing.' },
    { chatId: 'c-b', title: 'Migrate the payments table', outcome: 'failed', text: 'The column already exists' },
    { chatId: 'c-c', title: 'Fix login', outcome: 'interrupted' },
    {
        chatId: 'c-d',
        title: 'Load test',
        outcome: 'finished',
        text: 'The short run held.',
        background: ['k6 run long.js', 'bun run report'],
    },
];
const notice = item(1, { kind: 'user', text: '', from: { kind: 'threadNotice', threads: notices } });

const draw = (items: StreamItem[], links: StreamLinks = {}) =>
    act(async () => root.render(<StreamView items={items} links={links} />));
const cards = (slot: string) => [...container.querySelectorAll<HTMLElement>(`[data-slot="${slot}"]`)];
const linkNamed = (scope: HTMLElement, name: string) =>
    [...scope.querySelectorAll('button')].find(button => button.textContent === name);

describe('a message from another thread', () => {
    it("is a card titled with who wrote it, not the person's bubble, with the words as Markdown", async () => {
        await draw([message]);

        const [card] = cards('thread-message');

        expect(card.textContent).toContain('Message from Ship the checkout');
        expect(card.querySelector('[data-streamdown="strong"]')?.textContent).toBe('staging');
        // No time under it: it is not the person's message, so it has no row of actions.
        expect(container.querySelector('time')).toBeNull();
        expect(card.getAttribute('data-turn')).toBe('i-0');
    });

    it('opens the chat that wrote it from its name', async () => {
        const onOpenChat = vi.fn();

        await draw([message], { onOpenChat, hasChat: () => true });
        await act(async () => linkNamed(cards('thread-message')[0], 'Ship the checkout')!.click());

        expect(onOpenChat).toHaveBeenCalledWith('c-parent');
    });

    it("clamps a long message, as the person's long messages are, with a toggle that opens the rest", async () => {
        layout = { scrollHeight: 900, clientHeight: 300 };
        await draw([message]);

        const toggle = linkNamed(cards('thread-message')[0], 'Show full message')!;

        expect(toggle.getAttribute('aria-expanded')).toBe('false');

        await act(async () => toggle.click());

        expect(linkNamed(cards('thread-message')[0], 'Show less')?.getAttribute('aria-expanded')).toBe('true');
    });

    it('has no toggle for a message that fits', async () => {
        await draw([message]);

        expect(linkNamed(cards('thread-message')[0], 'Show full message')).toBeUndefined();
    });

    it('names a chat that is gone in plain words', async () => {
        await draw([message], { onOpenChat: vi.fn(), hasChat: () => false });

        expect(linkNamed(cards('thread-message')[0], 'Ship the checkout')).toBeUndefined();
        expect(cards('thread-message')[0].textContent).toContain('Message from Ship the checkout');
    });
});

describe('threads that stopped', () => {
    it('is one card per thread in one group, titled by how each ended', async () => {
        await draw([notice]);

        const group = container.querySelector('[role="group"][aria-label="Threads that stopped"]')!;

        expect(group.getAttribute('data-turn')).toBe('i-1');
        expect(cards('thread-notice').map(card => card.querySelector('span[class*="title"]')?.textContent)).toEqual([
            'Write the refund tests finished',
            'Migrate the payments table failed',
            'Fix login was interrupted',
            'Load test finished',
        ]);
        expect(cards('thread-notice').map(card => card.getAttribute('data-outcome'))).toEqual([
            'finished',
            'failed',
            'interrupted',
            'finished',
        ]);
        expect(cards('thread-notice').every(card => card.querySelector('svg'))).toBe(true);
        expect(group.textContent).not.toMatch(/(finished|failed|interrupted)\./);
    });

    it("shows the thread's words, and nothing for a thread that said nothing", async () => {
        await draw([notice]);

        const [refunds, , login] = cards('thread-notice');

        expect(refunds.textContent).toContain('14 cases, all passing.');
        expect(login.textContent).toBe('Fix login was interrupted');
    });

    it('says what a thread still runs, and that its words are not its final result', async () => {
        await draw([notice]);

        const [refunds, , , load] = cards('thread-notice');

        expect(load.textContent).toContain('Still running: k6 run long.js, bun run report');
        expect(load.textContent).toContain('Not the final result');
        expect(refunds.textContent).not.toContain('Still running');
        expect(refunds.textContent).not.toContain('Not the final result');
    });

    it('clamps long words to a few lines with a toggle that opens the rest', async () => {
        layout = { scrollHeight: 400, clientHeight: 80 };
        await draw([notice]);

        const toggle = linkNamed(cards('thread-notice')[0], 'Show more')!;

        expect(toggle.getAttribute('aria-expanded')).toBe('false');

        await act(async () => toggle.click());

        expect(linkNamed(cards('thread-notice')[0], 'Show less')?.getAttribute('aria-expanded')).toBe('true');
    });

    it('opens the thread from its name', async () => {
        const onOpenChat = vi.fn();

        await draw([notice], { onOpenChat, hasChat: () => true });
        await act(async () => linkNamed(cards('thread-notice')[1], 'Migrate the payments table')!.click());

        expect(onOpenChat).toHaveBeenCalledWith('c-b');
    });

    it('is a turn of the rail, named by the threads that stopped', () => {
        expect(turnMarks([message, notice]).map(mark => mark.title)).toEqual([
            'Use the staging keys',
            'Write the refund tests finished, Migrate the payments table failed, Fix login was interrupted, Load test finished',
        ]);
    });
});

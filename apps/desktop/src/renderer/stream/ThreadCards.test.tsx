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

    it('is marked with the agent icon, as a sub-agent is in the list, whichever agent wrote it', async () => {
        await draw([message]);

        const mark = cards('thread-message')[0].querySelector('svg');

        expect(mark).not.toBeNull();
        expect(cards('thread-message')[0].querySelector('[data-provider]')).toBeNull();
        // The notice cards of the threads that stopped have the marks of how they ended, not this one.
        await draw([message, notice]);
        expect(cards('thread-message')[0].querySelector('svg')?.outerHTML).toBe(mark?.outerHTML);
        expect(cards('agent-card')[0].querySelector('svg')?.outerHTML).not.toBe(mark?.outerHTML);
    });

    it('holds the icon in the title line, so the words under it start at the edge of the card and not after the icon', async () => {
        await draw([message, notice]);

        expect(cards('thread-message')).toHaveLength(1);
        expect(cards('agent-card')).toHaveLength(notices.length);

        for (const card of [...cards('thread-message'), ...cards('agent-card')]) {
            const head = card.firstElementChild as HTMLElement;

            expect(head.querySelector('svg')).not.toBeNull();
            expect(head.textContent).toMatch(/Message from|finished|failed|interrupted/);
        }
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

    it("puts the toggle across the foot of a card, centred, so the card's whole width presses it, in a message and in a report", async () => {
        layout = { scrollHeight: 900, clientHeight: 300 };
        await draw([message, notice]);

        for (const card of [...cards('thread-message'), ...cards('agent-card')]) {
            const toggle = linkNamed(card, 'Show full message');

            if (toggle) expect(toggle.getAttribute('data-align')).toBe('full');
        }

        expect(linkNamed(cards('thread-message')[0], 'Show full message')).toBeDefined();
        expect(linkNamed(cards('agent-card')[0], 'Show full message')).toBeDefined();
    });

    it('draws the words of a card in a body under the header, and no body for a card with nothing to say', async () => {
        await draw([message, notice]);

        const [refunds, , login] = cards('agent-card');

        expect(cards('thread-message')[0].children).toHaveLength(2);
        expect(refunds.children).toHaveLength(2);
        expect(refunds.children[1].textContent).toContain('14 cases, all passing.');
        expect(login.children).toHaveLength(1);
    });

    it('has no toggle for a message that fits', async () => {
        await draw([message]);

        expect(linkNamed(cards('thread-message')[0], 'Show full message')).toBeUndefined();
    });

    it('is named by what the chat is called now, not by the title it had when the message was written', async () => {
        await draw([message], { onOpenChat: vi.fn(), chatOfId: id => ({ id, title: 'Ship the whole checkout' }) });

        expect(cards('thread-message')[0].textContent).toContain('Message from Ship the whole checkout');
        expect(cards('thread-message')[0].textContent).not.toContain('Ship the checkout');
    });

    it('keeps the title it was written with when the chat is gone or has no title', async () => {
        await draw([message], { chatOfId: () => undefined });

        expect(cards('thread-message')[0].textContent).toContain('Message from Ship the checkout');

        await draw([message], { chatOfId: id => ({ id, title: '  ' }) });

        expect(cards('thread-message')[0].textContent).toContain('Message from Ship the checkout');
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
        expect(cards('agent-card').map(card => card.querySelector('span[class*="title"]')?.textContent)).toEqual([
            'Write the refund tests finished',
            'Migrate the payments table failed',
            'Fix login was interrupted',
            'Load test finished',
        ]);
        expect(cards('agent-card').map(card => card.getAttribute('data-outcome'))).toEqual([
            'finished',
            'failed',
            'interrupted',
            'finished',
        ]);
        expect(cards('agent-card').every(card => card.querySelector('svg'))).toBe(true);
        expect(group.textContent).not.toMatch(/(finished|failed|interrupted)\./);
    });

    it("shows the thread's words, and nothing for a thread that said nothing", async () => {
        await draw([notice]);

        const [refunds, , login] = cards('agent-card');

        expect(refunds.textContent).toContain('14 cases, all passing.');
        expect(login.textContent).toBe('Fix login was interrupted');
    });

    it('says what a thread still runs, and that its words are not its final result', async () => {
        await draw([notice]);

        const [refunds, , , load] = cards('agent-card');

        expect(load.textContent).toContain('Still running: k6 run long.js, bun run report');
        expect(load.textContent).toContain('Not the final result');
        expect(refunds.textContent).not.toContain('Still running');
        expect(refunds.textContent).not.toContain('Not the final result');
    });

    it("clamps long words to a few lines with a toggle that opens the rest, as a thread's message and a person's long message have", async () => {
        layout = { scrollHeight: 400, clientHeight: 80 };
        await draw([notice]);

        const toggle = linkNamed(cards('agent-card')[0], 'Show full message')!;

        expect(toggle.getAttribute('aria-expanded')).toBe('false');

        await act(async () => toggle.click());

        expect(linkNamed(cards('agent-card')[0], 'Show less')?.getAttribute('aria-expanded')).toBe('true');
    });

    it('opens the thread from a press on its title, and from nowhere in the card when the project no longer has it', async () => {
        const onOpenChat = vi.fn();

        await draw([notice], { onOpenChat, hasChat: chatId => chatId !== 'c-a' });
        await act(async () => linkNamed(cards('agent-card')[1], 'Migrate the payments table failed')!.click());

        expect(onOpenChat).toHaveBeenCalledWith('c-b');
        expect(cards('agent-card')[0].querySelector('button')).toBeNull();
        expect(cards('agent-card')[0].getAttribute('data-pressable')).toBeNull();
        expect(cards('agent-card')[1].getAttribute('data-pressable')).toBe('');
    });

    it('names a thread that stopped by what it is called now', async () => {
        await draw([notice], {
            chatOfId: id => (id === 'c-a' ? { id, title: 'Refund tests' } : undefined),
        });

        expect(cards('agent-card')[0].textContent).toContain('Refund tests finished');
        expect(cards('agent-card')[1].textContent).toContain('Migrate the payments table failed');
    });

    it('has nothing to press where nothing opens chats', async () => {
        await draw([notice]);

        expect(cards('agent-card').some(card => card.querySelector('button[class*="press"]'))).toBe(false);
    });

    it('is a turn of the rail, named by the threads that stopped', () => {
        expect(turnMarks([message, notice]).map(mark => mark.title)).toEqual([
            'Use the staging keys',
            'Write the refund tests finished, Migrate the payments table failed, Fix login was interrupted, Load test finished',
        ]);
    });
});

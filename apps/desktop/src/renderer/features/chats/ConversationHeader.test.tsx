// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFixtureData, FIXTURE_PROJECT_ID, type FixtureData } from '../../daemon/fixtureData';
import { FixtureTransport } from '../../daemon/fixtureTransport';
import { RootStore, RootStoreProvider } from '../../stores';
import { ConversationHeader } from './ConversationHeader';

import type { Chat, Run } from '@clowdy/protocol';
import type { KeyValueStorage } from '../../stores/storage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/*
 * The header over a conversation, on the fixture project. Threads: c-6 "Ship the checkout" > c-6a "Fix the price rounding" (working) > c-6a1 "Check the
 * currency table" (done). Sub-agents of c-1 "Simplify booking": r-na-02 (Explore, working, "Find where the price is computed"), r-na-03 (General, working) and
 * r-na-01 (Explore, done). The test build has no MobX observer plugin, so the view is drawn again by hand after a change.
 */

const memoryStorage = (): KeyValueStorage => {
    const data: Record<string, string> = {};

    return { getItem: key => data[key] ?? null, setItem: (key, value) => void (data[key] = value) };
};

let container: HTMLDivElement;
let reactRoot: Root;
let store: RootStore;

const open = async (change?: (data: FixtureData) => void) => {
    const data = createFixtureData();

    change?.(data);
    store.dispose();
    store = new RootStore(new FixtureTransport({ data }), { storage: memoryStorage() });
    await store.load();
};
const ui = () => store.ui.forProject(FIXTURE_PROJECT_ID);
const chatOf = (id: string): Chat => store.selectedProject!.chats.get(id)!;
const runOf = (id: string): Run => store.selectedProject!.runs.get(id)!;
const draw = (chat: Chat | undefined, subagent?: Run) =>
    act(async () =>
        reactRoot.render(
            <RootStoreProvider value={store}>
                <ConversationHeader chat={chat} subagent={subagent} />
            </RootStoreProvider>
        )
    );
const path = () => container.querySelector('nav[aria-label="Conversation path"]');
const pathText = () => [...(path()?.querySelectorAll('li') ?? [])].map(item => item.textContent);
const part = (label: string) =>
    [...(path()?.querySelectorAll('li') ?? [])].find(item => item.textContent === label) as HTMLElement | undefined;
const press = (label: string) => act(async () => part(label)!.querySelector('button')!.click());
const status = () => container.querySelector('[data-tone]')?.textContent;

beforeEach(async () => {
    store = new RootStore(new FixtureTransport({ data: createFixtureData() }), { storage: memoryStorage() });
    await store.load();
    container = document.createElement('div');
    document.body.append(container);
    reactRoot = createRoot(container);
});

afterEach(() => {
    act(() => reactRoot.unmount());
    container.remove();
    store.dispose();
});

describe('ConversationHeader, a chat', () => {
    it('shows its title alone, as the page it is, with nothing to press', async () => {
        await draw(chatOf('c-6'));

        expect(pathText()).toEqual(['Ship the checkout']);
        expect(path()?.querySelector('button')).toBeNull();
        expect(path()?.querySelector('[aria-current="page"]')?.textContent).toBe('Ship the checkout');
    });

    it('shows the status of its run while it works, and none once it is done', async () => {
        await draw(chatOf('c-1'));

        expect(status()).toBe('Working');

        await draw(chatOf('c-6'));

        expect(status()).toBeUndefined();
    });

    it('says Waiting while a question is open to the person', async () => {
        await draw(chatOf('c-3'));

        expect(status()).toBe('Waiting');
    });

    it('has no summary line, no Stop, no model and no mode', async () => {
        await draw(chatOf('c-1'));

        expect(container.querySelectorAll('button')).toHaveLength(0);
        expect(container.textContent).toBe('Simplify bookingWorking');
    });
});

describe('ConversationHeader, a thread', () => {
    it('shows the chat it belongs to and then its own title', async () => {
        await draw(chatOf('c-6a'));

        expect(pathText()).toEqual(['Ship the checkout', 'Fix the price rounding']);
        expect(path()?.querySelector('[aria-current="page"]')?.textContent).toBe('Fix the price rounding');
    });

    it('shows the whole path of a thread of a thread, and each part above the page opens that chat', async () => {
        await draw(chatOf('c-6a1'));

        expect(pathText()).toEqual(['Ship the checkout', 'Fix the price rounding', 'Check the currency table']);

        await press('Fix the price rounding');
        await vi.waitFor(() => expect(ui().chatId).toBe('c-6a'));

        await press('Ship the checkout');
        await vi.waitFor(() => expect(ui().chatId).toBe('c-6'));
    });

    it('names a parent in the archive without opening it', async () => {
        await open(data => {
            data.chats.find(chat => chat.id === 'c-6a')!.archivedAt = Date.now();
        });
        await draw(chatOf('c-6a1'));

        expect(pathText()).toEqual(['Ship the checkout', 'Fix the price rounding', 'Check the currency table']);
        expect(part('Fix the price rounding')!.querySelector('button')!.disabled).toBe(true);
        expect(part('Ship the checkout')!.querySelector('button')!.disabled).toBe(false);
    });

    it('starts its path below a parent that is gone', async () => {
        await open(data => {
            data.chats = data.chats.filter(chat => chat.id !== 'c-6a');
        });
        await draw(chatOf('c-6a1'));

        expect(pathText()).toEqual(['Check the currency table']);
    });
});

describe('ConversationHeader, a sub-agent', () => {
    it('shows the path of its chat and then its own name as the people read it', async () => {
        await draw(chatOf('c-1'), runOf('r-na-03'));

        expect(pathText()).toEqual(['Simplify booking', 'General agent']);
        expect(path()?.querySelector('[aria-current="page"]')?.textContent).toBe('General agent');
        expect(container.textContent).not.toContain('general-purpose');
        expect(container.textContent).not.toContain('Orchestrator');
    });

    it('opens its chat from the first part, which leaves the sub-agent', async () => {
        ui().openRun('r-na-02');
        await draw(chatOf('c-1'), runOf('r-na-02'));
        await press('Simplify booking');

        await vi.waitFor(() => expect(ui().chatId).toBe('c-1'));
        expect(ui().runId).toBeNull();
    });

    it('puts its summary under the path as one line', async () => {
        await draw(chatOf('c-1'), runOf('r-na-02'));

        expect(container.textContent).toContain('Find where the price is computed');
        expect(path()?.textContent).not.toContain('Find where');
    });

    it('shows its status while it works and not once it is over', async () => {
        await draw(chatOf('c-1'), runOf('r-na-02'));

        expect(status()).toBe('Working');

        await draw(chatOf('c-1'), runOf('r-na-01'));

        expect(status()).toBeUndefined();
    });

    it('shows the status of the sub-agent, not of its chat, when the chat is done and the sub-agent is not', async () => {
        await draw(chatOf('c-1'), { ...runOf('r-na-02'), status: 'waiting_user' });

        expect(status()).toBe('Waiting');
    });

    it('goes below a thread: every chat above it, then the sub-agent', async () => {
        await open(data => {
            data.runs.push({
                ...data.runs.find(run => run.id === 'r-na-02')!,
                id: 'r-na-70',
                parentRunId: 'r-orch-6a',
                rootRunId: 'r-orch-6a',
            });
        });
        await draw(chatOf('c-6a'), runOf('r-na-70'));

        expect(pathText()).toEqual(['Ship the checkout', 'Fix the price rounding', 'Explore agent']);

        await press('Ship the checkout');
        await vi.waitFor(() => expect(ui().chatId).toBe('c-6'));
    });

    it('adds the sub-agents it runs inside, and each opens its own page', async () => {
        await open(data => {
            data.runs.push({
                ...data.runs.find(run => run.id === 'r-na-02')!,
                id: 'r-na-71',
                parentRunId: 'r-na-03',
            });
        });
        await draw(chatOf('c-1'), runOf('r-na-71'));

        expect(pathText()).toEqual(['Simplify booking', 'General agent', 'Explore agent']);

        await press('General agent');
        await vi.waitFor(() => expect(ui().runId).toBe('r-na-03'));
    });

    it('is the sub-agent alone when its chat is gone', async () => {
        await draw(undefined, runOf('r-na-02'));

        expect(pathText()).toEqual(['Explore agent']);
    });
});

describe('ConversationHeader, a long path', () => {
    const deep = (data: FixtureData) => {
        const base = data.chats.find(chat => chat.id === 'c-6a1')!;

        for (const [index, parent] of ['c-6a1', 'c-x1', 'c-x2'].entries())
            data.chats.push({ ...base, id: `c-x${index + 1}`, title: `Deeper ${index + 1}`, parentChatId: parent });
    };

    it('folds its middle into …, keeping the first part, the last two and the page', async () => {
        await open(deep);
        await draw(chatOf('c-x3'));

        expect(pathText()).toEqual(['Ship the checkout', '…Show 3 more', 'Deeper 2', 'Deeper 3']);
        expect(path()?.querySelector('[aria-current="page"]')?.textContent).toBe('Deeper 3');
    });

    it('shows every part once the … is pressed, and each opens its page', async () => {
        await open(deep);
        await draw(chatOf('c-x3'));
        await act(async () => container.querySelector<HTMLButtonElement>('nav li:nth-child(2) button')!.click());

        expect(pathText()).toEqual([
            'Ship the checkout',
            'Fix the price rounding',
            'Check the currency table',
            'Deeper 1',
            'Deeper 2',
            'Deeper 3',
        ]);

        await press('Check the currency table');
        await vi.waitFor(() => expect(ui().chatId).toBe('c-6a1'));
    });

    it('keeps the last part of a long path with a long sub-agent name too', async () => {
        await open(deep);
        await draw(chatOf('c-x3'), runOf('r-na-02'));

        expect(path()?.querySelector('[aria-current="page"]')?.textContent).toBe('Explore agent');
    });
});

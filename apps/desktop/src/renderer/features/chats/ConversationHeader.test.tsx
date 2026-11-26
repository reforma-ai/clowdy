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
 * currency table" (done). Sub-agents of c-1 "Simplify booking": r-na-02 (working, "Find where the price is computed"), r-na-03 (working, "Update the booking form") and
 * r-na-01 (done, "Map the booking flow"). A sub-agent is named by what it was asked to do. The test build has no MobX observer plugin, so the view is drawn again by hand after a change.
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

    it('has no status of the run, whether it works, waits for the person or is done', async () => {
        for (const id of ['c-1', 'c-3', 'c-6']) {
            await draw(chatOf(id));

            expect(container.querySelector('[data-tone]')).toBeNull();
            expect(container.textContent).toBe(chatOf(id).title);
        }
    });

    it('has no summary line, no Stop, no model and no mode', async () => {
        await draw(chatOf('c-1'));

        expect(container.querySelectorAll('button')).toHaveLength(0);
        expect(container.textContent).toBe('Simplify booking');
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

        expect(pathText()).toEqual(['Simplify booking', 'Update the booking form']);
        expect(path()?.querySelector('[aria-current="page"]')?.textContent).toBe('Update the booking form');
        expect(container.textContent).not.toContain('General agent');
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

    it('is named by what it was asked to do, once: no line for it under the path', async () => {
        await draw(chatOf('c-1'), runOf('r-na-02'));

        expect(pathText()).toEqual(['Simplify booking', 'Find where the price is computed']);
        expect(container.textContent!.split('Find where the price is computed')).toHaveLength(2);
    });

    it('is named by its type when it was given no purpose', async () => {
        await draw(chatOf('c-1'), { ...runOf('r-na-02'), summary: '' });

        expect(pathText()).toEqual(['Simplify booking', 'Explore agent']);
    });

    it('has no status of the sub-agent either', async () => {
        for (const run of [
            runOf('r-na-02'),
            runOf('r-na-01'),
            { ...runOf('r-na-02'), status: 'waiting_user' as const },
        ]) {
            await draw(chatOf('c-1'), run);

            expect(container.querySelector('[data-tone]')).toBeNull();
        }
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

        expect(pathText()).toEqual(['Ship the checkout', 'Fix the price rounding', 'Find where the price is computed']);

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

        expect(pathText()).toEqual(['Simplify booking', 'Update the booking form', 'Find where the price is computed']);

        await press('Update the booking form');
        await vi.waitFor(() => expect(ui().runId).toBe('r-na-03'));
    });

    it('names an archived chat above a sub-agent without opening it, and opens the ones that are not', async () => {
        await open(data => {
            data.chats.find(chat => chat.id === 'c-6')!.archivedAt = Date.now();
            data.runs.push({
                ...data.runs.find(run => run.id === 'r-na-02')!,
                id: 'r-na-72',
                parentRunId: 'r-orch-6a',
                rootRunId: 'r-orch-6a',
            });
        });
        await draw(chatOf('c-6a'), runOf('r-na-72'));

        expect(pathText()).toEqual(['Ship the checkout', 'Fix the price rounding', 'Find where the price is computed']);
        expect(part('Ship the checkout')!.querySelector('button')!.disabled).toBe(true);
        expect(part('Fix the price rounding')!.querySelector('button')!.disabled).toBe(false);
    });

    it('goes below a thread twice over: its chats, the sub-agent it runs inside, and its own name', async () => {
        await open(data => {
            const general = {
                ...data.runs.find(run => run.id === 'r-na-03')!,
                id: 'r-na-73',
                parentRunId: 'r-orch-6a',
                rootRunId: 'r-orch-6a',
            };

            data.runs.push(general, { ...general, id: 'r-na-74', parentRunId: 'r-na-73' });
        });
        await draw(chatOf('c-6a'), runOf('r-na-74'));

        expect(pathText()).toEqual([
            'Ship the checkout',
            'Fix the price rounding',
            'Update the booking form',
            'Update the booking form',
        ]);

        await press('Ship the checkout');
        await vi.waitFor(() => expect(ui().chatId).toBe('c-6'));
    });

    it('is the sub-agent alone when its chat is gone', async () => {
        await draw(undefined, runOf('r-na-02'));

        expect(pathText()).toEqual(['Find where the price is computed']);
    });
});

describe('ConversationHeader, a long path', () => {
    const deep = (data: FixtureData) => {
        const base = data.chats.find(chat => chat.id === 'c-6a1')!;

        for (const [index, parent] of ['c-6a1', 'c-x1', 'c-x2'].entries())
            data.chats.push({ ...base, id: `c-x${index + 1}`, title: `Deeper ${index + 1}`, parentChatId: parent });
    };

    it('does not fold a path of exactly four parts', async () => {
        await open(deep);
        await draw(chatOf('c-x1'));

        expect(pathText()).toEqual([
            'Ship the checkout',
            'Fix the price rounding',
            'Check the currency table',
            'Deeper 1',
        ]);
        expect(container.querySelector('nav li:nth-child(2) button')?.textContent).toBe('Fix the price rounding');
    });

    it('moves the keyboard to the first part the … uncovered', async () => {
        await open(deep);
        await draw(chatOf('c-x3'));
        await act(async () => container.querySelector<HTMLButtonElement>('nav li:nth-child(2) button')!.click());

        expect(document.activeElement?.textContent).toBe('Fix the price rounding');
    });

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

    it('folds the path of a sub-agent too, and the sub-agent stays as the last part', async () => {
        await open(deep);
        await draw(chatOf('c-x3'), runOf('r-na-02'));

        expect(pathText()).toEqual([
            'Ship the checkout',
            '…Show 4 more',
            'Deeper 3',
            'Find where the price is computed',
        ]);
        expect(path()?.querySelector('[aria-current="page"]')?.textContent).toBe('Find where the price is computed');
    });
});

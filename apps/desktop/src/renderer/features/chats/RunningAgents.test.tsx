// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFixtureData, FIXTURE_PROJECT_ID } from '../../daemon/fixtureData';
import { FixtureTransport } from '../../daemon/fixtureTransport';
import { RootStore, RootStoreProvider } from '../../stores';
import { RunningAgents } from './RunningAgents';

import type { KeyValueStorage } from '../../stores/storage';

vi.mock('@clowdy/components/Toast', () => ({ toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn(), info: vi.fn(), show: vi.fn() } }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/*
 * The strip above the message box of c-1, whose orchestrator r-orch-1 has Executor 07 working, Executor 08 waiting for the person and the
 * native Explore sub-agent r-na-02 searching. The test build has no MobX observer plugin, so the view is drawn again by hand after a change.
 */

const memoryStorage = (): KeyValueStorage => {
    const data: Record<string, string> = {};

    return { getItem: key => data[key] ?? null, setItem: (key, value) => void (data[key] = value) };
};

let container: HTMLDivElement;
let reactRoot: Root;
let store: RootStore;

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
});

const ui = () => store.ui.forProject(FIXTURE_PROJECT_ID);
const rows = () => [...container.querySelectorAll('[aria-label="Agents at work"] > div')];
const render = (chatId: string) => act(async () => reactRoot.render(<RootStoreProvider value={ store }><RunningAgents chat={ store.selectedProject!.chats.get(chatId)! } /></RootStoreProvider>));

/** Draws the strip, then again once the streams of the agents at work have been fetched. */
async function draw(chatId = 'c-1') {
    await render(chatId);
    await render(chatId);
}

describe('RunningAgents', () => {
    it('has a row per agent at work with what it does, and Stop only for the runs that can stop alone', async () => {
        await draw();

        expect(rows().map(row => [row.querySelector('button')?.textContent, [...row.querySelectorAll('button')].at(1)?.textContent])).toEqual([
            ['Executor 07 · Finishing reply · 5 calls', 'Stop'],
            ['Executor 08 · Waiting for you', 'Stop'],
            // A native sub-agent stops with its parent's session.
            ['Explore agent · Searching useBookingPrice · 1 call', undefined],
        ]);
    });

    it('opens the run a row stands for, and Stop cancels that run', async () => {
        await draw();

        const command = vi.spyOn(store, 'command');
        const [executor07, , explore] = rows();

        await act(async () => explore.querySelector('button')!.click());
        expect(ui().runId).toBe('r-na-02');

        await act(async () => [...executor07.querySelectorAll('button')][1].click());
        expect(command).toHaveBeenCalledWith({ type: 'run.cancel', runId: 'r-ex-07' });
    });

    it('draws nothing while no agent of the chat works', async () => {
        await draw('c-2');

        expect(container.innerHTML).toBe('');
    });
});

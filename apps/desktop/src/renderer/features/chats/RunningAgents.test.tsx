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
 * native Explore sub-agent r-na-02 searching, and of c-5, whose orchestrator r-orch-5 waits for two commands it started in the background.
 * The test build has no MobX observer plugin, so the view is drawn again by hand after a change.
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
const rows = () => [...container.querySelectorAll('[aria-label="Work in progress"] > div')];
const runs = () => store.selectedProject!.runs;
const background = (...titles: string[]) => titles.map((title, index) => ({ id: `bg-${ index + 1 }`, kind: 'command' as const, title }));
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

describe('RunningAgents, the background row', () => {
    it('counts what the orchestrator has open in the background, with Stop', async () => {
        await draw('c-5');

        expect(rows().map(row => row.textContent)).toEqual(['2 background tasks runningStop']);
    });

    it('says it in the singular for one item', async () => {
        runs().set('r-orch-5', { ...runs().get('r-orch-5')!, background: background('bun run test') });
        await draw('c-5');

        expect(rows().map(row => row.textContent)).toEqual(['Background task runningStop']);
    });

    it('stops the orchestrator, which ends the background work with it', async () => {
        await draw('c-5');

        const command = vi.spyOn(store, 'command');

        await act(async () => rows()[0].querySelector('button')!.click());
        expect(command).toHaveBeenCalledWith({ type: 'run.cancel', runId: 'r-orch-5' });

        // The daemon clears the list with the run, and the row goes with it.
        await vi.waitFor(() => expect(runs().get('r-orch-5')?.status).toBe('cancelled'));
        await draw('c-5');
        expect(container.innerHTML).toBe('');
    });

    it('comes after the agents at work', async () => {
        runs().set('r-orch-1', { ...runs().get('r-orch-1')!, background: background('bun run test') });
        await draw();

        expect(rows().map(row => row.textContent)).toEqual([
            expect.stringContaining('Executor 07'),
            expect.stringContaining('Executor 08'),
            expect.stringContaining('Explore agent'),
            'Background task runningStop',
        ]);
    });

    it('is drawn while the session works on a message too, not only while it waits', async () => {
        runs().set('r-orch-5', { ...runs().get('r-orch-5')!, status: 'running' });
        await draw('c-5');

        expect(rows().map(row => row.textContent)).toEqual(['2 background tasks runningStop']);
    });

    it('is not drawn with nothing open, whether the list is empty or absent', async () => {
        const bare = { ...runs().get('r-orch-5')! };

        delete bare.background;
        runs().set('r-orch-5', { ...bare, background: [] });
        await draw('c-5');
        expect(container.innerHTML).toBe('');

        runs().set('r-orch-5', bare);
        await draw('c-5');
        expect(container.innerHTML).toBe('');
    });

    it('is not drawn for a chat at rest, whatever a stale list says', async () => {
        runs().set('r-orch-5', { ...runs().get('r-orch-5')!, status: 'succeeded' });
        await draw('c-5');

        expect(container.innerHTML).toBe('');
    });
});

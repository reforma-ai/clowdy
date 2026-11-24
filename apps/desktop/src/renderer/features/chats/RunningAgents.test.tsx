// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFixtureData, FIXTURE_PROJECT_ID } from '../../daemon/fixtureData';
import { FixtureTransport } from '../../daemon/fixtureTransport';
import { RootStore, RootStoreProvider } from '../../stores';
import { RunningAgents } from './RunningAgents';

import type { BackgroundItem, Chat, Run } from '@clowdy/protocol';
import type { KeyValueStorage } from '../../stores/storage';

vi.mock('@clowdy/components/Toast', () => ({
    toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn(), info: vi.fn(), show: vi.fn() },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/*
 * The strip above the message box of c-1, whose orchestrator r-orch-1 has the native sub-agents r-na-03 (a general-purpose one, writing) and r-na-02
 * (Explore, searching) at work, and of c-5, whose orchestrator r-orch-5 waits for two commands it started in the background. The test build has no
 * MobX observer plugin, so the view is drawn again by hand after a change.
 */

const memoryStorage = (): KeyValueStorage => {
    const data: Record<string, string> = {};

    return { getItem: key => data[key] ?? null, setItem: (key, value) => void (data[key] = value) };
};

let container: HTMLDivElement;
let reactRoot: Root;
let store: RootStore;
let data: ReturnType<typeof createFixtureData>;

beforeEach(async () => {
    data = createFixtureData();
    store = new RootStore(new FixtureTransport({ data }), {
        storage: memoryStorage(),
        initialUi: { agentsFolded: false },
    });
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
const lines = () => [...container.querySelectorAll('[aria-label="Work in progress"] > div')];
/** The line over the agents' rows, when there is one. */
const header = () => lines().find(line => line.querySelector('button[aria-expanded]'));
const toggle = () => header()!.querySelector<HTMLButtonElement>('button[aria-expanded]')!;
const stopAll = () => header()!.querySelector<HTMLButtonElement>('button:not([aria-expanded])')!;
/** The rows of the strip: every line but the header. */
const rows = () => lines().filter(line => line !== header());
/** The buttons of a line by their words or accessible name. */
const buttons = (line: Element | undefined) =>
    [...(line?.querySelectorAll('button') ?? [])].map(
        button => button.textContent || button.getAttribute('aria-label')
    );
const runs = () => store.selectedProject!.runs;
/** Sets a run in the demo daemon and in what the app shows of it, so a command finds the run the strip draws. */
function put(run: Run) {
    const index = data.runs.findIndex(candidate => candidate.id === run.id);

    if (index >= 0) data.runs[index] = structuredClone(run);
    else data.runs.push(structuredClone(run));

    runs().set(run.id, run);
}
const background = (...titles: string[]) =>
    titles.map((title, index) => ({ id: `bg-${index + 1}`, kind: 'command' as const, title }));
const render = (chatId: string) =>
    act(async () =>
        reactRoot.render(
            <RootStoreProvider value={store}>
                <RunningAgents chat={store.selectedProject!.chats.get(chatId)!} />
            </RootStoreProvider>
        )
    );

/** Draws the strip, then again once the streams of the agents at work have been fetched. */
async function draw(chatId = 'c-1') {
    await render(chatId);
    await render(chatId);
}

describe('RunningAgents', () => {
    it('has a row per sub-agent at work with what it does, and a Stop on each that can stop alone', async () => {
        await draw();

        expect(
            rows().map(row => [
                row.querySelector('button')?.textContent,
                [...row.querySelectorAll('button')].at(1)?.textContent,
            ])
        ).toEqual([
            ['General agent · Finishing reply · 5 calls', 'Stop'],
            ['Explore agent · Searching useBookingPrice · 1 call', 'Stop'],
        ]);
    });

    it('opens the run a row stands for, and Stop cancels that run alone', async () => {
        await draw();

        const command = vi.spyOn(store, 'command');
        const [general, explore] = rows();

        await act(async () => explore.querySelector('button')!.click());
        expect(ui().runId).toBe('r-na-02');

        await act(async () => [...general.querySelectorAll('button')][1].click());
        expect(command).toHaveBeenCalledWith({ type: 'run.cancel', runId: 'r-na-03' });
        await vi.waitFor(() => expect(runs().get('r-na-03')?.status).toBe('cancelled'));
        // Nothing else stopped, the orchestrator included.
        expect([runs().get('r-orch-1')?.status, runs().get('r-na-02')?.status]).toEqual(['running', 'running']);
    });

    it("stops a sub-agent of the session alone from its row, with the orchestrator's turn running", async () => {
        await draw();

        const command = vi.spyOn(store, 'command');

        await act(async () => [...rows()[1].querySelectorAll('button')][1].click());
        expect(command).toHaveBeenCalledWith({ type: 'run.cancel', runId: 'r-na-02' });
        await vi.waitFor(() => expect(runs().get('r-na-02')?.status).toBe('cancelled'));
        expect([runs().get('r-orch-1')?.status, runs().get('r-na-03')?.status]).toEqual(['running', 'running']);
    });

    it('has no Stop on a sub-agent whose session cannot end it alone: the composer stops the run', async () => {
        put({ ...runs().get('r-na-02')!, canStopAlone: undefined });
        await draw();

        expect(rows().map(row => buttons(row).slice(1))).toEqual([['Stop'], []]);
    });

    it('draws nothing while no agent of the chat works', async () => {
        await draw('c-2');

        expect(container.innerHTML).toBe('');
    });
});

describe('RunningAgents, the header', () => {
    it('shows the running count and offers Stop all when two or more agents can stop alone', async () => {
        await draw();

        expect(lines().map(line => line.textContent)).toEqual([
            'Agents2 runningStop all',
            expect.stringContaining('General agent'),
            expect.stringContaining('Explore agent'),
        ]);
        expect(lines()[0]).toBe(header());
    });

    it('has no Stop all with one agent that can stop alone', async () => {
        put({ ...runs().get('r-na-03')!, status: 'succeeded' });
        await draw();

        expect(lines().map(line => line.textContent)).toEqual([
            'Agents1 running',
            expect.stringContaining('Explore agent'),
        ]);
        expect(buttons(header())).toEqual([toggle().textContent]);
        expect(buttons(rows()[0]).slice(1)).toEqual(['Stop']);
    });

    it('counts agents that cannot stop alone but only offers Stop all for two stoppable agents', async () => {
        put({ ...runs().get('r-na-02')!, canStopAlone: undefined });
        await draw();

        expect(lines().map(line => line.textContent)).toEqual([
            'Agents2 running',
            expect.stringContaining('General agent'),
            expect.stringContaining('Explore agent'),
        ]);
        expect(buttons(header())).toEqual([toggle().textContent]);
    });

    it('has Stop all that stops every agent that can stop alone and lets the orchestrator go on, its queue not held', async () => {
        await draw();

        const command = vi.spyOn(store, 'command');

        await act(async () => stopAll().click());
        expect(command).toHaveBeenCalledWith({ type: 'run.stopAgents', runId: 'r-orch-1' });
        expect(command).toHaveBeenCalledTimes(1);

        await vi.waitFor(() =>
            expect(['r-na-03', 'r-na-02'].map(id => runs().get(id)?.status)).toEqual(['cancelled', 'cancelled'])
        );
        expect(runs().get('r-orch-1')?.status).toBe('running');
        expect(store.selectedProject!.chats.get('c-1')?.queuePaused).toBeUndefined();

        // The agents are gone from the strip, and the header with them.
        await draw();
        expect(container.innerHTML).toBe('');
    });

    it('leaves a sub-agent that cannot stop alone at work', async () => {
        put({ ...runs().get('r-na-02')!, canStopAlone: undefined });
        put({ ...runs().get('r-na-03')!, id: 'r-na-07', parentToolCallId: 'tc-agent-7', createdAt: 5 });
        await draw();

        await act(async () => stopAll().click());
        await vi.waitFor(() =>
            expect(['r-na-03', 'r-na-07'].map(id => runs().get(id)?.status)).toEqual(['cancelled', 'cancelled'])
        );
        expect(runs().get('r-na-02')?.status).toBe('running');
        expect(runs().get('r-orch-1')?.status).toBe('running');
    });

    it('is one line over eight agents, and the line that counts the ones beyond the fifth has no button', async () => {
        for (const id of ['r-na-03', 'r-na-02']) runs().set(id, { ...runs().get(id)!, status: 'succeeded' });

        for (let index = 1; index <= 8; index++) {
            put({
                ...runs().get('r-na-03')!,
                id: `r-many-${index}`,
                name: 'Explore',
                status: 'running',
                createdAt: 100 + index,
            });
        }

        await draw();

        expect(toggle().textContent).toBe('Agents8 running');
        expect(lines()).toHaveLength(7);
        expect(lines()[0]).toBe(header());
        expect(buttons(header())).toEqual([toggle().textContent, 'Stop all']);
        expect(rows()).toHaveLength(6);
        expect(
            rows()
                .slice(0, 5)
                .every(row => buttons(row).at(-1) === 'Stop')
        ).toBe(true);
        expect(rows().at(-1)?.textContent).toBe('3 more agents at work');
        expect(buttons(rows().at(-1))).toEqual([]);

        // It stops all eight, the three that no row shows too.
        const command = vi.spyOn(store, 'command');

        await act(async () => stopAll().click());
        expect(command).toHaveBeenCalledWith({ type: 'run.stopAgents', runId: 'r-orch-1' });
        await vi.waitFor(() =>
            expect(
                [...runs().values()]
                    .filter(run => run.id.startsWith('r-many-'))
                    .every(run => run.status === 'cancelled')
            ).toBe(true)
        );
        expect(runs().get('r-orch-1')?.status).toBe('running');
    });

    it("is not drawn when the strip has only background rows: that row's Stop ends the run, and a command row is no agent", async () => {
        await draw('c-5');

        expect(header()).toBeUndefined();
        expect(lines().map(line => line.textContent)).toEqual([
            'Command · bun run testStop',
            'Background task runningStop',
        ]);
    });
});

/**
 * c-5 waits for background work with a sub-agent among it: the orchestrator's Agent call `tc-agent-5` started the native child r-na-05, which works
 * (its item in the list is named by that call), besides the command bg-1 that has no run of its own.
 */
function waitWithSubagent(
    items = [
        { id: 'bg-1', kind: 'command' as const, title: 'bun run test' },
        { id: 'tc-agent-5', kind: 'subagent' as const, title: 'Explore' },
    ],
    canStopAlone = true
) {
    put({ ...runs().get('r-orch-5')!, background: items });
    put({
        id: 'r-na-05',
        projectId: FIXTURE_PROJECT_ID,
        rootRunId: 'r-orch-5',
        parentRunId: 'r-orch-5',
        role: 'executor',
        origin: 'native',
        parentToolCallId: 'tc-agent-5',
        ...(canStopAlone && { canStopAlone }),
        name: 'Explore',
        summary: 'Find where the price is computed',
        status: 'running',
        engine: 'claude',
        createdAt: 1,
    });
}

describe('RunningAgents, folding the rows', () => {
    it('folds from the title and keeps the running count before the chevron', async () => {
        await draw();

        expect(toggle().getAttribute('aria-expanded')).toBe('true');
        expect(toggle().textContent).toBe('Agents2 running');

        const title = [...toggle().querySelectorAll('span')].find(element => element.textContent === 'Agents')!;
        await act(async () => title.click());
        await draw();

        expect(ui().agentsFolded).toBe(true);
        expect(lines()).toEqual([header()]);
        expect(header()!.textContent).toBe('Agents2 runningStop all');
        expect(toggle().getAttribute('aria-expanded')).toBe('false');
        expect(toggle().textContent).toBe('Agents2 running');
    });

    it('shows the rows again from the chevron, and keeps the fold for every chat of the project', async () => {
        await draw();
        await act(async () => toggle().click());
        await draw('c-6');

        expect(lines()).toEqual([header()]);
        expect(header()!.textContent).toBe('Agents2 runningStop all');

        await act(async () =>
            toggle()
                .querySelector('svg')!
                .dispatchEvent(new MouseEvent('click', { bubbles: true }))
        );
        await draw('c-6');

        expect(ui().agentsFolded).toBe(false);
        expect(rows().map(row => row.textContent?.split(' · ')[0])).toEqual([
            'Fix the price rounding',
            'Load test the checkout',
        ]);
    });

    it('keeps Stop all on the folded line, and it stops the agents the rows would', async () => {
        await draw();
        await act(async () => toggle().click());
        await draw();

        const command = vi.spyOn(store, 'command');

        await act(async () => stopAll().click());
        expect(command).toHaveBeenCalledWith({ type: 'run.stopAgents', runId: 'r-orch-1' });
        await vi.waitFor(() =>
            expect(['r-na-03', 'r-na-02'].map(id => runs().get(id)?.status)).toEqual(['cancelled', 'cancelled'])
        );
    });

    it('folds the background rows under the line too, and does not fold them when there is no line to unfold them from', async () => {
        put({
            ...runs().get('r-orch-1')!,
            background: [{ id: 'bg-1', kind: 'command', title: 'command 1', canStopAlone: true }],
        });
        ui().toggleAgentsFolded();
        await draw();
        expect(lines()).toEqual([header()]);

        await draw('c-5');
        expect(header()).toBeUndefined();
        expect(rows().map(row => row.textContent)).toEqual([
            'Command · bun run testStop',
            'Background task runningStop',
        ]);
    });
});

describe('RunningAgents, a sub-agent of a session that waits', () => {
    it('is one row of its own, which the background row does not count again', async () => {
        waitWithSubagent();
        await draw('c-5');

        expect(rows().map(row => row.textContent)).toEqual([
            'Explore agent workingStop',
            'Background task runningStop',
        ]);
        // One agent: its own Stop is enough, so there is no Stop all.
        expect(toggle().textContent).toBe('Agents1 running');
    });

    it("leaves no background row when every open item has a run, and the sub-agent's row has a Stop that stops it alone, not the run", async () => {
        waitWithSubagent([{ id: 'tc-agent-5', kind: 'subagent', title: 'Explore' }]);
        await draw('c-5');

        expect(rows().map(row => buttons(row))).toEqual([['Explore agent working', 'Stop']]);

        const command = vi.spyOn(store, 'command');

        await act(async () => [...rows()[0].querySelectorAll('button')][1].click());
        expect(command).toHaveBeenCalledWith({ type: 'run.cancel', runId: 'r-na-05' });
        await vi.waitFor(() => expect(runs().get('r-na-05')?.status).toBe('cancelled'));
        // The run waits on, and the sub-agent has left its list of open work.
        expect(runs().get('r-orch-5')?.status).toBe('waiting_background');
        expect(runs().get('r-orch-5')?.background).toEqual([]);
    });

    it("opens the sub-agent's run from its row", async () => {
        waitWithSubagent([{ id: 'tc-agent-5', kind: 'subagent', title: 'Explore' }]);
        await draw('c-5');
        await act(async () => rows()[0].querySelector('button')!.click());
        expect(ui().runId).toBe('r-na-05');
    });

    it('counts the sub-agent again when its run is not at work, so nothing open goes unlisted', async () => {
        waitWithSubagent();
        put({ ...runs().get('r-na-05')!, status: 'succeeded' });
        await draw('c-5');

        expect(rows().map(row => row.textContent)).toEqual(['2 background tasks runningStop']);
        expect(header()).toBeUndefined();
    });

    it("has Stop on the row while the orchestrator's own turn runs too", async () => {
        waitWithSubagent([{ id: 'tc-agent-5', kind: 'subagent', title: 'Explore' }]);
        put({ ...runs().get('r-orch-5')!, status: 'running' });
        await draw('c-5');

        expect(rows().map(row => buttons(row))).toEqual([['Explore agent working', 'Stop']]);
    });

    it('has no Stop on a sub-agent whose session cannot end it alone, however the orchestrator waits', async () => {
        waitWithSubagent([{ id: 'tc-agent-5', kind: 'subagent', title: 'Explore' }], false);
        await draw('c-5');

        expect(rows().map(row => buttons(row))).toEqual([['Explore agent working']]);
        expect(buttons(header())).toEqual([toggle().textContent]);
    });

    it('has no Stop all label anywhere in the strip', async () => {
        waitWithSubagent([{ id: 'tc-agent-5', kind: 'subagent', title: 'Explore' }], false);
        await draw('c-5');

        expect(container.textContent).not.toContain('Stop all');
    });
});

describe('RunningAgents, the background row', () => {
    /** c-5's two commands, neither of which the agent lets the person stop alone: both are counted. */
    const unstoppable = () =>
        put({
            ...runs().get('r-orch-5')!,
            background: [
                { id: 'bg-1', kind: 'command', title: 'bun run test' },
                { id: 'bg-2', kind: 'command', title: 'bun run typecheck' },
            ],
        });

    it('counts what the orchestrator has open in the background that cannot be stopped alone, with Stop', async () => {
        unstoppable();
        await draw('c-5');

        expect(rows().map(row => row.textContent)).toEqual(['2 background tasks runningStop']);
    });

    it('counts the rest after the commands that have a row of their own', async () => {
        await draw('c-5');

        expect(rows().map(row => row.textContent)).toEqual([
            'Command · bun run testStop',
            'Background task runningStop',
        ]);
    });

    it('says it in the singular for one item', async () => {
        put({ ...runs().get('r-orch-5')!, background: background('bun run test') });
        await draw('c-5');

        expect(rows().map(row => row.textContent)).toEqual(['Background task runningStop']);
    });

    it('stops the orchestrator, which ends the background work with it', async () => {
        unstoppable();
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
        put({ ...runs().get('r-orch-1')!, background: background('bun run test') });
        await draw();

        expect(rows().map(row => row.textContent)).toEqual([
            expect.stringContaining('General agent'),
            expect.stringContaining('Explore agent'),
            'Background task runningStop',
        ]);
    });

    it('is drawn while the session works on a message too, not only while it waits', async () => {
        unstoppable();
        put({ ...runs().get('r-orch-5')!, status: 'running' });
        await draw('c-5');

        expect(rows().map(row => row.textContent)).toEqual(['2 background tasks runningStop']);
    });

    it('is not drawn with nothing open, whether the list is empty or absent', async () => {
        const bare = { ...runs().get('r-orch-5')! };

        delete bare.background;
        put({ ...bare, background: [] });
        await draw('c-5');
        expect(container.innerHTML).toBe('');

        put(bare);
        await draw('c-5');
        expect(container.innerHTML).toBe('');
    });

    it('is not drawn for a chat at rest, whatever a stale list says', async () => {
        put({ ...runs().get('r-orch-5')!, status: 'succeeded' });
        await draw('c-5');

        expect(container.innerHTML).toBe('');
    });
});

/**
 * c-6 (Ship the checkout) rests while its threads work: c-6a (Fix the price rounding) runs `bun test src/checkout` and holds a queued notice, c-6e
 * (Load test the checkout) waits for its background work. Its other threads are over, and c-6a1, the thread of c-6a, belongs to c-6a's strip.
 */
describe('RunningAgents, threads', () => {
    /** Sets a chat in the demo daemon and in what the app shows of it. */
    function putChat(chat: Chat) {
        const index = data.chats.findIndex(candidate => candidate.id === chat.id);

        if (index >= 0) data.chats[index] = structuredClone(chat);
        else data.chats.push(structuredClone(chat));

        store.selectedProject!.chats.set(chat.id, chat);
    }

    it('has a row per thread at work, with what it does and a Stop, under the header with Stop all', async () => {
        await draw('c-6');

        expect(rows().map(row => buttons(row))).toEqual([
            ['Fix the price rounding · Running bun test src/checkout', 'Stop'],
            ['Load test the checkout · Waiting for background work', 'Stop'],
        ]);
        expect(buttons(header())).toEqual([toggle().textContent, 'Stop all']);
    });

    it('puts a thread that waits for the person first, also when it rests for its background work and its card is the only sign', async () => {
        put({ ...runs().get('r-orch-6e')!, awaitingUser: true });
        await draw('c-6');

        expect(rows().map(row => buttons(row))).toEqual([
            ['Load test the checkout · Waiting for you', 'Stop'],
            ['Fix the price rounding · Running bun test src/checkout', 'Stop'],
        ]);
    });

    it('keeps a thread that waits for the person on the folded line, and folds the thread that works away', async () => {
        put({ ...runs().get('r-orch-6e')!, awaitingUser: true });
        ui().toggleAgentsFolded();
        await draw('c-6');

        expect(rows().map(row => buttons(row))).toEqual([['Load test the checkout · Waiting for you', 'Stop']]);
        expect(header()!.textContent).toBe('Agents2 runningStop all');

        // Once it is decided nothing is left to show on the folded line.
        put({ ...runs().get('r-orch-6e')!, awaitingUser: undefined });
        await draw('c-6');
        expect(lines()).toEqual([header()]);
    });

    it("opens the thread's chat from its row", async () => {
        await draw('c-6');
        await act(async () => rows()[1].querySelector('button')!.click());

        await vi.waitFor(() => expect(ui().chatId).toBe('c-6e'));
    });

    it('stops one thread alone from its row: its run is cancelled and its queue held, the parent and the other thread go on', async () => {
        await draw('c-6');

        const command = vi.spyOn(store, 'command');

        await act(async () => [...rows()[0].querySelectorAll('button')][1].click());
        expect(command).toHaveBeenCalledWith({ type: 'run.cancel', runId: 'r-orch-6a' });
        await vi.waitFor(() => expect(runs().get('r-orch-6a')?.status).toBe('cancelled'));
        await vi.waitFor(() => expect(store.selectedProject!.chats.get('c-6a')?.queuePaused).toBe('stopped'));
        expect([runs().get('r-orch-6')?.status, runs().get('r-orch-6e')?.status]).toEqual([
            'succeeded',
            'waiting_background',
        ]);
    });

    it('stops every thread from Stop all, one cancel each, and asks no sub-agent to stop when there is none', async () => {
        await draw('c-6');

        const command = vi.spyOn(store, 'command');

        await act(async () => stopAll().click());
        expect(command.mock.calls.map(([input]) => input)).toEqual([
            { type: 'run.cancel', runId: 'r-orch-6a' },
            { type: 'run.cancel', runId: 'r-orch-6e' },
        ]);
        await vi.waitFor(() =>
            expect(['r-orch-6a', 'r-orch-6e'].map(id => runs().get(id)?.status)).toEqual(['cancelled', 'cancelled'])
        );
    });

    it('stops the sub-agents and the threads together from Stop all', async () => {
        putChat({ ...store.selectedProject!.chats.get('c-6e')!, parentChatId: 'c-1' });
        await draw();

        // Oldest first, by when each was made: the thread before the two sub-agents.
        expect(rows().map(row => row.textContent?.split(' ·')[0])).toEqual([
            'Load test the checkout',
            'General agent',
            'Explore agent',
        ]);

        const command = vi.spyOn(store, 'command');

        await act(async () => stopAll().click());
        expect(command).toHaveBeenCalledWith({ type: 'run.stopAgents', runId: 'r-orch-1' });
        expect(command).toHaveBeenCalledWith({ type: 'run.cancel', runId: 'r-orch-6e' });
        expect(command).toHaveBeenCalledTimes(2);
    });

    it("lists only the chat's own threads: a thread of a thread is in its parent's strip", async () => {
        put({ ...runs().get('r-orch-6a1')!, status: 'running', finishedAt: undefined });
        await draw('c-6');

        expect(rows().map(row => row.textContent)).not.toContainEqual(
            expect.stringContaining('Check the currency table')
        );

        await draw('c-6a');

        // Its stream ends with its answer, which reads as thinking about the next step.
        expect(rows().map(row => buttons(row))).toEqual([['Check the currency table · Thinking…', 'Stop']]);
    });

    it('has a Stop all with a single sub-agent that can stop alone and one thread', async () => {
        put({ ...runs().get('r-na-03')!, status: 'succeeded' });
        putChat({ ...store.selectedProject!.chats.get('c-6e')!, parentChatId: 'c-1' });
        await draw();

        expect(buttons(header())).toEqual([toggle().textContent, 'Stop all']);
    });

    it('counts threads in the five rows and in the line that counts the rest', async () => {
        for (let index = 1; index <= 4; index++) {
            putChat({
                ...store.selectedProject!.chats.get('c-6e')!,
                id: `c-many-${index}`,
                title: `Thread ${index}`,
                parentChatId: 'c-1',
                orchestratorRunId: `r-many-${index}`,
                createdAt: Date.now() + index,
            });
            put({
                ...runs().get('r-orch-6e')!,
                id: `r-many-${index}`,
                rootRunId: `r-many-${index}`,
                chatId: `c-many-${index}`,
            });
        }

        await draw();

        expect(rows()).toHaveLength(6);
        expect(
            rows()
                .slice(0, 5)
                .map(row => row.textContent?.split(' ·')[0])
        ).toEqual(['General agent', 'Explore agent', 'Thread 1', 'Thread 2', 'Thread 3']);
        expect(rows().at(-1)?.textContent).toBe('1 more agent at work');
    });
});

describe('RunningAgents, a command that can be stopped alone', () => {
    const command = (n: number, over: Partial<BackgroundItem> = {}): BackgroundItem => ({
        id: `bg-${n}`,
        kind: 'command',
        title: `command ${n}`,
        canStopAlone: true,
        ...over,
    });

    it('has a row of its own with the command as its title and a Stop that stops that command only', async () => {
        await draw('c-5');

        expect(rows().map(row => row.textContent)).toEqual([
            'Command · bun run testStop',
            'Background task runningStop',
        ]);
        expect(rows()[0].querySelector('svg')).not.toBeNull();

        const spy = vi.spyOn(store, 'command');

        await act(async () => rows()[0].querySelector('button')!.click());
        expect(spy).toHaveBeenCalledWith({ type: 'run.stopBackground', runId: 'r-orch-5', itemId: 'bg-1' });
        expect(spy).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'run.cancel' }));

        // The daemon takes the command out of the list; the run, its other work and the row that counts it are untouched.
        await vi.waitFor(() =>
            expect(
                runs()
                    .get('r-orch-5')
                    ?.background?.map(item => item.id)
            ).toEqual(['bg-2'])
        );
        await draw('c-5');
        expect(rows().map(row => row.textContent)).toEqual(['Background task runningStop']);
        expect(runs().get('r-orch-5')?.status).toBe('waiting_background');
    });

    it('is not an agent: it opens no header and Stop all does not touch it', async () => {
        put({ ...runs().get('r-orch-5')!, background: [command(1), command(2)] });
        await draw('c-5');

        expect(header()).toBeUndefined();
        expect(rows().map(row => row.textContent)).toEqual(['Command · command 1Stop', 'Command · command 2Stop']);
        expect(container.textContent).not.toContain('Stop all');

        // Beside agents, it comes after them, and they keep their header and their own Stop all.
        put({ ...runs().get('r-orch-1')!, background: [command(1)] });
        await draw();
        expect(header()).toBeDefined();
        expect(rows().map(row => row.textContent?.split(' · ')[0])).toEqual([
            'General agent',
            'Explore agent',
            'Command',
        ]);
        expect(buttons(header())).toEqual([toggle().textContent, 'Stop all']);

        const spy = vi.spyOn(store, 'command');

        await act(async () => stopAll().click());
        expect(spy).toHaveBeenCalledWith({ type: 'run.stopAgents', runId: 'r-orch-1' });
        // Stop all stops agents: the command is still in the list.
        await vi.waitFor(() =>
            expect(
                runs()
                    .get('r-orch-1')
                    ?.background?.map(item => item.id)
            ).toEqual(['bg-1'])
        );
    });

    it('is capped at five rows, and the rest are counted with what cannot be stopped alone', async () => {
        put({
            ...runs().get('r-orch-5')!,
            background: [
                ...Array.from({ length: 7 }, (_, index) => command(index + 1)),
                { id: 'plain', kind: 'command', title: 'plain' },
            ],
        });
        await draw('c-5');

        expect(rows().map(row => row.textContent)).toEqual([
            ...Array.from({ length: 5 }, (_, index) => `Command · command ${index + 1}Stop`),
            '3 background tasks runningStop',
        ]);
    });

    it('is a task when the agent lets a task be stopped alone, and is not drawn once the run is over', async () => {
        put({
            ...runs().get('r-orch-5')!,
            background: [{ id: 'wf-1', kind: 'task', title: 'Workflow: verify', canStopAlone: true }],
        });
        await draw('c-5');
        expect(rows().map(row => row.textContent)).toEqual(['Task · Workflow: verifyStop']);

        put({ ...runs().get('r-orch-5')!, status: 'cancelled' });
        await draw('c-5');
        expect(container.innerHTML).toBe('');
    });
});

// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createFixtureData, FIXTURE_PROJECT_ID } from '../daemon/fixtureData';
import { FixtureTransport } from '../daemon/fixtureTransport';
import { RootStore, RootStoreProvider } from '../stores';
import { StreamView } from './StreamView';

import type { StreamItem, StreamItemBody } from '@clowdy/protocol';
import type { KeyValueStorage } from '../stores/storage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/*
 * The agent cards in a stream, on the fixture project: the orchestrator r-orch-1 has a finished `Agent` call (tc-agent-1, native child
 * r-na-01), a running one (tc-agent-2, native child r-na-02, which is searching), and `run_spawn` calls for Executor 07 (as JSON text) and
 * Executor 08 (as the tool's object). The test build has no MobX observer plugin, so the view is drawn again by hand after a change.
 */

const memoryStorage = (): KeyValueStorage => {
    const data: Record<string, string> = {};

    return { getItem: key => data[key] ?? null, setItem: (key, value) => void (data[key] = value) };
};

type ToolBody = Extract<StreamItemBody, { kind: 'tool' }>;

let container: HTMLDivElement;
let reactRoot: Root;
let store: RootStore;
let fixtureCall: (toolCallId: string) => ToolBody;

beforeEach(async () => {
    const data = createFixtureData();

    fixtureCall = toolCallId => data.items['r-orch-1'].map(entry => entry.body).find((body): body is ToolBody => body.kind === 'tool' && body.toolCallId === toolCallId)!;
    store = new RootStore(new FixtureTransport({ data }), { storage: memoryStorage() });
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
const card = () => container.querySelector<HTMLElement>('[data-slot="agent-card"]')!;
const opener = () => card().querySelector('button');

/** The card's words. The loader is an SVG with a style sheet of its own, whose text is not words. */
function text(): string | null {
    const copy = card().cloneNode(true) as HTMLElement;

    copy.querySelectorAll('svg').forEach(svg => svg.remove());

    return copy.textContent;
}

/** Draws the calls as a stream of r-orch-1, then again once the streams the cards read have been fetched. */
async function draw(calls: ToolBody[], active = true) {
    const items: StreamItem[] = calls.map((body, index) => ({ id: `i-${ index }`, runId: 'r-orch-1', seq: index + 1, at: index, body }));
    const render = () => act(async () => reactRoot.render(<RootStoreProvider value={ store }><StreamView items={ items } active={ active } /></RootStoreProvider>));

    await render();
    await render();
}

describe('the card of an agent\'s own sub-agent', () => {
    it('reads `Ran Explore agent` and Finished once its call is done, and opens the native child the call started', async () => {
        await draw([fixtureCall('tc-agent-1')]);

        expect(text()).toBe('Ran Explore agentFinished');
        expect(card().getAttribute('aria-busy')).toBeNull();

        await act(async () => opener()!.click());

        expect(ui().runId).toBe('r-na-01');
        expect(ui().section).toBe('agents');
    });

    it('shimmers its verb while the call runs, with what the child does now as its one live line', async () => {
        await draw([fixtureCall('tc-agent-2')]);

        expect(text()).toBe('ExploringSearching useBookingPrice');
        expect(card().getAttribute('aria-busy')).toBe('true');
        expect(opener()!.getAttribute('aria-label')).toBe('Exploring. Searching useBookingPrice');
    });

    it('says the agent did not finish when the stream\'s run is over and the call never ended', async () => {
        await draw([fixtureCall('tc-agent-2')], false);

        expect(text()).toBe('The agent did not finish');
        expect(card().getAttribute('aria-busy')).toBeNull();
    });

    it('shows a failed call\'s error, and is not pressable when the agent reported no child', async () => {
        await draw([{ kind: 'tool', toolCallId: 'tc-lonely', name: 'Task', input: { subagent_type: 'Plan' }, state: 'error', error: 'The sub-agent stopped' }]);

        expect(text()).toBe('Ran Plan agentThe sub-agent stopped');
        expect(opener()).toBeNull();
    });

    it('stays a plain card, starting, for a running call of an agent that reports nothing about it', async () => {
        await draw([{ kind: 'tool', toolCallId: 'tc-codex', name: 'spawnAgent', input: { prompt: 'Look around' }, state: 'running' }]);

        expect(text()).toBe('Running agentStarting…');
        expect(opener()).toBeNull();
    });
});

describe('the card of a run started with run_spawn', () => {
    it('names the child from its JSON text result, says what it works on, its status and what it does now (writing, here), and opens it', async () => {
        await draw([fixtureCall('tc-spawn-07')]);

        expect(text()).toBe('Executor 07Update the booking formWorkingFinishing reply');
        expect(card().getAttribute('aria-busy')).toBe('true');

        await act(async () => opener()!.click());

        expect(ui().runId).toBe('r-ex-07');
    });

    it('reads the tool\'s object too, and says why a child that is not working waits', async () => {
        await draw([fixtureCall('tc-spawn-08')]);

        expect(text()).toBe('Executor 08Confirmation email and cancellationWaitingAsked which mail provider to use');
        expect(card().getAttribute('aria-busy')).toBeNull();
    });

    it('says a finished child finished, and shows a failed one\'s error', async () => {
        const spawned = (runId: string): ToolBody => ({ kind: 'tool', toolCallId: `tc-${ runId }`, name: 'run_spawn', input: {}, state: 'done', output: { runId } });

        await draw([spawned('r-ex-09')]);
        expect(text()).toBe('Executor 09Set up the booking schemaDoneFinished');

        await draw([spawned('r-ex-10')]);
        expect(text()).toBe('Executor 10Weekend pricing rulesFailedTypecheck failed in 3 files and the run could not repair them.');
    });

    it('starts, fails to start, or names no run it can find, and is not pressable then', async () => {
        await draw([{ kind: 'tool', toolCallId: 'tc-s1', name: 'run_spawn', input: {}, state: 'running' }]);
        expect(text()).toBe('Starting an agent');

        await draw([{ kind: 'tool', toolCallId: 'tc-s2', name: 'run_spawn', input: {}, state: 'error', error: 'Too many children' }]);
        expect(text()).toBe('Could not start an agentToo many children');
        expect(opener()).toBeNull();

        await draw([{ kind: 'tool', toolCallId: 'tc-s3', name: 'run_spawn', input: {}, state: 'done', output: '{"runId":"r-gone"}' }]);
        expect(text()).toBe('Started an agent');
        expect(opener()).toBeNull();
    });
});

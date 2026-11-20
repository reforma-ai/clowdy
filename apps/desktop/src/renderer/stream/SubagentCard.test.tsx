// @vitest-environment happy-dom
import { runInAction } from 'mobx';
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
 * r-na-01) and a running one (tc-agent-2, native child r-na-02, which is searching). The test build has no MobX observer plugin, so the view is drawn
 * again by hand after a change.
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

    it('says the agent did not finish when its child ended with the turn while the call never did, though the run works again', async () => {
        const runs = store.selectedProject!.runs;

        // The turn was stopped mid-call and the person wrote again: the run is going, the old call is still `running`, its child was cancelled.
        runInAction(() => runs.set('r-na-02', { ...runs.get('r-na-02')!, status: 'cancelled', statusReason: 'The parent run ended its turn' }));
        await draw([fixtureCall('tc-agent-2')]);

        expect(text()).toBe('The agent did not finish');
        expect(card().getAttribute('aria-busy')).toBeNull();
    });

    it('is named by the call alone, not by the placeholder name the daemon gives a child the call does not name', async () => {
        const runs = store.selectedProject!.runs;

        runInAction(() => runs.set('r-na-x', { ...runs.get('r-na-01')!, id: 'r-na-x', name: 'Sub-agent', parentToolCallId: 'tc-unnamed' }));
        await draw([{ kind: 'tool', toolCallId: 'tc-unnamed', name: 'Agent', input: { description: 'Look around', prompt: 'Look around' }, state: 'done', output: 'Done' }]);

        expect(text()).toBe('Ran agentFinished');
        expect(opener()).not.toBeNull();
    });
});

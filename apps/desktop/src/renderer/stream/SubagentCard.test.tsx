// @vitest-environment happy-dom
import { STOPPED_TOOL } from '@clowdy/protocol';
import { runInAction } from 'mobx';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFixtureData, FIXTURE_PROJECT_ID } from '../daemon/fixtureData';
import { FixtureTransport } from '../daemon/fixtureTransport';
import { RootStore, RootStoreProvider } from '../stores';
import { StreamView } from './StreamView';

import type { StreamItem, StreamItemBody, ThreadNotice } from '@clowdy/protocol';
import type { KeyValueStorage } from '../stores/storage';
import type { StreamLinks } from './StreamLinks';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/*
 * The agent cards in a stream, on the fixture project: the orchestrator r-orch-1 has a finished `Agent` call (tc-agent-1, native child r-na-01), two running
 * ones (tc-agent-2, native child r-na-02, which is searching, and tc-agent-3) and a failed one (tc-agent-4, r-na-04). The test build has no MobX observer
 * plugin, so the view is drawn again by hand after a change.
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
/** What the clamp of a card measures: the height of its content, and the height it is allowed. */
let layout = { scrollHeight: 0, clientHeight: 0 };

beforeEach(async () => {
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

    const data = createFixtureData();

    fixtureCall = toolCallId =>
        data.items['r-orch-1']
            .map(entry => entry.body)
            .find((body): body is ToolBody => body.kind === 'tool' && body.toolCallId === toolCallId)!;
    store = new RootStore(new FixtureTransport({ data }), { storage: memoryStorage() });
    await store.load();
    container = document.createElement('div');
    document.body.append(container);
    reactRoot = createRoot(container);
});

afterEach(() => {
    act(() => reactRoot.unmount());
    container.remove();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(HTMLElement.prototype, 'scrollHeight');
    Reflect.deleteProperty(HTMLElement.prototype, 'clientHeight');
});

const ui = () => store.ui.forProject(FIXTURE_PROJECT_ID);
const cards = () => [...container.querySelectorAll<HTMLElement>('[data-slot="agent-card"]')];
const card = () => cards()[0]!;
const opener = (scope: HTMLElement = card()) => scope.querySelector<HTMLButtonElement>('button[class*="press"]');
/** What the title's button is described by: the live line, which a screen reader reads once, after the name. */
const described = (scope: HTMLElement = card()) =>
    document.getElementById(opener(scope)?.getAttribute('aria-describedby') ?? '')?.textContent;
const toggle = (scope: HTMLElement = card()) =>
    [...scope.querySelectorAll('button')].find(button => button.textContent?.startsWith('Show'));

/** The card's words. The loader is an SVG with a style sheet of its own, whose text is not words. */
function text(scope: HTMLElement = card()): string | null {
    const copy = scope.cloneNode(true) as HTMLElement;

    copy.querySelectorAll('svg').forEach(svg => svg.remove());

    return copy.textContent;
}

/** Draws the calls as a stream of r-orch-1, then again once the streams the cards read have been fetched. */
async function draw(calls: StreamItemBody[], active = true, links: StreamLinks = {}) {
    const items: StreamItem[] = calls.map((body, index) => ({
        id: `i-${index}`,
        runId: 'r-orch-1',
        seq: index + 1,
        at: index,
        body,
    }));
    const render = () =>
        act(async () =>
            reactRoot.render(
                <RootStoreProvider value={store}>
                    <StreamView items={items} active={active} links={links} />
                </RootStoreProvider>
            )
        );

    await render();
    await render();
}

describe("the card of an agent's own sub-agent", () => {
    it('reads what the sub-agent was asked to do and that it finished, with its report, and opens the native child the call started', async () => {
        await draw([fixtureCall('tc-agent-1')]);

        expect(text()).toBe(
            'Map the booking flow finishedThree step components in src/booking/steps.tsx share one context; the price is computed only on the last step.'
        );
        expect(card().getAttribute('data-outcome')).toBe('finished');
        expect(card().getAttribute('aria-busy')).toBeNull();

        await act(async () => opener()!.click());

        expect(ui().runId).toBe('r-na-01');
    });

    it('shimmers what the sub-agent was asked to do while the call runs, with what the child does now as its one live line', async () => {
        await draw([fixtureCall('tc-agent-2')]);

        expect(text()).toBe('Find where the price is computedSearching useBookingPrice');
        expect(card().getAttribute('data-outcome')).toBeNull();
        expect(card().getAttribute('aria-busy')).toBe('true');
        expect(described()).toBe('Searching useBookingPrice');

        await act(async () => opener()!.click());

        expect(ui().runId).toBe('r-na-02');
    });

    it('shimmers its verb instead when the child was given no purpose, and names it by its type after', async () => {
        const runs = store.selectedProject!.runs;

        runInAction(() => runs.set('r-na-02', { ...runs.get('r-na-02')!, summary: '' }));
        await draw([fixtureCall('tc-agent-2')]);

        expect(text()).toBe('ExploringSearching useBookingPrice');
        expect(described()).toBe('Searching useBookingPrice');

        runInAction(() => runs.set('r-na-02', { ...runs.get('r-na-02')!, status: 'succeeded', result: 'Found it.' }));
        await draw([{ ...fixtureCall('tc-agent-2'), state: 'done', output: 'Found it.' }]);

        expect(text()).toBe('Explore agent finishedFound it.');
    });

    it("says a failed sub-agent failed, with its run's error as its report, and opens it", async () => {
        await draw([fixtureCall('tc-agent-4')]);

        expect(text()).toBe(
            'Weekend pricing rules failedTypecheck failed in 3 files and the run could not repair them.'
        );
        expect(card().getAttribute('data-outcome')).toBe('failed');

        await act(async () => opener()!.click());

        expect(ui().runId).toBe('r-na-04');
    });

    it("says the agent was interrupted when the stream's run is over and the call never ended", async () => {
        await draw([fixtureCall('tc-agent-2')], false);

        expect(text()).toBe('Find where the price is computed was interrupted');
        expect(card().getAttribute('data-outcome')).toBe('interrupted');
        expect(card().getAttribute('aria-busy')).toBeNull();
    });

    it('says the agent was interrupted when its child ended with the turn while the call never did, though the run works again', async () => {
        const runs = store.selectedProject!.runs;

        // The turn was stopped mid-call and the person wrote again: the run is going, the old call is still `running`, its child was cancelled.
        runInAction(() =>
            runs.set('r-na-02', {
                ...runs.get('r-na-02')!,
                status: 'cancelled',
                statusReason: 'The parent run ended its turn',
            })
        );
        await draw([fixtureCall('tc-agent-2')]);

        expect(text()).toBe('Find where the price is computed was interrupted');
        expect(card().getAttribute('aria-busy')).toBeNull();
    });

    it('is finished the moment its child is, though its call has not returned yet, not interrupted in between', async () => {
        const runs = store.selectedProject!.runs;

        runInAction(() => runs.set('r-na-02', { ...runs.get('r-na-02')!, status: 'succeeded', result: 'Found it.' }));
        await draw([fixtureCall('tc-agent-2')]);

        expect(text()).toBe('Find where the price is computed finishedFound it.');
        expect(card().getAttribute('data-outcome')).toBe('finished');
        expect(card().getAttribute('aria-busy')).toBeNull();
    });

    it('keeps working while its child does after its call returned, as a background sub-agent does', async () => {
        await draw([{ ...fixtureCall('tc-agent-2'), state: 'done', output: 'Started in the background' }]);

        expect(text()).toBe('Find where the price is computedSearching useBookingPrice');
        expect(card().getAttribute('aria-busy')).toBe('true');
    });

    it('says what its child says when the call returned: stopped alone is interrupted, failed is failed with its reason', async () => {
        const runs = store.selectedProject!.runs;
        const done = { ...fixtureCall('tc-agent-2'), state: 'done' as const, output: 'Done' };

        runInAction(() => runs.set('r-na-02', { ...runs.get('r-na-02')!, status: 'cancelled' }));
        await draw([done]);

        expect(text()).toBe('Find where the price is computed was interrupted');

        runInAction(() =>
            runs.set('r-na-02', { ...runs.get('r-na-02')!, status: 'failed', error: 'The session ended unexpectedly' })
        );
        await draw([done]);

        expect(text()).toBe('Find where the price is computed failedThe session ended unexpectedly');
    });

    it('keeps the error of the call when its child has none to give', async () => {
        const runs = store.selectedProject!.runs;

        runInAction(() => runs.set('r-na-04', { ...runs.get('r-na-04')!, error: '' }));
        await draw([fixtureCall('tc-agent-4')]);

        expect(text()).toBe(
            'Weekend pricing rules failedTypecheck failed in 3 files and the run could not repair them.'
        );
    });

    it('says the agent was interrupted when it was stopped, not that it failed, and adds no report of its own', async () => {
        await draw([{ ...fixtureCall('tc-agent-2'), state: 'error', error: STOPPED_TOOL }]);

        expect(text()).toBe('Find where the price is computed was interrupted');
        expect(card().getAttribute('data-outcome')).toBe('interrupted');
    });

    it("shows a failed call's error, and is not pressable when the agent reported no child", async () => {
        await draw([
            {
                kind: 'tool',
                toolCallId: 'tc-lonely',
                name: 'Task',
                input: { subagent_type: 'Plan' },
                state: 'error',
                error: 'The sub-agent stopped',
            },
        ]);

        expect(text()).toBe('Plan agent failedThe sub-agent stopped');
        expect(opener()).toBeNull();
        expect(card().getAttribute('data-pressable')).toBeNull();
    });

    it('stays a plain card, starting, for a running call of an agent that reports nothing about it', async () => {
        await draw([
            {
                kind: 'tool',
                toolCallId: 'tc-codex',
                name: 'spawnAgent',
                input: { prompt: 'Look around' },
                state: 'running',
            },
        ]);

        expect(text()).toBe('Running agentStarting…');
        expect(opener()).toBeNull();
    });

    it('is named by the call alone, not by the placeholder name the daemon gives a child the call does not name', async () => {
        const runs = store.selectedProject!.runs;

        runInAction(() =>
            runs.set('r-na-x', {
                ...runs.get('r-na-01')!,
                id: 'r-na-x',
                name: 'Sub-agent',
                summary: '',
                result: undefined,
                parentToolCallId: 'tc-unnamed',
            })
        );
        await draw([
            {
                kind: 'tool',
                toolCallId: 'tc-unnamed',
                name: 'Agent',
                input: { description: 'Look around', prompt: 'Look around' },
                state: 'done',
                output: 'Done',
            },
        ]);

        expect(text()).toBe('Agent finished');
        expect(opener()).not.toBeNull();
    });
});

describe('the card family', () => {
    const notices: ThreadNotice[] = [
        { chatId: 'c-6b', title: 'Write the refund tests', outcome: 'finished', text: '14 cases, all passing.' },
        { chatId: 'c-6c', title: 'Migrate the payments table', outcome: 'failed', text: 'The column already exists' },
        { chatId: 'c-6d', title: 'Fix login', outcome: 'interrupted' },
    ];
    const notice: StreamItemBody = { kind: 'user', text: '', from: { kind: 'threadNotice', threads: notices } };

    /** A stream of r-orch-1: a notice of threads that stopped, then a finished, a failed, an interrupted and a running sub-agent. */
    const mixed = (): StreamItemBody[] => [
        notice,
        fixtureCall('tc-agent-1'),
        fixtureCall('tc-agent-4'),
        { ...fixtureCall('tc-agent-3'), state: 'error', error: STOPPED_TOOL },
        fixtureCall('tc-agent-2'),
    ];

    it('draws a sub-agent and a thread that stopped as the same card, with the same words for how they ended', async () => {
        await draw(mixed());

        expect(cards().map(found => text(found))).toEqual([
            'Write the refund tests finished14 cases, all passing.',
            'Migrate the payments table failedThe column already exists',
            'Fix login was interrupted',
            'Map the booking flow finishedThree step components in src/booking/steps.tsx share one context; the price is computed only on the last step.',
            'Weekend pricing rules failedTypecheck failed in 3 files and the run could not repair them.',
            'Update the booking form was interrupted',
            'Find where the price is computedSearching useBookingPrice',
        ]);
        expect(cards().map(found => found.getAttribute('data-outcome'))).toEqual([
            'finished',
            'failed',
            'interrupted',
            'finished',
            'failed',
            'interrupted',
            null,
        ]);
        // One frame: an icon, then the body that begins with the title, in a thread's card and a sub-agent's alike.
        const shape = (found: HTMLElement) =>
            `${[...found.children].map(child => child.tagName).join()} ${found.querySelector('div > span[class*="title"]') ? 'title' : ''}`;

        expect(cards().every(found => found.querySelector('svg'))).toBe(true);
        expect(new Set(cards().map(shape))).toEqual(new Set(['SPAN,DIV title']));
    });

    it('opens the page of a sub-agent and the chat of a thread from a press on the title', async () => {
        const onOpenChat = vi.fn();

        await draw(mixed(), true, { onOpenChat, hasChat: () => true });

        await act(async () => opener(cards()[1])!.click());

        expect(onOpenChat).toHaveBeenCalledWith('c-6c');

        await act(async () => opener(cards()[3])!.click());

        expect(ui().runId).toBe('r-na-01');
    });

    it('has nothing to press on a thread the project no longer has', async () => {
        await draw(mixed(), true, { onOpenChat: vi.fn(), hasChat: chatId => chatId !== 'c-6b' });

        expect(opener(cards()[0])).toBeNull();
        expect(cards()[0].getAttribute('data-pressable')).toBeNull();
        expect(opener(cards()[1])).not.toBeNull();
    });

    it('clamps a long report of a sub-agent as it does the words of a thread, with the toggle that opens the rest', async () => {
        const runs = store.selectedProject!.runs;
        const long = Array.from({ length: 30 }, (_, line) => `Line ${line + 1} of the report`).join('\n\n');

        runInAction(() => runs.set('r-na-01', { ...runs.get('r-na-01')!, result: long }));
        layout = { scrollHeight: 900, clientHeight: 90 };
        await draw([fixtureCall('tc-agent-1'), notice]);

        const [subagent, refunds] = [cards()[0], cards()[1]];

        for (const found of [subagent, refunds]) {
            expect(toggle(found)?.textContent).toBe('Show full message');
            expect(toggle(found)?.getAttribute('aria-expanded')).toBe('false');
        }

        await act(async () => toggle(subagent)!.click());

        expect(toggle(subagent)?.textContent).toBe('Show less');
        expect(toggle(subagent)?.getAttribute('aria-expanded')).toBe('true');
        // The toggle belongs to the report: it does not open the sub-agent.
        expect(ui().runId).not.toBe('r-na-01');
    });

    it('has no toggle for a report that fits', async () => {
        await draw([fixtureCall('tc-agent-1')]);

        expect(toggle()).toBeUndefined();
    });
});

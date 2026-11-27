// @vitest-environment happy-dom
import { runInAction } from 'mobx';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFixtureData } from '../../daemon/fixtureData';
import { FixtureTransport } from '../../daemon/fixtureTransport';
import { RootStore, RootStoreProvider } from '../../stores';
import { ConversationView } from './ConversationView';

import type { Run } from '@clowdy/protocol';
import type { RunStream } from '../../stores';
import type { KeyValueStorage } from '../../stores/storage';
import type { ConversationLinks } from './useStreamLinks';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/*
 * The page a chat, a thread and a sub-agent share, on the fixture project: the orchestrator r-orch-1 of the chat "Simplify booking", whose stream has messages.
 * What differs between the pages (the line over the stream, the banners, the box) is given to it, and is drawn in its place.
 */

const memoryStorage = (): KeyValueStorage => {
    const data: Record<string, string> = {};

    return { getItem: key => data[key] ?? null, setItem: (key, value) => void (data[key] = value) };
};

let container: HTMLDivElement;
let reactRoot: Root;
let store: RootStore;

const runOf = (id: string): Run => store.selectedProject!.runs.get(id)!;
const streamOf = async (id: string): Promise<RunStream> => {
    const stream = store.streams.of(id);

    await stream.load();

    return stream;
};
const draw = (props: { run?: Run; stream?: RunStream; backgroundLine?: string; emptyState?: ReactNode }) =>
    act(async () =>
        reactRoot.render(
            <RootStoreProvider value={store}>
                <ConversationView
                    run={props.run}
                    stream={props.stream}
                    links={links}
                    backgroundLine={props.backgroundLine}
                    emptyState={props.emptyState}
                    top={<div data-testid="top">Over the stream</div>}
                    banners={<div data-testid="banners">Above the box</div>}
                    bottom={<div data-testid="bottom">The box</div>}
                />
            </RootStoreProvider>
        )
    );
const text = () => container.textContent ?? '';
const links: ConversationLinks = { attachmentBlob: async () => new Blob(), onOpenChat: () => {} };

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

describe('ConversationView, its parts', () => {
    it('draws the line over the stream first, then the stream, and over its bottom the banners and the box, in that order', async () => {
        await draw({ run: runOf('r-orch-1'), stream: await streamOf('r-orch-1') });
        await draw({ run: runOf('r-orch-1'), stream: await streamOf('r-orch-1') });

        const top = container.querySelector('[data-testid="top"]')!;
        const banners = container.querySelector('[data-testid="banners"]')!;
        const bottom = container.querySelector('[data-testid="bottom"]')!;

        expect(top.compareDocumentPosition(banners) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(banners.compareDocumentPosition(bottom) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(banners.parentElement?.parentElement).toBe(bottom.parentElement);
        expect(container.querySelector('[data-turn]')).not.toBeNull();
    });

    it('draws the stream of a chat that has no run yet, with its empty state', async () => {
        await draw({ emptyState: <span>Nothing here yet</span> });

        expect(text()).toContain('Nothing here yet');
        expect(container.querySelector('[data-testid="bottom"]')).not.toBeNull();
    });
});

describe('ConversationView, the states of the stream', () => {
    it('says the messages are loading while they are, and draws no stream', async () => {
        const stream = await streamOf('r-orch-1');

        runInAction(() => {
            stream.status = 'loading';
        });
        await draw({ run: runOf('r-orch-1'), stream });

        runInAction(() => stream.byId.clear());
        await draw({ run: runOf('r-orch-1'), stream });

        expect(text()).toContain('Loading messages…');
        expect(container.querySelector('[data-turn]')).toBeNull();
        expect(container.querySelector('[data-testid="bottom"]')).not.toBeNull();
    });

    it('keeps the stream on the page while it is read again, so the reading place is not lost', async () => {
        const stream = await streamOf('r-orch-1');

        runInAction(() => {
            stream.status = 'loading';
        });
        await draw({ run: runOf('r-orch-1'), stream });
        await draw({ run: runOf('r-orch-1'), stream });

        expect(text()).not.toContain('Loading messages…');
        expect(container.querySelector('[data-turn]')).not.toBeNull();
    });

    it('says why the messages could not be loaded and loads them again from Retry', async () => {
        const stream = await streamOf('r-orch-1');

        runInAction(() => {
            stream.status = 'failed';
            stream.error = 'The daemon is not answering';
        });

        const reload = vi.spyOn(stream, 'reload').mockResolvedValue();

        await draw({ run: runOf('r-orch-1'), stream });

        expect(text()).toContain('The messages could not be loaded. The daemon is not answering');

        await act(async () =>
            [...container.querySelectorAll('button')].find(button => button.textContent === 'Retry')!.click()
        );

        expect(reload).toHaveBeenCalledOnce();
    });

    it('shows the empty state of a run that has written nothing', async () => {
        const stream = await streamOf('r-na-02');

        runInAction(() => stream.byId.clear());
        await draw({ run: runOf('r-na-02'), stream, emptyState: <span>Nothing written</span> });

        expect(text()).toContain('Nothing written');
    });
});

describe('ConversationView, the live line', () => {
    const resting = (): Run => ({ ...runOf('r-na-02'), status: 'waiting_background' });
    const line = 'Waiting for background work…';

    it('says that a run rests for its background work when the page was given the words, and does not when it was not', async () => {
        await draw({ run: resting(), stream: await streamOf('r-na-02'), backgroundLine: line });
        await draw({ run: resting(), stream: await streamOf('r-na-02'), backgroundLine: line });

        expect(text()).toContain(line);

        await draw({ run: resting(), stream: await streamOf('r-na-02') });

        expect(text()).not.toContain(line);
    });

    it('says that a run waits for a free slot, and says nothing of a run that is over', async () => {
        await draw({ run: { ...runOf('r-na-02'), status: 'queued' }, stream: await streamOf('r-na-02') });
        await draw({ run: { ...runOf('r-na-02'), status: 'queued' }, stream: await streamOf('r-na-02') });

        expect(text()).toContain('Waiting for a free slot…');

        await draw({ run: { ...runOf('r-na-02'), status: 'cancelled' }, stream: await streamOf('r-na-02') });

        expect(text()).not.toContain('Waiting for a free slot…');
    });

    it('shows the reason and reset time when a queued run waits for a usage limit', async () => {
        const reason = 'Claude is at its usage limit until 14:00';

        await draw({
            run: { ...runOf('r-na-02'), status: 'queued', statusReason: reason },
            stream: await streamOf('r-na-02'),
        });

        const message = "I've hit the Claude usage limit, I'll continue at 14:00";

        expect(text()).toContain(message);
        expect(text()).not.toContain('Waiting for a free slot');
        expect(container.querySelector('[role="status"][data-color="warning"]')?.textContent).toContain(message);
        expect(container.querySelector('[role="status"][data-color="warning"] svg')).toBeNull();
    });

    it('shows when a paused run will continue', async () => {
        const reason = 'Claude is at its usage limit until 14:00; this run continues then';

        await draw({
            run: { ...runOf('r-na-02'), status: 'blocked', statusReason: reason },
            stream: await streamOf('r-na-02'),
        });

        const message = "I've hit the Claude usage limit, I'll continue at 14:00";

        expect(text()).toContain(message);
        expect(container.querySelector('[role="status"][data-color="warning"]')?.textContent).toContain(message);

        await draw({ run: { ...runOf('r-na-02'), status: 'running' }, stream: await streamOf('r-na-02') });

        expect(container.querySelector('[role="status"][data-color="warning"]')).toBeNull();
    });
    it('counts down from the exact deadline and stops promising a time after it passes', async () => {
        const stream = await streamOf('r-na-02');
        const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
        const run = {
            ...runOf('r-na-02'),
            status: 'queued' as const,
            statusReason: 'Claude is at its usage limit until 14:00',
            usageLimitUntil: 1_323_000,
        };

        try {
            await draw({ run, stream });
            expect(text()).toContain('Continue in 6m');
            clock.mockReturnValue(1_322_000);
            await act(async () => {
                await new Promise(resolve => setTimeout(resolve, 1100));
            });
            expect(text()).toContain('Continue in 1m');
            clock.mockReturnValue(1_324_000);
            await act(async () => {
                await new Promise(resolve => setTimeout(resolve, 1100));
            });
            expect(text()).toContain('Usage limit reached, waiting to continue');
            expect(text()).not.toContain('Continue in');
            await draw({ run: { ...run, status: 'running' }, stream });
            expect(text()).not.toContain('Usage limit reached, waiting to continue');
        } finally {
            clock.mockRestore();
        }
    });
    it('shows long pauses in whole minutes', async () => {
        const stream = await streamOf('r-na-02');
        const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);

        try {
            await draw({
                run: {
                    ...runOf('r-na-02'),
                    status: 'blocked',
                    statusReason: 'Claude is at its usage limit until 30 Nov, 14:00; this run continues then',
                    usageLimitUntil: 1_000_000 + (2 * 86400 + 3 * 3600 + 4 * 60 + 5) * 1000,
                },
                stream,
            });
            expect(text()).toContain('Continue in 3,065m');
        } finally {
            clock.mockRestore();
        }
    });
});

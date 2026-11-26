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

        expect(text()).toContain('Loading messages…');
        expect(text()).not.toContain('Over the stream Simplify');
        expect(container.querySelector('[data-testid="bottom"]')).not.toBeNull();
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
});

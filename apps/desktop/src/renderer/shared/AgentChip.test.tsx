// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FixtureTransport } from '../daemon/fixtureTransport';
import { memoryStorage } from '../features/tasks/screenHarness';
import { RootStore, RootStoreProvider } from '../stores';
import { AgentChip } from './AgentChip';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let reactRoot: Root;
let store: RootStore;

const draw = (run: Parameters<typeof AgentChip>[0]['run']) =>
    act(async () =>
        reactRoot.render(
            <RootStoreProvider value={store}>
                <AgentChip run={run} />
            </RootStoreProvider>
        )
    );

beforeEach(async () => {
    container = document.createElement('div');
    document.body.append(container);
    reactRoot = createRoot(container);
    store = new RootStore(new FixtureTransport(), { storage: memoryStorage() });
    await store.load();
});

afterEach(async () => {
    await act(async () => reactRoot.unmount());
    container.remove();
});

describe('AgentChip', () => {
    it('names the orchestrator of a chat by the chat title, never by the daemon number', async () => {
        await draw({ id: 'r-orch-1', name: 'Orchestrator 01', summary: '' });

        expect(container.textContent).toBe('Simplify booking');
        expect(container.textContent).not.toContain('Orchestrator');
    });

    it('names a native sub-agent by its type, as its card and the running-agents row do', async () => {
        await draw({ id: 'native-1', name: 'general-purpose', origin: 'native', summary: '' });

        expect(container.textContent).toBe('General agent');
    });

    it('does not show the old title a chat orchestrator kept as its summary after a rename', async () => {
        await draw({ id: 'r-orch-1', name: 'Orchestrator 01', summary: 'An old title' });

        expect(container.querySelector('button')!.textContent).toBe('Simplify booking');
    });

    it('explains a native sub-agent by its summary', async () => {
        await draw({ id: 'native-1', name: 'general-purpose', origin: 'native', summary: 'Review clone route diff' });

        expect(container.querySelector('button')!.textContent).toBe('Review clone route diff');
    });

    it('keeps the run name when no chat answers to the run', async () => {
        await draw({ id: 'r-gone', name: 'Orchestrator 99', summary: '' });

        expect(container.textContent).toBe('Orchestrator 99');
    });
});

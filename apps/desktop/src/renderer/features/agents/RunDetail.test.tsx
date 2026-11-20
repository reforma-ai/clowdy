// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFixtureData, FIXTURE_PROJECT_ID } from '../../daemon/fixtureData';
import { FixtureTransport } from '../../daemon/fixtureTransport';
import { RootStore, RootStoreProvider } from '../../stores';
import { RunDetail } from './RunDetail';

import type { Run } from '@clowdy/protocol';
import type { KeyValueStorage } from '../../stores/storage';

vi.mock('@clowdy/components/Toast', () => ({ toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn(), info: vi.fn(), show: vi.fn() } }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/*
 * The header of a sub-agent's page, on the fixture project: the native Explore sub-agent r-na-02, which its session can end alone. The test build
 * has no MobX observer plugin, so the view is drawn again by hand after a change.
 */

const memoryStorage = (): KeyValueStorage => {
    const data: Record<string, string> = {};

    return { getItem: key => data[key] ?? null, setItem: (key, value) => void (data[key] = value) };
};

let container: HTMLDivElement;
let reactRoot: Root;
let store: RootStore;

const runOf = (id: string): Run => store.selectedProject!.runs.get(id)!;
const draw = (run: Run) => act(async () => reactRoot.render(<RootStoreProvider value={ store }><RunDetail run={ run } /></RootStoreProvider>));
const stopButton = () => [...container.querySelectorAll('header button')].find(button => button.textContent === 'Stop');

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

describe('RunDetail, Stop', () => {
    it('stops a sub-agent of a session alone when its session can end it', async () => {
        expect(runOf('r-na-02').canStopAlone).toBe(true);
        await draw(runOf('r-na-02'));

        const command = vi.spyOn(store, 'command');

        await act(async () => (stopButton() as HTMLButtonElement).click());
        expect(command).toHaveBeenCalledWith({ type: 'run.cancel', runId: 'r-na-02' });
        await vi.waitFor(() => expect(runOf('r-na-02').status).toBe('cancelled'));
        expect(runOf('r-orch-1').status).toBe('running');
        expect(container.textContent).not.toContain('Runs inside');
    });

    it('has no Stop on a sub-agent whose session cannot end it alone, and says where it runs', async () => {
        await draw({ ...runOf('r-na-02'), canStopAlone: undefined });

        expect(stopButton()).toBeUndefined();
        expect(container.querySelector('header')?.textContent).toContain('Runs inside Orchestrator');
    });
});

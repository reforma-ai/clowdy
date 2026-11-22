// @vitest-environment happy-dom
import { toast } from '@clowdy/components/Toast';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFixtureData, FIXTURE_APPROVALS_RUN_ID, FIXTURE_PROJECT_ID, withFixtureApprovals } from '../../daemon/fixtureData';
import { FixtureTransport } from '../../daemon/fixtureTransport';
import { RootStore, RootStoreProvider } from '../../stores';
import { RunDetail } from './RunDetail';

import type { CommandResult, Run } from '@clowdy/protocol';
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

describe('RunDetail, messages', () => {
    it('reads a finished sub-agent run without a row of actions under its answer', async () => {
        await draw(runOf('r-na-01'));
        await draw(runOf('r-na-01'));

        expect(container.textContent).toContain('Three step components in');
        expect(container.querySelector('time')).toBeNull();
        expect(container.querySelector('[aria-label="Copy message"]')).toBeNull();
    });
});

describe('RunDetail, requests for permission', () => {
    const cardButton = (heading: string, label: string) => {
        const card = container.querySelector(`[role="group"][aria-label="${ heading }"]`);

        return [...card?.querySelectorAll('button') ?? []].find(button => button.textContent === label);
    };

    it('decides a request of the run it shows while the item is open, and says so when the daemon refuses', async () => {
        store.dispose();
        store = new RootStore(new FixtureTransport({ data: withFixtureApprovals(createFixtureData()) }), { storage: memoryStorage() });
        await store.load();
        vi.mocked(toast.error).mockClear();

        await draw(runOf(FIXTURE_APPROVALS_RUN_ID));
        await draw(runOf(FIXTURE_APPROVALS_RUN_ID));

        const command = vi.spyOn(store, 'command');

        await act(async () => cardButton('Change these files', 'Deny')!.click());

        expect(command).toHaveBeenCalledWith({ type: 'run.decide', runId: FIXTURE_APPROVALS_RUN_ID, approvalId: 'apv-3', decision: 'reject' });
        expect(toast.error).not.toHaveBeenCalled();

        command.mockResolvedValueOnce({ ok: false, requestId: 'x', error: { code: 'conflict', message: 'The agent is no longer waiting for this approval' } } satisfies CommandResult);
        await act(async () => cardButton('Use mcp__docs__publish', 'Allow once')!.click());

        expect(toast.error).toHaveBeenCalledWith({ message: 'Could not send the decision: The agent is no longer waiting for this approval' });
    });
});

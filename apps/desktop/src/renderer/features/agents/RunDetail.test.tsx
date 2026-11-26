// @vitest-environment happy-dom
import { toast } from '@clowdy/components/Toast';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    createFixtureData,
    FIXTURE_APPROVALS_RUN_ID,
    FIXTURE_PROJECT_ID,
    type FixtureData,
    withFixtureApprovals,
} from '../../daemon/fixtureData';
import { FixtureTransport } from '../../daemon/fixtureTransport';
import { RootStore, RootStoreProvider } from '../../stores';
import { RunDetail } from './RunDetail';

import type { CommandResult, Run, StreamItem } from '@clowdy/protocol';
import type { KeyValueStorage } from '../../stores/storage';

vi.mock('@clowdy/components/Toast', () => ({
    toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn(), info: vi.fn(), show: vi.fn() },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/*
 * The page of a native sub-agent, on the fixture project: the Explore sub-agent r-na-02, which works and which its session can end alone, and r-na-01, which is
 * done, both of the chat "Simplify booking" (c-1, orchestrator r-orch-1). It is the page of a chat with its box off. The test build has no MobX observer plugin,
 * so the view is drawn again by hand after a change.
 */

const memoryStorage = (): KeyValueStorage => {
    const data: Record<string, string> = {};

    return { getItem: key => data[key] ?? null, setItem: (key, value) => void (data[key] = value) };
};

const refusal = (message: string): CommandResult => ({
    ok: false,
    requestId: 'x',
    error: { code: 'conflict', message },
});

let container: HTMLDivElement;
let reactRoot: Root;
let store: RootStore;

const open = async (data: FixtureData = createFixtureData()) => {
    store.dispose();
    store = new RootStore(new FixtureTransport({ data }), { storage: memoryStorage() });
    await store.load();
};
const runOf = (id: string): Run => store.selectedProject!.runs.get(id)!;
const draw = (run: Run) =>
    act(async () =>
        reactRoot.render(
            <RootStoreProvider value={store}>
                <RunDetail run={run} />
            </RootStoreProvider>
        )
    );
const box = () => container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]');
const stopButton = () => container.querySelector<HTMLButtonElement>('button[aria-label="Stop"]');
const sendButton = () => container.querySelector<HTMLButtonElement>('button[aria-label="Send"]');

beforeEach(async () => {
    store = new RootStore(new FixtureTransport({ data: createFixtureData() }), { storage: memoryStorage() });
    await store.load();
    container = document.createElement('div');
    document.body.append(container);
    reactRoot = createRoot(container);
    vi.mocked(toast.error).mockClear();
});

afterEach(() => {
    act(() => reactRoot.unmount());
    container.remove();
    store.dispose();
});

describe('RunDetail, the page', () => {
    it('has the page of a chat: its stream, with the line of whose sub-agent it is over it, and none of the old header or footer', async () => {
        await draw(runOf('r-na-02'));
        await draw(runOf('r-na-02'));

        expect(container.textContent).toContain('Looking for the price helper and its callers.');
        expect(container.querySelector('nav[aria-label="Chat of the sub-agent"]')?.textContent).toBe(
            'Explore agent in Simplify booking'
        );
        expect(container.querySelector('header')).toBeNull();
        expect(container.querySelector('footer')).toBeNull();
        expect(container.textContent).not.toContain('Viewing agent work');
        // The daemon's name of the run is shown nowhere.
        expect(container.textContent).not.toContain('Orchestrator 01');
        expect(container.textContent).not.toContain('general-purpose');
    });

    it('opens its chat from the line over the stream', async () => {
        await draw(runOf('r-na-02'));

        const link = container.querySelector<HTMLElement>('nav[aria-label="Chat of the sub-agent"] button')!;

        await act(async () => link.click());

        expect(store.ui.forProject(FIXTURE_PROJECT_ID).chatId).toBe('c-1');
    });

    it('has none of the chat banners over its box', async () => {
        // c-1 has two sub-agents at work and tasks: on its own page their plates stand over the box, and here nothing does.
        const banners = ['Work in progress', 'Chat tasks', 'Changes from the last run'];
        const { ChatView } = await import('../chats/ChatView');
        const chat = store.selectedProject!.chats.get('c-1')!;

        await act(async () =>
            reactRoot.render(
                <RootStoreProvider value={store}>
                    <ChatView chat={chat} />
                </RootStoreProvider>
            )
        );
        await act(async () => {});

        expect(container.querySelector('[role="group"][aria-label="Work in progress"]')).not.toBeNull();
        expect(container.querySelector('[role="group"][aria-label="Chat tasks"]')).not.toBeNull();

        await draw(runOf('r-na-02'));
        await draw(runOf('r-na-02'));

        for (const label of banners) expect(container.querySelector(`[aria-label="${label}"]`)).toBeNull();
        expect(container.querySelector('[aria-label^="Open General agent"]')).toBeNull();
    });

    it('reads a finished sub-agent without Reply, Fork or Edit under its answer, and keeps Copy', async () => {
        await draw(runOf('r-na-01'));
        await draw(runOf('r-na-01'));

        expect(container.textContent).toContain('Three step components in');
        expect(container.querySelector('[aria-label="Copy message"]')).not.toBeNull();
        expect(container.querySelector('[aria-label="Reply"]')).toBeNull();
        expect(container.querySelector('[aria-label="Edit message"]')).toBeNull();
        expect(container.querySelector('[aria-label*="Fork"]')).toBeNull();
    });

    it('says so when a sub-agent has not written anything yet', async () => {
        const data = createFixtureData();

        data.items['r-na-02'] = [];
        await open(data);
        await draw(runOf('r-na-02'));
        await draw(runOf('r-na-02'));

        expect(container.textContent).toContain('This sub-agent has not written anything yet');
    });
});

describe('RunDetail, the message box', () => {
    it('is the composer with nothing to type: disabled, with no files, model or mode, and says that only the parent can write', async () => {
        await draw(runOf('r-na-01'));

        expect(box()?.disabled).toBe(true);
        expect(box()?.placeholder).toBe('Only its parent can write to this sub-agent');
        expect(container.querySelector('[contenteditable="true"]')).toBeNull();
        expect(container.querySelector('[aria-label="Attach files"]')).toBeNull();
        expect(container.querySelector('[aria-label="Mode"]')).toBeNull();
        expect(container.textContent).not.toContain('Hands-off');
    });

    it('has nothing to press at rest: no Stop, and a Send that is off', async () => {
        await draw(runOf('r-na-01'));

        expect(stopButton()).toBeNull();
        expect(sendButton()?.disabled).toBe(true);
    });

    it('has the Stop where Send would be while a sub-agent its session can end alone works, and it ends that sub-agent only', async () => {
        expect(runOf('r-na-02').canStopAlone).toBe(true);
        await draw(runOf('r-na-02'));

        expect(box()?.placeholder).toBe('Only its parent can write to this sub-agent');
        expect(sendButton()).toBeNull();

        const command = vi.spyOn(store, 'command');

        await act(async () => stopButton()!.click());
        expect(command).toHaveBeenCalledWith({ type: 'run.cancel', runId: 'r-na-02' });
        await vi.waitFor(() => expect(runOf('r-na-02').status).toBe('cancelled'));
        expect(runOf('r-orch-1').status).toBe('running');
    });

    it('says why when the daemon refuses to stop it, naming the sub-agent as the person reads it', async () => {
        await draw(runOf('r-na-02'));
        vi.spyOn(store, 'command').mockResolvedValueOnce(refusal('The session cannot end it'));

        await act(async () => stopButton()!.click());

        expect(toast.error).toHaveBeenCalledWith({
            message: 'Could not stop Explore agent: The session cannot end it',
        });
    });

    it('has no Stop on a sub-agent whose session cannot end it alone, and the box says which chat it runs inside', async () => {
        await draw({ ...runOf('r-na-02'), canStopAlone: undefined });

        expect(stopButton()).toBeNull();
        expect(sendButton()?.disabled).toBe(true);
        expect(box()?.placeholder).toBe('Runs inside Simplify booking');
        expect(container.textContent).not.toContain('Orchestrator');
    });

    it('stops saying it runs inside its parent once it is over', async () => {
        await draw({ ...runOf('r-na-02'), canStopAlone: undefined, status: 'succeeded' });

        expect(box()?.placeholder).toBe('Only its parent can write to this sub-agent');
    });

    it('names a sub-agent that runs inside another sub-agent by its type', async () => {
        await draw({ ...runOf('r-na-02'), canStopAlone: undefined, parentRunId: 'r-na-03' });

        expect(box()?.placeholder).toBe('Runs inside General agent');
    });
});

describe('RunDetail, a card open to the person', () => {
    const resting = (): Run => ({
        ...runOf('r-na-02'),
        status: 'waiting_background',
        statusReason: 'Waiting for background work',
    });

    it('ends the stream of a run that rests for its background work with a line that says so', async () => {
        await draw(resting());
        await draw(resting());

        expect(container.textContent).toContain('Waiting for background work…');
    });

    it('has no line that says it waits for background work while a request is open to the person', async () => {
        await draw({ ...resting(), awaitingUser: true });
        await draw({ ...resting(), awaitingUser: true });

        expect(container.textContent).not.toContain('Waiting for background work…');
    });
});

describe('RunDetail, questions', () => {
    const asked: StreamItem = {
        id: 'r-na-02-q',
        runId: 'r-na-02',
        seq: 99,
        at: Date.now(),
        body: {
            kind: 'question',
            questionId: 'q-helper',
            text: 'Which helper is the one to change?',
            options: [
                { id: 'price', label: 'useBookingPrice', consequence: 'The form reads its price from it' },
                { id: 'total', label: 'bookingTotal', consequence: 'Only the summary reads it' },
            ],
        },
    };
    const waiting = (): Run => ({ ...runOf('r-na-02'), status: 'waiting_user' });

    it('answers a question of the sub-agent from its card in the stream, as the run of that page', async () => {
        const data = createFixtureData();

        data.items['r-na-02'] = [...data.items['r-na-02']!, asked];
        await open(data);
        await draw(waiting());
        await draw(waiting());

        const form = container.querySelector('form')!;

        expect(form.textContent).toContain('Which helper is the one to change?');

        const command = vi.spyOn(store, 'command');

        await act(async () => form.querySelector<HTMLButtonElement>('button[aria-label="Next"]')!.click());

        expect(command).toHaveBeenCalledWith({
            type: 'run.answer',
            runId: 'r-na-02',
            questionId: 'q-helper',
            answer: 'useBookingPrice',
        });
    });

    it('shows a question that the sub-agent no longer waits on, and cannot be answered', async () => {
        const data = createFixtureData();

        data.items['r-na-02'] = [...data.items['r-na-02']!, asked];
        await open(data);
        await draw(runOf('r-na-02'));
        await draw(runOf('r-na-02'));

        expect(container.textContent).toContain('Which helper is the one to change?');

        const command = vi.spyOn(store, 'command');

        await act(async () => container.querySelector<HTMLButtonElement>('form button[aria-label="Next"]')?.click());

        expect(command).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'run.answer' }));
    });
});

describe('RunDetail, requests for permission', () => {
    const cardButton = (heading: string, label: string) => {
        const card = container.querySelector(`[role="group"][aria-label="${heading}"]`);

        return [...(card?.querySelectorAll('button') ?? [])].find(button => button.textContent === label);
    };

    it('decides a request of the run it shows while the item is open, and says so when the daemon refuses', async () => {
        await open(withFixtureApprovals(createFixtureData()));
        await draw(runOf(FIXTURE_APPROVALS_RUN_ID));
        await draw(runOf(FIXTURE_APPROVALS_RUN_ID));

        const command = vi.spyOn(store, 'command');

        await act(async () => cardButton('Change these files', 'Deny')!.click());

        expect(command).toHaveBeenCalledWith({
            type: 'run.decide',
            runId: FIXTURE_APPROVALS_RUN_ID,
            approvalId: 'apv-3',
            decision: 'reject',
        });
        expect(toast.error).not.toHaveBeenCalled();

        command.mockResolvedValueOnce(refusal('The agent is no longer waiting for this approval'));
        await act(async () => cardButton('Use mcp__docs__publish', 'Allow once')!.click());

        expect(toast.error).toHaveBeenCalledWith({ message: 'The agent is no longer waiting for this approval' });
    });
});

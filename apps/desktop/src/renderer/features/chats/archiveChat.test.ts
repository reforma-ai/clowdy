import { toast } from '@clowdy/components/Toast';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FIXTURE_PROJECT_ID } from '../../daemon/fixtureData';
import { FixtureTransport } from '../../daemon/fixtureTransport';
import { RootStore } from '../../stores';
import { archiveChat, archiveRun, openChat, openRun, unarchiveChat } from './archiveChat';

import type { KeyValueStorage } from '../../stores/storage';

// The refusal of the daemon is a toast, which has no host here.
vi.mock('@clowdy/components/Toast', () => ({ toast: { error: vi.fn(), info: vi.fn() } }));

const memoryStorage = (): KeyValueStorage => {
    const data: Record<string, string> = {};

    return { getItem: key => data[key] ?? null, setItem: (key, value) => void (data[key] = value) };
};

let store: RootStore;

const project = () => store.selectedProject!;
const ui = () => store.ui.forProject(FIXTURE_PROJECT_ID);
const isArchived = (chatId: string) => project().chats.get(chatId)?.archivedAt !== undefined;

/** The change comes back on the event feed, a moment after the answer. */
const archived = (chatId: string, expected: boolean) => vi.waitFor(() => expect(isArchived(chatId)).toBe(expected));

beforeEach(async () => {
    store = new RootStore(new FixtureTransport(), { storage: memoryStorage() });
    await store.load();
});

afterEach(() => store.dispose());

describe('archiveChat', () => {
    it('puts the chat in the archive, and moves the page off it when it was the one open', async () => {
        ui().openChat('c-4');
        await archiveChat(store, ui(), project().chats.get('c-4')!, true);
        await archived('c-4', true);

        expect(ui().chatId).toBeNull();
    });

    it('leaves the page where it is when another chat was open', async () => {
        ui().openChat('c-3');
        await archiveChat(store, ui(), project().chats.get('c-4')!, false);
        await archived('c-4', true);

        expect(ui().chatId).toBe('c-3');
    });

    it('leaves the page where it is when the daemon refused, because the agents of the chat work', async () => {
        ui().openChat('c-1');
        await archiveChat(store, ui(), project().chats.get('c-1')!, true);

        expect(isArchived('c-1')).toBe(false);
        expect(ui().chatId).toBe('c-1');
    });
});

describe('a sub-agent in the archive', () => {
    const isRunArchived = (runId: string) => project().runs.get(runId)?.archivedAt !== undefined;
    const runArchived = (runId: string, expected: boolean) =>
        vi.waitFor(() => expect(isRunArchived(runId)).toBe(expected));
    /** r-na-02 started r-na-05, both below the orchestrator of c-1: the orchestrator is cancelled, so that every one of them is over. */
    async function finishTheFirstChat() {
        await store.command({ type: 'run.cancel', runId: 'r-orch-1' });
        await vi.waitFor(() => expect(project().runs.get('r-na-05')?.status).toBe('cancelled'));
    }
    const run = (runId: string) => project().runs.get(runId)!;

    describe('archiveRun', () => {
        it('puts a finished sub-agent in the archive, and moves the page off it when it was the one open, to its chat', async () => {
            ui().openRun('r-na-01');
            await archiveRun(store, project(), ui(), run('r-na-01'), run('r-na-01'));
            await runArchived('r-na-01', true);

            expect(ui().runId).toBeNull();
            expect(ui().chatId).toBe('c-1');
        });

        it('leaves the page where it is when another sub-agent was open', async () => {
            ui().openRun('r-na-04');
            await archiveRun(store, project(), ui(), run('r-na-01'), run('r-na-04'));
            await runArchived('r-na-01', true);

            expect(ui().runId).toBe('r-na-04');
        });

        it('moves the page off a sub-agent that went with the one archived', async () => {
            await finishTheFirstChat();
            ui().openRun('r-na-05');
            await archiveRun(store, project(), ui(), run('r-na-02'), run('r-na-05'));
            await runArchived('r-na-05', true);

            expect(isRunArchived('r-na-02')).toBe(true);
            expect(ui().runId).toBeNull();
            expect(ui().chatId).toBe('c-1');
        });

        it('leaves the page and tells the person when the daemon refused, because the sub-agent works', async () => {
            ui().openRun('r-na-02');
            await archiveRun(store, project(), ui(), run('r-na-02'), run('r-na-02'));

            expect(isRunArchived('r-na-02')).toBe(false);
            expect(ui().runId).toBe('r-na-02');
            expect(toast.error).toHaveBeenCalledWith({ message: 'A working sub-agent cannot be archived' });
        });
    });

    describe('openRun', () => {
        it('brings the sub-agent back before it shows it', async () => {
            await store.command({ type: 'run.setArchived', runId: 'r-na-01', archived: true });
            await runArchived('r-na-01', true);

            await openRun(store, project(), ui(), 'r-na-01');
            await runArchived('r-na-01', false);

            expect(ui().runId).toBe('r-na-01');
        });

        it('brings back the archived sub-agents above it, the farthest first, and nothing beside them', async () => {
            await finishTheFirstChat();
            await store.command({ type: 'run.setArchived', runId: 'r-na-02', archived: true });
            await runArchived('r-na-05', true);
            await store.command({ type: 'run.setArchived', runId: 'r-na-01', archived: true });
            await runArchived('r-na-01', true);

            const command = vi.spyOn(store, 'command');

            await openRun(store, project(), ui(), 'r-na-05');
            await runArchived('r-na-05', false);

            expect(
                command.mock.calls.map(([input]) => (input.type === 'run.setArchived' ? input.runId : input.type))
            ).toEqual(['r-na-02', 'r-na-05']);
            expect(isRunArchived('r-na-02')).toBe(false);
            expect(isRunArchived('r-na-01')).toBe(true);
            expect(ui().runId).toBe('r-na-05');
        });

        it('brings back the chat of the sub-agent too, the chat first', async () => {
            await finishTheFirstChat();
            await store.command({ type: 'run.setArchived', runId: 'r-na-01', archived: true });
            await store.command({ type: 'chat.setArchived', chatId: 'c-1', archived: true });
            await archived('c-1', true);

            const command = vi.spyOn(store, 'command');

            await openRun(store, project(), ui(), 'r-na-01');
            await archived('c-1', false);
            await runArchived('r-na-01', false);

            expect(command.mock.calls.map(([input]) => input.type)).toEqual(['chat.setArchived', 'run.setArchived']);
            expect(ui().runId).toBe('r-na-01');
        });

        it('shows nothing when the daemon refused to bring it back', async () => {
            await store.command({ type: 'run.setArchived', runId: 'r-na-01', archived: true });
            await runArchived('r-na-01', true);
            vi.spyOn(store, 'command').mockResolvedValue({
                ok: false,
                requestId: 'x',
                error: { code: 'conflict', message: 'No' },
            } as never);

            await openRun(store, project(), ui(), 'r-na-01');

            expect(ui().runId).not.toBe('r-na-01');
        });
    });
});

describe('openChat', () => {
    it('shows a chat that is in use at once', async () => {
        await openChat(store, project(), ui(), 'c-3');

        expect(ui().chatId).toBe('c-3');
    });

    it('brings a chat out of the archive before it shows it', async () => {
        await store.command({ type: 'chat.setArchived', chatId: 'c-4', archived: true });
        await archived('c-4', true);

        await openChat(store, project(), ui(), 'c-4');
        await archived('c-4', false);

        expect(ui().chatId).toBe('c-4');
    });
});

describe('openChat, a thread', () => {
    /** c-6 rests, but c-6a and c-6e work: they are stopped so the chat can be archived with its threads. */
    async function archiveShipTheCheckout() {
        for (const runId of ['r-orch-6a', 'r-orch-6e']) await store.command({ type: 'run.cancel', runId });

        await store.command({ type: 'chat.setArchived', chatId: 'c-6', archived: true });
        await archived('c-6', true);
        await archived('c-6a1', true);
    }

    it('brings back the chats above a thread that went to the archive with them, the thread itself, and nothing beside them', async () => {
        await archiveShipTheCheckout();
        await openChat(store, project(), ui(), 'c-6a1');

        await archived('c-6', false);
        await archived('c-6a', false);
        await archived('c-6a1', false);
        expect(isArchived('c-6b')).toBe(true);
        expect(ui().chatId).toBe('c-6a1');
    });

    it("brings back the chat of a thread's run with the path to it", async () => {
        await archiveShipTheCheckout();
        await openRun(store, project(), ui(), 'r-orch-6a1');

        await archived('c-6', false);
        await archived('c-6a1', false);
        expect(ui().runId).toBe('r-orch-6a1');
    });
});

describe('openRun', () => {
    it('brings the chat of the run out of the archive before it shows the run', async () => {
        await store.command({ type: 'chat.setArchived', chatId: 'c-2', archived: true });
        await archived('c-2', true);

        await openRun(store, project(), ui(), 'r-na-06');
        await archived('c-2', false);

        expect(ui().runId).toBe('r-na-06');
    });

    it('shows a run of a chat in use at once', async () => {
        await openRun(store, project(), ui(), 'r-na-02');

        expect(ui().runId).toBe('r-na-02');
    });
});

describe('unarchiveChat', () => {
    it('says whether the chat is out of the archive', async () => {
        await store.command({ type: 'chat.setArchived', chatId: 'c-4', archived: true });
        await archived('c-4', true);

        expect(await unarchiveChat(store, project().chats.get('c-4')!)).toBe(true);
        await archived('c-4', false);
    });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FIXTURE_PROJECT_ID } from '../../daemon/fixtureData';
import { FixtureTransport } from '../../daemon/fixtureTransport';
import { RootStore } from '../../stores';
import { archiveChat, openChat, openRun, unarchiveChat } from './archiveChat';

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

    it('brings back the chat of a thread\'s run with the path to it', async () => {
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

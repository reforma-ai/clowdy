// @vitest-environment happy-dom
import { observer } from 'mobx-react-lite';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    createFixtureData,
    FIXTURE_LAST_RUN_CHAT_ID,
    FIXTURE_PROJECT_ID,
    FIXTURE_QUIET_CHAT_ID,
    FIXTURE_RUN_FILES,
    FIXTURE_RUN_SCOPE,
    FIXTURE_RUN_TREES,
    withFixtureLastRun,
    withFixtureWorkspace,
} from '../../daemon/fixtureData';
import { FixtureTransport } from '../../daemon/fixtureTransport';
import { overrideTransport } from '../../daemon/testing';
import { type Transport, TransportError } from '../../daemon/transport';
import { RootStore, RootStoreProvider } from '../../stores';
import { chatFolder } from '../agents/agentTree';
import { gitFactsOf } from '../changes/gitFacts';
import { placeChangesOf } from '../changes/PlaceChanges';
import { chatPlace } from '../sidePanel/currentPlace';
import { LastRunPlate } from './LastRunPlate';
import { rowLabel } from './lastRunRows';

import type { Chat, Run, StreamItem } from '@clowdy/protocol';
import type { KeyValueStorage } from '../../stores/storage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/*
 * The plate over the message box of the two chats `withFixtureLastRun` adds to the worktree of `withFixtureWorkspace`: one whose latest run changed seven files, one whose run
 * changed nothing. The test build has no MobX observer plugin, so the plate is wrapped by hand.
 */

const memoryStorage = (): KeyValueStorage => {
    const data: Record<string, string> = {};

    return { getItem: key => data[key] ?? null, setItem: (key, value) => void (data[key] = value) };
};

const Plate = observer(LastRunPlate);

let container: HTMLDivElement;
let reactRoot: Root;
let store: RootStore;
let transport: Transport;
let data: ReturnType<typeof createFixtureData>;

const settle = () =>
    act(async () => {
        await new Promise(resolve => setTimeout(resolve, 0));
    });
const chatOf = (id: string): Chat => store.selectedProject!.chats.get(id)!;
const runOf = (id: string): Run => ({ ...store.selectedProject!.runs.get(chatOf(id).orchestratorRunId!)! });
const itemsOf = (id: string): StreamItem[] => structuredClone(data.items[chatOf(id).orchestratorRunId!]!);

interface Draw {
    chat?: string;
    run?: Partial<Run> | null;
    items?: StreamItem[] | null;
    chatFields?: Partial<Chat>;
}

/** Draws the plate for a chat as the chat view does, with what the test says of its run and stream, and lets the list of the run come. */
async function draw({ chat = FIXTURE_LAST_RUN_CHAT_ID, run, items, chatFields }: Draw = {}) {
    const found = { ...chatOf(chat), ...chatFields };

    await act(async () =>
        reactRoot.render(
            <RootStoreProvider value={store}>
                <Plate
                    chat={found}
                    run={run === null ? undefined : { ...runOf(chat), ...run }}
                    items={items === null ? undefined : (items ?? itemsOf(chat))}
                />
            </RootStoreProvider>
        )
    );
    await settle();
    await settle();
}

const plate = () => container.querySelector<HTMLElement>('[aria-label="Changes from the last run"]');
const rows = () => [...(plate()?.querySelectorAll<HTMLElement>('[role="row"]') ?? [])];
const header = () => plate()?.querySelector<HTMLButtonElement>('button[aria-expanded]') ?? null;

beforeEach(async () => {
    data = withFixtureLastRun(withFixtureWorkspace(createFixtureData()));
    transport = new FixtureTransport({ data });
    store = new RootStore(transport, { storage: memoryStorage() });
    await store.load();
    store.selectProject(FIXTURE_PROJECT_ID);
    container = document.createElement('div');
    document.body.append(container);
    reactRoot = createRoot(container);
});

afterEach(() => {
    act(() => reactRoot.unmount());
    container.remove();
    store.dispose();
    vi.restoreAllMocks();
});

describe('the Last run plate', () => {
    it('shows only the changes summary with its totals by default', async () => {
        await draw();

        expect(plate()).not.toBeNull();
        expect(header()?.textContent).toBe('Changes7 files+178−29');
        expect(header()?.getAttribute('aria-expanded')).toBe('false');
        expect(rows()).toHaveLength(0);
    });

    it('unfolds the full file list from the header and folds it again', async () => {
        await draw();
        await act(async () => header()!.click());

        expect(header()?.getAttribute('aria-expanded')).toBe('true');
        expect(rows().map(row => row.getAttribute('aria-label'))).toEqual(FIXTURE_RUN_FILES.map(rowLabel));
        // The button controls the rows it unfolds.
        expect(
            plate()
                ?.querySelector(`[id="${header()!.getAttribute('aria-controls')}"]`)
                ?.querySelectorAll('[role="row"]')
        ).toHaveLength(7);

        await act(async () => header()!.click());
        expect(header()?.getAttribute('aria-expanded')).toBe('false');
        expect(rows()).toHaveLength(0);
    });

    it('also starts collapsed when only one file changed', async () => {
        vi.spyOn(transport, 'getGitChanges').mockResolvedValue({
            isRepository: true,
            scope: FIXTURE_RUN_SCOPE,
            files: FIXTURE_RUN_FILES.slice(0, 1),
            fileCount: 1,
            additions: 38,
            deletions: 0,
            statsComplete: true,
        });
        await draw();

        expect(header()?.textContent).toBe('Changes1 file+38−0');
        expect(rows()).toHaveLength(0);
        await act(async () => header()!.click());
        expect(rows()).toHaveLength(1);
    });

    it("draws a row's path with the folder dimmed, the name after it, and the start cut when it is long, so the name stays", async () => {
        await draw();
        await act(async () => header()!.click());

        const long = rows()[0]!;
        const path = long.querySelector<HTMLElement>('[dir="rtl"]')!;

        expect(path.getAttribute('title')).toBe(FIXTURE_RUN_FILES[0]!.path);
        expect(path.querySelector('bdi')?.getAttribute('dir')).toBe('ltr');
        // The folder and the name are two runs of text inside it.
        expect([...path.querySelectorAll('bdi > *')].map(part => part.textContent)).toEqual([
            'docs/pricing/a/deeply/nested/folder/for/the/weekend-surcharge-rules/',
            'weekend-surcharge-calculation-notes.md',
        ]);
        // Only the letter and the lines are hidden from a screen reader: the row's own name says them.
        expect([...long.querySelectorAll('[aria-hidden="true"]')].map(part => part.textContent)).toEqual([
            'A',
            '+38−0',
        ]);
    });

    it('is not drawn for a chat whose latest run changed nothing', async () => {
        await draw({ chat: FIXTURE_QUIET_CHAT_ID });

        expect(plate()).toBeNull();
    });

    it('is not drawn for a run that changed files but whose list is empty, or is not a repository', async () => {
        const read = vi.spyOn(transport, 'getGitChanges');

        read.mockResolvedValueOnce({
            isRepository: true,
            scope: FIXTURE_RUN_SCOPE,
            files: [],
            fileCount: 0,
            additions: 0,
            deletions: 0,
            statsComplete: true,
        });
        await draw();
        expect(plate()).toBeNull();

        await act(async () => reactRoot.render(null));
        read.mockResolvedValueOnce({ isRepository: false });
        await draw({ chat: FIXTURE_LAST_RUN_CHAT_ID });
        expect(plate()).toBeNull();
    });

    it('says nothing when the list of the run cannot be read, and asks again the next time the plate is drawn', async () => {
        const read = vi.spyOn(transport, 'getGitChanges');

        read.mockRejectedValueOnce(new TransportError('The daemon does not answer', 503));
        await draw();
        expect(plate()).toBeNull();

        await act(async () => reactRoot.render(null));
        await draw();
        expect(plate()).not.toBeNull();
        expect(read).toHaveBeenCalledTimes(2);
    });

    it('is not drawn for a run whose trees git has pruned: the daemon says unavailable', async () => {
        await draw({ chatFields: { lastRun: { startTree: 'c'.repeat(40), endTree: 'd'.repeat(40), seq: 2, at: 1 } } });

        expect(plate()).toBeNull();
    });

    it('comes at the end of a run and goes when the person writes: not while a run works, not for a message in the queue, not for one sent after the run', async () => {
        const working = { status: 'running' as const };

        await draw({ run: working });
        expect(plate()).toBeNull();

        // The run ends.
        await draw({ run: { status: 'succeeded' } });
        expect(plate()).not.toBeNull();
        await act(async () => header()!.click());
        expect(rows()).not.toHaveLength(0);

        // The person writes: the message waits in the queue, then starts a turn.
        await draw({ chatFields: { queue: [{ id: 'q1', text: 'Next', mode: 'queue', createdAt: 5 } as never] } });
        expect(plate()).toBeNull();
        await draw({ run: working });
        expect(plate()).toBeNull();

        const sent: StreamItem = {
            id: 'i3',
            runId: 'r-orch-11',
            seq: 3,
            at: 5,
            body: { kind: 'user', text: 'And now the tests' },
        };

        await draw({ items: [...itemsOf(FIXTURE_LAST_RUN_CHAT_ID), sent] });
        expect(plate()).toBeNull();

        // The run ends again with a newer latest turn that changed files (the daemon says so with a `lastRun` of its own, after the message): its plate stands in place of the one that went.
        await draw({
            items: [
                ...itemsOf(FIXTURE_LAST_RUN_CHAT_ID),
                sent,
                { ...sent, id: 'i4', seq: 4, body: { kind: 'assistant', text: 'Tests added', done: true } },
            ],
            chatFields: { lastRun: { ...FIXTURE_RUN_TREES, seq: 4, at: 9 } },
        });
        expect(header()?.getAttribute('aria-expanded')).toBe('false');
        expect(rows()).toHaveLength(0);
    });

    it('waits for the stream, and is drawn for a chat that cannot be written to as well, since it asks only what the chat holds', async () => {
        await draw({ items: null });
        expect(plate()).toBeNull();

        await draw({ chatFields: { archivedAt: 5 } });
        expect(plate()).not.toBeNull();
    });

    it('reads the list of a run once, and keeps it: the same run drawn again, or after the run worked and ended, asks nothing more', async () => {
        const read = vi.spyOn(transport, 'getGitChanges');

        await draw();
        await draw({ run: { status: 'running' } });
        await draw({ run: { status: 'succeeded' } });
        await draw();

        expect(plate()).not.toBeNull();
        expect(read).toHaveBeenCalledTimes(1);
        expect(read).toHaveBeenCalledWith(
            FIXTURE_PROJECT_ID,
            { folderId: 'fld_car_rental', workspaceId: 'wks_ab12cd34' },
            FIXTURE_RUN_SCOPE
        );
    });

    it('reads nothing while it could not be drawn: a run that works, a stream that is not loaded', async () => {
        const read = vi.spyOn(transport, 'getGitChanges');

        await draw({ run: { status: 'running' } });
        await draw({ items: null });
        expect(read).not.toHaveBeenCalled();
    });

    it('opens the Changes tab on the run, with the file of the row brought up, when a row is pressed, and shows the panel when it is shut', async () => {
        const ui = store.ui.forProject(FIXTURE_PROJECT_ID);

        ui.closeSidePanel();
        await draw();
        await act(async () => header()!.click());

        const chat = chatOf(FIXTURE_LAST_RUN_CHAT_ID);
        const place = chatPlace(
            store.selectedProject!.project.folders,
            chat,
            chatFolder(store.selectedProject!.chats, store.selectedProject!.project.folders, chat.id)?.folder
        );
        const model = placeChangesOf(
            transport,
            gitFactsOf(transport).of({
                projectId: FIXTURE_PROJECT_ID,
                folderId: place.folder.id,
                workspaceId: place.workspace!.id,
            })
        );

        expect(model.effectiveScope).toBe('all');

        await act(async () => rows()[2]!.click());

        expect(ui.sidePanelOpen).toBe(true);
        expect(ui.sidePanelTab).toBe('changes');
        expect(model.effectiveScope).toBe(FIXTURE_RUN_SCOPE);
        expect(model.followsRun).toBe(true);
        expect(model.revealRequest).toBe('src/booking/price.ts');
        // A file below the initial viewport opens the same way.
        await act(async () => rows()[6]!.click());
        expect(model.revealRequest).toBe('src/mail/confirmation.ts');
    });

    it('is not drawn for a chat whose worktree is not made yet: there is nothing in it to list', async () => {
        const read = vi.spyOn(transport, 'getGitChanges');

        await draw({ chatFields: { workspace: { ...chatOf(FIXTURE_LAST_RUN_CHAT_ID).workspace!, ready: false } } });

        expect(plate()).toBeNull();
        expect(read).not.toHaveBeenCalled();
    });

    it('says nothing of a transport that cannot answer: a window with no daemon draws no plate', async () => {
        const broken = overrideTransport(transport, {
            getGitChanges: () => Promise.reject(new TransportError('No daemon', 503)),
        });
        const other = new RootStore(broken, { storage: memoryStorage() });

        await other.load();
        other.selectProject(FIXTURE_PROJECT_ID);
        await act(async () =>
            reactRoot.render(
                <RootStoreProvider value={other}>
                    <Plate
                        chat={other.selectedProject!.chats.get(FIXTURE_LAST_RUN_CHAT_ID)!}
                        run={other.selectedProject!.runs.get('r-orch-11')}
                        items={itemsOf(FIXTURE_LAST_RUN_CHAT_ID)}
                    />
                </RootStoreProvider>
            )
        );
        await settle();
        expect(plate()).toBeNull();
        other.dispose();
    });
});

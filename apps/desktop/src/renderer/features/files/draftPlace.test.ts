// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createFixtureData, FIXTURE_PROJECT_ID, FIXTURE_WORKTREE_PATH } from '../../daemon/fixtureData';
import { FixtureTransport } from '../../daemon/fixtureTransport';
import { RootStore } from '../../stores';
import { currentPlace, isSamePlace, placeKey } from '../sidePanel/currentPlace';
import { FilesStore } from './FilesStore';

import type { Chat, ChatWorkspace } from '@clowdy/protocol';
import type { KeyValueStorage } from '../../stores/storage';

const memoryStorage = (): KeyValueStorage => {
    const data: Record<string, string> = {};

    return { getItem: key => data[key] ?? null, setItem: (key, value) => void (data[key] = value) };
};

const settle = () => new Promise(resolve => setTimeout(resolve, 20));

let store: RootStore;

const ui = () => store.ui.forProject(FIXTURE_PROJECT_ID);
const place = () => currentPlace(store.selectedProject!, ui());

beforeEach(async () => {
    store = new RootStore(new FixtureTransport({ data: createFixtureData() }), { storage: memoryStorage() });
    await store.load();
    store.selectProject(FIXTURE_PROJECT_ID);
});

afterEach(() => {
    store.dispose();
});

/** The side panel's tree when the new-chat page chose a worktree that exists, and when the chat that page makes takes its place. */
describe('the files of a new chat that chose an existing worktree', () => {
    const choose = async () => {
        ui().openDraft([], null, { mode: 'existing', path: FIXTURE_WORKTREE_PATH });

        const opened = await store.command({
            type: 'workspace.open',
            projectId: FIXTURE_PROJECT_ID,
            folderId: 'fld_car_rental',
            path: FIXTURE_WORKTREE_PATH,
        });

        if (!opened.ok) throw new Error(opened.error.message);

        ui().setDraftWorkspaceRow((opened.data as { workspace: ChatWorkspace }).workspace);
    };

    it("lists the worktree's files in the tree, which its folder's own checkout lacks", async () => {
        const files = new FilesStore(store.transport, memoryStorage());

        ui().openDraft([], null, null);
        await settle();

        const own = files.managerOf(FIXTURE_PROJECT_ID, place());

        await choose();
        await settle();

        const worktree = files.managerOf(FIXTURE_PROJECT_ID, place());

        expect(worktree).not.toBe(own);
        expect(place().workspace?.path).toBe(FIXTURE_WORKTREE_PATH);
        expect(await worktree.provider.list('src/booking')).toEqual(
            expect.arrayContaining([expect.objectContaining({ path: 'src/booking/weekend.ts' })])
        );
        expect(await own.provider.list('src/booking')).not.toEqual(
            expect.arrayContaining([expect.objectContaining({ path: 'src/booking/weekend.ts' })])
        );

        files.dispose();
    });

    it('is the same place, with the same manager and so the same tabs, once the first message has made the chat in it', async () => {
        const files = new FilesStore(store.transport, memoryStorage());

        await choose();

        const before = place();
        const manager = files.managerOf(FIXTURE_PROJECT_ID, before);

        await settle();
        await manager.open('src/booking/weekend.ts');

        const made = await store.command({
            type: 'chat.create',
            projectId: FIXTURE_PROJECT_ID,
            workspace: { mode: 'existing', path: FIXTURE_WORKTREE_PATH },
        });

        if (!made.ok) throw new Error(made.error.message);

        const { chat } = made.data as { chat: Chat };

        ui().openChat(chat.id);

        const after = place();

        expect(placeKey(after)).toBe(placeKey(before));
        expect(isSamePlace(after, before)).toBe(true);
        expect(files.managerOf(FIXTURE_PROJECT_ID, after)).toBe(manager);
        expect(files.managerOf(FIXTURE_PROJECT_ID, after).tabs.active?.path).toBe('src/booking/weekend.ts');

        files.dispose();
    });
});

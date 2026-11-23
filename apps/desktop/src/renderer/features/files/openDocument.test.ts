// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    createFixtureData,
    FIXTURE_PROJECT_ID,
    FIXTURE_WORKSPACE_CHAT_ID,
    withFixtureWorkspace,
} from '../../daemon/fixtureData';
import { FixtureTransport } from '../../daemon/fixtureTransport';
import { RootStore } from '../../stores';
import { openDocument } from './openDocument';
import { filesStoreOf } from './useFilesStore';

import type { Place } from '../sidePanel/currentPlace';

const toasts = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));

vi.mock('@clowdy/components/Toast', () => ({ toast: toasts }));

const FOLDER = { id: 'fld_car_rental', path: '/Users/dev/car-rental' };

let store: RootStore;

const project = () => store.selectedProject!;
const ui = () => store.ui.forProject(FIXTURE_PROJECT_ID);
const docsOf = async (place: Place) =>
    (await filesStoreOf(store).startedManagerOf(FIXTURE_PROJECT_ID, place, 'docs')).tabs.documents.map(
        document => document.path
    );
const worktree = (): Place => ({
    folder: FOLDER,
    workspace: project().chats.get(FIXTURE_WORKSPACE_CHAT_ID)!.workspace!,
});

beforeEach(async () => {
    localStorage.clear();
    toasts.error.mockClear();
    store = new RootStore(new FixtureTransport({ data: withFixtureWorkspace(createFixtureData()) }));
    await store.load();
    store.selectProject(FIXTURE_PROJECT_ID);
});

afterEach(() => {
    filesStoreOf(store).dispose();
    store.dispose();
    localStorage.clear();
});

describe('opening a document on the Docs tab', () => {
    it("opens it in the folder's own checkout when no chat is open", async () => {
        expect(await openDocument(store, project(), 'decisions/pricing.md')).toBe(true);

        expect(await docsOf({ folder: FOLDER })).toEqual(['.clowdy/docs/decisions/pricing.md']);
        expect(await docsOf(worktree())).toEqual([]);
        expect(ui().sidePanelTab).toBe('docs');
    });

    it('opens it in the worktree of the open chat, since that is the place the tab shows', async () => {
        ui().openChat(FIXTURE_WORKSPACE_CHAT_ID);

        expect(await openDocument(store, project(), 'decisions/pricing.md')).toBe(true);

        expect(await docsOf(worktree())).toEqual(['.clowdy/docs/decisions/pricing.md']);
        expect(await docsOf({ folder: FOLDER })).toEqual([]);
    });

    it("says the document is not on the disk, and opens nothing, while the chat's worktree is not made yet", async () => {
        const made = await store.command({
            type: 'chat.create',
            projectId: FIXTURE_PROJECT_ID,
            workspace: { mode: 'new' },
        });

        ui().openChat((made as { data: { chat: { id: string } } }).data.chat.id);
        await vi.waitFor(() => expect(project().chats.get(ui().chatId!)?.workspace?.ready).toBe(false));

        expect(await openDocument(store, project(), 'decisions/pricing.md')).toBe(false);
        expect(toasts.error).toHaveBeenCalledWith({ message: 'The worktree is not made yet' });
        expect(ui().sidePanelOpen).toBe(false);
    });

    it("says it is not in this worktree for a document the worktree does not have, and not on the disk for one the folder's own checkout lacks", async () => {
        ui().openChat(FIXTURE_WORKSPACE_CHAT_ID);

        expect(await openDocument(store, project(), 'decisions/nobody.md')).toBe(false);
        expect(toasts.error).toHaveBeenLastCalledWith({ message: 'That document is not in this worktree' });

        ui().openChat(null);

        expect(await openDocument(store, project(), 'decisions/nobody.md')).toBe(false);
        expect(toasts.error).toHaveBeenLastCalledWith({ message: 'That document is not on the disk' });
    });
});

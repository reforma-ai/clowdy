// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    createFixtureData,
    FIXTURE_PROJECT_ID,
    FIXTURE_WORKSPACE_CHAT_ID,
    withFixtureWorkspace,
} from '../../daemon/fixtureData';
import { FixtureTransport } from '../../daemon/fixtureTransport';
import { RootStore, RootStoreProvider } from '../../stores';
import { chatPlace, type Place } from '../sidePanel/currentPlace';
import { gitFactsOf } from './gitFacts';
import { useGitFacts } from './useGitFacts';

import type { ProjectId } from '@clowdy/protocol';
import type { KeyValueStorage } from '../../stores/storage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/*
 * Two readers of one place's facts: the rail's summary, which keeps the place observed all the time, and the Changes tab, which lists the place's files and reads them again for
 * each round of the facts. The tab is never the first to look at the place, so it has to ask for its round itself.
 */

const memoryStorage = (): KeyValueStorage => {
    const data: Record<string, string> = {};

    return { getItem: key => data[key] ?? null, setItem: (key, value) => void (data[key] = value) };
};

let container: HTMLDivElement;
let reactRoot: Root;
let store: RootStore;
let transport: FixtureTransport;
let place: Place;

const settle = () =>
    act(async () => {
        await new Promise(resolve => setTimeout(resolve, 0));
    });

function Reader({ projectId }: { projectId: ProjectId | undefined }) {
    useGitFacts(projectId, place);

    return null;
}

/** The readers drawn, in this order: the rail's and the Changes tab's. */
const render = (readers: ('rail' | 'tab')[], projectId: ProjectId | null = FIXTURE_PROJECT_ID) =>
    act(async () => {
        reactRoot.render(
            <RootStoreProvider value={store}>
                {readers.map(reader => (
                    <Reader key={reader} projectId={projectId ?? undefined} />
                ))}
            </RootStoreProvider>
        );
    });

beforeEach(async () => {
    container = document.createElement('div');
    document.body.append(container);
    reactRoot = createRoot(container);
    transport = new FixtureTransport({ data: withFixtureWorkspace(createFixtureData()) });
    store = new RootStore(transport, { storage: memoryStorage() });
    await store.load();
    store.selectProject(FIXTURE_PROJECT_ID);

    const project = store.selectedProject!;
    const chat = project.chats.get(FIXTURE_WORKSPACE_CHAT_ID)!;

    place = chatPlace(project.project.folders, chat);
});

afterEach(() => {
    act(() => reactRoot.unmount());
    container.remove();
    vi.restoreAllMocks();
    store.dispose();
});

describe('useGitFacts', () => {
    it('reads a place once for two readers that appear together, whichever comes first, and once for one that comes back at once', async () => {
        const read = vi.spyOn(transport, 'getGitStatus');

        await render(['rail', 'tab']);
        await settle();

        expect(read).toHaveBeenCalledTimes(1);

        await render([]);
        await settle();
        read.mockClear();
        await render(['tab', 'rail']);
        await settle();

        expect(read).toHaveBeenCalledTimes(1);
    });

    it('starts a round of reads for a reader that appears where another reads the place already', async () => {
        await render(['rail']);
        await settle();

        const read = vi.spyOn(transport, 'getGitStatus');

        await render(['rail']);
        await settle();

        expect(read).not.toHaveBeenCalled();

        await render(['rail', 'tab']);
        await settle();

        expect(read).toHaveBeenCalledTimes(1);

        // Shut and open again: the place may have changed meanwhile, and what the tab had is as old as the last round.
        await render(['rail']);
        await settle();
        await render(['rail', 'tab']);
        await settle();

        expect(read).toHaveBeenCalledTimes(2);
    });

    it('counts the round it asks for, so what lists more than the facts keep reads again', async () => {
        await render(['rail']);
        await settle();

        const facts = gitFactsOf(transport).of({
            projectId: FIXTURE_PROJECT_ID,
            folderId: place.folder.id,
            workspaceId: place.workspace!.id,
        });
        const before = facts.generation;

        await render(['rail', 'tab']);
        await settle();

        expect(facts.generation).toBe(before + 1);
    });

    it('reads nothing for no project', async () => {
        const read = vi.spyOn(transport, 'getGitStatus');

        await render(['rail', 'tab'], null);
        await settle();

        expect(read).not.toHaveBeenCalled();
    });
});

// @vitest-environment happy-dom
import { observer } from 'mobx-react-lite';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFixtureData, FIXTURE_PROJECT_ID, FIXTURE_WORKSPACE_CHAT_ID, withFixtureWorkspace } from '../../daemon/fixtureData';
import { FixtureTransport } from '../../daemon/fixtureTransport';
import { RootStore, RootStoreProvider, useProjectState } from '../../stores';
import { chatFolder } from '../agents/agentTree';
import { chatPlace } from '../sidePanel/currentPlace';
import { useGitFacts } from './useGitFacts';
import { useRefreshGitFactsAtRunEnd } from './useRefreshGitFactsAtRunEnd';

import type { Run } from '@clowdy/protocol';
import type { KeyValueStorage } from '../../stores/storage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/*
 * The chat of `withFixtureWorkspace` works in a worktree. Something observes the place's facts (the Info tab or the Changes tab does that in the app), and the hook says when to read
 * them again: when the chat's run stops being busy. The test build has no MobX observer plugin, so the view is wrapped by hand.
 */

const memoryStorage = (): KeyValueStorage => {
    const data: Record<string, string> = {};

    return { getItem: key => data[key] ?? null, setItem: (key, value) => void (data[key] = value) };
};

let container: HTMLDivElement;
let reactRoot: Root;
let store: RootStore;
let transport: FixtureTransport;

const settle = () => act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
});

/** Something that shows the place's facts, and the hook under test beside it. */
const Probe = observer(function Probe({ chatId, run, observed }: { chatId: string; run: Run | undefined; observed: boolean }) {
    const project = useProjectState();
    const chat = project.chats.get(chatId)!;
    const place = chatPlace(project.project.folders, chat, chatFolder(project.chats, project.project.folders, chat.id)?.folder);

    useRefreshGitFactsAtRunEnd(chat, run);

    return observed ? <Observer projectId={ project.id } place={ place } /> : null;
});

function Observer({ projectId, place }: { projectId: string; place: ReturnType<typeof chatPlace> }) {
    useGitFacts(projectId, place);

    return null;
}

const render = (run: Run | undefined, observed = true) => act(async () => {
    reactRoot.render(<RootStoreProvider value={ store }><Probe chatId={ FIXTURE_WORKSPACE_CHAT_ID } run={ run } observed={ observed } /></RootStoreProvider>);
});

beforeEach(async () => {
    container = document.createElement('div');
    document.body.append(container);
    reactRoot = createRoot(container);
    transport = new FixtureTransport({ data: withFixtureWorkspace(createFixtureData()) });
    store = new RootStore(transport, { storage: memoryStorage() });
    await store.load();
    store.selectProject(FIXTURE_PROJECT_ID);
});

afterEach(() => {
    act(() => reactRoot.unmount());
    container.remove();
    vi.restoreAllMocks();
    store.dispose();
});

describe('useRefreshGitFactsAtRunEnd', () => {
    const runOf = () => store.selectedProject!.runs.get(store.selectedProject!.chats.get(FIXTURE_WORKSPACE_CHAT_ID)!.orchestratorRunId ?? '');

    it('reads the place again when the chat\'s run ends, and not before', async () => {
        const busy = { ...runOf()!, status: 'running' as const };
        const atRest = { ...busy, status: 'succeeded' as const };

        await render(busy);
        await settle();
        await settle();

        const read = vi.spyOn(transport, 'getGitStatus');

        await render({ ...busy, summary: 'still going' });
        expect(read).not.toHaveBeenCalled();

        await new Promise(resolve => setTimeout(resolve, 0));
        await render(atRest);
        await settle();

        expect(read).toHaveBeenCalledTimes(1);

        // A run that is at rest and stays so is not a reason to read.
        await render({ ...atRest, summary: 'done' });
        await settle();

        expect(read).toHaveBeenCalledTimes(1);
    });

    it('reads nothing when nothing shows the place\'s facts', async () => {
        const busy = { ...runOf()!, status: 'running' as const };

        await render(busy, false);
        await settle();

        const read = vi.spyOn(transport, 'getGitStatus');

        await render({ ...busy, status: 'succeeded' as const }, false);
        await settle();

        expect(read).not.toHaveBeenCalled();
    });
});

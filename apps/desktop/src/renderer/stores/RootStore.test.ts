import { autorun } from 'mobx';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFixtureData, FIXTURE_EMPTY_PROJECT_ID, FIXTURE_PERSONAL_PROJECT_ID, FIXTURE_PROJECT_ID } from '../daemon/fixtureData';
import { FixtureTransport } from '../daemon/fixtureTransport';
import { overrideTransport } from '../daemon/testing';
import { BANNER_DELAY_MS, RootStore } from './RootStore';

import type { ClowdyEvent } from '@clowdy/protocol';
import type { FeedStatus } from '../daemon/transport';
import type { KeyValueStorage } from './storage';

function memoryStorage(initial: Record<string, string> = {}): KeyValueStorage & { data: Record<string, string> } {
    const data = { ...initial };

    return { data, getItem: key => data[key] ?? null, setItem: (key, value) => void (data[key] = value), removeItem: key => void delete data[key] };
}

async function settle() {
    await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

describe('RootStore', () => {
    it('loads the projects with the personal space first, and selects the first project of the person\'s own, with its snapshot', async () => {
        const root = new RootStore(new FixtureTransport(), { storage: memoryStorage() });

        await root.load();
        await settle();

        expect(root.phase).toBe('ready');
        expect(root.projects.map(project => project.name)).toEqual(['Personal', 'Car Rental', 'Clowdy']);
        expect(root.selectedProjectId).toBe(FIXTURE_PROJECT_ID);
        expect(root.selectedProject?.status).toBe('ready');
        expect(root.selectedProject?.tasks.size).toBe(11);
        root.dispose();
    });

    it('selects the project it showed last time', async () => {
        const storage = memoryStorage({ 'clowdy:selected-project': JSON.stringify(FIXTURE_EMPTY_PROJECT_ID) });
        const root = new RootStore(new FixtureTransport(), { storage });

        await root.load();

        expect(root.selectedProjectId).toBe(FIXTURE_EMPTY_PROJECT_ID);
        root.dispose();
    });

    it('reports an unreachable daemon, and loads once a retry reaches it', async () => {
        const transport = new FixtureTransport();
        let down = true;
        const flaky = overrideTransport(transport, {
            getRootSnapshot: () => (down ? Promise.reject(new Error('connect ECONNREFUSED')) : transport.getRootSnapshot()),
        });
        const root = new RootStore(flaky, { storage: memoryStorage() });

        await root.load();
        expect(root.phase).toBe('unreachable');
        expect(root.loadError).toBe('connect ECONNREFUSED');

        down = false;
        await root.load();
        expect(root.phase).toBe('ready');
        expect(root.loadError).toBe('');
        root.dispose();
    });

    it('applies the events of a command to the loaded project', async () => {
        const root = new RootStore(new FixtureTransport(), { storage: memoryStorage() });

        await root.load();
        await settle();

        const result = await root.command({ type: 'task.create', projectId: FIXTURE_PROJECT_ID, title: 'Write the release notes' });

        await settle();

        expect(result.ok).toBe(true);
        expect([...root.selectedProject!.tasks.values()].find(task => task.title === 'Write the release notes')?.key).toBe('CAR-31');
        root.dispose();
    });

    it('feeds stream items of the project to the streams that were opened', async () => {
        const root = new RootStore(new FixtureTransport(), { storage: memoryStorage() });

        await root.load();
        await settle();

        const stream = root.streams.of('r-orch-1');

        await stream.load();
        const before = stream.items.length;

        await root.command({ type: 'chat.send', chatId: 'c-1', text: 'Also add a dark theme' });
        await settle();

        expect(stream.items).toHaveLength(before + 1);
        expect(stream.items.at(-1)?.body).toEqual({ kind: 'user', text: 'Also add a dark theme' });
        root.dispose();
    });

    it('lists a project that appears by event, and creating one selects it', async () => {
        const root = new RootStore(new FixtureTransport(), { storage: memoryStorage() });

        await root.load();
        await settle();

        const result = await root.createProject('Garden Planner');

        await settle();

        expect(result.ok).toBe(true);
        expect(root.projects.map(project => project.name)).toEqual(['Personal', 'Car Rental', 'Clowdy', 'Garden Planner']);
        expect(root.selectedProject?.project.name).toBe('Garden Planner');
        expect(root.selectedProject?.project.taskPrefix).toBe('GAR');
        root.dispose();
    });

    it('opening a repository that is already a project selects it instead of adding another', async () => {
        const root = new RootStore(new FixtureTransport(), { storage: memoryStorage() });

        await root.load();
        await root.openProject('/Users/dev/clowdy');
        await settle();

        expect(root.projects).toHaveLength(3);
        expect(root.selectedProjectId).toBe(FIXTURE_EMPTY_PROJECT_ID);
        root.dispose();
    });

    it('turns a daemon that cannot be reached into an unavailable result for a command', async () => {
        const transport = new FixtureTransport();
        const root = new RootStore(overrideTransport(transport, { command: () => Promise.reject(new Error('fetch failed')) }), { storage: memoryStorage() });

        const result = await root.command({ type: 'chat.rename', chatId: 'c-1', title: 'x' });

        expect(result).toMatchObject({ ok: false, error: { code: 'unavailable', message: 'fetch failed' } });
    });

    it('passes daemon notices on to the person', async () => {
        const notify = vi.fn();
        const root = new RootStore(new FixtureTransport(), { storage: memoryStorage(), notify });
        const notice: ClowdyEvent = { cursor: 5000, at: 0, projectId: FIXTURE_PROJECT_ID, data: { type: 'notice', level: 'warn', text: 'The disk is almost full' } };

        root.handleEvent(notice);

        expect(notify).toHaveBeenCalledWith({ level: 'warn', text: 'The disk is almost full' });
    });

    it('shows the first project that appears while none is selected, and leaves a later one alone', async () => {
        const root = new RootStore(new FixtureTransport(), { storage: memoryStorage() });
        const project = { ...createFixtureData().projects[0], id: 'prj-new', name: 'Opened elsewhere', path: '/tmp/opened-elsewhere' };
        const upsert = (cursor: number, id: string, position: number): ClowdyEvent => ({ cursor, at: 0, projectId: id, data: { type: 'project.upserted', project: { ...project, id, position }, statuses: [] } });

        root.handleEvent(upsert(6000, 'prj-new', 1));
        root.handleEvent(upsert(6001, 'prj-later', 2));

        expect(root.selectedProjectId).toBe('prj-new');
        expect(root.projects.map(candidate => candidate.id)).toEqual(['prj-new', 'prj-later']);
        root.dispose();
    });
});

describe('RootStore projects', () => {
    it('opens on the personal space when the person has no project of their own', async () => {
        const data = createFixtureData();

        data.projects = data.projects.filter(project => project.personal);

        const root = new RootStore(new FixtureTransport({ data }), { storage: memoryStorage() });

        await root.load();
        await settle();

        expect(root.selectedProjectId).toBe(FIXTURE_PERSONAL_PROJECT_ID);
        expect(root.selectedProject?.status).toBe('ready');
        root.dispose();
    });

    it('keeps the personal space first and the rest by position when a project is renamed or moved in the order', async () => {
        const root = new RootStore(new FixtureTransport(), { storage: memoryStorage() });

        await root.load();
        await settle();
        await root.command({ type: 'project.update', projectId: FIXTURE_PERSONAL_PROJECT_ID, settings: { chatMode: 'semi' } });
        await root.command({ type: 'project.update', projectId: FIXTURE_PROJECT_ID, name: 'Car Rental 2' });
        await settle();

        expect(root.projects.map(project => project.name)).toEqual(['Personal', 'Car Rental 2', 'Clowdy']);
        root.dispose();
    });

    it('drops a removed project with its state and remembered window, and moves a window that was on it to the first project', async () => {
        const storage = memoryStorage({ [`clowdy:ui:${ FIXTURE_EMPTY_PROJECT_ID }`]: JSON.stringify({ section: 'docs' }) });
        const root = new RootStore(new FixtureTransport(), { storage });

        await root.load();
        root.selectProject(FIXTURE_EMPTY_PROJECT_ID);
        await settle();
        root.ui.openProjectSettings(FIXTURE_EMPTY_PROJECT_ID);

        const result = await root.command({ type: 'project.delete', projectId: FIXTURE_EMPTY_PROJECT_ID });

        await settle();

        expect(result.ok).toBe(true);
        expect(root.projects.map(project => project.name)).toEqual(['Personal', 'Car Rental']);
        expect(root.projectState(FIXTURE_EMPTY_PROJECT_ID)).toBeUndefined();
        expect(root.selectedProjectId).toBe(FIXTURE_PERSONAL_PROJECT_ID);
        expect(root.selectedProject?.status).toBe('ready');
        expect(root.ui.settingsProjectId).toBeNull();
        expect(storage.data).not.toHaveProperty(`clowdy:ui:${ FIXTURE_EMPTY_PROJECT_ID }`);
        root.dispose();
    });

    it('leaves the selection alone when another project is removed', async () => {
        const root = new RootStore(new FixtureTransport(), { storage: memoryStorage() });

        await root.load();
        await settle();
        await root.command({ type: 'project.delete', projectId: FIXTURE_EMPTY_PROJECT_ID });
        await settle();

        expect(root.selectedProjectId).toBe(FIXTURE_PROJECT_ID);
        root.dispose();
    });

    it('puts the projects in the dragged order at once, and back when the daemon refuses', async () => {
        const transport = new FixtureTransport();
        let refuse = false;
        const flaky = overrideTransport(transport, {
            command: input => (refuse ? Promise.resolve({ ok: false, requestId: 'x', error: { code: 'conflict', message: 'No' } }) : transport.command(input)),
        });
        const root = new RootStore(flaky, { storage: memoryStorage() });

        await root.load();
        await settle();

        const pending = root.reorderProjects([FIXTURE_EMPTY_PROJECT_ID, FIXTURE_PROJECT_ID]);

        expect(root.projects.map(project => [project.name, project.position])).toEqual([['Personal', 0], ['Clowdy', 1], ['Car Rental', 2]]);
        await pending;
        await settle();
        expect(root.projects.map(project => project.name)).toEqual(['Personal', 'Clowdy', 'Car Rental']);

        refuse = true;

        const result = await root.reorderProjects([FIXTURE_PROJECT_ID, FIXTURE_EMPTY_PROJECT_ID]);

        expect(result.ok).toBe(false);
        expect(root.projects.map(project => project.name)).toEqual(['Personal', 'Clowdy', 'Car Rental']);
        root.dispose();
    });

    it('keeps the personal space first however the order names it', async () => {
        const root = new RootStore(new FixtureTransport(), { storage: memoryStorage() });

        await root.load();
        await settle();
        await root.reorderProjects([FIXTURE_EMPTY_PROJECT_ID, FIXTURE_PERSONAL_PROJECT_ID, FIXTURE_PROJECT_ID]);
        await settle();

        expect(root.projects.map(project => project.name)).toEqual(['Personal', 'Clowdy', 'Car Rental']);
        root.dispose();
    });
});

describe('RootStore sync status', () => {
    it('shows nothing while the feed is healthy', async () => {
        const root = new RootStore(new FixtureTransport(), { storage: memoryStorage() });

        await root.load();
        await settle();
        await vi.advanceTimersByTimeAsync(BANNER_DELAY_MS * 2);

        expect(root.syncStatus).toBe('connected');
        expect(root.bannerVisible).toBe(false);
        root.dispose();
    });

    it('stays quiet for a drop shorter than the delay, then shows the banner for a longer one', () => {
        const root = new RootStore(new FixtureTransport(), { storage: memoryStorage() });

        root.handleFeedStatus('reconnecting');
        vi.advanceTimersByTime(BANNER_DELAY_MS - 1);
        expect(root.syncStatus).toBe('reconnecting');
        expect(root.bannerVisible).toBe(false);

        root.handleFeedStatus('connected');
        vi.advanceTimersByTime(BANNER_DELAY_MS);
        expect(root.bannerVisible).toBe(false);

        root.handleFeedStatus('reconnecting');
        vi.advanceTimersByTime(BANNER_DELAY_MS);
        expect(root.bannerVisible).toBe(true);

        root.handleFeedStatus('connected');
        expect(root.bannerVisible).toBe(false);
        expect(root.syncStatus).toBe('connected');
    });

    it('counts the delay from the first failure, not from each retry', () => {
        const root = new RootStore(new FixtureTransport(), { storage: memoryStorage() });

        root.handleFeedStatus('reconnecting');
        vi.advanceTimersByTime(2000);
        root.handleFeedStatus('reconnecting');
        vi.advanceTimersByTime(1000);

        expect(root.bannerVisible).toBe(true);
    });
});

describe('RootStore resync', () => {
    it('takes every snapshot again and follows from the new cursor when the daemon forgot the old one', async () => {
        const data = createFixtureData();
        const transport = new FixtureTransport({ data });
        const feeds: Array<{ cursor: number; status: (status: FeedStatus) => void }> = [];
        const spy = overrideTransport(transport, {
            subscribe: (cursor, onEvent, onStatus) => {
                feeds.push({ cursor, status: onStatus });

                return transport.subscribe(cursor, onEvent, onStatus);
            },
        });
        const root = new RootStore(spy, { storage: memoryStorage() });

        await root.load();
        await settle();
        expect(feeds.map(feed => feed.cursor)).toEqual([1000]);

        // The tasks change while the feed is gone; the old cursor can no longer be resumed.
        data.tasks[0].title = 'Changed while offline';
        await transport.command({ type: 'chat.rename', chatId: 'c-1', title: 'Renamed' });
        feeds[0].status('resync');
        await settle();

        expect(root.syncStatus).toBe('connected');
        expect(root.selectedProject?.tasks.get(data.tasks[0].id)?.title).toBe('Changed while offline');
        expect(root.selectedProject?.chats.get('c-1')?.title).toBe('Renamed');
        expect(feeds.map(feed => feed.cursor)).toEqual([1000, 1001]);
        root.dispose();
    });

    it('reads the model lists that were opened again, for an agents.changed it may have missed', async () => {
        const transport = new FixtureTransport();
        const feeds: Array<(status: FeedStatus) => void> = [];
        const asked: string[] = [];
        const spy = overrideTransport(transport, {
            getAgentModels: (agentId: string) => {
                asked.push(agentId);

                return transport.getAgentModels(agentId);
            },
            subscribe: (cursor, onEvent, onStatus) => {
                feeds.push(onStatus);

                return transport.subscribe(cursor, onEvent, onStatus);
            },
        });
        const root = new RootStore(spy, { storage: memoryStorage() });

        await root.load();
        await root.models.of('claude').load();
        root.models.of('codex');
        asked.length = 0;
        feeds[0]('resync');
        await settle();

        expect(asked).toEqual(['claude']);
        root.dispose();
    });

    it('forgets a project that was removed while the feed was away', async () => {
        const data = createFixtureData();
        const transport = new FixtureTransport({ data });
        const feeds: Array<(status: FeedStatus) => void> = [];
        const spy = overrideTransport(transport, {
            subscribe: (cursor, onEvent, onStatus) => {
                feeds.push(onStatus);

                return transport.subscribe(cursor, onEvent, onStatus);
            },
        });
        const root = new RootStore(spy, { storage: memoryStorage() });
        // Something on screen watches the list, as the window does; MobX complains about a change made outside an action only then.
        const stopWatching = autorun(() => void root.projects.length);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        await root.load();
        root.selectProject(FIXTURE_EMPTY_PROJECT_ID);
        await settle();
        data.projects = data.projects.filter(project => project.id !== FIXTURE_EMPTY_PROJECT_ID);
        feeds[0]('resync');
        await settle();

        expect(root.projects.map(project => project.name)).toEqual(['Personal', 'Car Rental']);
        expect(root.selectedProjectId).toBe(FIXTURE_PERSONAL_PROJECT_ID);
        expect(root.syncStatus).toBe('connected');
        expect(feeds).toHaveLength(2);
        expect(warn).not.toHaveBeenCalled();
        stopWatching();
        warn.mockRestore();
        root.dispose();
    });

    it('tries again while the daemon stays out of reach', async () => {
        const transport = new FixtureTransport();
        let down = false;
        const feeds: Array<(status: FeedStatus) => void> = [];
        const flaky = overrideTransport(transport, {
            getRootSnapshot: () => (down ? Promise.reject(new Error('offline')) : transport.getRootSnapshot()),
            subscribe: (cursor, onEvent, onStatus) => {
                feeds.push(onStatus);

                return transport.subscribe(cursor, onEvent, onStatus);
            },
        });
        const root = new RootStore(flaky, { storage: memoryStorage() });

        await root.load();
        await settle();
        down = true;
        feeds[0]('resync');
        await vi.advanceTimersByTimeAsync(5000);
        expect(feeds).toHaveLength(1);

        down = false;
        await vi.advanceTimersByTimeAsync(2000);
        expect(feeds).toHaveLength(2);
        root.dispose();
    });
});

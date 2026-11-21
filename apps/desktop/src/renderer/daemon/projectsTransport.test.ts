import { describe, expect, it } from 'vitest';

import { FIXTURE_EMPTY_PROJECT_ID, FIXTURE_PERSONAL_PROJECT_ID, FIXTURE_PROJECT_ID } from './fixtureData';
import { FixtureTransport } from './fixtureTransport';
import { HttpTransport } from './httpTransport';

import type { ClowdyEvent } from '@clowdy/protocol';

describe('HttpTransport.getProjectsInfo', () => {
    it('asks for the information of every project', async () => {
        const urls: string[] = [];
        const fetchImpl = (async (input: RequestInfo | URL) => {
            urls.push(String(input));

            return new Response(JSON.stringify([]), { status: 200 });
        }) as typeof fetch;
        const transport = new HttpTransport({ url: 'http://127.0.0.1:4310', token: 't', fetch: fetchImpl });

        expect(await transport.getProjectsInfo()).toEqual([]);
        expect(urls).toEqual(['http://127.0.0.1:4310/v1/projects/info']);
    });
});

async function connected() {
    const transport = new FixtureTransport();
    const { cursor } = await transport.getRootSnapshot();
    const events: ClowdyEvent[] = [];

    transport.subscribe(cursor, event => events.push(event), () => undefined);

    return { transport, events };
}

describe('FixtureTransport projects', () => {
    it('lists the personal space first, then the projects by position', async () => {
        const { projects } = await new FixtureTransport().getRootSnapshot();

        expect(projects.map(project => project.name)).toEqual(['Personal', 'Car Rental', 'Clowdy']);
        expect(projects[0]).toMatchObject({ personal: true, position: 0 });
    });

    it('reads what is known of each project, in the order of the list', async () => {
        const info = await new FixtureTransport().getProjectsInfo();

        expect(info.map(entry => entry.projectId)).toEqual([FIXTURE_PERSONAL_PROJECT_ID, FIXTURE_PROJECT_ID, FIXTURE_EMPTY_PROJECT_ID]);
        expect(info[0]).toMatchObject({ folders: [{ folderId: 'fld_personal', exists: true }], chats: 0, tasks: 0, activeRuns: 0 });
        expect(info[0].folders[0].remoteUrl).toBeUndefined();
        expect(info[1].folders).toEqual([{ folderId: 'fld_car_rental', exists: true, remoteUrl: 'git@github.com:acme/car-rental.git', chats: 0 }]);
        expect(info[1].chats).toBeGreaterThan(0);
        expect(info[1].activeRuns).toBeGreaterThan(0);
    });

    it('refuses to rename the personal space or give it other folders, and takes its settings', async () => {
        const { transport } = await connected();

        expect(await transport.command({ type: 'project.update', projectId: FIXTURE_PERSONAL_PROJECT_ID, name: 'Mine' })).toMatchObject({ ok: false, error: { code: 'conflict' } });
        expect(await transport.command({ type: 'project.update', projectId: FIXTURE_PERSONAL_PROJECT_ID, folders: [{ path: '/elsewhere' }] })).toMatchObject({ ok: false, error: { code: 'conflict' } });
        expect(await transport.command({ type: 'project.update', projectId: FIXTURE_PERSONAL_PROJECT_ID, settings: { chatMode: 'semi' } })).toMatchObject({ ok: true, data: { project: { settings: { chatMode: 'semi' } } } });
    });

    it('clears a setting set to null and keeps the others', async () => {
        const { transport } = await connected();
        const result = await transport.command({ type: 'project.update', projectId: FIXTURE_PROJECT_ID, settings: { engine: null } });

        expect(result).toMatchObject({ ok: true, data: { project: { settings: { maxParallelRuns: 4, targetBranch: 'main' } } } });
        expect((result as { data: { project: { settings: object } } }).data.project.settings).not.toHaveProperty('engine');
    });

    it('takes a new main folder only when nothing runs, adds others at any time, and lets two projects share a folder', async () => {
        const { transport } = await connected();

        expect(await transport.command({ type: 'project.update', projectId: FIXTURE_PROJECT_ID, folders: [{ path: '/Users/dev/moved' }] })).toMatchObject({ ok: false, error: { code: 'conflict' } });
        expect(await transport.command({ type: 'project.update', projectId: FIXTURE_PROJECT_ID, folders: [{ id: 'fld_car_rental' }, { path: '/Users/dev/api' }] }))
            .toMatchObject({ ok: true, data: { project: { folders: [{ id: 'fld_car_rental' }, { path: '/Users/dev/api' }] } } });
        expect(await transport.command({ type: 'project.update', projectId: FIXTURE_EMPTY_PROJECT_ID, folders: [{ id: 'fld_clowdy' }, { path: '/Users/dev/car-rental' }] })).toMatchObject({ ok: true });
        expect(await transport.command({ type: 'project.update', projectId: FIXTURE_EMPTY_PROJECT_ID, folders: [{ path: '/Users/dev/moved' }] })).toMatchObject({ ok: true, data: { project: { folders: [{ path: '/Users/dev/moved' }] } } });
    });

    it('adds a project of several folders, and answers the same folders with the project that has them', async () => {
        const { transport } = await connected();
        const added = await transport.command({ type: 'project.add', folders: ['/Users/dev/web', '/Users/dev/api'] });

        expect(added).toMatchObject({ ok: true, data: { project: { name: 'web', folders: [{ path: '/Users/dev/web' }, { path: '/Users/dev/api' }] } } });
        expect((added as { data: object }).data).not.toHaveProperty('existing');
        expect(await transport.command({ type: 'project.add', folders: ['/Users/dev/api', '/Users/dev/web'] }))
            .toMatchObject({ ok: true, data: { project: { id: (added as { data: { project: { id: string } } }).data.project.id }, existing: true } });
        expect(await transport.command({ type: 'project.add', name: 'Fresh' })).toMatchObject({ ok: true, data: { project: { name: 'Fresh', folders: [{ path: '/Users/dev/Clowdy/projects/fresh' }] } } });
        expect(await transport.command({ type: 'project.add' })).toMatchObject({ ok: false, error: { code: 'invalid' } });
    });

    it('removes a project with what it holds and announces it, and refuses the personal space and a project with agents at work', async () => {
        const { transport, events } = await connected();

        expect(await transport.command({ type: 'project.delete', projectId: FIXTURE_PERSONAL_PROJECT_ID })).toMatchObject({ ok: false, error: { code: 'conflict' } });
        expect(await transport.command({ type: 'project.delete', projectId: FIXTURE_PROJECT_ID })).toMatchObject({ ok: false, error: { code: 'conflict' } });
        expect(await transport.command({ type: 'project.delete', projectId: 'nope' })).toMatchObject({ ok: false, error: { code: 'not_found' } });
        expect(await transport.command({ type: 'project.delete', projectId: FIXTURE_EMPTY_PROJECT_ID })).toMatchObject({ ok: true });

        expect(events.map(event => [event.projectId, event.data.type])).toEqual([[FIXTURE_EMPTY_PROJECT_ID, 'project.deleted']]);
        expect((await transport.getRootSnapshot()).projects.map(project => project.name)).toEqual(['Personal', 'Car Rental']);
        await expect(transport.getProjectSnapshot(FIXTURE_EMPTY_PROJECT_ID)).rejects.toMatchObject({ status: 404 });
    });

    it('reorders the projects behind the personal space and announces only those that moved', async () => {
        const { transport, events } = await connected();

        expect(await transport.command({ type: 'project.reorder', projectIds: ['nope'] })).toMatchObject({ ok: false, error: { code: 'invalid' } });

        await transport.command({ type: 'project.reorder', projectIds: [FIXTURE_EMPTY_PROJECT_ID, FIXTURE_PERSONAL_PROJECT_ID] });

        const { projects } = await transport.getRootSnapshot();

        expect(projects.map(project => [project.name, project.position])).toEqual([['Personal', 0], ['Clowdy', 1], ['Car Rental', 2]]);
        expect(events.map(event => event.projectId).sort()).toEqual([FIXTURE_PROJECT_ID, FIXTURE_EMPTY_PROJECT_ID].sort());
    });
});

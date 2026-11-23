import { describe, expect, it } from 'vitest';

import { createFixtureData, FIXTURE_EMPTY_PROJECT_ID, FIXTURE_PERSONAL_PROJECT_ID, FIXTURE_PROJECT_ID, FIXTURE_WORKTREE_PATH, withFixtureWorktrees } from './fixtureData';
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

    it('limits the question to one project when it names it', async () => {
        const urls: string[] = [];
        const fetchImpl = (async (input: RequestInfo | URL) => {
            urls.push(String(input));

            return new Response(JSON.stringify([]), { status: 200 });
        }) as typeof fetch;
        const transport = new HttpTransport({ url: 'http://127.0.0.1:4310', token: 't', fetch: fetchImpl });

        await transport.getProjectsInfo('prj_a b');
        expect(urls).toEqual(['http://127.0.0.1:4310/v1/projects/info?project=prj_a%20b']);
    });
});

describe('HttpTransport.getFolderGit', () => {
    it('asks for one folder of one project, both ids escaped', async () => {
        const urls: string[] = [];
        const fetchImpl = (async (input: RequestInfo | URL) => {
            urls.push(String(input));

            return new Response(JSON.stringify({ isRepository: false }), { status: 200 });
        }) as typeof fetch;
        const transport = new HttpTransport({ url: 'http://127.0.0.1:4310', token: 't', fetch: fetchImpl });

        expect(await transport.getFolderGit('prj a', 'fld/b')).toEqual({ isRepository: false });
        expect(urls).toEqual(['http://127.0.0.1:4310/v1/projects/prj%20a/git?folderId=fld%2Fb']);
    });

    it('rejects with the daemon\'s own reason when it cannot read the folder, for the page to say why', async () => {
        const fetchImpl = (async () => new Response(JSON.stringify({ error: { code: 'unavailable', message: 'git did not answer' } }), { status: 503 })) as unknown as typeof fetch;
        const transport = new HttpTransport({ url: 'http://127.0.0.1:4310', token: 't', fetch: fetchImpl });

        await expect(transport.getFolderGit('prj_a', 'fld_b')).rejects.toMatchObject({ message: 'git did not answer', status: 503 });
    });

    it('rejects with the status when the daemon gives no reason', async () => {
        const fetchImpl = (async () => new Response('Bad gateway', { status: 502 })) as unknown as typeof fetch;
        const transport = new HttpTransport({ url: 'http://127.0.0.1:4310', token: 't', fetch: fetchImpl });

        await expect(transport.getFolderGit('prj_a', 'fld_b')).rejects.toMatchObject({ message: expect.stringContaining('502'), status: 502 });
    });
});

describe('HttpTransport.getProjectWorktrees', () => {
    it('asks for one project, its id escaped, and gives the daemon\'s answer', async () => {
        const urls: string[] = [];
        const answer = [{ folderId: 'fld_b', name: 'app', isRepository: false, worktrees: [] }];
        const fetchImpl = (async (input: RequestInfo | URL) => {
            urls.push(String(input));

            return new Response(JSON.stringify(answer), { status: 200 });
        }) as typeof fetch;
        const transport = new HttpTransport({ url: 'http://127.0.0.1:4310', token: 't', fetch: fetchImpl });

        expect(await transport.getProjectWorktrees('prj a/b')).toEqual(answer);
        expect(urls).toEqual(['http://127.0.0.1:4310/v1/projects/prj%20a%2Fb/worktrees']);
    });

    it('rejects with the status for a project the daemon does not have', async () => {
        const fetchImpl = (async () => new Response(JSON.stringify({ error: { code: 'not_found', message: 'Project prj_x does not exist' } }), { status: 404 })) as unknown as typeof fetch;
        const transport = new HttpTransport({ url: 'http://127.0.0.1:4310', token: 't', fetch: fetchImpl });

        await expect(transport.getProjectWorktrees('prj_x')).rejects.toMatchObject({ status: 404 });
    });
});

describe('FixtureTransport.getProjectWorktrees', () => {
    it('lists a group per folder with its own checkout first, and no worktrees for a folder that is no repository', async () => {
        const transport = new FixtureTransport({ data: withFixtureWorktrees(createFixtureData()) });
        const groups = await transport.getProjectWorktrees(FIXTURE_PROJECT_ID);

        expect(groups.map(group => [group.name, group.isRepository])).toEqual([['car-rental', true], ['car-rental-api', true], ['notes', false]]);
        expect(groups[0].worktrees[0]).toMatchObject({ path: '/Users/dev/car-rental', branch: 'main', main: true, changes: 0, blocked: 'main', chats: [] });
        expect(groups[0].worktrees.slice(1).every(worktree => !worktree.main)).toBe(true);
        expect(groups[2].worktrees).toEqual([]);
    });

    it('describes a Clowdy-made worktree with its two chats, a found changed one, a locked one and one gone from the disk', async () => {
        const transport = new FixtureTransport({ data: withFixtureWorktrees(createFixtureData()) });
        const [carRental] = await transport.getProjectWorktrees(FIXTURE_PROJECT_ID);
        const byPath = (path: string) => carRental.worktrees.find(worktree => worktree.path === path);

        expect(byPath(FIXTURE_WORKTREE_PATH)).toMatchObject({
            branch: 'clowdy/ab12cd34',
            managed: true,
            workspaceId: 'wks_ab12cd34',
            changes: 3,
            merged: false,
            base: 'origin/main',
            blocked: 'chats',
            chats: [{ id: 'c-9', archived: false }, { id: 'c-10', archived: true }],
        });
        expect(byPath('/Users/dev/orca/car-rental/search-filters')).toMatchObject({ managed: false, changes: 2, submodules: true, merged: false, chats: [] });
        expect(byPath('/Users/dev/orca/car-rental/search-filters')?.blocked).toBeUndefined();
        expect(byPath('/Users/dev/car-rental-hotfix')).toMatchObject({ locked: 'on an external drive', blocked: 'locked' });
        expect(byPath('/Users/dev/car-rental-old')).toMatchObject({ missing: true, changes: 0 });
    });

    it('lists the worktrees of the fixture project that nobody works in with no chats, and refuses a project it does not have', async () => {
        const transport = new FixtureTransport();
        const [carRental] = await transport.getProjectWorktrees(FIXTURE_PROJECT_ID);

        expect(carRental.worktrees.find(worktree => worktree.path === FIXTURE_WORKTREE_PATH)).toMatchObject({ chats: [], managed: true });
        expect(carRental.worktrees.find(worktree => worktree.path === FIXTURE_WORKTREE_PATH)?.blocked).toBeUndefined();
        await expect(transport.getProjectWorktrees(FIXTURE_PERSONAL_PROJECT_ID)).resolves.toMatchObject([{ isRepository: false, worktrees: [] }]);
        await expect(transport.getProjectWorktrees('p-none')).rejects.toMatchObject({ status: 404 });
    });
});

describe('FixtureTransport workspace.remove', () => {
    const FOUND = '/Users/dev/orca/car-rental/search-filters';
    const LOCKED = '/Users/dev/car-rental-hotfix';
    const MISSING = '/Users/dev/car-rental-old';
    const remove = (transport: FixtureTransport, fields: { path: string; projectId?: string; folderId?: string; discard?: boolean; deleteBranch?: boolean }) => transport.command({ type: 'workspace.remove', projectId: FIXTURE_PROJECT_ID, folderId: 'fld_car_rental', ...fields });
    const paths = async (transport: FixtureTransport) => (await transport.getProjectWorktrees(FIXTURE_PROJECT_ID))[0].worktrees.map(worktree => worktree.path);
    const gitOf = async (transport: FixtureTransport) => {
        const git = await transport.getFolderGit(FIXTURE_PROJECT_ID, 'fld_car_rental');

        if (!git.isRepository) throw new Error('Not a repository');

        return git;
    };
    const branches = async (transport: FixtureTransport) => (await gitOf(transport)).branches.filter(branch => !branch.remote).map(branch => branch.name);

    it('takes a worktree out of the list and keeps its branch as a local one, or deletes the branch with deleteBranch', async () => {
        const transport = new FixtureTransport();

        expect(await paths(transport)).toContain(FOUND);
        expect(await branches(transport)).not.toContain('search-filters');

        // The tree is changed, which is the person's to say yes to.
        expect(await remove(transport, { path: FOUND })).toMatchObject({ ok: false, error: { code: 'conflict', message: 'The worktree has changes that are not committed' } });
        expect(await paths(transport)).toContain(FOUND);

        expect(await remove(transport, { path: FOUND, discard: true })).toMatchObject({ ok: true, data: { path: FOUND, branchDeleted: false } });
        expect(await paths(transport)).not.toContain(FOUND);
        expect(await branches(transport)).toContain('search-filters');
        expect((await gitOf(transport)).worktrees.map(worktree => worktree.path)).not.toContain(FOUND);

        // Gone from the disk: only its record, and the branch with it when asked.
        expect(await remove(transport, { path: MISSING, deleteBranch: true })).toMatchObject({ ok: true, data: { path: MISSING, branchDeleted: true } });
        expect(await paths(transport)).not.toContain(MISSING);
        expect(await branches(transport)).not.toContain('old-pricing');
        // Nothing else went.
        expect(await paths(transport)).toEqual(['/Users/dev/car-rental', FIXTURE_WORKTREE_PATH, LOCKED]);
    });

    it('removes the worktree a chat was made for once no chat works in it, and the branch it was made on goes when it is asked to', async () => {
        const transport = new FixtureTransport();

        expect(await remove(transport, { path: FIXTURE_WORKTREE_PATH, discard: true, deleteBranch: true })).toMatchObject({ ok: true, data: { branchDeleted: true } });
        expect(await paths(transport)).not.toContain(FIXTURE_WORKTREE_PATH);
        expect(await branches(transport)).not.toContain('clowdy/ab12cd34');
    });

    it('refuses what the daemon refuses, and removes nothing', async () => {
        const transport = new FixtureTransport({ data: withFixtureWorktrees(createFixtureData()) });
        const before = await paths(transport);

        expect(await remove(transport, { path: '/Users/dev/car-rental', discard: true })).toMatchObject({ ok: false, error: { code: 'conflict', message: 'That is the folder\'s own checkout' } });
        expect(await remove(transport, { path: LOCKED, discard: true })).toMatchObject({ ok: false, error: { code: 'conflict', message: 'The worktree is locked' } });
        expect(await remove(transport, { path: FIXTURE_WORKTREE_PATH, discard: true })).toMatchObject({ ok: false, error: { code: 'conflict', message: expect.stringContaining('works in this worktree') as unknown as string } });
        expect(await remove(transport, { path: '/Users/dev/elsewhere' })).toMatchObject({ ok: false, error: { code: 'conflict', message: 'Git does not list it as a worktree of the folder' } });
        expect(await remove(transport, { path: 'search-filters' })).toMatchObject({ ok: false, error: { code: 'invalid' } });
        expect(await remove(transport, { path: FOUND, folderId: 'fld_none' })).toMatchObject({ ok: false, error: { code: 'invalid' } });
        expect(await remove(transport, { path: FOUND, folderId: 'fld_notes' })).toMatchObject({ ok: false, error: { code: 'invalid' } });
        expect(await remove(transport, { path: FOUND, projectId: 'p-none' })).toMatchObject({ ok: false, error: { code: 'not_found' } });
        expect(await paths(transport)).toEqual(before);
    });

    it('takes the row workspace.open answered for the worktree with it, and a chat can no longer be made there', async () => {
        const transport = new FixtureTransport();
        const opened = await transport.command({ type: 'workspace.open', projectId: FIXTURE_PROJECT_ID, path: FIXTURE_WORKTREE_PATH });

        expect(opened.ok).toBe(true);
        expect(await remove(transport, { path: FIXTURE_WORKTREE_PATH, discard: true })).toMatchObject({ ok: true });
        expect(await transport.command({ type: 'workspace.open', projectId: FIXTURE_PROJECT_ID, path: FIXTURE_WORKTREE_PATH })).toMatchObject({ ok: false, error: { code: 'invalid' } });
        expect(await transport.command({ type: 'chat.create', projectId: FIXTURE_PROJECT_ID, workspace: { mode: 'existing', path: FIXTURE_WORKTREE_PATH } })).toMatchObject({ ok: false, error: { code: 'invalid' } });
    });
});

describe('HttpTransport.getChatWorkspaceRemoval', () => {
    it('asks for one chat, its id escaped, and gives the daemon\'s answer', async () => {
        const urls: string[] = [];
        const fetchImpl = (async (input: RequestInfo | URL) => {
            urls.push(String(input));

            return new Response(JSON.stringify({ removable: true, path: '/w/ab12cd34/app', branch: 'clowdy/ab12cd34' }), { status: 200 });
        }) as typeof fetch;
        const transport = new HttpTransport({ url: 'http://127.0.0.1:4310', token: 't', fetch: fetchImpl });

        expect(await transport.getChatWorkspaceRemoval('cht a/b')).toEqual({ removable: true, path: '/w/ab12cd34/app', branch: 'clowdy/ab12cd34' });
        expect(urls).toEqual(['http://127.0.0.1:4310/v1/chats/cht%20a%2Fb/workspace']);
    });

    it('rejects with the status for a chat the daemon does not have', async () => {
        const fetchImpl = (async () => new Response(JSON.stringify({ error: { code: 'not_found', message: 'Chat cht_x does not exist' } }), { status: 404 })) as unknown as typeof fetch;
        const transport = new HttpTransport({ url: 'http://127.0.0.1:4310', token: 't', fetch: fetchImpl });

        await expect(transport.getChatWorkspaceRemoval('cht_x')).rejects.toMatchObject({ status: 404 });
    });
});

describe('FixtureTransport.getFolderGit', () => {
    it('answers the branches and worktrees of a repository, and that a folder git knows nothing of is none', async () => {
        const transport = new FixtureTransport();
        const { projects } = await transport.getRootSnapshot();
        const [personal, carRental] = [projects[0].folders[0], projects.find(project => project.id === FIXTURE_PROJECT_ID)!.folders[0]];

        expect(await transport.getFolderGit(FIXTURE_PROJECT_ID, carRental.id)).toMatchObject({
            isRepository: true,
            branch: 'main',
            defaultBranch: 'origin/main',
            branches: expect.arrayContaining([{ name: 'main', remote: false }, { name: 'origin/main', remote: true }]),
            worktrees: [{ path: carRental.path, branch: 'main', main: true, dirty: false }, { branch: 'clowdy/ab12cd34', main: false, dirty: true }],
        });
        expect(await transport.getFolderGit(FIXTURE_PERSONAL_PROJECT_ID, personal.id)).toEqual({ isRepository: false });
    });

    it('refuses a project or a folder it does not have', async () => {
        const transport = new FixtureTransport();

        await expect(transport.getFolderGit('p-none', 'fld_car_rental')).rejects.toMatchObject({ status: 404 });
        await expect(transport.getFolderGit(FIXTURE_PROJECT_ID, 'fld_none')).rejects.toMatchObject({ status: 404 });
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
        expect(info[1].folders).toEqual([{ folderId: 'fld_car_rental', exists: true, remoteUrl: 'git@github.com:acme/car-rental.git', branch: 'main', chats: 0 }]);
        expect(info[1].chats).toBeGreaterThan(0);
        expect(info[1].activeRuns).toBeGreaterThan(0);
    });

    it('reads one project alone when it is asked for', async () => {
        const info = await new FixtureTransport().getProjectsInfo(FIXTURE_PROJECT_ID);

        expect(info.map(entry => entry.projectId)).toEqual([FIXTURE_PROJECT_ID]);
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

    it('sets the settings of one folder, clears a field set to null, announces the project, and leaves the other folders and projects alone', async () => {
        const { transport, events } = await connected();
        const settings = { baseBranch: 'origin/dev', setup: { files: ['.env', '.env*'], command: 'bun install' } };
        const sharing = await transport.command({ type: 'project.update', projectId: FIXTURE_EMPTY_PROJECT_ID, folders: [{ id: 'fld_clowdy' }, { path: '/Users/dev/car-rental' }] });

        expect(sharing).toMatchObject({ ok: true });

        const set = await transport.command({ type: 'project.updateFolder', projectId: FIXTURE_PROJECT_ID, folderId: 'fld_car_rental', settings });

        expect(set).toMatchObject({ ok: true, data: { project: { id: FIXTURE_PROJECT_ID, folders: [{ id: 'fld_car_rental', settings }] } } });
        expect(events.filter(event => event.data.type === 'project.upserted' && event.projectId === FIXTURE_PROJECT_ID)).toHaveLength(1);

        // The same path in another project has its own settings.
        const { projects } = await transport.getRootSnapshot();

        expect(projects.find(project => project.id === FIXTURE_EMPTY_PROJECT_ID)!.folders.map(folder => folder.settings)).toEqual([undefined, undefined]);

        await transport.command({ type: 'project.updateFolder', projectId: FIXTURE_PROJECT_ID, folderId: 'fld_car_rental', settings: { baseBranch: null } });

        const cleared = await transport.command({ type: 'project.updateFolder', projectId: FIXTURE_PROJECT_ID, folderId: 'fld_car_rental', settings: { setup: null } });
        const folder = (cleared as { data: { project: { folders: object[] } } }).data.project.folders[0]!;

        expect(folder).not.toHaveProperty('settings');
    });

    it('keeps a folder\'s settings through a project update that reorders or renames, and the folder\'s base branch answers as its default', async () => {
        const { transport } = await connected();
        const settings = { baseBranch: 'dev' };

        await transport.command({ type: 'project.update', projectId: FIXTURE_PROJECT_ID, folders: [{ id: 'fld_car_rental' }, { path: '/Users/dev/api' }, { path: '/Users/dev/notes' }] });
        await transport.command({ type: 'project.updateFolder', projectId: FIXTURE_PROJECT_ID, folderId: 'fld_car_rental', settings });

        const reordered = await transport.command({ type: 'project.update', projectId: FIXTURE_PROJECT_ID, name: 'Rental', folders: [{ id: 'fld_car_rental' }, { path: '/Users/dev/notes' }, { path: '/Users/dev/api' }] });

        expect(reordered).toMatchObject({ ok: true, data: { project: { name: 'Rental', folders: [{ id: 'fld_car_rental', settings }, { path: '/Users/dev/notes' }, { path: '/Users/dev/api' }] } } });
        expect(await transport.getFolderGit(FIXTURE_PROJECT_ID, 'fld_car_rental')).toMatchObject({ defaultBranch: 'dev' });

        // A base branch the repository does not have is skipped.
        await transport.command({ type: 'project.updateFolder', projectId: FIXTURE_PROJECT_ID, folderId: 'fld_car_rental', settings: { baseBranch: 'nope' } });
        expect(await transport.getFolderGit(FIXTURE_PROJECT_ID, 'fld_car_rental')).toMatchObject({ defaultBranch: 'origin/main' });
    });

    it('refuses settings for the personal space, a folder the project does not have, a project that is not there, and a file outside the folder', async () => {
        const { transport } = await connected();
        const update = (projectId: string, folderId: string, settings: object) => transport.command({ type: 'project.updateFolder', projectId, folderId, settings });

        expect(await update(FIXTURE_PERSONAL_PROJECT_ID, 'fld_personal', { baseBranch: 'main' })).toMatchObject({ ok: false, error: { code: 'conflict' } });
        expect(await update(FIXTURE_PROJECT_ID, 'fld_clowdy', { baseBranch: 'main' })).toMatchObject({ ok: false, error: { code: 'not_found' } });
        expect(await update('p-none', 'fld_car_rental', { baseBranch: 'main' })).toMatchObject({ ok: false, error: { code: 'not_found' } });
        expect(await update(FIXTURE_PROJECT_ID, 'fld_car_rental', { setup: { files: ['../x'] } })).toMatchObject({ ok: false, error: { code: 'invalid' } });
        expect(await update(FIXTURE_PROJECT_ID, 'fld_car_rental', { baseBranch: ' ' })).toMatchObject({ ok: false, error: { code: 'invalid' } });
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

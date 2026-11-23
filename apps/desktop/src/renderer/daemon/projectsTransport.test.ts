import { describe, expect, it } from 'vitest';

import { createFixtureData, FIXTURE_EMPTY_PROJECT_ID, FIXTURE_GIT_COMMITS, FIXTURE_PERSONAL_PROJECT_ID, FIXTURE_PROJECT_ID, FIXTURE_WORKTREE_PATH, withFixtureWorkspace, withFixtureWorktrees } from './fixtureData';
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

describe('HttpTransport git reads', () => {
    /** A transport whose daemon answers `body` with `status`, and the urls it was asked. */
    function transportFor(body: unknown, status = 200) {
        const urls: string[] = [];
        const fetchImpl = (async (input: RequestInfo | URL) => {
            urls.push(String(input));

            return new Response(JSON.stringify(body), { status });
        }) as typeof fetch;

        return { urls, transport: new HttpTransport({ url: 'http://127.0.0.1:4310', token: 't', fetch: fetchImpl }) };
    }

    it('asks for the status of a folder\'s own checkout, and of a worktree of it, both ids escaped', async () => {
        const { urls, transport } = transportFor({ isRepository: false });

        expect(await transport.getGitStatus('prj a', { folderId: 'fld/b' })).toEqual({ isRepository: false });
        await transport.getGitStatus('prj a', { folderId: 'fld/b', workspaceId: 'wks 1' });
        expect(urls).toEqual([
            'http://127.0.0.1:4310/v1/projects/prj%20a/git/status?folderId=fld%2Fb',
            'http://127.0.0.1:4310/v1/projects/prj%20a/git/status?folderId=fld%2Fb&workspaceId=wks+1',
        ]);
    });

    it('asks for the changes of a scope, a commit\'s scope included', async () => {
        const { urls, transport } = transportFor({ isRepository: true, scope: 'branch', files: [], fileCount: 0, additions: 0, deletions: 0, statsComplete: true });

        expect(await transport.getGitChanges('prj_a', { folderId: 'fld_b', workspaceId: 'wks_c' }, 'branch')).toMatchObject({ scope: 'branch', fileCount: 0 });
        await transport.getGitChanges('prj_a', { folderId: 'fld_b' }, 'commit:abc1234');
        expect(urls).toEqual([
            'http://127.0.0.1:4310/v1/projects/prj_a/git/changes?folderId=fld_b&workspaceId=wks_c&scope=branch',
            'http://127.0.0.1:4310/v1/projects/prj_a/git/changes?folderId=fld_b&scope=commit%3Aabc1234',
        ]);
    });

    it('asks for the two sides of a file by its path, and by its old path when it was renamed', async () => {
        const { urls, transport } = transportFor({ state: 'text', original: 'a\n', modified: 'b\n', revision: 'r' });

        expect(await transport.getGitFile('prj_a', { folderId: 'fld_b' }, 'all', 'src/a b.ts')).toEqual({ state: 'text', original: 'a\n', modified: 'b\n', revision: 'r' });
        await transport.getGitFile('prj_a', { folderId: 'fld_b', workspaceId: 'wks_c' }, 'uncommitted', 'new.ts', 'old.ts');
        expect(urls).toEqual([
            'http://127.0.0.1:4310/v1/projects/prj_a/git/file?folderId=fld_b&scope=all&path=src%2Fa+b.ts',
            'http://127.0.0.1:4310/v1/projects/prj_a/git/file?folderId=fld_b&workspaceId=wks_c&scope=uncommitted&path=new.ts&oldPath=old.ts',
        ]);
    });

    it('rejects with the daemon\'s own reason and status, for the strip to say why, and with the status when it gives none', async () => {
        const gone = transportFor({ error: { code: 'unavailable', message: 'The worktree /w/app is missing' } }, 503).transport;

        await expect(gone.getGitStatus('prj_a', { folderId: 'fld_b', workspaceId: 'wks_c' })).rejects.toMatchObject({ message: 'The worktree /w/app is missing', status: 503 });
        await expect(gone.getGitChanges('prj_a', { folderId: 'fld_b' }, 'all')).rejects.toMatchObject({ status: 503 });
        await expect(gone.getGitFile('prj_a', { folderId: 'fld_b' }, 'all', 'a.ts')).rejects.toMatchObject({ status: 503 });

        const bare = new HttpTransport({ url: 'http://127.0.0.1:4310', token: 't', fetch: (async () => new Response('Bad gateway', { status: 502 })) as unknown as typeof fetch });

        await expect(bare.getGitStatus('prj_a', { folderId: 'fld_b' })).rejects.toMatchObject({ message: expect.stringContaining('502'), status: 502 });
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

describe('FixtureTransport git reads', () => {
    const place = { folderId: 'fld_car_rental' };
    const worktree = () => new FixtureTransport({ data: withFixtureWorkspace(createFixtureData()) });
    const inWorktree = { ...place, workspaceId: 'wks_ab12cd34' };

    it('says the folder\'s own checkout is clean and level with its base, and that a folder git knows nothing of is none', async () => {
        const transport = new FixtureTransport();
        const status = await transport.getGitStatus(FIXTURE_PROJECT_ID, place);

        expect(status).toMatchObject({
            isRepository: true,
            head: { kind: 'branch', name: 'main' },
            upstream: { name: 'origin/main', ahead: 0, behind: 0 },
            origin: true,
            entries: [],
            base: { state: 'ready', name: 'origin/main', ahead: 0, behind: 0, commits: [] },
        });
        expect(await transport.getGitChanges(FIXTURE_PROJECT_ID, place, 'all')).toMatchObject({ isRepository: true, baseState: 'ready', files: [], fileCount: 0, statsComplete: true });

        const [personal] = (await transport.getRootSnapshot()).projects[0]!.folders;

        expect(await transport.getGitStatus(FIXTURE_PERSONAL_PROJECT_ID, { folderId: personal!.id })).toEqual({ isRepository: false });
        expect(await transport.getGitChanges(FIXTURE_PERSONAL_PROJECT_ID, { folderId: personal!.id }, 'all')).toEqual({ isRepository: false });
    });

    it('says a chat\'s worktree is dirty and ahead of its base, with the commits it made', async () => {
        const status = await worktree().getGitStatus(FIXTURE_PROJECT_ID, inWorktree);

        expect(status).toMatchObject({
            isRepository: true,
            head: { kind: 'branch', name: 'clowdy/ab12cd34' },
            entries: [{ path: 'notes.md', untracked: true }, { path: 'src/booking/price.ts', unstaged: 'modified' }, { path: 'src/limits.ts', unstaged: 'modified' }],
            base: { state: 'ready', name: 'origin/main', ahead: 2, behind: 1, commits: FIXTURE_GIT_COMMITS },
        });
        expect((status as { upstream?: unknown }).upstream).toBeUndefined();
    });

    it('lists the files of each scope with their numbers, and one commit\'s by its hash, a short one too', async () => {
        const transport = worktree();
        const committed = await transport.getGitChanges(FIXTURE_PROJECT_ID, inWorktree, 'branch');
        const uncommitted = await transport.getGitChanges(FIXTURE_PROJECT_ID, inWorktree, 'uncommitted');
        const all = await transport.getGitChanges(FIXTURE_PROJECT_ID, inWorktree, 'all');
        const [newest, oldest] = FIXTURE_GIT_COMMITS;

        expect(committed).toMatchObject({ isRepository: true, scope: 'branch', baseState: 'ready', fileCount: 4, additions: 23 + 42 + 37, deletions: 5 });
        expect(committed).toMatchObject({ files: expect.arrayContaining([{ path: 'assets/logo.png', kind: 'added', binary: true, revision: expect.stringMatching(/^000000:0+:100644:9+$/) }]) });
        expect(uncommitted).toMatchObject({ scope: 'uncommitted', fileCount: 3, additions: 3 + 6 + 1, deletions: 2 + 1 });
        expect((uncommitted as { baseState?: unknown }).baseState).toBeUndefined();
        expect(all).toMatchObject({ scope: 'all', fileCount: 6 });
        expect((await transport.getGitChanges(FIXTURE_PROJECT_ID, inWorktree, `commit:${ newest!.sha }`) as { files: Array<{ path: string }> }).files.map(file => file.path)).toEqual(['src/booking/price.ts', 'src/booking/weekend.ts']);
        expect((await transport.getGitChanges(FIXTURE_PROJECT_ID, inWorktree, `commit:${ oldest!.sha.slice(0, 7) }`) as { fileCount: number }).fileCount).toBe(3);
    });

    it('reads the text of a file before and after, and nothing for a binary one', async () => {
        const transport = worktree();

        expect(await transport.getGitFile(FIXTURE_PROJECT_ID, inWorktree, 'all', 'src/booking/price.ts')).toMatchObject({ state: 'text', original: expect.stringContaining('days * rate'), modified: expect.stringContaining('weekend') });
        expect(await transport.getGitFile(FIXTURE_PROJECT_ID, inWorktree, 'uncommitted', 'notes.md')).toMatchObject({ state: 'text', original: null });
        expect(await transport.getGitFile(FIXTURE_PROJECT_ID, inWorktree, 'branch', 'assets/logo.png')).toEqual({ state: 'binary', revision: expect.any(String) });
    });

    it('does not give the same object twice, so a caller that edits an answer does not change the next', async () => {
        const transport = worktree();
        const first = await transport.getGitChanges(FIXTURE_PROJECT_ID, inWorktree, 'all');

        (first as { files: unknown[] }).files.length = 0;
        expect(await transport.getGitChanges(FIXTURE_PROJECT_ID, inWorktree, 'all')).toMatchObject({ fileCount: 6, files: expect.arrayContaining([expect.anything()]) });
    });

    it('refuses what the daemon refuses: an unknown project, folder, worktree or commit, a path that did not change, a file of a folder that is no repository', async () => {
        const transport = worktree();

        await expect(transport.getGitStatus('p-none', place)).rejects.toMatchObject({ status: 404 });
        await expect(transport.getGitStatus(FIXTURE_PROJECT_ID, { folderId: 'fld_none' })).rejects.toMatchObject({ status: 404 });
        await expect(transport.getGitStatus(FIXTURE_PROJECT_ID, { ...place, workspaceId: 'wks_none' })).rejects.toMatchObject({ status: 404 });
        await expect(transport.getGitChanges(FIXTURE_PROJECT_ID, inWorktree, 'commit:0123456789abcdef')).rejects.toMatchObject({ status: 404 });
        await expect(transport.getGitChanges(FIXTURE_PROJECT_ID, place, 'commit:0123456789abcdef')).rejects.toMatchObject({ status: 404 });
        await expect(transport.getGitFile(FIXTURE_PROJECT_ID, inWorktree, 'branch', 'notes.md')).rejects.toMatchObject({ status: 404 });
        await expect(transport.getGitFile(FIXTURE_PROJECT_ID, place, 'all', 'src/booking/price.ts')).rejects.toMatchObject({ status: 404 });

        const personal = (await transport.getRootSnapshot()).projects[0]!.folders[0]!;

        await expect(transport.getGitFile(FIXTURE_PERSONAL_PROJECT_ID, { folderId: personal.id }, 'all', 'a.ts')).rejects.toMatchObject({ status: 400 });
    });

    it('says a worktree that is not made yet is unavailable, as the daemon does', async () => {
        const data = withFixtureWorkspace(createFixtureData());

        data.chats.find(chat => chat.workspace)!.workspace!.ready = false;
        await expect(new FixtureTransport({ data }).getGitStatus(FIXTURE_PROJECT_ID, inWorktree)).rejects.toMatchObject({ status: 503 });
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

import { turnScope } from '@clowdy/protocol';
import { describe, expect, it, vi } from 'vitest';

import {
    createFixtureData,
    FIXTURE_EMPTY_PROJECT_ID,
    FIXTURE_GIT_COMMITS,
    FIXTURE_LAST_RUN_CHAT_ID,
    FIXTURE_PERSONAL_PROJECT_ID,
    FIXTURE_PROJECT_ID,
    FIXTURE_QUIET_CHAT_ID,
    FIXTURE_RUN_FILES,
    FIXTURE_RUN_SCOPE,
    FIXTURE_RUN_TREES,
    FIXTURE_WORKTREE_PATH,
    withFixtureLastRun,
    withFixtureWorkspace,
    withFixtureWorktrees,
} from './fixtureData';
import { FixtureTransport } from './fixtureTransport';
import { HttpTransport } from './httpTransport';

import type { ClowdyEvent, GitStatus } from '@clowdy/protocol';
import type { FixturePullRequestScript } from './fixtureData';
import type { FixtureGitWritesOptions } from './fixtureGitWrites';

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

    it("rejects with the daemon's own reason when it cannot read the folder, for the page to say why", async () => {
        const fetchImpl = (async () =>
            new Response(JSON.stringify({ error: { code: 'unavailable', message: 'git did not answer' } }), {
                status: 503,
            })) as unknown as typeof fetch;
        const transport = new HttpTransport({ url: 'http://127.0.0.1:4310', token: 't', fetch: fetchImpl });

        await expect(transport.getFolderGit('prj_a', 'fld_b')).rejects.toMatchObject({
            message: 'git did not answer',
            status: 503,
        });
    });

    it('rejects with the status when the daemon gives no reason', async () => {
        const fetchImpl = (async () => new Response('Bad gateway', { status: 502 })) as unknown as typeof fetch;
        const transport = new HttpTransport({ url: 'http://127.0.0.1:4310', token: 't', fetch: fetchImpl });

        await expect(transport.getFolderGit('prj_a', 'fld_b')).rejects.toMatchObject({
            message: expect.stringContaining('502'),
            status: 502,
        });
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

    it("asks for the status of a folder's own checkout, and of a worktree of it, both ids escaped", async () => {
        const { urls, transport } = transportFor({ isRepository: false });

        expect(await transport.getGitStatus('prj a', { folderId: 'fld/b' })).toEqual({ isRepository: false });
        await transport.getGitStatus('prj a', { folderId: 'fld/b', workspaceId: 'wks 1' });
        expect(urls).toEqual([
            'http://127.0.0.1:4310/v1/projects/prj%20a/git/status?folderId=fld%2Fb',
            'http://127.0.0.1:4310/v1/projects/prj%20a/git/status?folderId=fld%2Fb&workspaceId=wks+1',
        ]);
    });

    it("asks for the changes of a scope, a commit's scope included", async () => {
        const { urls, transport } = transportFor({
            isRepository: true,
            scope: 'branch',
            files: [],
            fileCount: 0,
            additions: 0,
            deletions: 0,
            statsComplete: true,
        });

        expect(
            await transport.getGitChanges('prj_a', { folderId: 'fld_b', workspaceId: 'wks_c' }, 'branch')
        ).toMatchObject({ scope: 'branch', fileCount: 0 });
        await transport.getGitChanges('prj_a', { folderId: 'fld_b' }, 'commit:abc1234');
        expect(urls).toEqual([
            'http://127.0.0.1:4310/v1/projects/prj_a/git/changes?folderId=fld_b&workspaceId=wks_c&scope=branch',
            'http://127.0.0.1:4310/v1/projects/prj_a/git/changes?folderId=fld_b&scope=commit%3Aabc1234',
        ]);
    });

    it("asks for the changes of what a run did by the two trees of its scope, which are no part of the daemon's own words for a scope and go through as they are", async () => {
        const scope = turnScope('a'.repeat(40), 'b'.repeat(40));
        const { urls, transport } = transportFor({
            isRepository: true,
            scope,
            files: [],
            fileCount: 0,
            additions: 0,
            deletions: 0,
            statsComplete: true,
        });

        expect(
            await transport.getGitChanges('prj_a', { folderId: 'fld_b', workspaceId: 'wks_c' }, scope)
        ).toMatchObject({ scope, fileCount: 0 });
        await transport.getGitFile('prj_a', { folderId: 'fld_b' }, scope, 'src/a.ts');
        expect(urls).toEqual([
            `http://127.0.0.1:4310/v1/projects/prj_a/git/changes?folderId=fld_b&workspaceId=wks_c&scope=turn%3A${'a'.repeat(40)}%3A${'b'.repeat(40)}`,
            `http://127.0.0.1:4310/v1/projects/prj_a/git/file?folderId=fld_b&scope=turn%3A${'a'.repeat(40)}%3A${'b'.repeat(40)}&path=src%2Fa.ts`,
        ]);
    });

    it("says a run whose trees git has pruned is unavailable, with the daemon's status", async () => {
        const { transport } = transportFor(
            { error: { code: 'unavailable', message: 'The changes of that run are no longer in the repository' } },
            503
        );

        await expect(
            transport.getGitChanges('prj_a', { folderId: 'fld_b' }, turnScope('a'.repeat(40), 'b'.repeat(40)))
        ).rejects.toMatchObject({ status: 503 });
    });

    it('asks for the two sides of a file by its path, and by its old path when it was renamed', async () => {
        const { urls, transport } = transportFor({ state: 'text', original: 'a\n', modified: 'b\n', revision: 'r' });

        expect(await transport.getGitFile('prj_a', { folderId: 'fld_b' }, 'all', 'src/a b.ts')).toEqual({
            state: 'text',
            original: 'a\n',
            modified: 'b\n',
            revision: 'r',
        });
        await transport.getGitFile(
            'prj_a',
            { folderId: 'fld_b', workspaceId: 'wks_c' },
            'uncommitted',
            'new.ts',
            'old.ts'
        );
        expect(urls).toEqual([
            'http://127.0.0.1:4310/v1/projects/prj_a/git/file?folderId=fld_b&scope=all&path=src%2Fa+b.ts',
            'http://127.0.0.1:4310/v1/projects/prj_a/git/file?folderId=fld_b&workspaceId=wks_c&scope=uncommitted&path=new.ts&oldPath=old.ts',
        ]);
    });

    it('sends the start of the list a file belongs to, with or without an old path', async () => {
        const { urls, transport } = transportFor({ state: 'binary', revision: 'r' });

        await transport.getGitFile('prj_a', { folderId: 'fld_b' }, 'all', 'a.ts', undefined, 'abc1234');
        await transport.getGitFile(
            'prj_a',
            { folderId: 'fld_b', workspaceId: 'wks_c' },
            'branch',
            'new.ts',
            'old.ts',
            'abc1234'
        );
        expect(urls).toEqual([
            'http://127.0.0.1:4310/v1/projects/prj_a/git/file?folderId=fld_b&scope=all&path=a.ts&from=abc1234',
            'http://127.0.0.1:4310/v1/projects/prj_a/git/file?folderId=fld_b&workspaceId=wks_c&scope=branch&path=new.ts&oldPath=old.ts&from=abc1234',
        ]);
    });

    it("asks for the pull request of a place, a worktree of its folder included, and gives the daemon's answer", async () => {
        const answer = {
            isRepository: true,
            access: 'ready',
            repo: { host: 'github.com', owner: 'acme', name: 'app' },
        };
        const { urls, transport } = transportFor(answer);

        expect(await transport.getGitPullRequest('prj a', { folderId: 'fld/b' })).toEqual(answer);
        await transport.getGitPullRequest('prj a', { folderId: 'fld/b', workspaceId: 'wks 1' });
        expect(urls).toEqual([
            'http://127.0.0.1:4310/v1/projects/prj%20a/git/pull-request?folderId=fld%2Fb',
            'http://127.0.0.1:4310/v1/projects/prj%20a/git/pull-request?folderId=fld%2Fb&workspaceId=wks+1',
        ]);
    });

    it("rejects with the daemon's own reason and status, for the strip to say why, and with the status when it gives none", async () => {
        const gone = transportFor(
            { error: { code: 'unavailable', message: 'The worktree /w/app is missing' } },
            503
        ).transport;

        await expect(gone.getGitStatus('prj_a', { folderId: 'fld_b', workspaceId: 'wks_c' })).rejects.toMatchObject({
            message: 'The worktree /w/app is missing',
            status: 503,
        });
        await expect(gone.getGitChanges('prj_a', { folderId: 'fld_b' }, 'all')).rejects.toMatchObject({ status: 503 });
        await expect(gone.getGitFile('prj_a', { folderId: 'fld_b' }, 'all', 'a.ts')).rejects.toMatchObject({
            status: 503,
        });
        await expect(gone.getGitPullRequest('prj_a', { folderId: 'fld_b' })).rejects.toMatchObject({
            message: 'The worktree /w/app is missing',
            status: 503,
        });

        const bare = new HttpTransport({
            url: 'http://127.0.0.1:4310',
            token: 't',
            fetch: (async () => new Response('Bad gateway', { status: 502 })) as unknown as typeof fetch,
        });

        await expect(bare.getGitStatus('prj_a', { folderId: 'fld_b' })).rejects.toMatchObject({
            message: expect.stringContaining('502'),
            status: 502,
        });
        await expect(bare.getGitPullRequest('prj_a', { folderId: 'fld_b' })).rejects.toMatchObject({
            message: expect.stringContaining('502'),
            status: 502,
        });
    });
});

describe('HttpTransport viewed marks', () => {
    /** A transport whose daemon answers `body` with `status`, and what it was asked: the method, the url and the body of each request. */
    function transportFor(body: unknown, status = 200) {
        const requests: Array<{ method: string; url: string; body?: unknown; headers: Record<string, string> }> = [];
        const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
            requests.push({
                method: init?.method ?? 'GET',
                url: String(input),
                ...(typeof init?.body === 'string' && { body: JSON.parse(init.body) }),
                headers: init?.headers as Record<string, string>,
            });

            return new Response(JSON.stringify(body), { status });
        }) as typeof fetch;

        return {
            requests,
            transport: new HttpTransport({ url: 'http://127.0.0.1:4310', token: 't', fetch: fetchImpl }),
        };
    }

    it("asks for the marks of a scope of a place, and gives the daemon's list", async () => {
        const marks = [{ path: 'src/a b.ts', revision: '100644:aa:100644:bb' }];
        const { requests, transport } = transportFor(marks);

        expect(await transport.getGitViewed('prj a', { folderId: 'fld/b' }, 'branch')).toEqual(marks);
        await transport.getGitViewed('prj a', { folderId: 'fld/b', workspaceId: 'wks 1' }, 'commit:abc1234');
        expect(requests.map(request => `${request.method} ${request.url}`)).toEqual([
            'GET http://127.0.0.1:4310/v1/projects/prj%20a/git/viewed?folderId=fld%2Fb&scope=branch',
            'GET http://127.0.0.1:4310/v1/projects/prj%20a/git/viewed?folderId=fld%2Fb&workspaceId=wks+1&scope=commit%3Aabc1234',
        ]);
    });

    it('marks a file with a JSON body that names the place, the scope, the path and the revision, and gives what the daemon kept', async () => {
        const kept = { path: 'src/a.ts', revision: '100644:aa:100644:bb' };
        const { requests, transport } = transportFor(kept);

        expect(await transport.setGitViewed('prj_a', { folderId: 'fld_b' }, 'all', 'src/a.ts', kept.revision)).toEqual(
            kept
        );
        await transport.setGitViewed(
            'prj_a',
            { folderId: 'fld_b', workspaceId: 'wks_c' },
            'uncommitted',
            'src/a.ts',
            kept.revision
        );
        expect(requests.map(request => [request.method, request.url, request.body])).toEqual([
            [
                'POST',
                'http://127.0.0.1:4310/v1/projects/prj_a/git/viewed',
                { folderId: 'fld_b', scope: 'all', path: 'src/a.ts', revision: kept.revision },
            ],
            [
                'POST',
                'http://127.0.0.1:4310/v1/projects/prj_a/git/viewed',
                {
                    folderId: 'fld_b',
                    workspaceId: 'wks_c',
                    scope: 'uncommitted',
                    path: 'src/a.ts',
                    revision: kept.revision,
                },
            ],
        ]);
        expect(requests[0]!.headers).toMatchObject({ authorization: 'Bearer t', 'content-type': 'application/json' });
    });

    it("clears a file's mark with a DELETE that names the place, the scope and the path in its address", async () => {
        const { requests, transport } = transportFor({ ok: true });

        expect(
            await transport.clearGitViewed('prj_a', { folderId: 'fld_b', workspaceId: 'wks_c' }, 'all', 'src/a b.ts')
        ).toBeUndefined();
        expect(requests.map(request => `${request.method} ${request.url}`)).toEqual([
            'DELETE http://127.0.0.1:4310/v1/projects/prj_a/git/viewed?folderId=fld_b&workspaceId=wks_c&scope=all&path=src%2Fa+b.ts',
        ]);
        expect(requests[0]!.body).toBeUndefined();
    });

    it("rejects with the daemon's own reason and status, and with the status when it gives none", async () => {
        const refusing = transportFor(
            { error: { code: 'invalid', message: 'The folder is not the root of a git repository' } },
            400
        ).transport;
        const place = { folderId: 'fld_b' };

        await expect(refusing.getGitViewed('prj_a', place, 'all')).rejects.toMatchObject({
            message: 'The folder is not the root of a git repository',
            status: 400,
        });
        await expect(refusing.setGitViewed('prj_a', place, 'all', 'a.ts', 'r')).rejects.toMatchObject({
            message: 'The folder is not the root of a git repository',
            status: 400,
        });
        await expect(refusing.clearGitViewed('prj_a', place, 'all', 'a.ts')).rejects.toMatchObject({
            message: 'The folder is not the root of a git repository',
            status: 400,
        });

        const bare = new HttpTransport({
            url: 'http://127.0.0.1:4310',
            token: 't',
            fetch: (async () => new Response('Bad gateway', { status: 502 })) as unknown as typeof fetch,
        });

        await expect(bare.getGitViewed('prj_a', place, 'all')).rejects.toMatchObject({
            message: expect.stringContaining('502'),
            status: 502,
        });
        await expect(bare.setGitViewed('prj_a', place, 'all', 'a.ts', 'r')).rejects.toMatchObject({
            message: expect.stringContaining('502'),
            status: 502,
        });
        await expect(bare.clearGitViewed('prj_a', place, 'all', 'a.ts')).rejects.toMatchObject({
            message: expect.stringContaining('502'),
            status: 502,
        });
    });
});

describe('HttpTransport.getProjectWorktrees', () => {
    it("asks for one project, its id escaped, and gives the daemon's answer", async () => {
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
        const fetchImpl = (async () =>
            new Response(JSON.stringify({ error: { code: 'not_found', message: 'Project prj_x does not exist' } }), {
                status: 404,
            })) as unknown as typeof fetch;
        const transport = new HttpTransport({ url: 'http://127.0.0.1:4310', token: 't', fetch: fetchImpl });

        await expect(transport.getProjectWorktrees('prj_x')).rejects.toMatchObject({ status: 404 });
    });
});

describe('FixtureTransport.getProjectWorktrees', () => {
    it('lists a group per folder with its own checkout first, and no worktrees for a folder that is no repository', async () => {
        const transport = new FixtureTransport({ data: withFixtureWorktrees(createFixtureData()) });
        const groups = await transport.getProjectWorktrees(FIXTURE_PROJECT_ID);

        expect(groups.map(group => [group.name, group.isRepository])).toEqual([
            ['car-rental', true],
            ['car-rental-api', true],
            ['notes', false],
        ]);
        expect(groups[0].worktrees[0]).toMatchObject({
            path: '/Users/dev/car-rental',
            branch: 'main',
            main: true,
            changes: 0,
            blocked: 'main',
            chats: [],
        });
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
            chats: [
                { id: 'c-9', archived: false },
                { id: 'c-10', archived: true },
            ],
        });
        expect(byPath('/Users/dev/worktrees/car-rental/search-filters')).toMatchObject({
            managed: false,
            changes: 2,
            submodules: true,
            merged: false,
            chats: [],
        });
        expect(byPath('/Users/dev/worktrees/car-rental/search-filters')?.blocked).toBeUndefined();
        expect(byPath('/Users/dev/car-rental-hotfix')).toMatchObject({
            locked: 'on an external drive',
            blocked: 'locked',
        });
        expect(byPath('/Users/dev/car-rental-old')).toMatchObject({ missing: true, changes: 0 });
    });

    it('lists the worktrees of the fixture project that nobody works in with no chats, and refuses a project it does not have', async () => {
        const transport = new FixtureTransport();
        const [carRental] = await transport.getProjectWorktrees(FIXTURE_PROJECT_ID);

        expect(carRental.worktrees.find(worktree => worktree.path === FIXTURE_WORKTREE_PATH)).toMatchObject({
            chats: [],
            managed: true,
        });
        expect(carRental.worktrees.find(worktree => worktree.path === FIXTURE_WORKTREE_PATH)?.blocked).toBeUndefined();
        await expect(transport.getProjectWorktrees(FIXTURE_PERSONAL_PROJECT_ID)).resolves.toMatchObject([
            { isRepository: false, worktrees: [] },
        ]);
        await expect(transport.getProjectWorktrees('p-none')).rejects.toMatchObject({ status: 404 });
    });
});

describe('FixtureTransport workspace.remove', () => {
    const FOUND = '/Users/dev/worktrees/car-rental/search-filters';
    const LOCKED = '/Users/dev/car-rental-hotfix';
    const MISSING = '/Users/dev/car-rental-old';
    const remove = (
        transport: FixtureTransport,
        fields: { path: string; projectId?: string; folderId?: string; discard?: boolean; deleteBranch?: boolean }
    ) =>
        transport.command({
            type: 'workspace.remove',
            projectId: FIXTURE_PROJECT_ID,
            folderId: 'fld_car_rental',
            ...fields,
        });
    const paths = async (transport: FixtureTransport) =>
        (await transport.getProjectWorktrees(FIXTURE_PROJECT_ID))[0].worktrees.map(worktree => worktree.path);
    const gitOf = async (transport: FixtureTransport) => {
        const git = await transport.getFolderGit(FIXTURE_PROJECT_ID, 'fld_car_rental');

        if (!git.isRepository) throw new Error('Not a repository');

        return git;
    };
    const branches = async (transport: FixtureTransport) =>
        (await gitOf(transport)).branches.filter(branch => !branch.remote).map(branch => branch.name);

    it('takes a worktree out of the list and keeps its branch as a local one, or deletes the branch with deleteBranch', async () => {
        const transport = new FixtureTransport();

        expect(await paths(transport)).toContain(FOUND);
        expect(await branches(transport)).not.toContain('search-filters');

        // The tree is changed, which is the person's to say yes to.
        expect(await remove(transport, { path: FOUND })).toMatchObject({
            ok: false,
            error: { code: 'conflict', message: 'The worktree has changes that are not committed' },
        });
        expect(await paths(transport)).toContain(FOUND);

        expect(await remove(transport, { path: FOUND, discard: true })).toMatchObject({
            ok: true,
            data: { path: FOUND, branchDeleted: false },
        });
        expect(await paths(transport)).not.toContain(FOUND);
        expect(await branches(transport)).toContain('search-filters');
        expect((await gitOf(transport)).worktrees.map(worktree => worktree.path)).not.toContain(FOUND);

        // Gone from the disk: only its record, and the branch with it when asked.
        expect(await remove(transport, { path: MISSING, deleteBranch: true })).toMatchObject({
            ok: true,
            data: { path: MISSING, branchDeleted: true },
        });
        expect(await paths(transport)).not.toContain(MISSING);
        expect(await branches(transport)).not.toContain('old-pricing');
        // Nothing else went.
        expect(await paths(transport)).toEqual(['/Users/dev/car-rental', FIXTURE_WORKTREE_PATH, LOCKED]);
    });

    it('removes the worktree a chat was made for once no chat works in it, and the branch it was made on goes when it is asked to', async () => {
        const transport = new FixtureTransport();

        expect(
            await remove(transport, { path: FIXTURE_WORKTREE_PATH, discard: true, deleteBranch: true })
        ).toMatchObject({ ok: true, data: { branchDeleted: true } });
        expect(await paths(transport)).not.toContain(FIXTURE_WORKTREE_PATH);
        expect(await branches(transport)).not.toContain('clowdy/ab12cd34');
    });

    it('refuses what the daemon refuses, and removes nothing', async () => {
        const transport = new FixtureTransport({ data: withFixtureWorktrees(createFixtureData()) });
        const before = await paths(transport);

        expect(await remove(transport, { path: '/Users/dev/car-rental', discard: true })).toMatchObject({
            ok: false,
            error: { code: 'conflict', message: "That is the folder's own checkout" },
        });
        expect(await remove(transport, { path: LOCKED, discard: true })).toMatchObject({
            ok: false,
            error: { code: 'conflict', message: 'The worktree is locked' },
        });
        expect(await remove(transport, { path: FIXTURE_WORKTREE_PATH, discard: true })).toMatchObject({
            ok: false,
            error: {
                code: 'conflict',
                message: expect.stringContaining('works in this worktree') as unknown as string,
            },
        });
        expect(await remove(transport, { path: '/Users/dev/elsewhere' })).toMatchObject({
            ok: false,
            error: { code: 'conflict', message: 'Git does not list it as a worktree of the folder' },
        });
        expect(await remove(transport, { path: 'search-filters' })).toMatchObject({
            ok: false,
            error: { code: 'invalid' },
        });
        expect(await remove(transport, { path: FOUND, folderId: 'fld_none' })).toMatchObject({
            ok: false,
            error: { code: 'invalid' },
        });
        expect(await remove(transport, { path: FOUND, folderId: 'fld_notes' })).toMatchObject({
            ok: false,
            error: { code: 'invalid' },
        });
        expect(await remove(transport, { path: FOUND, projectId: 'p-none' })).toMatchObject({
            ok: false,
            error: { code: 'not_found' },
        });
        expect(await paths(transport)).toEqual(before);
    });

    it('takes the row workspace.open answered for the worktree with it, and a chat can no longer be made there', async () => {
        const transport = new FixtureTransport();
        const opened = await transport.command({
            type: 'workspace.open',
            projectId: FIXTURE_PROJECT_ID,
            path: FIXTURE_WORKTREE_PATH,
        });

        expect(opened.ok).toBe(true);
        expect(await remove(transport, { path: FIXTURE_WORKTREE_PATH, discard: true })).toMatchObject({ ok: true });
        expect(
            await transport.command({
                type: 'workspace.open',
                projectId: FIXTURE_PROJECT_ID,
                path: FIXTURE_WORKTREE_PATH,
            })
        ).toMatchObject({ ok: false, error: { code: 'invalid' } });
        expect(
            await transport.command({
                type: 'chat.create',
                projectId: FIXTURE_PROJECT_ID,
                workspace: { mode: 'existing', path: FIXTURE_WORKTREE_PATH },
            })
        ).toMatchObject({ ok: false, error: { code: 'invalid' } });
    });
});

describe('HttpTransport.getChatWorkspaceRemoval', () => {
    it("asks for one chat, its id escaped, and gives the daemon's answer", async () => {
        const urls: string[] = [];
        const fetchImpl = (async (input: RequestInfo | URL) => {
            urls.push(String(input));

            return new Response(
                JSON.stringify({ removable: true, path: '/w/ab12cd34/app', branch: 'clowdy/ab12cd34' }),
                { status: 200 }
            );
        }) as typeof fetch;
        const transport = new HttpTransport({ url: 'http://127.0.0.1:4310', token: 't', fetch: fetchImpl });

        expect(await transport.getChatWorkspaceRemoval('cht a/b')).toEqual({
            removable: true,
            path: '/w/ab12cd34/app',
            branch: 'clowdy/ab12cd34',
        });
        expect(urls).toEqual(['http://127.0.0.1:4310/v1/chats/cht%20a%2Fb/workspace']);
    });

    it('rejects with the status for a chat the daemon does not have', async () => {
        const fetchImpl = (async () =>
            new Response(JSON.stringify({ error: { code: 'not_found', message: 'Chat cht_x does not exist' } }), {
                status: 404,
            })) as unknown as typeof fetch;
        const transport = new HttpTransport({ url: 'http://127.0.0.1:4310', token: 't', fetch: fetchImpl });

        await expect(transport.getChatWorkspaceRemoval('cht_x')).rejects.toMatchObject({ status: 404 });
    });
});

describe('FixtureTransport.getFolderGit', () => {
    it('answers the branches and worktrees of a repository, and that a folder git knows nothing of is none', async () => {
        const transport = new FixtureTransport();
        const { projects } = await transport.getRootSnapshot();
        const [personal, carRental] = [
            projects[0].folders[0],
            projects.find(project => project.id === FIXTURE_PROJECT_ID)!.folders[0],
        ];

        expect(await transport.getFolderGit(FIXTURE_PROJECT_ID, carRental.id)).toMatchObject({
            isRepository: true,
            branch: 'main',
            defaultBranch: 'origin/main',
            branches: expect.arrayContaining([
                { name: 'main', remote: false },
                { name: 'origin/main', remote: true },
            ]),
            worktrees: [
                { path: carRental.path, branch: 'main', main: true, dirty: false },
                { branch: 'clowdy/ab12cd34', main: false, dirty: true },
            ],
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

    it("says the folder's own checkout is clean and level with its base, and that a folder git knows nothing of is none", async () => {
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
        expect(await transport.getGitChanges(FIXTURE_PROJECT_ID, place, 'all')).toMatchObject({
            isRepository: true,
            baseState: 'ready',
            files: [],
            fileCount: 0,
            statsComplete: true,
        });

        const [personal] = (await transport.getRootSnapshot()).projects[0]!.folders;

        expect(await transport.getGitStatus(FIXTURE_PERSONAL_PROJECT_ID, { folderId: personal!.id })).toEqual({
            isRepository: false,
        });
        expect(await transport.getGitChanges(FIXTURE_PERSONAL_PROJECT_ID, { folderId: personal!.id }, 'all')).toEqual({
            isRepository: false,
        });
    });

    it("says a chat's worktree is dirty and ahead of its base, with the commits it made", async () => {
        const status = await worktree().getGitStatus(FIXTURE_PROJECT_ID, inWorktree);

        expect(status).toMatchObject({
            isRepository: true,
            head: { kind: 'branch', name: 'clowdy/ab12cd34' },
            entries: [
                { path: 'notes.md', untracked: true },
                { path: 'src/booking/price.ts', unstaged: 'modified' },
                { path: 'src/limits.ts', unstaged: 'modified' },
            ],
            base: { state: 'ready', name: 'origin/main', ahead: 2, behind: 1, commits: FIXTURE_GIT_COMMITS },
        });
        expect((status as { upstream?: unknown }).upstream).toBeUndefined();
    });

    it("lists the files of each scope with their numbers, and one commit's by its hash, a short one too", async () => {
        const transport = worktree();
        const committed = await transport.getGitChanges(FIXTURE_PROJECT_ID, inWorktree, 'branch');
        const uncommitted = await transport.getGitChanges(FIXTURE_PROJECT_ID, inWorktree, 'uncommitted');
        const all = await transport.getGitChanges(FIXTURE_PROJECT_ID, inWorktree, 'all');
        const [newest, oldest] = FIXTURE_GIT_COMMITS;

        expect(committed).toMatchObject({
            isRepository: true,
            scope: 'branch',
            baseState: 'ready',
            fileCount: 4,
            additions: 23 + 42 + 37,
            deletions: 5,
        });
        expect(committed).toMatchObject({
            files: expect.arrayContaining([
                {
                    path: 'assets/logo.png',
                    kind: 'added',
                    binary: true,
                    revision: expect.stringMatching(/^000000:0+:100644:9+$/),
                },
            ]),
        });
        expect(uncommitted).toMatchObject({
            scope: 'uncommitted',
            fileCount: 3,
            additions: 3 + 6 + 1,
            deletions: 2 + 1,
        });
        expect((uncommitted as { baseState?: unknown }).baseState).toBeUndefined();
        expect(all).toMatchObject({ scope: 'all', fileCount: 6 });
        expect(
            (
                (await transport.getGitChanges(FIXTURE_PROJECT_ID, inWorktree, `commit:${newest!.sha}`)) as {
                    files: Array<{ path: string }>;
                }
            ).files.map(file => file.path)
        ).toEqual(['src/booking/price.ts', 'src/booking/weekend.ts']);
        expect(
            (
                (await transport.getGitChanges(
                    FIXTURE_PROJECT_ID,
                    inWorktree,
                    `commit:${oldest!.sha.slice(0, 7)}`
                )) as { fileCount: number }
            ).fileCount
        ).toBe(3);
    });

    it('reads the text of a file before and after, and nothing for a binary one', async () => {
        const transport = worktree();

        expect(await transport.getGitFile(FIXTURE_PROJECT_ID, inWorktree, 'all', 'src/booking/price.ts')).toMatchObject(
            {
                state: 'text',
                original: expect.stringContaining('days * rate'),
                modified: expect.stringContaining('weekend'),
            }
        );
        expect(await transport.getGitFile(FIXTURE_PROJECT_ID, inWorktree, 'uncommitted', 'notes.md')).toMatchObject({
            state: 'text',
            original: null,
        });
        expect(await transport.getGitFile(FIXTURE_PROJECT_ID, inWorktree, 'branch', 'assets/logo.png')).toEqual({
            state: 'binary',
            revision: expect.any(String),
        });
    });

    it("reads a file with the list's own start as it does without one, and judges the start as the daemon does", async () => {
        const transport = worktree();
        const { from } = (await transport.getGitChanges(FIXTURE_PROJECT_ID, inWorktree, 'all')) as { from: string };

        expect(
            await transport.getGitFile(FIXTURE_PROJECT_ID, inWorktree, 'all', 'src/booking/price.ts', undefined, from)
        ).toEqual(await transport.getGitFile(FIXTURE_PROJECT_ID, inWorktree, 'all', 'src/booking/price.ts'));
        expect(
            await transport.getGitFile(
                FIXTURE_PROJECT_ID,
                inWorktree,
                'all',
                'src/booking/price.ts',
                undefined,
                from.slice(0, 9)
            )
        ).toMatchObject({ state: 'text' });
        await expect(
            transport.getGitFile(FIXTURE_PROJECT_ID, inWorktree, 'all', 'src/booking/price.ts', undefined, 'main')
        ).rejects.toMatchObject({ status: 400 });
        await expect(
            transport.getGitFile(
                FIXTURE_PROJECT_ID,
                inWorktree,
                'all',
                'src/booking/price.ts',
                undefined,
                '0123456789abcdef'
            )
        ).rejects.toMatchObject({ status: 404 });
    });

    it('does not give the same object twice, so a caller that edits an answer does not change the next', async () => {
        const transport = worktree();
        const first = await transport.getGitChanges(FIXTURE_PROJECT_ID, inWorktree, 'all');

        (first as { files: unknown[] }).files.length = 0;
        expect(await transport.getGitChanges(FIXTURE_PROJECT_ID, inWorktree, 'all')).toMatchObject({
            fileCount: 6,
            files: expect.arrayContaining([expect.anything()]),
        });
    });

    it('refuses what the daemon refuses: an unknown project, folder, worktree or commit, a path that did not change, a file of a folder that is no repository', async () => {
        const transport = worktree();

        await expect(transport.getGitStatus('p-none', place)).rejects.toMatchObject({ status: 404 });
        await expect(transport.getGitStatus(FIXTURE_PROJECT_ID, { folderId: 'fld_none' })).rejects.toMatchObject({
            status: 404,
        });
        await expect(
            transport.getGitStatus(FIXTURE_PROJECT_ID, { ...place, workspaceId: 'wks_none' })
        ).rejects.toMatchObject({ status: 404 });
        await expect(
            transport.getGitChanges(FIXTURE_PROJECT_ID, inWorktree, 'commit:0123456789abcdef')
        ).rejects.toMatchObject({ status: 404 });
        await expect(
            transport.getGitChanges(FIXTURE_PROJECT_ID, place, 'commit:0123456789abcdef')
        ).rejects.toMatchObject({ status: 404 });
        await expect(transport.getGitFile(FIXTURE_PROJECT_ID, inWorktree, 'branch', 'notes.md')).rejects.toMatchObject({
            status: 404,
        });
        await expect(
            transport.getGitFile(FIXTURE_PROJECT_ID, place, 'all', 'src/booking/price.ts')
        ).rejects.toMatchObject({ status: 404 });

        const personal = (await transport.getRootSnapshot()).projects[0]!.folders[0]!;

        await expect(
            transport.getGitFile(FIXTURE_PERSONAL_PROJECT_ID, { folderId: personal.id }, 'all', 'a.ts')
        ).rejects.toMatchObject({ status: 400 });
    });

    it("lists what a run changed by its trees, with no start of its own and no base state, and its files' texts, and says the trees of any other run are pruned", async () => {
        const transport = new FixtureTransport({ data: withFixtureLastRun(withFixtureWorkspace(createFixtureData())) });
        const answer = await transport.getGitChanges(FIXTURE_PROJECT_ID, inWorktree, FIXTURE_RUN_SCOPE);

        expect(answer).toMatchObject({
            isRepository: true,
            scope: FIXTURE_RUN_SCOPE,
            fileCount: 7,
            additions: 178,
            deletions: 29,
            statsComplete: true,
        });
        expect(answer).not.toHaveProperty('from');
        expect(answer).not.toHaveProperty('baseState');
        expect((answer as { files: Array<{ path: string }> }).files.map(file => file.path)).toEqual(
            FIXTURE_RUN_FILES.map(file => file.path)
        );
        expect(
            await transport.getGitFile(FIXTURE_PROJECT_ID, inWorktree, FIXTURE_RUN_SCOPE, 'src/booking/price.ts')
        ).toMatchObject({
            state: 'text',
            original: expect.stringContaining('days * rate'),
            modified: expect.stringContaining('weekend'),
        });
        await expect(
            transport.getGitFile(FIXTURE_PROJECT_ID, inWorktree, FIXTURE_RUN_SCOPE, 'README.md')
        ).rejects.toMatchObject({ status: 404 });
        await expect(
            transport.getGitChanges(FIXTURE_PROJECT_ID, inWorktree, turnScope('c'.repeat(40), 'd'.repeat(40)))
        ).rejects.toMatchObject({ status: 503 });
        // The folder's own checkout has no run's trees either.
        await expect(transport.getGitChanges(FIXTURE_PROJECT_ID, place, FIXTURE_RUN_SCOPE)).rejects.toMatchObject({
            status: 503,
        });
    });

    it('has two chats that finished a turn in the worktree: one whose run changed seven files, and one whose run changed nothing', async () => {
        const data = withFixtureLastRun(withFixtureWorkspace(createFixtureData()));
        const chat = (id: string) => data.chats.find(candidate => candidate.id === id)!;

        expect(chat(FIXTURE_LAST_RUN_CHAT_ID).lastRun).toMatchObject({ ...FIXTURE_RUN_TREES, seq: 2 });
        expect(chat(FIXTURE_QUIET_CHAT_ID)).not.toHaveProperty('lastRun');
        expect(chat(FIXTURE_LAST_RUN_CHAT_ID).workspace).toEqual(chat(FIXTURE_QUIET_CHAT_ID).workspace);
        expect(
            data.runs
                .filter(run => run.chatId === FIXTURE_LAST_RUN_CHAT_ID || run.chatId === FIXTURE_QUIET_CHAT_ID)
                .map(run => run.status)
        ).toEqual(['succeeded', 'succeeded']);
    });

    it('says a worktree that is not made yet is unavailable, as the daemon does', async () => {
        const data = withFixtureWorkspace(createFixtureData());

        data.chats.find(chat => chat.workspace)!.workspace!.ready = false;
        await expect(new FixtureTransport({ data }).getGitStatus(FIXTURE_PROJECT_ID, inWorktree)).rejects.toMatchObject(
            { status: 503 }
        );
    });
});

describe('FixtureTransport viewed marks', () => {
    const place = { folderId: 'fld_car_rental' };
    const worktree = () => new FixtureTransport({ data: withFixtureWorkspace(createFixtureData()) });
    const inWorktree = { ...place, workspaceId: 'wks_ab12cd34' };

    it('keeps a mark for the session under its place and scope, replaces it, lists it in path order and clears it', async () => {
        const transport = worktree();

        expect(await transport.getGitViewed(FIXTURE_PROJECT_ID, inWorktree, 'all')).toEqual([]);
        expect(
            await transport.setGitViewed(FIXTURE_PROJECT_ID, inWorktree, 'all', 'src/limits.ts', '100644:aa:100644:bb')
        ).toEqual({ path: 'src/limits.ts', revision: '100644:aa:100644:bb' });
        await transport.setGitViewed(FIXTURE_PROJECT_ID, inWorktree, 'all', 'notes.md', 'r-notes');
        await transport.setGitViewed(FIXTURE_PROJECT_ID, inWorktree, 'all', 'src/limits.ts', '100644:aa:100644:cc');
        expect(await transport.getGitViewed(FIXTURE_PROJECT_ID, inWorktree, 'all')).toEqual([
            { path: 'notes.md', revision: 'r-notes' },
            { path: 'src/limits.ts', revision: '100644:aa:100644:cc' },
        ]);

        await transport.clearGitViewed(FIXTURE_PROJECT_ID, inWorktree, 'all', 'notes.md');
        await transport.clearGitViewed(FIXTURE_PROJECT_ID, inWorktree, 'all', 'never-marked.ts');
        expect(await transport.getGitViewed(FIXTURE_PROJECT_ID, inWorktree, 'all')).toEqual([
            { path: 'src/limits.ts', revision: '100644:aa:100644:cc' },
        ]);
    });

    it('keeps the marks of another scope, another place and another transport apart', async () => {
        const transport = worktree();
        const [newest] = FIXTURE_GIT_COMMITS;

        await transport.setGitViewed(FIXTURE_PROJECT_ID, inWorktree, 'all', 'src/limits.ts', 'r-all');
        await transport.setGitViewed(FIXTURE_PROJECT_ID, inWorktree, 'uncommitted', 'src/limits.ts', 'r-uncommitted');
        await transport.setGitViewed(FIXTURE_PROJECT_ID, place, 'all', 'src/limits.ts', 'r-checkout');
        await transport.setGitViewed(
            FIXTURE_PROJECT_ID,
            inWorktree,
            `commit:${newest!.sha}`,
            'src/booking/price.ts',
            'r-commit'
        );

        expect(await transport.getGitViewed(FIXTURE_PROJECT_ID, inWorktree, 'all')).toEqual([
            { path: 'src/limits.ts', revision: 'r-all' },
        ]);
        expect(await transport.getGitViewed(FIXTURE_PROJECT_ID, inWorktree, 'uncommitted')).toEqual([
            { path: 'src/limits.ts', revision: 'r-uncommitted' },
        ]);
        expect(await transport.getGitViewed(FIXTURE_PROJECT_ID, place, 'all')).toEqual([
            { path: 'src/limits.ts', revision: 'r-checkout' },
        ]);
        expect(await transport.getGitViewed(FIXTURE_PROJECT_ID, inWorktree, 'branch')).toEqual([]);
        expect(await transport.getGitViewed(FIXTURE_PROJECT_ID, inWorktree, `commit:${newest!.sha}`)).toEqual([
            { path: 'src/booking/price.ts', revision: 'r-commit' },
        ]);
        expect(await worktree().getGitViewed(FIXTURE_PROJECT_ID, inWorktree, 'all')).toEqual([]);
    });

    it('does not give the same object twice, so a caller that edits an answer does not change the next', async () => {
        const transport = worktree();

        await transport.setGitViewed(FIXTURE_PROJECT_ID, inWorktree, 'all', 'notes.md', 'r');
        (await transport.getGitViewed(FIXTURE_PROJECT_ID, inWorktree, 'all'))[0]!.revision = 'changed';
        expect(await transport.getGitViewed(FIXTURE_PROJECT_ID, inWorktree, 'all')).toEqual([
            { path: 'notes.md', revision: 'r' },
        ]);
    });

    it('refuses what the daemon refuses: a path or a revision that cannot be one, a commit it does not have, an unknown project, folder or worktree, a folder that is no repository', async () => {
        const transport = worktree();

        for (const path of ['', '/etc/passwd', '../a.ts', 'a//b', 'dir/', 'x'.repeat(5000)]) {
            await expect(
                transport.setGitViewed(FIXTURE_PROJECT_ID, inWorktree, 'all', path, 'r')
            ).rejects.toMatchObject({ status: 400 });
            await expect(transport.clearGitViewed(FIXTURE_PROJECT_ID, inWorktree, 'all', path)).rejects.toMatchObject({
                status: 400,
            });
        }

        for (const revision of ['', 'ABC', 'a b', 'a'.repeat(257)]) {
            await expect(
                transport.setGitViewed(FIXTURE_PROJECT_ID, inWorktree, 'all', 'a.ts', revision)
            ).rejects.toMatchObject({ status: 400 });
        }

        await expect(
            transport.getGitViewed(FIXTURE_PROJECT_ID, inWorktree, 'commit:0123456789abcdef')
        ).rejects.toMatchObject({ status: 404 });
        await expect(
            transport.setGitViewed(FIXTURE_PROJECT_ID, inWorktree, 'commit:0123456789abcdef', 'a.ts', 'r')
        ).rejects.toMatchObject({ status: 404 });
        await expect(transport.getGitViewed('p-none', place, 'all')).rejects.toMatchObject({ status: 404 });
        await expect(transport.getGitViewed(FIXTURE_PROJECT_ID, { folderId: 'fld_none' }, 'all')).rejects.toMatchObject(
            { status: 404 }
        );
        await expect(
            transport.getGitViewed(FIXTURE_PROJECT_ID, { ...place, workspaceId: 'wks_none' }, 'all')
        ).rejects.toMatchObject({ status: 404 });

        const personal = (await transport.getRootSnapshot()).projects[0]!.folders[0]!;

        await expect(
            transport.getGitViewed(FIXTURE_PERSONAL_PROJECT_ID, { folderId: personal.id }, 'all')
        ).rejects.toMatchObject({ status: 400 });
        await expect(
            transport.setGitViewed(FIXTURE_PERSONAL_PROJECT_ID, { folderId: personal.id }, 'all', 'a.ts', 'r')
        ).rejects.toMatchObject({ status: 400 });
    });
});

describe('FixtureTransport pull request reads', () => {
    const place = { folderId: 'fld_car_rental' };
    const inWorktree = { ...place, workspaceId: 'wks_ab12cd34' };
    const worktree = () => new FixtureTransport({ data: withFixtureWorkspace(createFixtureData()) });
    const repo = { host: 'github.com', owner: 'acme', name: 'car-rental' };

    /** A fixture whose Car Rental checkout is scripted as `script`. */
    function scripted(script: FixturePullRequestScript) {
        const data = createFixtureData();

        data.pullRequests['/Users/dev/car-rental'] = { checkout: script };

        return new FixtureTransport({ data });
    }

    it('says the checkout on the default branch has no pull request, with gh ready', async () => {
        expect(await new FixtureTransport().getGitPullRequest(FIXTURE_PROJECT_ID, place)).toEqual({
            isRepository: true,
            access: 'ready',
            repo,
        });
    });

    it("gives a chat's worktree an open pull request with counts for every check state", async () => {
        const info = await worktree().getGitPullRequest(FIXTURE_PROJECT_ID, inWorktree);

        expect(info).toMatchObject({
            isRepository: true,
            access: 'ready',
            repo,
            pullRequest: {
                number: 128,
                state: 'open',
                url: 'https://github.com/acme/car-rental/pull/128',
                base: 'main',
                head: 'clowdy/ab12cd34',
                headCommit: FIXTURE_GIT_COMMITS[0]!.sha,
                reviewDecision: 'review_required',
                mergeability: 'blocked',
                checks: { state: 'failing', passing: 3, failing: 1, pending: 2, skipped: 1 },
            },
        });
    });

    it("scripts the other places: a merged pull request on Clowdy's branch, a draft on the API's, and a closed one on request", async () => {
        const transport = new FixtureTransport();

        expect(await transport.getGitPullRequest(FIXTURE_EMPTY_PROJECT_ID, { folderId: 'fld_clowdy' })).toMatchObject({
            access: 'ready',
            repo: { host: 'github.com', owner: 'acme', name: 'clowdy' },
            pullRequest: {
                number: 31,
                state: 'merged',
                head: 'next',
                checks: { state: 'passing', failing: 0, pending: 0 },
            },
        });
        expect(
            ((await scripted('draft').getGitPullRequest(FIXTURE_PROJECT_ID, place)) as { pullRequest: unknown })
                .pullRequest
        ).toMatchObject({ number: 54, state: 'draft', head: 'main', checks: { state: 'pending', pending: 1 } });
        expect(
            ((await scripted('closed').getGitPullRequest(FIXTURE_PROJECT_ID, place)) as { pullRequest: unknown })
                .pullRequest
        ).toMatchObject({ number: 19, state: 'closed', checks: { state: 'failing' } });
        expect(
            (
                (await scripted('merged').getGitPullRequest(FIXTURE_PROJECT_ID, place)) as {
                    pullRequest: { mergeability?: unknown };
                }
            ).pullRequest.mergeability
        ).toBeUndefined();
    });

    it('says what a machine without gh, one not signed in, and a folder with no remote look like, and that a folder that is no repository is none', async () => {
        expect(await scripted('no_gh').getGitPullRequest(FIXTURE_PROJECT_ID, place)).toEqual({
            isRepository: true,
            access: 'no_gh',
            repo,
        });
        expect(await scripted('not_signed_in').getGitPullRequest(FIXTURE_PROJECT_ID, place)).toEqual({
            isRepository: true,
            access: 'not_signed_in',
            repo,
        });
        expect(await scripted('no_remote').getGitPullRequest(FIXTURE_PROJECT_ID, place)).toEqual({
            isRepository: true,
            access: 'no_remote',
        });

        const transport = new FixtureTransport();
        const [personal] = (await transport.getRootSnapshot()).projects[0]!.folders;

        expect(await transport.getGitPullRequest(FIXTURE_PERSONAL_PROJECT_ID, { folderId: personal!.id })).toEqual({
            isRepository: false,
        });
    });

    it('rejects as the daemon does when gh cannot read, with its reason and 503', async () => {
        await expect(scripted('unavailable').getGitPullRequest(FIXTURE_PROJECT_ID, place)).rejects.toMatchObject({
            message: "GitHub didn't answer",
            status: 503,
        });
    });

    it('refuses what the daemon refuses: an unknown project, folder or worktree, and a worktree that is not made yet', async () => {
        const transport = worktree();

        await expect(transport.getGitPullRequest('p-none', place)).rejects.toMatchObject({ status: 404 });
        await expect(transport.getGitPullRequest(FIXTURE_PROJECT_ID, { folderId: 'fld_none' })).rejects.toMatchObject({
            status: 404,
        });
        await expect(
            transport.getGitPullRequest(FIXTURE_PROJECT_ID, { ...place, workspaceId: 'wks_none' })
        ).rejects.toMatchObject({ status: 404 });

        const data = withFixtureWorkspace(createFixtureData());

        data.chats.find(chat => chat.workspace)!.workspace!.ready = false;
        await expect(
            new FixtureTransport({ data }).getGitPullRequest(FIXTURE_PROJECT_ID, inWorktree)
        ).rejects.toMatchObject({ status: 503 });
    });

    it('does not give the same object twice, so a caller that edits an answer does not change the next', async () => {
        const transport = worktree();
        const first = await transport.getGitPullRequest(FIXTURE_PROJECT_ID, inWorktree);

        if (!first.isRepository || !first.pullRequest) throw new Error('Expected the worktree pull request');

        first.pullRequest.checks.passing = 0;
        expect(await transport.getGitPullRequest(FIXTURE_PROJECT_ID, inWorktree)).toMatchObject({
            pullRequest: { checks: { passing: 3 } },
        });
    });
});

async function connected() {
    const transport = new FixtureTransport();
    const { cursor } = await transport.getRootSnapshot();
    const events: ClowdyEvent[] = [];

    transport.subscribe(
        cursor,
        event => events.push(event),
        () => undefined
    );

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

        expect(info.map(entry => entry.projectId)).toEqual([
            FIXTURE_PERSONAL_PROJECT_ID,
            FIXTURE_PROJECT_ID,
            FIXTURE_EMPTY_PROJECT_ID,
        ]);
        expect(info[0]).toMatchObject({
            folders: [{ folderId: 'fld_personal', exists: true }],
            chats: 0,
            tasks: 0,
            activeRuns: 0,
        });
        expect(info[0].folders[0].remoteUrl).toBeUndefined();
        expect(info[1].folders).toEqual([
            {
                folderId: 'fld_car_rental',
                exists: true,
                remoteUrl: 'git@github.com:acme/car-rental.git',
                branch: 'main',
                chats: 0,
            },
        ]);
        expect(info[1].chats).toBeGreaterThan(0);
        expect(info[1].activeRuns).toBeGreaterThan(0);
    });

    it('reads one project alone when it is asked for', async () => {
        const info = await new FixtureTransport().getProjectsInfo(FIXTURE_PROJECT_ID);

        expect(info.map(entry => entry.projectId)).toEqual([FIXTURE_PROJECT_ID]);
    });

    it('refuses to rename the personal space or give it other folders, and takes its settings', async () => {
        const { transport } = await connected();

        expect(
            await transport.command({ type: 'project.update', projectId: FIXTURE_PERSONAL_PROJECT_ID, name: 'Mine' })
        ).toMatchObject({ ok: false, error: { code: 'conflict' } });
        expect(
            await transport.command({
                type: 'project.update',
                projectId: FIXTURE_PERSONAL_PROJECT_ID,
                folders: [{ path: '/elsewhere' }],
            })
        ).toMatchObject({ ok: false, error: { code: 'conflict' } });
        expect(
            await transport.command({
                type: 'project.update',
                projectId: FIXTURE_PERSONAL_PROJECT_ID,
                settings: { chatMode: 'semi' },
            })
        ).toMatchObject({ ok: true, data: { project: { settings: { chatMode: 'semi' } } } });
    });

    it('clears a setting set to null and keeps the others', async () => {
        const { transport } = await connected();
        const result = await transport.command({
            type: 'project.update',
            projectId: FIXTURE_PROJECT_ID,
            settings: { engine: null },
        });

        expect(result).toMatchObject({
            ok: true,
            data: { project: { settings: { maxParallelRuns: 4, targetBranch: 'main' } } },
        });
        expect((result as { data: { project: { settings: object } } }).data.project.settings).not.toHaveProperty(
            'engine'
        );
    });

    it('sets the settings of one folder, clears a field set to null, announces the project, and leaves the other folders and projects alone', async () => {
        const { transport, events } = await connected();
        const settings = { baseBranch: 'origin/dev', setup: { files: ['.env', '.env*'], command: 'bun install' } };
        const sharing = await transport.command({
            type: 'project.update',
            projectId: FIXTURE_EMPTY_PROJECT_ID,
            folders: [{ id: 'fld_clowdy' }, { path: '/Users/dev/car-rental' }],
        });

        expect(sharing).toMatchObject({ ok: true });

        const set = await transport.command({
            type: 'project.updateFolder',
            projectId: FIXTURE_PROJECT_ID,
            folderId: 'fld_car_rental',
            settings,
        });

        expect(set).toMatchObject({
            ok: true,
            data: { project: { id: FIXTURE_PROJECT_ID, folders: [{ id: 'fld_car_rental', settings }] } },
        });
        expect(
            events.filter(event => event.data.type === 'project.upserted' && event.projectId === FIXTURE_PROJECT_ID)
        ).toHaveLength(1);

        // The same path in another project has its own settings.
        const { projects } = await transport.getRootSnapshot();

        expect(
            projects.find(project => project.id === FIXTURE_EMPTY_PROJECT_ID)!.folders.map(folder => folder.settings)
        ).toEqual([undefined, undefined]);

        await transport.command({
            type: 'project.updateFolder',
            projectId: FIXTURE_PROJECT_ID,
            folderId: 'fld_car_rental',
            settings: { baseBranch: null },
        });

        const cleared = await transport.command({
            type: 'project.updateFolder',
            projectId: FIXTURE_PROJECT_ID,
            folderId: 'fld_car_rental',
            settings: { setup: null },
        });
        const folder = (cleared as { data: { project: { folders: object[] } } }).data.project.folders[0]!;

        expect(folder).not.toHaveProperty('settings');
    });

    it("keeps a folder's settings through a project update that reorders or renames, and the folder's base branch answers as its default", async () => {
        const { transport } = await connected();
        const settings = { baseBranch: 'dev' };

        await transport.command({
            type: 'project.update',
            projectId: FIXTURE_PROJECT_ID,
            folders: [{ id: 'fld_car_rental' }, { path: '/Users/dev/api' }, { path: '/Users/dev/notes' }],
        });
        await transport.command({
            type: 'project.updateFolder',
            projectId: FIXTURE_PROJECT_ID,
            folderId: 'fld_car_rental',
            settings,
        });

        const reordered = await transport.command({
            type: 'project.update',
            projectId: FIXTURE_PROJECT_ID,
            name: 'Rental',
            folders: [{ id: 'fld_car_rental' }, { path: '/Users/dev/notes' }, { path: '/Users/dev/api' }],
        });

        expect(reordered).toMatchObject({
            ok: true,
            data: {
                project: {
                    name: 'Rental',
                    folders: [
                        { id: 'fld_car_rental', settings },
                        { path: '/Users/dev/notes' },
                        { path: '/Users/dev/api' },
                    ],
                },
            },
        });
        expect(await transport.getFolderGit(FIXTURE_PROJECT_ID, 'fld_car_rental')).toMatchObject({
            defaultBranch: 'dev',
        });

        // A base branch the repository does not have is skipped.
        await transport.command({
            type: 'project.updateFolder',
            projectId: FIXTURE_PROJECT_ID,
            folderId: 'fld_car_rental',
            settings: { baseBranch: 'nope' },
        });
        expect(await transport.getFolderGit(FIXTURE_PROJECT_ID, 'fld_car_rental')).toMatchObject({
            defaultBranch: 'origin/main',
        });
    });

    it('refuses settings for the personal space, a folder the project does not have, a project that is not there, and a file outside the folder', async () => {
        const { transport } = await connected();
        const update = (projectId: string, folderId: string, settings: object) =>
            transport.command({ type: 'project.updateFolder', projectId, folderId, settings });

        expect(await update(FIXTURE_PERSONAL_PROJECT_ID, 'fld_personal', { baseBranch: 'main' })).toMatchObject({
            ok: false,
            error: { code: 'conflict' },
        });
        expect(await update(FIXTURE_PROJECT_ID, 'fld_clowdy', { baseBranch: 'main' })).toMatchObject({
            ok: false,
            error: { code: 'not_found' },
        });
        expect(await update('p-none', 'fld_car_rental', { baseBranch: 'main' })).toMatchObject({
            ok: false,
            error: { code: 'not_found' },
        });
        expect(await update(FIXTURE_PROJECT_ID, 'fld_car_rental', { setup: { files: ['../x'] } })).toMatchObject({
            ok: false,
            error: { code: 'invalid' },
        });
        expect(await update(FIXTURE_PROJECT_ID, 'fld_car_rental', { baseBranch: ' ' })).toMatchObject({
            ok: false,
            error: { code: 'invalid' },
        });
    });

    it('takes a new main folder only when nothing runs, adds others at any time, and lets two projects share a folder', async () => {
        const { transport } = await connected();

        expect(
            await transport.command({
                type: 'project.update',
                projectId: FIXTURE_PROJECT_ID,
                folders: [{ path: '/Users/dev/moved' }],
            })
        ).toMatchObject({ ok: false, error: { code: 'conflict' } });
        expect(
            await transport.command({
                type: 'project.update',
                projectId: FIXTURE_PROJECT_ID,
                folders: [{ id: 'fld_car_rental' }, { path: '/Users/dev/api' }],
            })
        ).toMatchObject({
            ok: true,
            data: { project: { folders: [{ id: 'fld_car_rental' }, { path: '/Users/dev/api' }] } },
        });
        expect(
            await transport.command({
                type: 'project.update',
                projectId: FIXTURE_EMPTY_PROJECT_ID,
                folders: [{ id: 'fld_clowdy' }, { path: '/Users/dev/car-rental' }],
            })
        ).toMatchObject({ ok: true });
        expect(
            await transport.command({
                type: 'project.update',
                projectId: FIXTURE_EMPTY_PROJECT_ID,
                folders: [{ path: '/Users/dev/moved' }],
            })
        ).toMatchObject({ ok: true, data: { project: { folders: [{ path: '/Users/dev/moved' }] } } });
    });

    it('adds a project of several folders, and answers the same folders with the project that has them', async () => {
        const { transport } = await connected();
        const added = await transport.command({ type: 'project.add', folders: ['/Users/dev/web', '/Users/dev/api'] });

        expect(added).toMatchObject({
            ok: true,
            data: { project: { name: 'web', folders: [{ path: '/Users/dev/web' }, { path: '/Users/dev/api' }] } },
        });
        expect((added as { data: object }).data).not.toHaveProperty('existing');
        expect(
            await transport.command({ type: 'project.add', folders: ['/Users/dev/api', '/Users/dev/web'] })
        ).toMatchObject({
            ok: true,
            data: { project: { id: (added as { data: { project: { id: string } } }).data.project.id }, existing: true },
        });
        expect(await transport.command({ type: 'project.add', name: 'Fresh' })).toMatchObject({
            ok: true,
            data: { project: { name: 'Fresh', folders: [{ path: '/Users/dev/Clowdy/projects/fresh' }] } },
        });
        expect(await transport.command({ type: 'project.add' })).toMatchObject({
            ok: false,
            error: { code: 'invalid' },
        });
    });

    it('removes a project with what it holds and announces it, and refuses the personal space and a project with agents at work', async () => {
        const { transport, events } = await connected();

        expect(
            await transport.command({ type: 'project.delete', projectId: FIXTURE_PERSONAL_PROJECT_ID })
        ).toMatchObject({ ok: false, error: { code: 'conflict' } });
        expect(await transport.command({ type: 'project.delete', projectId: FIXTURE_PROJECT_ID })).toMatchObject({
            ok: false,
            error: { code: 'conflict' },
        });
        expect(await transport.command({ type: 'project.delete', projectId: 'nope' })).toMatchObject({
            ok: false,
            error: { code: 'not_found' },
        });
        expect(await transport.command({ type: 'project.delete', projectId: FIXTURE_EMPTY_PROJECT_ID })).toMatchObject({
            ok: true,
        });

        expect(events.map(event => [event.projectId, event.data.type])).toEqual([
            [FIXTURE_EMPTY_PROJECT_ID, 'project.deleted'],
        ]);
        expect((await transport.getRootSnapshot()).projects.map(project => project.name)).toEqual([
            'Personal',
            'Car Rental',
        ]);
        await expect(transport.getProjectSnapshot(FIXTURE_EMPTY_PROJECT_ID)).rejects.toMatchObject({ status: 404 });
    });

    it('reorders the projects behind the personal space and announces only those that moved', async () => {
        const { transport, events } = await connected();

        expect(await transport.command({ type: 'project.reorder', projectIds: ['nope'] })).toMatchObject({
            ok: false,
            error: { code: 'invalid' },
        });

        await transport.command({
            type: 'project.reorder',
            projectIds: [FIXTURE_EMPTY_PROJECT_ID, FIXTURE_PERSONAL_PROJECT_ID],
        });

        const { projects } = await transport.getRootSnapshot();

        expect(projects.map(project => [project.name, project.position])).toEqual([
            ['Personal', 0],
            ['Clowdy', 1],
            ['Car Rental', 2],
        ]);
        expect(events.map(event => event.projectId).sort()).toEqual(
            [FIXTURE_PROJECT_ID, FIXTURE_EMPTY_PROJECT_ID].sort()
        );
    });
});

describe('HttpTransport git writes', () => {
    /** A transport whose daemon answers `body` with `status`, and what it was sent. */
    function transportFor(body: unknown, status = 200) {
        const sent: Array<{
            url: string;
            method?: string;
            body?: unknown;
            headers: Record<string, string>;
            signal?: AbortSignal | null;
        }> = [];
        const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
            sent.push({
                url: String(input),
                method: init?.method,
                body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
                headers: init?.headers as Record<string, string>,
                signal: init?.signal,
            });

            return new Response(JSON.stringify(body), { status });
        }) as typeof fetch;

        return { sent, transport: new HttpTransport({ url: 'http://127.0.0.1:4310', token: 't', fetch: fetchImpl }) };
    }

    it('commits the ticked files of a place, a worktree of its folder included, with the message, and gives the commit', async () => {
        const commit = { sha: 'a'.repeat(40), shortSha: 'aaaaaaa', subject: 'Edit a' };
        const { sent, transport } = transportFor(commit);

        expect(
            await transport.commitGit('prj a', { folderId: 'fld/b' }, ['a.ts', 'src/b c.ts'], 'Edit a\n\nbody')
        ).toEqual(commit);
        await transport.commitGit('prj a', { folderId: 'fld/b', workspaceId: 'wks 1' }, ['a.ts'], 'x');
        expect(sent.map(request => [request.url, request.method, request.body])).toEqual([
            [
                'http://127.0.0.1:4310/v1/projects/prj%20a/git/commit',
                'POST',
                { folderId: 'fld/b', paths: ['a.ts', 'src/b c.ts'], message: 'Edit a\n\nbody' },
            ],
            [
                'http://127.0.0.1:4310/v1/projects/prj%20a/git/commit',
                'POST',
                { folderId: 'fld/b', workspaceId: 'wks 1', paths: ['a.ts'], message: 'x' },
            ],
        ]);
        expect(sent[0]!.headers).toMatchObject({ authorization: 'Bearer t', 'content-type': 'application/json' });
    });

    it('asks for the message of the ticked files', async () => {
        const { sent, transport } = transportFor({ message: 'feat: add a' });
        const { signal } = new AbortController();

        expect(
            await transport.generateGitMessage('prj_a', { folderId: 'fld_b', workspaceId: 'wks_c' }, ['a.ts'], signal)
        ).toEqual({ message: 'feat: add a' });
        expect(sent.map(request => [request.url, request.method, request.body])).toEqual([
            [
                'http://127.0.0.1:4310/v1/projects/prj_a/git/message',
                'POST',
                { folderId: 'fld_b', workspaceId: 'wks_c', paths: ['a.ts'] },
            ],
        ]);
        expect(sent[0]?.signal).toBe(signal);
    });

    it('discards the files of a place, a worktree of its folder included, with the paths named, and gives what was discarded and where the copy is', async () => {
        const result = {
            discarded: [{ path: 'a.ts', action: 'restored' }],
            copy: {
                folder: '/data/discarded/prj_a/20261123T100000000Z-4f2a9c',
                keptUntil: 1_800_000_000_000,
                files: 1,
            },
        };
        const { sent, transport } = transportFor(result);

        expect(await transport.discardGit('prj a', { folderId: 'fld/b' }, ['a.ts'])).toEqual(result);
        await transport.discardGit('prj a', { folderId: 'fld/b', workspaceId: 'wks 1' }, ['src/b c.ts']);
        expect(sent.map(request => [request.url, request.method, request.body])).toEqual([
            ['http://127.0.0.1:4310/v1/projects/prj%20a/git/discard', 'POST', { folderId: 'fld/b', paths: ['a.ts'] }],
            [
                'http://127.0.0.1:4310/v1/projects/prj%20a/git/discard',
                'POST',
                { folderId: 'fld/b', workspaceId: 'wks 1', paths: ['src/b c.ts'] },
            ],
        ]);
        expect(sent[0]!.headers).toMatchObject({ authorization: 'Bearer t', 'content-type': 'application/json' });
    });

    it("rejects a discard with the daemon's own words and the status, and sends it only once", async () => {
        const conflict = transportFor(
            { ok: false, error: { code: 'conflict', message: 'Resolve the conflict first' } },
            409
        );
        const copy = transportFor(
            {
                ok: false,
                error: {
                    code: 'unavailable',
                    message:
                        "Couldn't keep a copy of the files, so nothing was discarded: ENOSPC: no space left on device",
                },
            },
            503
        );
        const invalid = transportFor(
            { ok: false, error: { code: 'invalid', message: "A submodule can't be discarded here" } },
            400
        );

        await expect(conflict.transport.discardGit('prj_a', { folderId: 'fld_b' }, ['a.ts'])).rejects.toMatchObject({
            message: 'Resolve the conflict first',
            status: 409,
        });
        await expect(copy.transport.discardGit('prj_a', { folderId: 'fld_b' }, ['a.ts'])).rejects.toMatchObject({
            message: expect.stringContaining('nothing was discarded'),
            status: 503,
        });
        await expect(invalid.transport.discardGit('prj_a', { folderId: 'fld_b' }, ['sub'])).rejects.toMatchObject({
            message: "A submodule can't be discarded here",
            status: 400,
        });
        // A discard is not asked for twice, whatever the answer.
        expect(conflict.sent).toHaveLength(1);
        expect(copy.sent).toHaveLength(1);

        const bare = new HttpTransport({
            url: 'http://127.0.0.1:4310',
            token: 't',
            fetch: (async () => new Response('Bad gateway', { status: 502 })) as unknown as typeof fetch,
        });

        await expect(bare.discardGit('prj_a', { folderId: 'fld_b' }, ['a.ts'])).rejects.toMatchObject({
            message: expect.stringContaining('502'),
            status: 502,
        });
    });

    it("rejects with git's own line and the hint the daemon gave, and the status, and sends a commit only once", async () => {
        const body = {
            ok: false,
            error: {
                code: 'conflict',
                message: 'error: No private key found for public key "k.pub"?',
                details: { hint: "The signing agent couldn't be reached" },
            },
        };
        const { sent, transport } = transportFor(body, 409);

        await expect(transport.commitGit('prj_a', { folderId: 'fld_b' }, ['a.ts'], 'x')).rejects.toMatchObject({
            message: 'error: No private key found for public key "k.pub"?',
            status: 409,
            hint: "The signing agent couldn't be reached",
        });
        // A commit is not asked for twice, whatever the answer.
        expect(sent).toHaveLength(1);
        await expect(
            transportFor({ error: { code: 'conflict', message: 'lint failed' } }, 409).transport.commitGit(
                'prj_a',
                { folderId: 'fld_b' },
                ['a.ts'],
                'x'
            )
        ).rejects.toMatchObject({ message: 'lint failed', hint: undefined });
        await expect(
            transportFor(
                {
                    error: {
                        code: 'unavailable',
                        message: "Couldn't write the message",
                        details: { reason: 'failed' },
                    },
                },
                503
            ).transport.generateGitMessage('prj_a', { folderId: 'fld_b' }, ['a.ts'])
        ).rejects.toMatchObject({ message: "Couldn't write the message", status: 503 });

        const bare = new HttpTransport({
            url: 'http://127.0.0.1:4310',
            token: 't',
            fetch: (async () => new Response('Bad gateway', { status: 502 })) as unknown as typeof fetch,
        });

        await expect(bare.commitGit('prj_a', { folderId: 'fld_b' }, ['a.ts'], 'x')).rejects.toMatchObject({
            message: expect.stringContaining('502'),
            status: 502,
        });
    });
});

describe('FixtureTransport git writes', () => {
    const place = { folderId: 'fld_car_rental' };
    const inWorktree = { ...place, workspaceId: 'wks_ab12cd34' };
    const worktree = (gitWrites?: FixtureGitWritesOptions) =>
        new FixtureTransport({ data: withFixtureWorkspace(createFixtureData()), gitWrites });
    const pathsOf = async (transport: FixtureTransport) =>
        (
            (await transport.getGitChanges(FIXTURE_PROJECT_ID, inWorktree, 'uncommitted')) as {
                files: Array<{ path: string }>;
            }
        ).files.map(file => file.path);

    it('takes the committed files out of the uncommitted list and the status, and leaves the other files and scopes as they are', async () => {
        const transport = worktree();
        const result = await transport.commitGit(
            FIXTURE_PROJECT_ID,
            inWorktree,
            ['notes.md', 'src/limits.ts'],
            'Add the notes\n\nand the limit'
        );

        expect(result).toMatchObject({ subject: 'Add the notes', sha: expect.stringMatching(/^[0-9a-f]{40}$/) });
        expect(result.shortSha).toBe(result.sha.slice(0, 7));
        expect(await pathsOf(transport)).toEqual(['src/booking/price.ts']);
        expect(await transport.getGitChanges(FIXTURE_PROJECT_ID, inWorktree, 'uncommitted')).toMatchObject({
            fileCount: 1,
            additions: 6,
            deletions: 2,
        });
        expect(
            ((await transport.getGitStatus(FIXTURE_PROJECT_ID, inWorktree)) as { entries: unknown[] }).entries
        ).toEqual([{ path: 'src/booking/price.ts', unstaged: 'modified' }]);
        expect(await transport.getGitChanges(FIXTURE_PROJECT_ID, inWorktree, 'all')).toMatchObject({ fileCount: 6 });
        // A second commit is another commit, and the files that went are not changed any more.
        expect(
            (await transport.commitGit(FIXTURE_PROJECT_ID, inWorktree, ['src/booking/price.ts'], 'More')).sha
        ).not.toBe(result.sha);
        expect(await pathsOf(transport)).toEqual([]);
        await expect(transport.commitGit(FIXTURE_PROJECT_ID, inWorktree, ['notes.md'], 'Again')).rejects.toMatchObject({
            status: 400,
            message: 'notes.md is not a changed file',
        });
    });

    it('judges the request as the daemon does: no paths, no message, a file that is not changed, a place with nothing to commit', async () => {
        const transport = worktree();

        await expect(transport.commitGit(FIXTURE_PROJECT_ID, inWorktree, [], 'x')).rejects.toMatchObject({
            status: 400,
            message: 'Pick at least one file',
        });
        await expect(transport.commitGit(FIXTURE_PROJECT_ID, inWorktree, ['notes.md'], ' ')).rejects.toMatchObject({
            status: 400,
        });
        await expect(
            transport.commitGit(FIXTURE_PROJECT_ID, inWorktree, ['assets/logo.png'], 'x')
        ).rejects.toMatchObject({ status: 400, message: 'assets/logo.png is not a changed file' });
        await expect(transport.commitGit(FIXTURE_PROJECT_ID, place, ['notes.md'], 'x')).rejects.toMatchObject({
            status: 400,
        });
        await expect(
            transport.commitGit(FIXTURE_PROJECT_ID, { ...place, workspaceId: 'wks_none' }, ['notes.md'], 'x')
        ).rejects.toMatchObject({ status: 404 });
        expect(await pathsOf(transport)).toHaveLength(3);
    });

    it("ends a commit the way its script says: git's signing line with the hint, or a hook's line, and takes nothing out", async () => {
        await expect(
            worktree({ commit: 'signing' }).commitGit(FIXTURE_PROJECT_ID, inWorktree, ['notes.md'], 'x')
        ).rejects.toMatchObject({
            status: 409,
            message: expect.stringContaining('No private key found'),
            hint: "The signing agent couldn't be reached",
        });

        const hook = worktree({ commit: 'hook' });

        await expect(hook.commitGit(FIXTURE_PROJECT_ID, inWorktree, ['notes.md'], 'x')).rejects.toMatchObject({
            status: 409,
            message: 'pre-commit: 2 problems in src/limits.ts',
        });
        expect(await pathsOf(hook)).toHaveLength(3);
    });

    it("discards a file: it leaves the uncommitted list, the status and `all`, a new file is removed and an edited one restored, and the branch's own changes stay in `all`", async () => {
        const transport = worktree();
        const result = await transport.discardGit(FIXTURE_PROJECT_ID, inWorktree, ['notes.md', 'src/booking/price.ts']);

        expect(result.discarded).toEqual([
            { path: 'notes.md', action: 'removed' },
            { path: 'src/booking/price.ts', action: 'restored' },
        ]);
        expect(result.copy).toMatchObject({
            files: 2,
            folder: expect.stringContaining(`/discarded/${FIXTURE_PROJECT_ID}/`),
        });
        expect(result.copy.keptUntil).toBeGreaterThan(Date.now() + 6 * 24 * 3600 * 1000);
        expect(await pathsOf(transport)).toEqual(['src/limits.ts']);
        expect(
            ((await transport.getGitStatus(FIXTURE_PROJECT_ID, inWorktree)) as { entries: unknown[] }).entries
        ).toEqual([{ path: 'src/limits.ts', unstaged: 'modified' }]);

        const all = (await transport.getGitChanges(FIXTURE_PROJECT_ID, inWorktree, 'all')) as {
            files: Array<{ path: string; additions?: number }>;
            fileCount: number;
        };

        // The new file is gone from `all`; the file the branch had committed changes to is still there, with the branch's own lines.
        expect(all.files.map(file => file.path)).toEqual([
            'assets/logo.png',
            'src/booking/price.test.ts',
            'src/booking/price.ts',
            'src/booking/weekend.ts',
            'src/limits.ts',
        ]);
        expect(all.files.find(file => file.path === 'src/booking/price.ts')?.additions).toBe(23);
        // The branch scope is what was committed, which a discard does not touch.
        expect(await transport.getGitChanges(FIXTURE_PROJECT_ID, inWorktree, 'branch')).toMatchObject({ fileCount: 4 });
        // The same file is not changed any more, and what was committed stays committed.
        await expect(transport.discardGit(FIXTURE_PROJECT_ID, inWorktree, ['notes.md'])).rejects.toMatchObject({
            status: 400,
            message: 'notes.md is not a changed file',
        });
        await expect(transport.commitGit(FIXTURE_PROJECT_ID, inWorktree, ['notes.md'], 'x')).rejects.toMatchObject({
            status: 400,
        });
        expect((await transport.commitGit(FIXTURE_PROJECT_ID, inWorktree, ['src/limits.ts'], 'Limit')).subject).toBe(
            'Limit'
        );
    });

    it('judges a discard as the daemon does: no paths, too many, a file that is not changed, a folder that is no repository, a place that is none', async () => {
        const transport = worktree();

        await expect(transport.discardGit(FIXTURE_PROJECT_ID, inWorktree, [])).rejects.toMatchObject({
            status: 400,
            message: 'Pick at least one file',
        });
        await expect(
            transport.discardGit(
                FIXTURE_PROJECT_ID,
                inWorktree,
                Array.from({ length: 51 }, (_, index) => `f${index}.ts`)
            )
        ).rejects.toMatchObject({ status: 400, message: 'Pick at most 50 files' });
        await expect(
            transport.discardGit(FIXTURE_PROJECT_ID, inWorktree, ['notes.md', 'assets/logo.png'])
        ).rejects.toMatchObject({ status: 400, message: 'assets/logo.png is not a changed file' });
        await expect(transport.discardGit(FIXTURE_PROJECT_ID, place, ['notes.md'])).rejects.toMatchObject({
            status: 400,
        });
        await expect(
            transport.discardGit(FIXTURE_PROJECT_ID, { ...place, workspaceId: 'wks_none' }, ['notes.md'])
        ).rejects.toMatchObject({ status: 404 });
        // The request that was refused did nothing to the file that was fine.
        expect(await pathsOf(transport)).toHaveLength(3);
    });

    it('ends a discard the way its script says: slow, a file with conflicts, or a copy that cannot be kept, and takes nothing out', async () => {
        vi.useFakeTimers();

        try {
            const slow = worktree({ discard: 'slow' });
            const pending = slow.discardGit(FIXTURE_PROJECT_ID, inWorktree, ['notes.md']);
            let done = false;

            void pending.then(() => {
                done = true;
            });
            await vi.advanceTimersByTimeAsync(1000);
            expect(done).toBe(false);
            await vi.advanceTimersByTimeAsync(2000);
            expect((await pending).discarded).toEqual([{ path: 'notes.md', action: 'removed' }]);
        } finally {
            vi.useRealTimers();
        }

        const refused = worktree({ discard: 'refused' });
        const copy = worktree({ discard: 'copyfail' });

        await expect(refused.discardGit(FIXTURE_PROJECT_ID, inWorktree, ['notes.md'])).rejects.toMatchObject({
            status: 409,
            message: 'Resolve the conflict first',
        });
        await expect(copy.discardGit(FIXTURE_PROJECT_ID, inWorktree, ['notes.md'])).rejects.toMatchObject({
            status: 503,
            message: expect.stringContaining('nothing was discarded'),
        });
        expect(await pathsOf(refused)).toHaveLength(3);
        expect(await pathsOf(copy)).toHaveLength(3);
    });

    it('writes a message for the changed files, as the agent the fixtures have on does, and fails as its script says', async () => {
        expect(await worktree().generateGitMessage(FIXTURE_PROJECT_ID, inWorktree, ['notes.md'])).toEqual({
            message: 'feat(booking): add the weekend surcharge',
        });
        await expect(
            worktree({ message: 'failed' }).generateGitMessage(FIXTURE_PROJECT_ID, inWorktree, ['notes.md'])
        ).rejects.toMatchObject({ status: 503, message: "Couldn't write the message" });
        await expect(worktree().generateGitMessage(FIXTURE_PROJECT_ID, inWorktree, [])).rejects.toMatchObject({
            status: 400,
        });
        await expect(
            worktree().generateGitMessage(FIXTURE_PROJECT_ID, inWorktree, ['assets/logo.png'])
        ).rejects.toMatchObject({ status: 400 });
    });

    it('refuses a message while no agent has Commit messages on and is signed in', async () => {
        const data = withFixtureWorkspace(createFixtureData());
        const codex = data.agents.find(agent => agent.id === 'codex')!;

        codex.settings = codex.settings!.map(setting => ({ ...setting, value: false }));
        await expect(
            new FixtureTransport({ data }).generateGitMessage(FIXTURE_PROJECT_ID, inWorktree, ['notes.md'])
        ).rejects.toMatchObject({ status: 400, message: "Couldn't write the message" });
    });
});

describe('HttpTransport git remote actions', () => {
    /** A transport whose daemon answers `body` with `status`, and what it was sent. */
    function transportFor(body: unknown, status = 200) {
        const sent: Array<{ url: string; method?: string; body?: unknown }> = [];
        const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
            sent.push({
                url: String(input),
                method: init?.method,
                body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
            });

            return new Response(JSON.stringify(body), { status });
        }) as typeof fetch;

        return { sent, transport: new HttpTransport({ url: 'http://127.0.0.1:4310', token: 't', fetch: fetchImpl }) };
    }

    it('posts the place to the route of each action, a worktree of its folder included, and gives what the daemon answers', async () => {
        const done = {
            state: 'done',
            action: 'push',
            published: true,
            upstream: { name: 'origin/feature', ahead: 0, behind: 0 },
        };
        const { sent, transport } = transportFor(done);

        expect(await transport.fetchGit('prj a', { folderId: 'fld/b' })).toEqual(done);
        expect(await transport.pullGit('prj a', { folderId: 'fld/b', workspaceId: 'wks 1' })).toEqual(done);
        expect(await transport.pushGit('prj_a', { folderId: 'fld_b' })).toEqual(done);
        expect(sent.map(request => [request.url, request.method, request.body])).toEqual([
            ['http://127.0.0.1:4310/v1/projects/prj%20a/git/fetch', 'POST', { folderId: 'fld/b' }],
            ['http://127.0.0.1:4310/v1/projects/prj%20a/git/pull', 'POST', { folderId: 'fld/b', workspaceId: 'wks 1' }],
            ['http://127.0.0.1:4310/v1/projects/prj_a/git/push', 'POST', { folderId: 'fld_b' }],
        ]);
    });

    it('gives a merge that stopped on conflicts as an answer, not an error', async () => {
        const conflicts = { state: 'conflicts', action: 'pull', conflicts: 2 };

        expect(await transportFor(conflicts).transport.pullGit('prj_a', { folderId: 'fld_b' })).toEqual(conflicts);
    });

    it("rejects with git's own line, the status and the hint, and sends a push only once", async () => {
        const body = {
            ok: false,
            error: {
                code: 'conflict',
                message: 'sign_and_send_pubkey: signing failed: agent refused operation',
                details: { hint: "The signing agent couldn't be reached" },
            },
        };
        const { sent, transport } = transportFor(body, 409);

        await expect(transport.pushGit('prj_a', { folderId: 'fld_b' })).rejects.toMatchObject({
            message: 'sign_and_send_pubkey: signing failed: agent refused operation',
            status: 409,
            hint: "The signing agent couldn't be reached",
        });
        // A push is not asked for twice, whatever the answer.
        expect(sent).toHaveLength(1);
        await expect(
            transportFor(
                { error: { code: 'conflict', message: '! [rejected] main -> main (fetch first)' } },
                409
            ).transport.pushGit('prj_a', { folderId: 'fld_b' })
        ).rejects.toMatchObject({ message: '! [rejected] main -> main (fetch first)', hint: undefined });
        await expect(
            transportFor(
                { error: { code: 'unavailable', message: 'The fetch did not finish in time' } },
                503
            ).transport.fetchGit('prj_a', { folderId: 'fld_b' })
        ).rejects.toMatchObject({ message: 'The fetch did not finish in time', status: 503 });
        await expect(
            transportFor(
                { error: { code: 'invalid', message: 'HEAD is detached, switch to a branch to pull' } },
                400
            ).transport.pullGit('prj_a', { folderId: 'fld_b' })
        ).rejects.toMatchObject({ status: 400 });
    });
});

describe('FixtureTransport git remote actions', () => {
    const place = { folderId: 'fld_car_rental' };
    const inWorktree = { ...place, workspaceId: 'wks_ab12cd34' };
    const worktree = (remote?: FixtureGitWritesOptions['remote']) =>
        new FixtureTransport({ data: withFixtureWorkspace(createFixtureData()), gitWrites: { remote } });
    const upstreamOf = async (
        transport: FixtureTransport,
        at: { folderId: string; workspaceId?: string } = inWorktree
    ) => ((await transport.getGitStatus(FIXTURE_PROJECT_ID, at)) as { upstream?: unknown }).upstream;

    it("has the worktree's branch unpublished and the folder's own checkout level with its upstream, as the fixtures always had them", async () => {
        const transport = worktree();

        expect(await upstreamOf(transport)).toBeUndefined();
        expect(await upstreamOf(transport, place)).toEqual({ name: 'origin/main', ahead: 0, behind: 0 });
    });

    it("publishes the worktree's branch with a push, which then tracks origin, and pushes it again as a plain push", async () => {
        const transport = worktree();

        await expect(transport.pullGit(FIXTURE_PROJECT_ID, inWorktree)).rejects.toMatchObject({
            status: 400,
            message: 'clowdy/ab12cd34 has no upstream to pull from, publish it first',
        });
        expect(await transport.pushGit(FIXTURE_PROJECT_ID, inWorktree)).toEqual({
            state: 'done',
            action: 'push',
            published: true,
            upstream: { name: 'origin/clowdy/ab12cd34', ahead: 0, behind: 0 },
        });
        expect(await upstreamOf(transport)).toEqual({ name: 'origin/clowdy/ab12cd34', ahead: 0, behind: 0 });
        expect(await transport.pushGit(FIXTURE_PROJECT_ID, inWorktree)).toEqual({
            state: 'done',
            action: 'push',
            upstream: { name: 'origin/clowdy/ab12cd34', ahead: 0, behind: 0 },
        });
    });

    it('puts a commit ahead of a published branch, and a push takes it to origin', async () => {
        const transport = worktree();

        await transport.pushGit(FIXTURE_PROJECT_ID, inWorktree);
        await transport.commitGit(FIXTURE_PROJECT_ID, inWorktree, ['notes.md'], 'Add the notes');
        expect(await upstreamOf(transport)).toMatchObject({ ahead: 1, behind: 0 });
        await transport.pushGit(FIXTURE_PROJECT_ID, inWorktree);
        expect(await upstreamOf(transport)).toMatchObject({ ahead: 0, behind: 0 });
    });

    it('pulls what origin has when the branch is behind, and says nothing came when it is not', async () => {
        const transport = worktree('behind');

        expect(await upstreamOf(transport)).toEqual({ name: 'origin/clowdy/ab12cd34', ahead: 0, behind: 2 });
        expect(await transport.pullGit(FIXTURE_PROJECT_ID, inWorktree)).toEqual({
            state: 'done',
            action: 'pull',
            pulled: 2,
            upstream: { name: 'origin/clowdy/ab12cd34', ahead: 0, behind: 0 },
        });
        expect(await transport.pullGit(FIXTURE_PROJECT_ID, inWorktree)).toMatchObject({ state: 'done', pulled: 0 });
    });

    it('merges a pull of a diverged branch, after which the push is of the merge', async () => {
        const transport = worktree('diverged');

        expect(await transport.pullGit(FIXTURE_PROJECT_ID, inWorktree)).toEqual({
            state: 'done',
            action: 'pull',
            pulled: 2,
            merged: true,
            upstream: { name: 'origin/clowdy/ab12cd34', ahead: 2, behind: 0 },
        });
        expect(await upstreamOf(transport)).toEqual({ name: 'origin/clowdy/ab12cd34', ahead: 2, behind: 0 });
        expect(await transport.pushGit(FIXTURE_PROJECT_ID, inWorktree)).toMatchObject({
            state: 'done',
            action: 'push',
        });
    });

    it('ends an action the way its script says', async () => {
        await expect(worktree('rejected').pushGit(FIXTURE_PROJECT_ID, inWorktree)).rejects.toMatchObject({
            status: 409,
            message: expect.stringContaining('[rejected]'),
        });
        await expect(worktree('signing').pushGit(FIXTURE_PROJECT_ID, inWorktree)).rejects.toMatchObject({
            status: 409,
            message: expect.stringContaining('No private key found'),
            hint: "The signing agent couldn't be reached",
        });

        const offline = worktree('offline');

        for (const act of [offline.fetchGit, offline.pullGit, offline.pushGit]) {
            await expect(act.call(offline, FIXTURE_PROJECT_ID, inWorktree)).rejects.toMatchObject({
                status: 409,
                message: expect.stringContaining('Could not resolve host'),
            });
        }
    });

    it('takes a while when its script is slow, and then goes through', async () => {
        vi.useFakeTimers();

        try {
            const pending = worktree('slow').fetchGit(FIXTURE_PROJECT_ID, inWorktree);
            let settled = false;

            void pending.then(() => {
                settled = true;
            });
            await vi.advanceTimersByTimeAsync(2000);
            expect(settled).toBe(false);
            await vi.advanceTimersByTimeAsync(1000);
            expect(await pending).toEqual({ state: 'done', action: 'fetch' });
        } finally {
            vi.useRealTimers();
        }
    });

    it('judges the place as the daemon does: a folder that is no repository and a detached HEAD are refused, a fetch of a detached HEAD is not', async () => {
        const transport = worktree();

        await expect(transport.pushGit(FIXTURE_PROJECT_ID, { folderId: 'fld_none' })).rejects.toMatchObject({
            status: 404,
        });
        await expect(
            transport.fetchGit(FIXTURE_PROJECT_ID, { ...place, workspaceId: 'wks_none' })
        ).rejects.toMatchObject({ status: 404 });

        const data = withFixtureWorkspace(createFixtureData());

        data.git['/Users/dev/car-rental'] = { ...data.git['/Users/dev/car-rental'], detached: true };

        const detached = new FixtureTransport({ data });

        await expect(detached.pushGit(FIXTURE_PROJECT_ID, place)).rejects.toMatchObject({
            status: 400,
            message: expect.stringContaining('HEAD is detached'),
        });
        expect(await detached.fetchGit(FIXTURE_PROJECT_ID, place)).toEqual({ state: 'done', action: 'fetch' });
    });
});

describe('the time of the last fetch in the transports', () => {
    const place = { folderId: 'fld_car_rental' };
    const inWorktree = { ...place, workspaceId: 'wks_ab12cd34' };
    const MINUTE = 60_000;
    const worktree = (remote?: FixtureGitWritesOptions['remote'], extra: Partial<FixtureGitWritesOptions> = {}) =>
        new FixtureTransport({ data: withFixtureWorkspace(createFixtureData()), gitWrites: { remote, ...extra } });
    const statusOf = async (transport: FixtureTransport, at: { folderId: string; workspaceId?: string } = inWorktree) =>
        (await transport.getGitStatus(FIXTURE_PROJECT_ID, at)) as Extract<GitStatus, { isRepository: true }>;

    it('is passed on by the HTTP transport as the daemon sent it, and left out when the daemon says nothing', async () => {
        const answers = [
            { isRepository: true, origin: true, lastFetchedAt: 1_700_000_000_000 },
            { isRepository: true, origin: true },
        ];
        const fetchImpl = (async () => new Response(JSON.stringify(answers.shift()), { status: 200 })) as typeof fetch;
        const transport = new HttpTransport({ url: 'http://127.0.0.1:4310', token: 't', fetch: fetchImpl });

        expect(await transport.getGitStatus('prj_a', { folderId: 'fld_b' })).toMatchObject({
            lastFetchedAt: 1_700_000_000_000,
        });
        expect(await transport.getGitStatus('prj_a', { folderId: 'fld_b' })).not.toHaveProperty('lastFetchedAt');
    });

    it("is three minutes ago in the fixtures, for the folder's own checkout and for a worktree alike, and a script can say the repository never fetched", async () => {
        const transport = worktree();
        const before = Date.now();
        const inCheckout = (await statusOf(transport, place)).lastFetchedAt!;
        const inTree = (await statusOf(transport)).lastFetchedAt!;

        expect(inCheckout).toBe(inTree);
        expect(before - inCheckout).toBeGreaterThanOrEqual(3 * MINUTE - 1000);
        expect(before - inCheckout).toBeLessThanOrEqual(3 * MINUTE + 1000);
        expect(await statusOf(worktree('never'))).not.toHaveProperty('lastFetchedAt');
        expect(await statusOf(worktree('never'), place)).not.toHaveProperty('lastFetchedAt');
    });

    it('is now after a fetch, and after a pull whatever it finds, in every place of the repository', async () => {
        const never = worktree('never');

        await never.fetchGit(FIXTURE_PROJECT_ID, inWorktree);
        expect(Date.now() - (await statusOf(never, place)).lastFetchedAt!).toBeLessThan(2000);

        const diverged = worktree('diverged');
        const was = (await statusOf(diverged)).lastFetchedAt!;

        expect(await diverged.pullGit(FIXTURE_PROJECT_ID, inWorktree)).toMatchObject({ state: 'done', merged: true });
        expect((await statusOf(diverged)).lastFetchedAt!).toBeGreaterThan(was);
    });

    it('is not moved by a push, a commit or a fetch that failed', async () => {
        const offline = worktree('offline');
        const was = (await statusOf(offline)).lastFetchedAt!;

        await expect(offline.fetchGit(FIXTURE_PROJECT_ID, inWorktree)).rejects.toMatchObject({ status: 409 });
        expect((await statusOf(offline)).lastFetchedAt).toBe(was);

        const ahead = worktree('ahead');
        const first = (await statusOf(ahead)).lastFetchedAt!;

        await ahead.pushGit(FIXTURE_PROJECT_ID, inWorktree);
        expect((await statusOf(ahead)).lastFetchedAt).toBe(first);
    });

    it('is left out of a place that has no origin, which refuses every action', async () => {
        const none = worktree('no_origin');

        expect(await statusOf(none)).toMatchObject({ origin: false });
        expect(await statusOf(none)).not.toHaveProperty('lastFetchedAt');

        for (const act of [none.fetchGit, none.pullGit, none.pushGit]) {
            await expect(act.call(none, FIXTURE_PROJECT_ID, inWorktree)).rejects.toMatchObject({
                status: 400,
                message: 'The repository has no origin',
            });
        }
    });
});

describe('the states of the sync button in the fixtures', () => {
    const place = { folderId: 'fld_car_rental' };
    const inWorktree = { ...place, workspaceId: 'wks_ab12cd34' };
    const worktree = (remote?: FixtureGitWritesOptions['remote'], extra: Partial<FixtureGitWritesOptions> = {}) =>
        new FixtureTransport({ data: withFixtureWorkspace(createFixtureData()), gitWrites: { remote, ...extra } });
    const statusOf = async (transport: FixtureTransport, at: { folderId: string; workspaceId?: string } = inWorktree) =>
        (await transport.getGitStatus(FIXTURE_PROJECT_ID, at)) as Extract<GitStatus, { isRepository: true }>;

    it('has the branch ahead by 2 for `ahead`, level and published for `level` and `never`', async () => {
        expect((await statusOf(worktree('ahead'))).upstream).toEqual({
            name: 'origin/clowdy/ab12cd34',
            ahead: 2,
            behind: 0,
        });
        expect((await statusOf(worktree('level'))).upstream).toEqual({
            name: 'origin/clowdy/ab12cd34',
            ahead: 0,
            behind: 0,
        });
        expect((await statusOf(worktree('never'))).upstream).toEqual({
            name: 'origin/clowdy/ab12cd34',
            ahead: 0,
            behind: 0,
        });
    });

    it('puts HEAD on no branch for `detached` and gives the branch no commit for `unborn`, neither with an upstream', async () => {
        const detached = await statusOf(worktree('detached'));
        const unborn = await statusOf(worktree('unborn'));

        expect(detached.head).toMatchObject({ kind: 'detached' });
        expect(detached.upstream).toBeUndefined();
        expect(unborn.head).toEqual({ kind: 'unborn', name: 'clowdy/ab12cd34' });
        expect(unborn.upstream).toBeUndefined();
        await expect(worktree('detached').pushGit(FIXTURE_PROJECT_ID, inWorktree)).rejects.toMatchObject({
            status: 400,
            message: expect.stringContaining('HEAD is detached'),
        });
        await expect(worktree('unborn').pullGit(FIXTURE_PROJECT_ID, inWorktree)).rejects.toMatchObject({
            status: 400,
            message: 'The branch has no commits yet',
        });
        expect(await worktree('unborn').fetchGit(FIXTURE_PROJECT_ID, inWorktree)).toMatchObject({
            state: 'done',
            action: 'fetch',
        });
    });

    it("leaves a worktree with nothing uncommitted when it is clean, and the folder's own checkout as it was", async () => {
        const clean = worktree(undefined, { clean: true });

        expect((await statusOf(clean)).entries).toEqual([]);
        expect(await clean.getGitChanges(FIXTURE_PROJECT_ID, inWorktree, 'uncommitted')).toMatchObject({
            files: [],
            fileCount: 0,
        });
        // What is committed on the branch is still there.
        expect(await clean.getGitChanges(FIXTURE_PROJECT_ID, inWorktree, 'branch')).toMatchObject({ fileCount: 4 });
        expect((await statusOf(clean, place)).entries).toEqual([]);
        expect((await statusOf(worktree())).entries).toHaveLength(3);
    });
});

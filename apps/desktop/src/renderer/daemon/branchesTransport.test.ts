import { describe, expect, it, vi } from 'vitest';

import {
    createFixtureData,
    FIXTURE_PROJECT_ID,
    FIXTURE_WORKTREE_PATH,
    withFixtureWorkspace,
    withFixtureWorktrees,
} from './fixtureData';
import { FixtureTransport } from './fixtureTransport';
import { HttpTransport } from './httpTransport';

import type { FixtureBranchScript } from './fixtureGitBranches';

describe('HttpTransport git branches and the switch', () => {
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

    it('reads the branches of a place from its route with the folder and the worktree, and gives what the daemon answers', async () => {
        const listing = {
            isRepository: true,
            defaultBranch: 'main',
            local: [{ name: 'main', current: true, default: true }],
            remote: [{ name: 'feature/x' }],
            recent: [],
        };
        const { sent, transport } = transportFor(listing);

        expect(await transport.getGitBranches('prj a', { folderId: 'fld/b' })).toEqual(listing);
        await transport.getGitBranches('prj_a', { folderId: 'fld_b', workspaceId: 'wks 1' });
        expect(sent.map(request => [request.url, request.method])).toEqual([
            ['http://127.0.0.1:4310/v1/projects/prj%20a/git/branches?folderId=fld%2Fb', undefined],
            ['http://127.0.0.1:4310/v1/projects/prj_a/git/branches?folderId=fld_b&workspaceId=wks+1', undefined],
        ]);
    });

    it('posts the branch, and for a new one where it starts, to the switch route, and gives the new head', async () => {
        const answer = { head: { kind: 'branch', name: 'feature/new', commit: 'a'.repeat(40) }, created: true };
        const { sent, transport } = transportFor(answer);

        expect(await transport.switchGitBranch('prj a', { folderId: 'fld/b' }, 'dev')).toEqual(answer);
        await transport.switchGitBranch('prj_a', { folderId: 'fld_b' }, 'feature/new', { start: 'default' });
        expect(sent.map(request => [request.url, request.method, request.body])).toEqual([
            ['http://127.0.0.1:4310/v1/projects/prj%20a/git/switch', 'POST', { folderId: 'fld/b', branch: 'dev' }],
            [
                'http://127.0.0.1:4310/v1/projects/prj_a/git/switch',
                'POST',
                { folderId: 'fld_b', branch: 'feature/new', create: { start: 'default' } },
            ],
        ]);
    });

    it('posts the exact commits of an accepted merge preview to the selected project and worktree', async () => {
        const sourceCommit = 'a'.repeat(40);
        const targetCommit = 'b'.repeat(40);
        const answer = { state: 'done', target: 'next', commit: sourceCommit, canPush: true };
        const { sent, transport } = transportFor(answer);
        const selection = {
            action: 'merge',
            direction: 'into',
            current: 'feature/x',
            branch: 'next',
            sourceCommit,
            targetCommit,
        } as const;
        const place = { folderId: 'fld/b', workspaceId: 'wks 1' };

        expect(await transport.branchMergeGit('prj a', place, selection)).toEqual(answer);
        expect(sent).toEqual([
            {
                url: 'http://127.0.0.1:4310/v1/projects/prj%20a/git/merge',
                method: 'POST',
                body: { ...place, ...selection },
            },
        ]);
    });

    it("rejects with the daemon's reason, the status and the hint, and sends a switch only once", async () => {
        const body = {
            ok: false,
            error: {
                code: 'conflict',
                message: 'Commit or discard the changes first',
                details: { hint: '3 files changed' },
            },
        };
        const { sent, transport } = transportFor(body, 409);

        await expect(transport.switchGitBranch('prj_a', { folderId: 'fld_b' }, 'dev')).rejects.toMatchObject({
            message: 'Commit or discard the changes first',
            status: 409,
            hint: '3 files changed',
        });
        // A switch is not asked for twice, whatever the answer.
        expect(sent).toHaveLength(1);
        await expect(
            transportFor(
                { error: { code: 'conflict', message: 'Merge this branch into origin/main before switching' } },
                409
            ).transport.switchGitBranch('prj_a', { folderId: 'fld_b', workspaceId: 'wks_1' }, 'dev')
        ).rejects.toMatchObject({
            message: 'Merge this branch into origin/main before switching',
            status: 409,
            hint: undefined,
        });
        await expect(
            transportFor(
                { error: { code: 'unavailable', message: 'The switch did not finish in time' } },
                503
            ).transport.switchGitBranch('prj_a', { folderId: 'fld_b' }, 'dev')
        ).rejects.toMatchObject({ status: 503 });
        await expect(
            transportFor(
                { error: { code: 'unavailable', message: 'git did not answer' } },
                503
            ).transport.getGitBranches('prj_a', { folderId: 'fld_b' })
        ).rejects.toMatchObject({ message: 'git did not answer', status: 503 });
    });
});

describe('FixtureTransport git branches and the switch', () => {
    const place = { folderId: 'fld_car_rental' };
    const inWorktree = { ...place, workspaceId: 'wks_ab12cd34' };
    const transportOf = (branches?: FixtureBranchScript[], worktree = false, clean = false) =>
        new FixtureTransport({
            data: worktree ? withFixtureWorkspace(createFixtureData()) : createFixtureData(),
            branches,
            gitWrites: clean ? { clean: true } : undefined,
        });
    const listing = async (transport: FixtureTransport, at: { folderId: string; workspaceId?: string } = place) => {
        const answer = await transport.getGitBranches(FIXTURE_PROJECT_ID, at);

        if (!answer.isRepository) throw new Error('not a repository');

        return answer;
    };

    it("lists the folder's branches with the current and the default one, the upstream and the recent ones", async () => {
        const answer = await listing(transportOf());

        expect(answer.defaultBranch).toBe('main');
        expect(answer.local.map(branch => branch.name)).toEqual(['main', 'dev']);
        expect(answer.local[0]).toMatchObject({ name: 'main', current: true, default: true, upstream: 'origin/main' });
        expect(answer.remote).toEqual([]);
        expect(answer.origin?.map(branch => branch.name)).toEqual(['main', 'dev']);
        expect(answer.recent).toEqual(['dev']);
    });

    it('lists branches only origin has, and branches that worktrees hold, when the page says so', async () => {
        const answer = await listing(transportOf(['remote', 'held']));

        expect(answer.remote.map(branch => branch.name)).toEqual(['feature/search', 'release/2.1', 'chore/deps']);
        expect(answer.local.find(branch => branch.name === 'clowdy/ab12cd34')?.heldBy).toEqual({
            path: FIXTURE_WORKTREE_PATH,
            workspaceId: 'wks_ab12cd34',
        });
        expect(answer.local.find(branch => branch.name === 'feature/payments')?.heldBy).toEqual({
            path: '/Users/dev/car-rental-payments',
        });
    });

    it('switches the checkout to a branch, which every read of its head then says, and answers the new head', async () => {
        const transport = transportOf();
        const answer = await transport.switchGitBranch(FIXTURE_PROJECT_ID, place, 'dev');

        expect(answer).toMatchObject({
            head: { kind: 'branch', name: 'dev' },
            upstream: { name: 'origin/dev', ahead: 0, behind: 0 },
        });
        expect(await transport.getGitStatus(FIXTURE_PROJECT_ID, place)).toMatchObject({
            head: { kind: 'branch', name: 'dev' },
        });
        expect((await listing(transport)).local.find(branch => branch.current)?.name).toBe('dev');
        expect(
            (await transport.getProjectsInfo(FIXTURE_PROJECT_ID))[0]!.folders.find(
                folder => folder.folderId === 'fld_car_rental'
            )?.branch
        ).toBe('dev');
    });

    it('makes a branch of its own, which tracks nothing, and a local branch for one that only origin has, which tracks it', async () => {
        const transport = transportOf(['remote']);

        expect(
            await transport.switchGitBranch(FIXTURE_PROJECT_ID, place, 'feature/new', { start: 'current' })
        ).toMatchObject({ head: { name: 'feature/new' }, created: true });
        expect((await listing(transport)).local.find(branch => branch.name === 'feature/new')).toMatchObject({
            current: true,
        });
        expect(
            (await listing(transport)).local.find(branch => branch.name === 'feature/new')?.upstream
        ).toBeUndefined();

        expect(await transport.switchGitBranch(FIXTURE_PROJECT_ID, place, 'feature/search')).toMatchObject({
            head: { name: 'feature/search' },
            upstream: { name: 'origin/feature/search' },
            created: true,
        });

        const after = await listing(transport);

        expect(after.remote.map(branch => branch.name)).toEqual(['release/2.1', 'chore/deps']);
        expect(after.local.find(branch => branch.name === 'feature/search')?.upstream).toBe('origin/feature/search');
    });

    it('keeps the previous worktree branch available and shows the new branch as held from the main checkout', async () => {
        const transport = transportOf(['merged'], true, true);

        await transport.switchGitBranch(FIXTURE_PROJECT_ID, inWorktree, 'dev');

        const worktree = await listing(transport, inWorktree);
        expect(worktree.local.find(branch => branch.name === 'dev')?.current).toBe(true);
        expect(worktree.local.find(branch => branch.name === 'clowdy/ab12cd34')).toEqual(
            expect.objectContaining({ name: 'clowdy/ab12cd34' })
        );
        expect(worktree.local.find(branch => branch.name === 'clowdy/ab12cd34')?.heldBy).toBeUndefined();
        expect((await listing(transport)).local.find(branch => branch.name === 'dev')?.heldBy?.workspaceId).toBe(
            inWorktree.workspaceId
        );

        await expect(
            transport.switchGitBranch(FIXTURE_PROJECT_ID, inWorktree, 'clowdy/ab12cd34')
        ).resolves.toMatchObject({
            head: { name: 'clowdy/ab12cd34' },
        });
    });

    it('refuses as the daemon does: an unmerged worktree, a bad name, a missing branch, a name taken, a branch held elsewhere', async () => {
        const transport = transportOf(['held', 'remote'], true, true);

        await expect(transport.switchGitBranch(FIXTURE_PROJECT_ID, inWorktree, 'dev')).rejects.toMatchObject({
            status: 409,
            message: 'Merge this branch into origin/main before switching',
        });
        await expect(transport.switchGitBranch(FIXTURE_PROJECT_ID, place, '-x')).rejects.toMatchObject({
            status: 400,
            message: 'A branch name cannot start with a dash',
        });
        await expect(transport.switchGitBranch(FIXTURE_PROJECT_ID, place, 'a b')).rejects.toMatchObject({
            status: 400,
            message: 'a b is not a branch name',
        });
        await expect(transport.switchGitBranch(FIXTURE_PROJECT_ID, place, '')).rejects.toMatchObject({ status: 400 });
        await expect(transport.switchGitBranch(FIXTURE_PROJECT_ID, place, 'nope')).rejects.toMatchObject({
            status: 400,
            message: 'There is no branch called nope',
        });
        await expect(
            transport.switchGitBranch(FIXTURE_PROJECT_ID, place, 'dev', { start: 'current' })
        ).rejects.toMatchObject({ status: 400, message: 'A branch called dev exists already' });
        await expect(
            transport.switchGitBranch(FIXTURE_PROJECT_ID, place, 'feature/search', { start: 'current' })
        ).rejects.toMatchObject({ status: 400, message: 'origin has a branch called feature/search already' });
        await expect(transport.switchGitBranch(FIXTURE_PROJECT_ID, place, 'clowdy/ab12cd34')).rejects.toMatchObject({
            status: 409,
            message: `Checked out in ${FIXTURE_WORKTREE_PATH}`,
        });
        await expect(
            transport.switchGitBranch(FIXTURE_PROJECT_ID, { folderId: 'fld_none' }, 'dev')
        ).rejects.toMatchObject({ status: 404 });
        // Nothing moved.
        expect((await listing(transport)).local.find(branch => branch.current)?.name).toBe('main');
    });

    it('refuses a dirty checkout with the count, and shows its files in the status and the changes', async () => {
        const transport = transportOf(['dirty']);

        await expect(transport.switchGitBranch(FIXTURE_PROJECT_ID, place, 'dev')).rejects.toMatchObject({
            status: 409,
            message: 'Commit or discard the changes first',
            hint: '3 files changed',
        });

        const status = await transport.getGitStatus(FIXTURE_PROJECT_ID, place);

        expect(status.isRepository && status.entries.map(entry => entry.path)).toEqual([
            'notes.md',
            'src/booking/price.ts',
            'src/limits.ts',
        ]);

        const changes = await transport.getGitChanges(FIXTURE_PROJECT_ID, place, 'all');

        expect(changes.isRepository && changes.files.map(file => file.path)).toEqual([
            'notes.md',
            'src/booking/price.ts',
            'src/limits.ts',
        ]);
        // The clean checkout has nothing.
        expect(await transportOf().getGitChanges(FIXTURE_PROJECT_ID, place, 'all')).toMatchObject({ files: [] });
    });

    it('refuses for the chats working there, and takes a while when the page says so', async () => {
        await expect(transportOf(['refused']).switchGitBranch(FIXTURE_PROJECT_ID, place, 'dev')).rejects.toMatchObject({
            status: 409,
            message: '2 chats are working here',
            hint: 'Stop them or wait until they finish',
        });

        vi.useFakeTimers();

        try {
            const pending = transportOf(['slow']).switchGitBranch(FIXTURE_PROJECT_ID, place, 'dev');
            let settled = false;

            void pending.then(() => {
                settled = true;
            });
            await vi.advanceTimersByTimeAsync(2000);
            expect(settled).toBe(false);
            await vi.advanceTimersByTimeAsync(1000);
            expect(await pending).toMatchObject({ head: { name: 'dev' } });
        } finally {
            vi.useRealTimers();
        }
    });

    it("says a worktree's list from the worktree: its own branch is the current one and the main checkout's is held", async () => {
        const answer = await listing(transportOf(['held'], true), inWorktree);

        expect(answer.local.find(branch => branch.name === 'clowdy/ab12cd34')).toMatchObject({ current: true });
        expect(answer.local.find(branch => branch.name === 'main')?.heldBy).toEqual({
            path: '/Users/dev/car-rental',
            main: true,
        });
    });

    describe("chat.create in the folder's own checkout on a branch", () => {
        const create = (transport: FixtureTransport, branch: string, extra: Record<string, unknown> = {}) =>
            transport.command({
                type: 'chat.create',
                projectId: FIXTURE_PROJECT_ID,
                workspace: { mode: 'main', branch },
                ...extra,
            });
        const chatsOf = (transport: FixtureTransport) => transport.getProjectSnapshot(FIXTURE_PROJECT_ID);

        it('switches the checkout and makes the chat after it, in the folder as it is: no worktree', async () => {
            const transport = transportOf(['remote']);
            const before = (await chatsOf(transport)).chats.length;
            const result = await create(transport, 'feature/search');

            expect(result.ok).toBe(true);

            const { chat } = (result.ok ? result.data : {}) as { chat: { workspace?: unknown } };

            expect(chat.workspace).toBeUndefined();
            expect((await chatsOf(transport)).chats).toHaveLength(before + 1);
            expect((await listing(transport)).local.find(branch => branch.current)?.name).toBe('feature/search');
        });

        it('answers a branch the checkout is on as made, with nothing switched', async () => {
            const transport = transportOf(['dirty']);
            const result = await create(transport, 'main');

            expect(result.ok).toBe(true);
            expect((await listing(transport)).local.find(branch => branch.current)?.name).toBe('main');
        });

        it('makes no chat for a refusal, and says why in the daemon words with the hint', async () => {
            const transport = transportOf(['dirty']);
            const before = (await chatsOf(transport)).chats.length;
            const result = await create(transport, 'dev');

            expect(result).toMatchObject({
                ok: false,
                error: {
                    code: 'conflict',
                    message: 'Commit or discard the changes first',
                    details: { hint: '3 files changed' },
                },
            });
            expect((await chatsOf(transport)).chats).toHaveLength(before);
            expect((await listing(transport)).local.find(branch => branch.current)?.name).toBe('main');
            expect(await create(transportOf(['refused']), 'dev')).toMatchObject({
                ok: false,
                error: { code: 'conflict', message: '2 chats are working here' },
            });
            expect(await create(transportOf(['held']), 'feature/payments')).toMatchObject({
                ok: false,
                error: { code: 'conflict', message: 'Checked out in /Users/dev/car-rental-payments' },
            });
            expect(await create(transportOf(), 'nowhere')).toMatchObject({
                ok: false,
                error: { code: 'invalid', message: 'There is no branch called nowhere' },
            });
        });

        it('judges the agent and the folder before it switches anything', async () => {
            const transport = transportOf();

            expect(await create(transport, 'dev', { engine: 'nobody' })).toMatchObject({
                ok: false,
                error: { code: 'unavailable' },
            });
            expect(await create(transport, 'dev', { folderId: 'fld_nobody' })).toMatchObject({
                ok: false,
                error: { code: 'invalid' },
            });
            expect((await listing(transport)).local.find(branch => branch.current)?.name).toBe('main');
        });

        it('carries the warning of a switch whose hook failed, and waits for a slow one', async () => {
            expect(await create(transportOf(['warned']), 'dev')).toMatchObject({
                ok: true,
                data: { warning: 'post-checkout: the install failed' },
            });

            vi.useFakeTimers();

            try {
                const pending = create(transportOf(['slow']), 'dev');
                let settled = false;

                void pending.then(() => {
                    settled = true;
                });
                await vi.advanceTimersByTimeAsync(2000);
                expect(settled).toBe(false);
                await vi.advanceTimersByTimeAsync(1000);
                expect(await pending).toMatchObject({ ok: true });
            } finally {
                vi.useRealTimers();
            }
        });

        it('is a chat as it was for any other choice: no switch', async () => {
            const transport = transportOf(['dirty']);
            const result = await transport.command({ type: 'chat.create', projectId: FIXTURE_PROJECT_ID });

            expect(result.ok).toBe(true);
            expect((await listing(transport)).local.find(branch => branch.current)?.name).toBe('main');
        });
    });

    it('is no repository for a folder with no git', async () => {
        const transport = new FixtureTransport({ data: withFixtureWorktrees(createFixtureData()) });

        expect(await transport.getGitBranches(FIXTURE_PROJECT_ID, { folderId: 'fld_notes' })).toEqual({
            isRepository: false,
        });
        await expect(
            transport.switchGitBranch(FIXTURE_PROJECT_ID, { folderId: 'fld_notes' }, 'main')
        ).rejects.toMatchObject({ status: 400, message: 'The folder is not the root of a git repository' });
    });
});

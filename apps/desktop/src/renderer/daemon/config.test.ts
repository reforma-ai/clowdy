import { describe, expect, it } from 'vitest';

import { createTransport, resolveDaemonConfig } from './config';
import { createFixtureTransport, fixtureOptions } from './fixtures';
import { FixtureTransport } from './fixtureTransport';
import { HttpTransport } from './httpTransport';

describe('resolveDaemonConfig', () => {
    const bridge = { url: 'http://127.0.0.1:1', token: 'from-bridge' };

    it('prefers what the desktop shell provides over the page URL', () => {
        expect(resolveDaemonConfig('?daemon=http://x&token=y&fixtures', bridge)).toEqual({ kind: 'daemon', ...bridge });
    });

    it('reads the daemon and token from the page URL', () => {
        expect(resolveDaemonConfig('?daemon=http://127.0.0.1:4310&token=abc&fixtures')).toEqual({
            kind: 'daemon',
            url: 'http://127.0.0.1:4310',
            token: 'abc',
        });
    });

    it('uses fixtures when asked, with or without the timed events', () => {
        expect(resolveDaemonConfig('?fixtures=static&worktree')).toEqual({
            kind: 'fixtures',
            search: '?fixtures=static&worktree',
        });
        expect(fixtureOptions('?fixtures=1')).toEqual({ timeline: true });
        expect(fixtureOptions('?fixtures')).toEqual({ timeline: true });
        expect(fixtureOptions('?fixtures=static')).toEqual({ timeline: false });
        expect(fixtureOptions('?fixtures=static&worktree')).toEqual({
            timeline: false,
            worktree: true,
        });
    });

    it('says how a commit and its message end in the fixtures, for the words it knows', () => {
        expect(fixtureOptions('?fixtures=static&worktree&commit=signing&message=failed')).toEqual({
            timeline: false,
            worktree: true,
            commit: 'signing',
            message: 'failed',
        });
        expect(fixtureOptions('?fixtures=static&commit=hook')).toEqual({
            timeline: false,
            commit: 'hook',
        });
        expect(fixtureOptions('?fixtures=static&commit=slow&message=slow')).toEqual({
            timeline: false,
            commit: 'slow',
            message: 'slow',
        });
        expect(fixtureOptions('?fixtures=static&commit=other&message=signing')).toEqual({
            timeline: false,
        });
    });

    it('says how a discard ends in the fixtures, for the words it knows', () => {
        for (const discard of ['slow', 'refused', 'hook']) {
            expect(fixtureOptions(`?fixtures=static&worktree&discard=${discard}`)).toEqual({
                timeline: false,
                worktree: true,
                discard,
            });
        }

        expect(fixtureOptions('?fixtures=static&discard=ok')).toEqual({ timeline: false });
        expect(fixtureOptions('?fixtures=static&discard=failed')).toEqual({ timeline: false });
    });

    it("says how a fetch, a pull and a push end in the fixtures, and what GitHub says of the worktree's branch, for the words it knows", () => {
        expect(fixtureOptions('?fixtures=static&worktree&remote=rejected&pr=none')).toEqual({
            timeline: false,
            worktree: true,
            remote: 'rejected',
            pr: 'none',
        });

        for (const remote of [
            'slow',
            'behind',
            'ahead',
            'level',
            'never',
            'diverged',
            'rejected',
            'signing',
            'offline',
            'no_origin',
            'detached',
            'unborn',
        ]) {
            expect(fixtureOptions(`?fixtures=static&remote=${remote}`)).toEqual({
                timeline: false,
                remote,
            });
        }

        for (const pr of [
            'none',
            'open',
            'draft',
            'merged',
            'closed',
            'no_gh',
            'not_signed_in',
            'no_remote',
            'unavailable',
        ]) {
            expect(fixtureOptions(`?fixtures=static&pr=${pr}`)).toEqual({ timeline: false, pr });
        }

        expect(fixtureOptions('?fixtures=static&remote=failed&pr=maybe')).toEqual({
            timeline: false,
        });
    });

    it('leaves the worktree clean, or on the base branch, when the page says &clean or &base', () => {
        expect(fixtureOptions('?fixtures=static&worktree&clean')).toEqual({
            timeline: false,
            worktree: true,
            clean: true,
        });
        expect(fixtureOptions('?fixtures=static&worktree&base&remote=level')).toEqual({
            timeline: false,
            worktree: true,
            base: true,
            remote: 'level',
        });
        expect(fixtureOptions('?fixtures=static&worktree')).not.toHaveProperty('clean');
    });

    it('has nothing otherwise', () => {
        expect(resolveDaemonConfig('')).toEqual({ kind: 'none' });
        expect(resolveDaemonConfig('?other=1')).toEqual({ kind: 'none' });
    });
});

describe('createTransport and the fixture transport', () => {
    it('makes the transport the config names', async () => {
        expect(await createTransport({ kind: 'daemon', url: 'http://d', token: 't' })).toBeInstanceOf(HttpTransport);
        expect(await createTransport({ kind: 'fixtures', search: '?fixtures=static' })).toBeInstanceOf(
            FixtureTransport
        );
    });

    it('adds the chat in a dirty worktree to the fixtures when asked, for the Changes tab to show', async () => {
        const plain = await createFixtureTransport({ timeline: false }).getRootSnapshot();
        const withTree = createFixtureTransport({ timeline: false, worktree: true });
        const project = plain.projects.find(candidate =>
            candidate.folders.some(folder => folder.id === 'fld_car_rental')
        )!;

        expect((await withTree.getProjectSnapshot(project.id)).chats.map(chat => chat.id)).toContain('c-9');
        expect(
            (await createFixtureTransport({ timeline: false }).getProjectSnapshot(project.id)).chats.map(
                chat => chat.id
            )
        ).not.toContain('c-9');
    });

    it("says what GitHub says of the worktree's branch when the page asks, and how the remote ends", async () => {
        const place = { folderId: 'fld_car_rental', workspaceId: 'wks_ab12cd34' };
        const project = (await createFixtureTransport({ timeline: false }).getRootSnapshot()).projects.find(candidate =>
            candidate.folders.some(folder => folder.id === 'fld_car_rental')
        )!;
        const open = createFixtureTransport({ timeline: false, worktree: true });
        const none = createFixtureTransport({
            timeline: false,
            worktree: true,
            pr: 'none',
            remote: 'offline',
        });

        expect(await open.getGitPullRequest(project.id, place)).toMatchObject({ pullRequest: { number: 128 } });
        expect(
            ((await none.getGitPullRequest(project.id, place)) as { pullRequest?: unknown }).pullRequest
        ).toBeUndefined();
        await expect(none.fetchGit(project.id, place)).rejects.toMatchObject({ status: 409 });
    });

    it("has the chat's worktree with nothing uncommitted for `clean`, and on the base branch for `base`", async () => {
        const place = { folderId: 'fld_car_rental', workspaceId: 'wks_ab12cd34' };
        const project = (await createFixtureTransport({ timeline: false }).getRootSnapshot()).projects.find(candidate =>
            candidate.folders.some(folder => folder.id === 'fld_car_rental')
        )!;
        const clean = await createFixtureTransport({
            timeline: false,
            worktree: true,
            clean: true,
        }).getGitStatus(project.id, place);
        const onBase = await createFixtureTransport({
            timeline: false,
            worktree: true,
            base: true,
        }).getGitStatus(project.id, place);

        expect(clean).toMatchObject({ isRepository: true, entries: [], head: { name: 'clowdy/ab12cd34' } });
        expect(onBase).toMatchObject({
            isRepository: true,
            head: { kind: 'branch', name: 'main' },
            base: { name: 'origin/main' },
        });
        expect((onBase as { entries: unknown[] }).entries).toHaveLength(3);
    });

    it('makes a transport that cannot reach anything when there is no config', async () => {
        const transport = await createTransport({ kind: 'none' });

        await expect(transport.getRootSnapshot()).rejects.toThrow('No daemon is configured');
        await expect(transport.pushGit('p', { folderId: 'f' })).rejects.toThrow('No daemon is configured');
        await expect(transport.discardGit('p', { folderId: 'f' }, ['a.ts'])).rejects.toThrow('No daemon is configured');
        await expect(transport.command({ type: 'run.cancel', runId: 'r' })).rejects.toThrow('No daemon is configured');
    });
});

describe('fixtureOptions and the words of &branches=', () => {
    it('reads each word of the branches switch the fixtures know, in the order given, and leaves out the others', () => {
        expect(fixtureOptions('?fixtures=static&branches=idle,dirty,warned,nope,remote')).toEqual({
            timeline: false,
            branches: ['idle', 'dirty', 'warned', 'remote'],
        });
        expect(fixtureOptions('?fixtures=static&branches=')).toEqual({ timeline: false });
        expect(fixtureOptions('?fixtures=static&branches=held,refused,slow')).toEqual({
            timeline: false,
            branches: ['held', 'refused', 'slow'],
        });
    });
});

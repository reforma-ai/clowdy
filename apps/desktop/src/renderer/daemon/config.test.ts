import { describe, expect, it } from 'vitest';

import { createTransport, resolveDaemonConfig } from './config';
import { FixtureTransport } from './fixtureTransport';
import { HttpTransport } from './httpTransport';

describe('resolveDaemonConfig', () => {
    const bridge = { url: 'http://127.0.0.1:1', token: 'from-bridge' };

    it('prefers what the desktop shell provides over the page URL', () => {
        expect(resolveDaemonConfig('?daemon=http://x&token=y&fixtures', bridge)).toEqual({ kind: 'daemon', ...bridge });
    });

    it('reads the daemon and token from the page URL', () => {
        expect(resolveDaemonConfig('?daemon=http://127.0.0.1:4310&token=abc&fixtures')).toEqual({ kind: 'daemon', url: 'http://127.0.0.1:4310', token: 'abc' });
    });

    it('uses fixtures when asked, with or without the timed events', () => {
        expect(resolveDaemonConfig('?fixtures=1')).toEqual({ kind: 'fixtures', timeline: true });
        expect(resolveDaemonConfig('?fixtures')).toEqual({ kind: 'fixtures', timeline: true });
        expect(resolveDaemonConfig('?fixtures=static')).toEqual({ kind: 'fixtures', timeline: false });
        expect(resolveDaemonConfig('?fixtures=static&worktree')).toEqual({ kind: 'fixtures', timeline: false, worktree: true });
    });

    it('says how a commit and its message end in the fixtures, for the words it knows', () => {
        expect(resolveDaemonConfig('?fixtures=static&worktree&commit=signing&message=failed')).toEqual({ kind: 'fixtures', timeline: false, worktree: true, commit: 'signing', message: 'failed' });
        expect(resolveDaemonConfig('?fixtures=static&commit=hook')).toEqual({ kind: 'fixtures', timeline: false, commit: 'hook' });
        expect(resolveDaemonConfig('?fixtures=static&commit=slow&message=slow')).toEqual({ kind: 'fixtures', timeline: false, commit: 'slow', message: 'slow' });
        expect(resolveDaemonConfig('?fixtures=static&commit=other&message=signing')).toEqual({ kind: 'fixtures', timeline: false });
    });

    it('says how a fetch, a pull and a push end in the fixtures, and what GitHub says of the worktree\'s branch, for the words it knows', () => {
        expect(resolveDaemonConfig('?fixtures=static&worktree&remote=rejected&pr=none')).toEqual({ kind: 'fixtures', timeline: false, worktree: true, remote: 'rejected', pr: 'none' });

        for (const remote of ['slow', 'behind', 'ahead', 'level', 'never', 'diverged', 'rejected', 'signing', 'offline', 'no_origin', 'detached', 'unborn']) {
            expect(resolveDaemonConfig(`?fixtures=static&remote=${ remote }`)).toEqual({ kind: 'fixtures', timeline: false, remote });
        }

        for (const pr of ['none', 'open', 'draft', 'merged', 'closed', 'no_gh', 'not_signed_in', 'no_remote', 'unavailable']) {
            expect(resolveDaemonConfig(`?fixtures=static&pr=${ pr }`)).toEqual({ kind: 'fixtures', timeline: false, pr });
        }

        expect(resolveDaemonConfig('?fixtures=static&remote=failed&pr=maybe')).toEqual({ kind: 'fixtures', timeline: false });
    });

    it('leaves the worktree clean, or on the base branch, when the page says &clean or &base', () => {
        expect(resolveDaemonConfig('?fixtures=static&worktree&clean')).toEqual({ kind: 'fixtures', timeline: false, worktree: true, clean: true });
        expect(resolveDaemonConfig('?fixtures=static&worktree&base&remote=level')).toEqual({ kind: 'fixtures', timeline: false, worktree: true, base: true, remote: 'level' });
        expect(resolveDaemonConfig('?fixtures=static&worktree')).not.toHaveProperty('clean');
    });

    it('has nothing otherwise', () => {
        expect(resolveDaemonConfig('')).toEqual({ kind: 'none' });
        expect(resolveDaemonConfig('?other=1')).toEqual({ kind: 'none' });
    });
});

describe('createTransport', () => {
    it('makes the transport the config names', () => {
        expect(createTransport({ kind: 'daemon', url: 'http://d', token: 't' })).toBeInstanceOf(HttpTransport);
        expect(createTransport({ kind: 'fixtures', timeline: false })).toBeInstanceOf(FixtureTransport);
    });

    it('adds the chat in a dirty worktree to the fixtures when asked, for the Changes tab to show', async () => {
        const plain = await createTransport({ kind: 'fixtures', timeline: false }).getRootSnapshot();
        const withTree = createTransport({ kind: 'fixtures', timeline: false, worktree: true });
        const project = plain.projects.find(candidate => candidate.folders.some(folder => folder.id === 'fld_car_rental'))!;

        expect((await withTree.getProjectSnapshot(project.id)).chats.map(chat => chat.id)).toContain('c-9');
        expect((await createTransport({ kind: 'fixtures', timeline: false }).getProjectSnapshot(project.id)).chats.map(chat => chat.id)).not.toContain('c-9');
    });

    it('says what GitHub says of the worktree\'s branch when the page asks, and how the remote ends', async () => {
        const place = { folderId: 'fld_car_rental', workspaceId: 'wks_ab12cd34' };
        const project = (await createTransport({ kind: 'fixtures', timeline: false }).getRootSnapshot()).projects.find(candidate => candidate.folders.some(folder => folder.id === 'fld_car_rental'))!;
        const open = createTransport({ kind: 'fixtures', timeline: false, worktree: true });
        const none = createTransport({ kind: 'fixtures', timeline: false, worktree: true, pr: 'none', remote: 'offline' });

        expect(await open.getGitPullRequest(project.id, place)).toMatchObject({ pullRequest: { number: 128 } });
        expect((await none.getGitPullRequest(project.id, place) as { pullRequest?: unknown }).pullRequest).toBeUndefined();
        await expect(none.fetchGit(project.id, place)).rejects.toMatchObject({ status: 409 });
    });

    it('has the chat\'s worktree with nothing uncommitted for `clean`, and on the base branch for `base`', async () => {
        const place = { folderId: 'fld_car_rental', workspaceId: 'wks_ab12cd34' };
        const project = (await createTransport({ kind: 'fixtures', timeline: false }).getRootSnapshot()).projects.find(candidate => candidate.folders.some(folder => folder.id === 'fld_car_rental'))!;
        const clean = await createTransport({ kind: 'fixtures', timeline: false, worktree: true, clean: true }).getGitStatus(project.id, place);
        const onBase = await createTransport({ kind: 'fixtures', timeline: false, worktree: true, base: true }).getGitStatus(project.id, place);

        expect(clean).toMatchObject({ isRepository: true, entries: [], head: { name: 'clowdy/ab12cd34' } });
        expect(onBase).toMatchObject({ isRepository: true, head: { kind: 'branch', name: 'main' }, base: { name: 'origin/main' } });
        expect((onBase as { entries: unknown[] }).entries).toHaveLength(3);
    });

    it('makes a transport that cannot reach anything when there is no config', async () => {
        const transport = createTransport({ kind: 'none' });

        await expect(transport.getRootSnapshot()).rejects.toThrow('No daemon is configured');
        await expect(transport.pushGit('p', { folderId: 'f' })).rejects.toThrow('No daemon is configured');
        await expect(transport.command({ type: 'run.cancel', runId: 'r' })).rejects.toThrow('No daemon is configured');
    });
});

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

    it('makes a transport that cannot reach anything when there is no config', async () => {
        const transport = createTransport({ kind: 'none' });

        await expect(transport.getRootSnapshot()).rejects.toThrow('No daemon is configured');
        await expect(transport.command({ type: 'run.cancel', runId: 'r' })).rejects.toThrow('No daemon is configured');
    });
});

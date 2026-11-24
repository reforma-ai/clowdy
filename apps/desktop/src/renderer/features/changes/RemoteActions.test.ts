import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TransportError } from '../../daemon/transport';
import { type GitPlaceKey, PlaceFacts } from './gitFacts';
import { NOTICE_MS, RemoteActions, type RemoteTransport, remoteActionsOf } from './RemoteActions';

import type { GitRemoteResult } from '@clowdy/protocol';

const KEY: GitPlaceKey = { projectId: 'prj_a', folderId: 'fld_b', workspaceId: 'wks_c' };
const PLACE = { folderId: 'fld_b', workspaceId: 'wks_c' };

/** A transport whose three actions answer what the test says, and an actions model over it for a place. */
function setup() {
    const done = (action: 'fetch' | 'pull' | 'push'): GitRemoteResult => ({ state: 'done', action });
    const transport = {
        fetchGit: vi.fn(async (): Promise<GitRemoteResult> => done('fetch')),
        pullGit: vi.fn(async (): Promise<GitRemoteResult> => ({ state: 'done', action: 'pull', pulled: 2 })),
        pushGit: vi.fn(async (): Promise<GitRemoteResult> => done('push')),
    };
    const refresh = vi.fn();
    const facts = new PlaceFacts(KEY, {
        getGitStatus: vi.fn(),
        getGitChanges: vi.fn(),
        getGitPullRequest: vi.fn(),
    } as never);

    return {
        transport,
        refresh,
        facts,
        actions: new RemoteActions(facts, transport as unknown as RemoteTransport, refresh),
    };
}

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

describe('the moves of a place to and from origin', () => {
    it('runs each action and refreshes the place without a success notice', async () => {
        const { actions, transport, refresh } = setup();

        expect(await actions.run('fetch')).toEqual({ ok: true, result: { state: 'done', action: 'fetch' } });
        expect(transport.fetchGit).toHaveBeenCalledWith('prj_a', PLACE);
        expect(actions.notice).toBeUndefined();

        await actions.run('pull');
        expect(transport.pullGit).toHaveBeenCalledWith('prj_a', PLACE);
        expect(actions.notice).toBeUndefined();

        await actions.run('push');
        expect(transport.pushGit).toHaveBeenCalledTimes(1);
        expect(actions.notice).toBeUndefined();

        // Publishing sends the branch through the push call.
        transport.pushGit.mockResolvedValueOnce({ state: 'done', action: 'push', published: true });
        await actions.run('publish');
        expect(transport.pushGit).toHaveBeenCalledTimes(2);
        expect(actions.notice).toBeUndefined();
        expect(refresh).toHaveBeenCalledTimes(4);
        expect(actions.running).toBeUndefined();
    });

    it('lets the conflict notice expire and keeps a failure until the person acts again', async () => {
        const { actions, transport } = setup();

        transport.pullGit.mockResolvedValueOnce({ state: 'conflicts', action: 'pull', conflicts: 2 });
        await actions.run('pull');
        expect(actions.notice).toBeDefined();
        vi.advanceTimersByTime(NOTICE_MS - 1);
        expect(actions.notice).toBeDefined();
        vi.advanceTimersByTime(1);
        expect(actions.notice).toBeUndefined();

        transport.pushGit.mockRejectedValueOnce(
            new TransportError('! [rejected] main -> main (fetch first)', 409, 'Pull first')
        );
        expect(await actions.run('push')).toEqual({
            ok: false,
            failure: { action: 'push', message: '! [rejected] main -> main (fetch first)', hint: 'Pull first' },
        });
        expect(actions.failure).toEqual({
            action: 'push',
            message: '! [rejected] main -> main (fetch first)',
            hint: 'Pull first',
        });
        vi.advanceTimersByTime(NOTICE_MS * 10);
        expect(actions.failure).toBeDefined();

        await actions.run('fetch');
        expect(actions.failure).toBeUndefined();
        expect(actions.notice).toBeUndefined();
    });

    it('submits another action to the daemon while reusing the pending fetch', async () => {
        const { actions, transport } = setup();
        const fetchReply = Promise.withResolvers<GitRemoteResult>();
        const pushReply = Promise.withResolvers<GitRemoteResult>();
        transport.fetchGit.mockReturnValueOnce(fetchReply.promise);
        transport.pushGit.mockReturnValueOnce(pushReply.promise);

        const fetch = actions.run('fetch');
        const push = actions.run('push');

        expect(actions.running).toBe('fetch');
        expect(actions.busy).toBe(true);
        expect(actions.isPending('push')).toBe(true);
        expect(actions.run('fetch', { report: false })).toBe(fetch);
        expect(transport.fetchGit).toHaveBeenCalledTimes(1);
        expect(transport.pushGit).toHaveBeenCalledWith('prj_a', PLACE);

        fetchReply.resolve({ state: 'done', action: 'fetch' });
        await fetch;
        expect(actions.running).toBe('push');
        expect(actions.isPending('fetch')).toBe(false);

        pushReply.resolve({ state: 'done', action: 'push' });
        await expect(push).resolves.toMatchObject({ ok: true });
        expect(actions.busy).toBe(false);
    });

    it("is busy while the place's branch is being changed, and refuses an action then, with nothing sent", async () => {
        const { actions, transport, facts } = setup();

        facts.switching = true;

        expect(actions.running).toBeUndefined();
        expect(actions.busy).toBe(true);
        expect(await actions.run('push')).toEqual({
            ok: false,
            failure: { action: 'push', message: 'The branch is being changed' },
        });
        expect(transport.pushGit).not.toHaveBeenCalled();
        expect(actions.failure).toBeUndefined();

        facts.switching = false;

        expect(actions.busy).toBe(false);
        expect(await actions.run('push')).toMatchObject({ ok: true });
    });

    it('says a merge that stopped as a warning that is not a failure', async () => {
        const { actions, transport } = setup();

        transport.pullGit.mockResolvedValueOnce({ state: 'conflicts', action: 'pull', conflicts: 2 });

        const outcome = await actions.run('pull');

        expect(outcome.ok).toBe(true);
        expect(actions.failure).toBeUndefined();
        expect(actions.notice).toEqual({ words: '2 conflicts', tone: 'warning' });
    });

    it('keeps its say to the caller that asked for it, and still reads the place again', async () => {
        const { actions, transport, refresh } = setup();

        expect((await actions.run('push', { report: false })).ok).toBe(true);
        expect(actions.notice).toBeUndefined();

        transport.pushGit.mockRejectedValueOnce(new TransportError('hook said no', 409));
        expect(await actions.run('push', { report: false })).toMatchObject({
            ok: false,
            failure: { message: 'hook said no' },
        });
        expect(actions.failure).toBeUndefined();
        expect(refresh).toHaveBeenCalledTimes(2);
    });

    it('reads the place again when an action failed too, since a push that was rejected may have moved something', async () => {
        const { actions, transport, refresh } = setup();

        transport.fetchGit.mockRejectedValueOnce(new TransportError('fatal: unable to access', 409));
        await actions.run('fetch');
        expect(refresh).toHaveBeenCalledTimes(1);
    });

    it('can be dismissed, and is one for a place for as long as its facts are', () => {
        const { actions, facts, transport, refresh } = setup();

        actions.notice = { words: '2 conflicts', tone: 'warning' };
        actions.dismiss();
        expect(actions.notice).toBeUndefined();

        const kept = remoteActionsOf(facts, transport as unknown as RemoteTransport, refresh);

        expect(remoteActionsOf(facts, transport as unknown as RemoteTransport, refresh)).toBe(kept);
        expect(
            remoteActionsOf(
                new PlaceFacts(KEY, {
                    getGitStatus: vi.fn(),
                    getGitChanges: vi.fn(),
                    getGitPullRequest: vi.fn(),
                } as never),
                transport as unknown as RemoteTransport,
                refresh
            )
        ).not.toBe(kept);
    });
});

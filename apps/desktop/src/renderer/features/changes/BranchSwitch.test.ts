import { describe, expect, it, vi } from 'vitest';

import { TransportError } from '../../daemon/transport';
import { type BranchTransport, branchSwitchOf } from './BranchSwitch';
import { PlaceFacts } from './gitFacts';

import type { GitBranches, GitSwitchResult } from '@clowdy/protocol';

const KEY = { projectId: 'p-1', folderId: 'f-1' };
const LISTING: GitBranches = {
    isRepository: true,
    defaultBranch: 'main',
    local: [{ name: 'main', current: true, default: true }, { name: 'dev' }],
    remote: [],
    recent: ['dev'],
};
const RESULT: GitSwitchResult = { head: { kind: 'branch', name: 'dev', commit: 'a'.repeat(40) } };

/** A transport whose reads and switches are answered when the test says so. */
function transport() {
    const reads: Array<{ resolve: (answer: GitBranches) => void; reject: (error: unknown) => void }> = [];
    const switches: Array<{
        branch: string;
        create?: unknown;
        resolve: (answer: GitSwitchResult) => void;
        reject: (error: unknown) => void;
    }> = [];
    const stand: BranchTransport = {
        getGitBranches: vi.fn(
            () => new Promise<GitBranches>((resolve, reject) => void reads.push({ resolve, reject }))
        ),
        switchGitBranch: vi.fn(
            (_project, _place, branch, create) =>
                new Promise<GitSwitchResult>(
                    (resolve, reject) => void switches.push({ branch, create, resolve, reject })
                )
        ),
    };

    return { stand, reads, switches };
}

/** A model of a place that no other test has, since a model is kept for its facts. */
function model(stand: BranchTransport, refresh = vi.fn()) {
    const facts = new PlaceFacts(KEY, { getGitStatus: vi.fn(), getGitChanges: vi.fn(), getGitPullRequest: vi.fn() });

    return { model: branchSwitchOf(facts, stand, refresh), refresh, facts };
}

const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));

describe('BranchSwitch', () => {
    it('reads the branches of the place and keeps them, with the loading state around the read', async () => {
        const { stand, reads } = transport();
        const { model: branches } = model(stand);
        const pending = branches.load();

        expect(branches.loading).toBe(true);
        expect(stand.getGitBranches).toHaveBeenCalledExactlyOnceWith('p-1', { folderId: 'f-1' });

        reads[0]!.resolve(LISTING);
        await pending;

        expect(branches.loading).toBe(false);
        expect(branches.listing).toEqual(LISTING);
        expect(branches.listFailure).toBeUndefined();
    });

    it('drops the answer of a read that a newer one has passed, and keeps what it knew when a read fails, saying why', async () => {
        const { stand, reads } = transport();
        const { model: branches } = model(stand);
        const first = branches.load();
        const second = branches.load();

        reads[1]!.resolve(LISTING);
        await second;
        reads[0]!.resolve({ ...LISTING, recent: [] });
        await first;
        expect(branches.listing).toEqual(LISTING);

        const third = branches.load();

        reads[2]!.reject(new TransportError('git did not answer', 503));
        await third;
        expect(branches.listing).toEqual(LISTING);
        expect(branches.listFailure).toBe('git did not answer');
        expect(branches.loading).toBe(false);
    });

    it('has no listing for a folder that is no repository', async () => {
        const { stand, reads } = transport();
        const { model: branches } = model(stand);
        const pending = branches.load();

        reads[0]!.resolve({ isRepository: false });
        await pending;
        expect(branches.listing).toBeUndefined();
    });

    it('switches, says it is running while it does, drops the old listing and reads the place again when it ends', async () => {
        const { stand, reads, switches } = transport();
        const { model: branches, refresh, facts } = model(stand);
        const read = branches.load();

        reads[0]!.resolve(LISTING);
        await read;

        const pending = branches.switchTo('dev');

        expect(branches.running).toBe('dev');
        expect(branches.busy).toBe(true);
        // The place's moves to and from origin wait for it (`RemoteActions.busy`).
        expect(facts.switching).toBe(true);
        expect(stand.switchGitBranch).toHaveBeenCalledExactlyOnceWith('p-1', { folderId: 'f-1' }, 'dev', undefined);
        expect(refresh).not.toHaveBeenCalled();

        switches[0]!.resolve(RESULT);

        expect(await pending).toEqual({ ok: true, result: RESULT });
        expect(facts.switching).toBe(false);
        expect(branches.running).toBeUndefined();
        expect(branches.listing).toBeUndefined();
        expect(branches.failure).toBeUndefined();
        expect(refresh).toHaveBeenCalledTimes(1);
    });

    it('sends where a new branch starts', async () => {
        const { stand, switches } = transport();
        const { model: branches } = model(stand);
        const pending = branches.switchTo('feature/new', { start: 'current' });

        expect(stand.switchGitBranch).toHaveBeenCalledWith('p-1', { folderId: 'f-1' }, 'feature/new', {
            start: 'current',
        });
        switches[0]!.resolve({ ...RESULT, created: true });
        await pending;
    });

    it('is one at a time: a second switch is refused at once and sends nothing', async () => {
        const { stand, switches } = transport();
        const { model: branches } = model(stand);
        const first = branches.switchTo('dev');
        const second = await branches.switchTo('main');

        expect(second).toEqual({ ok: false, failure: { message: 'A switch is running' } });
        expect(stand.switchGitBranch).toHaveBeenCalledTimes(1);
        // The refusal of the second does not take the first one's place or its reason.
        expect(branches.running).toBe('dev');

        switches[0]!.resolve(RESULT);
        await first;
    });

    it('keeps the reason of a refusal with its hint until the person acts again, reads the list again quietly and reads the place', async () => {
        const { stand, reads, switches } = transport();
        const { model: branches, refresh } = model(stand);
        const pending = branches.switchTo('dev');

        switches[0]!.reject(new TransportError('Commit or discard the changes first', 409, '3 files changed'));

        expect(await pending).toEqual({
            ok: false,
            failure: { message: 'Commit or discard the changes first', hint: '3 files changed' },
        });
        expect(branches.failure).toEqual({ message: 'Commit or discard the changes first', hint: '3 files changed' });
        expect(branches.running).toBeUndefined();
        expect(refresh).toHaveBeenCalledTimes(1);
        // The list is read again, so a branch that is gone is not offered a second time.
        expect(stand.getGitBranches).toHaveBeenCalledTimes(1);
        reads[0]!.resolve(LISTING);
        await flush();
        expect(branches.listing).toEqual(LISTING);

        branches.dismiss();
        expect(branches.failure).toBeUndefined();
    });

    it('says a reason that has no hint as it is, and a failure that is no daemon answer by its message', async () => {
        const { stand, switches } = transport();
        const { model: branches } = model(stand);
        const refused = branches.switchTo('dev');

        switches[0]!.reject(new TransportError("A chat's worktree keeps its branch", 400));
        expect(await refused).toEqual({ ok: false, failure: { message: "A chat's worktree keeps its branch" } });

        const broken = branches.switchTo('dev');

        switches[1]!.reject(new Error('Failed to fetch'));
        expect(await broken).toEqual({ ok: false, failure: { message: 'Failed to fetch' } });
    });

    it('keeps what a post-checkout hook said after a switch that was made, until the person acts again', async () => {
        const { stand, switches } = transport();
        const { model: branches, refresh } = model(stand);
        const pending = branches.switchTo('dev');

        switches[0]!.resolve({ ...RESULT, warning: 'post-checkout: the install failed' });
        await pending;
        expect(branches.warning).toEqual({ branch: 'dev', line: 'post-checkout: the install failed' });
        expect(branches.failure).toBeUndefined();
        expect(refresh).toHaveBeenCalledTimes(1);

        branches.dismiss();
        expect(branches.warning).toBeUndefined();
    });

    it('is one model for a place, kept with its facts', () => {
        const { stand } = transport();
        const facts = new PlaceFacts(
            { ...KEY, folderId: 'f-2' },
            { getGitStatus: vi.fn(), getGitChanges: vi.fn(), getGitPullRequest: vi.fn() }
        );

        expect(branchSwitchOf(facts, stand, vi.fn())).toBe(branchSwitchOf(facts, stand, vi.fn()));
    });
});

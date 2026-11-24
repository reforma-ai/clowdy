// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fixtureGitChanges, fixtureGitPullRequest, fixtureGitStatus } from '../../daemon/fixtureData';
import { TransportError } from '../../daemon/transport';
import { GIT_COALESCE_MS, GIT_POLL_MS, GitFacts, type GitPlaceKey, summarize } from './gitFacts';

import type { GitChanges, GitPullRequestInfo, GitStatus } from '@clowdy/protocol';

const head = { remoteUrl: 'git@github.com:acme/car-rental.git', branch: 'clowdy/ab12cd34' };
const workspace = { branch: 'clowdy/ab12cd34' };

const KEY: GitPlaceKey = { projectId: 'p-1', folderId: 'f-1', workspaceId: 'w-1' };
const OTHER: GitPlaceKey = { projectId: 'p-1', folderId: 'f-1' };

const statusOf = (): GitStatus => fixtureGitStatus(head, workspace);
const changesOf = (): GitChanges => fixtureGitChanges(head, true, 'branch')!;
const pullRequestOf = (state: 'pending' | 'passing' | 'failing' = 'pending'): GitPullRequestInfo => {
    const info = fixtureGitPullRequest(head, { worktree: 'open' }, workspace)!;

    if (info.isRepository && info.pullRequest) info.pullRequest.checks = { ...info.pullRequest.checks, state };

    return info;
};

/** A transport of three reads that count their calls and answer what the test sets, or what the test holds back. */
function stub() {
    const answers = { status: statusOf(), changes: changesOf(), pullRequest: pullRequestOf() };
    const calls = { status: 0, changes: 0, pullRequest: 0 };
    const places: string[] = [];
    let fail: Partial<Record<keyof typeof calls, string>> = {};
    let hold: Array<() => void> | undefined;
    const answer = async <T>(
        name: keyof typeof calls,
        value: () => T,
        place: { folderId: string; workspaceId?: string }
    ): Promise<T> => {
        calls[name]++;
        places.push(`${name}:${place.workspaceId ?? place.folderId}`);

        if (hold) await new Promise<void>(resolve => hold!.push(resolve));

        if (fail[name]) throw new TransportError(fail[name]!, 503);

        return structuredClone(value());
    };
    const transport = {
        getGitStatus: (_project: string, place: { folderId: string; workspaceId?: string }) =>
            answer('status', () => answers.status, place),
        getGitChanges: (_project: string, place: { folderId: string; workspaceId?: string }) =>
            answer('changes', () => answers.changes, place),
        getGitPullRequest: (_project: string, place: { folderId: string; workspaceId?: string }) =>
            answer('pullRequest', () => answers.pullRequest, place),
    };

    return {
        transport,
        answers,
        calls,
        places,
        failWith: (next: typeof fail) => void (fail = next),
        /** Holds every answer back until `release`. */
        holdBack: () => void (hold = []),
        release: () => {
            const held = hold ?? [];

            hold = undefined;
            held.forEach(resolve => resolve());
        },
    };
}

let hidden = false;
const setHidden = (value: boolean) => {
    hidden = value;
};
const total = (calls: Record<string, number>) => Object.values(calls).reduce((sum, count) => sum + count, 0);
const settle = () => vi.advanceTimersByTimeAsync(0);
const focus = () => window.dispatchEvent(new Event('focus'));
const becomeVisible = () => document.dispatchEvent(new Event('visibilitychange'));

let facts: GitFacts | undefined;

beforeEach(() => {
    vi.useFakeTimers();
    hidden = false;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
});

afterEach(() => {
    facts?.dispose();
    facts = undefined;
    vi.useRealTimers();
});

describe('GitFacts', () => {
    it('reads a place once for everything that observes it, and keeps the answers of each place apart', async () => {
        const daemon = stub();

        facts = new GitFacts(daemon.transport);

        const stopStrip = facts.observe(KEY);
        const stopInfo = facts.observe(KEY);

        await settle();

        expect(daemon.calls).toEqual({ status: 1, changes: 1, pullRequest: 1 });
        expect(facts.of(KEY).isRepository).toBe(true);
        expect(facts.of(KEY).branch).toEqual({
            files: 4,
            additions: 102,
            deletions: 5,
            baseState: 'ready',
            complete: true,
        });
        expect(facts.of(KEY).pr?.number).toBe(128);
        // Another place of the project has read nothing, and shows nothing of this one's.
        expect(facts.of(OTHER).status.value).toBeUndefined();
        expect(facts.of(OTHER).ready).toBe(false);

        // The Info tab goes away: the strip still reads. The strip goes too: nothing reads any more.
        stopInfo();
        focus();
        await settle();

        expect(total(daemon.calls)).toBe(6);

        stopStrip();
        vi.advanceTimersByTime(GIT_COALESCE_MS + 1);
        focus();
        await settle();

        expect(total(daemon.calls)).toBe(6);
    });

    it('gives the first observer of another place its own reads', async () => {
        const daemon = stub();

        facts = new GitFacts(daemon.transport);
        facts.observe(KEY);
        facts.observe(OTHER);
        await settle();

        expect(daemon.calls).toEqual({ status: 2, changes: 2, pullRequest: 2 });
        expect(daemon.places.sort()).toEqual([
            'changes:f-1',
            'changes:w-1',
            'pullRequest:f-1',
            'pullRequest:w-1',
            'status:f-1',
            'status:w-1',
        ]);
    });

    it('is ready for drawing once the status and the changes have answered, and does not wait for the pull request', async () => {
        const daemon = stub();

        facts = new GitFacts(daemon.transport);

        const place = facts.of(KEY);

        facts.observe(KEY);
        expect(place.ready).toBe(false);

        await settle();

        expect(place.ready).toBe(true);
        expect(place.status.loading).toBe(false);
    });

    it('rereads a recently visited destination after a branch operation in another checkout', async () => {
        const daemon = stub();

        facts = new GitFacts(daemon.transport);
        const stopDestination = facts.observe(OTHER);
        facts.observe(KEY);
        await settle();
        stopDestination();

        facts.refreshFolder(KEY);

        expect(facts.of(KEY).generation).toBe(2);
        expect(facts.of(OTHER).generation).toBe(1);

        facts.observe(OTHER);
        await settle();

        expect(facts.of(OTHER).generation).toBe(2);
        expect(daemon.calls.status).toBe(4);
    });

    it('does not draw the pull request before it came, and is ready without it', async () => {
        const daemon = stub();
        const slow = { ...daemon.transport, getGitPullRequest: () => new Promise<GitPullRequestInfo>(() => undefined) };

        facts = new GitFacts(slow);
        facts.observe(KEY);
        await settle();

        expect(facts.of(KEY).ready).toBe(true);
        expect(facts.of(KEY).pr).toBeUndefined();
        expect(facts.of(KEY).pullRequest.loading).toBe(true);
    });

    it('reads once for a focus and a visibility change that arrive together, and again for the next one', async () => {
        const daemon = stub();

        facts = new GitFacts(daemon.transport);
        facts.observe(KEY);
        await settle();
        vi.advanceTimersByTime(GIT_COALESCE_MS + 1);

        focus();
        becomeVisible();
        await settle();

        expect(daemon.calls).toEqual({ status: 2, changes: 2, pullRequest: 2 });

        vi.advanceTimersByTime(GIT_COALESCE_MS + 1);
        focus();
        await settle();

        expect(daemon.calls).toEqual({ status: 3, changes: 3, pullRequest: 3 });
    });

    it('counts the rounds of reads of a place, for a view that keeps more than the store does to read again with them', async () => {
        const daemon = stub();

        facts = new GitFacts(daemon.transport);
        facts.observe(KEY);
        await settle();

        const place = facts.of(KEY);

        expect(place.generation).toBe(1);

        // A refresh, and a focus, each start one; the poll of the pull request alone does not, nor does a place nobody observes.
        facts.refresh(KEY);
        await settle();
        expect(place.generation).toBe(2);

        vi.advanceTimersByTime(GIT_COALESCE_MS + 1);
        focus();
        await settle();
        expect(place.generation).toBe(3);

        vi.advanceTimersByTime(GIT_POLL_MS);
        await settle();
        expect(place.generation).toBe(3);

        facts.refresh(OTHER);
        expect(facts.of(OTHER).generation).toBe(0);
    });

    it('counts no round while the window is hidden, and one when it is visible again', async () => {
        const daemon = stub();

        facts = new GitFacts(daemon.transport);
        facts.observe(KEY);
        await settle();
        setHidden(true);
        facts.refresh(KEY);
        await settle();

        expect(facts.of(KEY).generation).toBe(1);

        setHidden(false);
        becomeVisible();
        await settle();

        expect(facts.of(KEY).generation).toBe(2);
    });

    it("keeps the daemon's status of a read that failed with one, and none for another failure", async () => {
        const daemon = stub();

        facts = new GitFacts(daemon.transport);
        facts.observe(KEY);
        await settle();

        const place = facts.of(KEY);

        expect(place.status.errorStatus).toBeUndefined();

        daemon.failWith({ status: 'The worktree is missing' });
        facts.refresh(KEY);
        await settle();

        expect(place.status.errorStatus).toBe(503);

        daemon.failWith({});
        vi.advanceTimersByTime(1);
        facts.refresh(KEY);
        await settle();

        expect(place.status.errorStatus).toBeUndefined();
    });

    it('reads when it is asked to, at once, and not for a place nobody observes', async () => {
        const daemon = stub();

        facts = new GitFacts(daemon.transport);
        facts.refresh(KEY);
        await settle();

        expect(total(daemon.calls)).toBe(0);

        facts.observe(KEY);
        await settle();
        facts.refresh(KEY);
        await settle();

        expect(daemon.calls).toEqual({ status: 2, changes: 2, pullRequest: 2 });
    });

    it('does not read a place again in the second after a read of it began, when its observer is drawn again', async () => {
        const daemon = stub();

        facts = new GitFacts(daemon.transport);

        const stop = facts.observe(KEY);

        await settle();
        // The same component, drawn again at once (an effect run twice).
        stop();
        const stopAgain = facts.observe(KEY);

        await settle();

        expect(daemon.calls).toEqual({ status: 1, changes: 1, pullRequest: 1 });

        // A place that was left and is back after a while is read again.
        stopAgain();
        vi.advanceTimersByTime(GIT_COALESCE_MS + 1);
        facts.observe(KEY);
        await settle();

        expect(daemon.calls).toEqual({ status: 2, changes: 2, pullRequest: 2 });
    });

    it('goes on polling a place that was left and is back within the second of its last read', async () => {
        const daemon = stub();

        facts = new GitFacts(daemon.transport);

        const stop = facts.observe(KEY);

        await settle();
        expect(daemon.calls.pullRequest).toBe(1);

        // Another chat of the same place opens: the first observer goes and the next comes before the second is up. Nothing is read, and the poll is not lost.
        vi.advanceTimersByTime(300);
        stop();
        facts.observe(KEY);
        await vi.advanceTimersByTimeAsync(GIT_POLL_MS);

        expect(daemon.calls).toEqual({ status: 1, changes: 1, pullRequest: 2 });
    });

    it('reads the pull request alone every minute while a check is pending, and stops when none is', async () => {
        const daemon = stub();

        facts = new GitFacts(daemon.transport);
        facts.observe(KEY);
        await settle();
        expect(daemon.calls).toEqual({ status: 1, changes: 1, pullRequest: 1 });
        expect(facts.of(KEY).checksPending).toBe(true);

        await vi.advanceTimersByTimeAsync(GIT_POLL_MS - 1);
        expect(daemon.calls.pullRequest).toBe(1);

        await vi.advanceTimersByTimeAsync(1);
        expect(daemon.calls).toEqual({ status: 1, changes: 1, pullRequest: 2 });

        await vi.advanceTimersByTimeAsync(GIT_POLL_MS);
        expect(daemon.calls.pullRequest).toBe(3);

        // The checks finish: the next answer says so, and nothing is read after it.
        daemon.answers.pullRequest = pullRequestOf('passing');
        await vi.advanceTimersByTimeAsync(GIT_POLL_MS);
        expect(daemon.calls.pullRequest).toBe(4);
        expect(facts.of(KEY).checksPending).toBe(false);

        await vi.advanceTimersByTimeAsync(GIT_POLL_MS * 5);
        expect(daemon.calls).toEqual({ status: 1, changes: 1, pullRequest: 4 });
    });

    it('does not poll a place whose checks are all done', async () => {
        const daemon = stub();

        daemon.answers.pullRequest = pullRequestOf('passing');
        facts = new GitFacts(daemon.transport);
        facts.observe(KEY);
        await vi.advanceTimersByTimeAsync(GIT_POLL_MS * 3);

        expect(daemon.calls.pullRequest).toBe(1);
    });

    it('stops waiting for the next read when the last observer goes', async () => {
        const daemon = stub();

        facts = new GitFacts(daemon.transport);

        const stopFirst = facts.observe(KEY);
        const stopSecond = facts.observe(KEY);

        await settle();
        stopFirst();
        await vi.advanceTimersByTimeAsync(GIT_POLL_MS);
        expect(daemon.calls.pullRequest).toBe(2);

        stopSecond();
        await vi.advanceTimersByTimeAsync(GIT_POLL_MS * 5);
        expect(daemon.calls.pullRequest).toBe(2);
    });

    it('reads nothing while the window is hidden, and everything it was due when the window is visible again', async () => {
        const daemon = stub();

        facts = new GitFacts(daemon.transport);
        facts.observe(KEY);
        await settle();

        setHidden(true);
        vi.advanceTimersByTime(GIT_COALESCE_MS + 1);
        focus();
        becomeVisible();
        facts.refresh(KEY);
        // The poll's wait ends while the window is hidden: it reads nothing and does not renew itself.
        await vi.advanceTimersByTimeAsync(GIT_POLL_MS * 4);

        expect(daemon.calls).toEqual({ status: 1, changes: 1, pullRequest: 1 });

        setHidden(false);
        becomeVisible();
        await settle();

        expect(daemon.calls).toEqual({ status: 2, changes: 2, pullRequest: 2 });

        // The return renewed the poll.
        await vi.advanceTimersByTimeAsync(GIT_POLL_MS);
        expect(daemon.calls.pullRequest).toBe(3);
    });

    it('reads nothing for a first observer when the window is hidden, and when it comes back', async () => {
        const daemon = stub();

        setHidden(true);
        facts = new GitFacts(daemon.transport);
        facts.observe(KEY);
        await settle();

        expect(total(daemon.calls)).toBe(0);

        setHidden(false);
        becomeVisible();
        await settle();

        expect(daemon.calls).toEqual({ status: 1, changes: 1, pullRequest: 1 });
    });

    it('keeps the last good answers when a read fails, and marks them stale until one succeeds', async () => {
        const daemon = stub();

        facts = new GitFacts(daemon.transport);
        facts.observe(KEY);
        await settle();

        const place = facts.of(KEY);

        daemon.failWith({ status: 'The worktree is missing', pullRequest: "GitHub didn't answer" });
        facts.refresh(KEY);
        await settle();

        expect(place.status.stale).toBe(true);
        expect(place.status.error).toBe('The worktree is missing');
        expect(place.status.value?.isRepository).toBe(true);
        expect(place.pr?.number).toBe(128);
        expect(place.pullRequest.stale).toBe(true);
        expect(place.changes.stale).toBe(false);
        expect(place.ready).toBe(true);

        daemon.failWith({});
        vi.advanceTimersByTime(1);
        facts.refresh(KEY);
        await settle();

        expect(place.status.stale).toBe(false);
        expect(place.status.error).toBeUndefined();
    });

    it('is ready, and shows nothing, for a place whose first read failed', async () => {
        const daemon = stub();

        daemon.failWith({
            status: 'The worktree is missing',
            changes: 'The worktree is missing',
            pullRequest: 'The worktree is missing',
        });
        facts = new GitFacts(daemon.transport);
        facts.observe(KEY);
        await settle();

        const place = facts.of(KEY);

        expect(place.ready).toBe(true);
        expect(place.isRepository).toBeUndefined();
        expect(place.status.value).toBeUndefined();
        expect(place.pr).toBeUndefined();
    });

    it('keeps the newer answer when an older read comes in last', async () => {
        const answers: GitStatus[] = [statusOf(), { ...statusOf(), entries: [] } as GitStatus];
        const resolvers: Array<(status: GitStatus) => void> = [];
        const transport = {
            getGitStatus: () => new Promise<GitStatus>(resolve => void resolvers.push(resolve)),
            getGitChanges: async () => changesOf(),
            getGitPullRequest: async () => pullRequestOf('passing'),
        };

        facts = new GitFacts(transport);
        facts.observe(KEY);
        vi.advanceTimersByTime(GIT_COALESCE_MS + 1);
        facts.refresh(KEY);
        await settle();
        expect(resolvers).toHaveLength(2);

        // The second read answers first, with a clean tree; the first one, which had the dirty tree, comes after it and is dropped.
        resolvers[1]!(answers[1]!);
        await settle();
        resolvers[0]!(answers[0]!);
        await settle();

        expect(facts.of(KEY).dirty).toBe(false);
    });

    it('asks a place that is no repository once, then about its status alone until it becomes one', async () => {
        const daemon = stub();

        daemon.answers.status = { isRepository: false };
        daemon.answers.changes = { isRepository: false };
        daemon.answers.pullRequest = { isRepository: false };
        facts = new GitFacts(daemon.transport);
        facts.observe(KEY);
        await settle();

        expect(daemon.calls).toEqual({ status: 1, changes: 1, pullRequest: 1 });
        expect(facts.of(KEY).isRepository).toBe(false);
        expect(facts.of(KEY).ready).toBe(true);
        expect(facts.of(KEY).branch).toBeUndefined();

        vi.advanceTimersByTime(GIT_COALESCE_MS + 1);
        focus();
        await vi.advanceTimersByTimeAsync(GIT_POLL_MS * 3);

        expect(daemon.calls).toEqual({ status: 2, changes: 1, pullRequest: 1 });

        // `git init` in a terminal, and the window gets focus: the rest is read then.
        daemon.answers.status = statusOf();
        daemon.answers.changes = changesOf();
        daemon.answers.pullRequest = pullRequestOf('passing');
        vi.advanceTimersByTime(GIT_COALESCE_MS + 1);
        focus();
        await settle();

        expect(daemon.calls).toEqual({ status: 3, changes: 2, pullRequest: 2 });
        expect(facts.of(KEY).isRepository).toBe(true);
    });

    it('forgets the places left longest ago, and keeps the ones observed', async () => {
        const daemon = stub();

        facts = new GitFacts(daemon.transport);

        const stopKept = facts.observe(KEY);
        const first = facts.of(OTHER);

        for (let index = 0; index < 10; index++) facts.observe({ projectId: 'p-1', folderId: `f-${index + 10}` })();

        await settle();

        // The first idle place was dropped: asking for it makes a new one, with nothing known.
        facts.observe(OTHER)();
        expect(facts.of(OTHER)).not.toBe(first);
        expect(facts.of(KEY).status.settled).toBe(true);

        stopKept();
    });

    it('stops listening to the window when the last place is let go', async () => {
        const daemon = stub();
        const add = vi.spyOn(window, 'addEventListener');
        const remove = vi.spyOn(window, 'removeEventListener');

        facts = new GitFacts(daemon.transport);

        const stopA = facts.observe(KEY);
        const stopB = facts.observe(OTHER);

        expect(add.mock.calls.filter(([type]) => type === 'focus')).toHaveLength(1);

        stopA();
        expect(remove.mock.calls.filter(([type]) => type === 'focus')).toHaveLength(0);

        stopB();
        expect(remove.mock.calls.filter(([type]) => type === 'focus')).toHaveLength(1);

        add.mockRestore();
        remove.mockRestore();
    });
});

describe('summarize', () => {
    it('keeps the counts of a read and says nothing for a folder that is no repository', () => {
        expect(summarize(changesOf())).toEqual({
            files: 4,
            additions: 102,
            deletions: 5,
            baseState: 'ready',
            complete: true,
        });
        expect(summarize({ isRepository: false })).toBeNull();
    });
});

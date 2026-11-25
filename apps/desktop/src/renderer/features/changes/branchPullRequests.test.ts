// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest';

import { type BranchPullRequestKey, BranchPullRequests } from './branchPullRequests';

import type { GitBranchPullRequests } from '@clowdy/protocol';

const key: BranchPullRequestKey = { projectId: 'project', folderId: 'folder', branch: 'feature/a' };
const history = (branch = key.branch, archived = false): GitBranchPullRequests => ({
    branch,
    access: 'ready',
    repo: { host: 'github.com', owner: 'acme', name: 'app' },
    pullRequests: [
        {
            number: 44,
            title: 'Change the form',
            state: 'merged',
            url: 'https://github.com/acme/app/pull/44',
            base: 'main',
            head: branch,
            updatedAt: 1,
            ...(archived && { archived: true as const }),
        },
    ],
});

it('shares a pending read, coalesces immediate refreshes, and preserves data when the next read fails', async () => {
    const pending = Promise.withResolvers<GitBranchPullRequests>();
    const read = vi.fn().mockReturnValueOnce(pending.promise).mockRejectedValueOnce(new Error('Offline'));
    const store = new BranchPullRequests({ getGitBranchPullRequests: read, setGitPullRequestArchived: vi.fn() });
    const stop1 = store.observe(key);
    const stop2 = store.observe({ ...key });
    const fact = store.of(key);
    try {
        expect(store.of({ ...key })).toBe(fact);
        expect(fact.loading).toBe(true);
        const request = fact.refresh();
        expect(read).toHaveBeenCalledTimes(1);
        expect(read).toHaveBeenCalledWith(key.projectId, key.folderId, key.branch);
        pending.resolve(history());
        await request;
        expect(fact.value).toEqual(history());
        expect(fact.loading).toBe(false);
        await fact.refresh();
        expect(read).toHaveBeenCalledTimes(1);
        await fact.refresh(true);
        expect(fact.value).toEqual(history());
        expect(fact.stale).toBe(true);
        expect(fact.error).toBe('Offline');
    } finally {
        stop1();
        stop2();
    }
});

it('keeps the archive result instead of replacing it with an older read', async () => {
    const pending = Promise.withResolvers<GitBranchPullRequests>();
    const archive = vi.fn().mockResolvedValue(history(key.branch, true));
    const store = new BranchPullRequests({
        getGitBranchPullRequests: vi.fn().mockResolvedValueOnce(history()).mockReturnValue(pending.promise),
        setGitPullRequestArchived: archive,
    });
    const stop = store.observe(key);
    const fact = store.of(key);
    try {
        await fact.refresh();
        const request = fact.refresh(true);
        expect(await fact.setArchived(44, true)).toBe(true);
        expect(archive).toHaveBeenCalledWith(key.projectId, {
            folderId: key.folderId,
            branch: key.branch,
            number: 44,
            archived: true,
            repo: history().repo,
        });
        pending.resolve(history());
        await request;
        expect(fact.value?.pullRequests[0]?.archived).toBe(true);
        expect(fact.archiving).toBe(false);
    } finally {
        stop();
    }
});

it('refreshes an obsolete row after an archive fails without losing the archive error', async () => {
    const differentRepo = { ...history(), repo: { host: 'github.com', owner: 'acme', name: 'other' } };
    const read = vi.fn().mockResolvedValueOnce(history()).mockResolvedValueOnce(differentRepo);
    const store = new BranchPullRequests({
        getGitBranchPullRequests: read,
        setGitPullRequestArchived: vi.fn().mockRejectedValue(new Error("The folder's origin has changed")),
    });
    const stop = store.observe(key);
    const fact = store.of(key);
    try {
        await fact.refresh();
        expect(await fact.setArchived(44, true)).toBe(false);
        await vi.waitFor(() => expect(fact.value).toEqual(differentRepo));
        expect(fact.archiveError).toBe("The folder's origin has changed");
        expect(read).toHaveBeenCalledTimes(2);
    } finally {
        stop();
    }
});

it('remembers the most recent worktree branch across store instances without reviving a detached head', () => {
    const transport = { getGitBranchPullRequests: vi.fn(), setGitPullRequestArchived: vi.fn() };
    const values = new Map<string, string>();
    const storage = {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
    };
    const workspace = { id: 'workspace', branch: 'feature/original', ready: true };
    const first = new BranchPullRequests(transport, storage);
    expect(first.workspaceHistoryBranch(key.projectId, workspace, { gone: true })).toBe('feature/original');
    first.rememberWorkspaceBranch(key.projectId, workspace.id, 'feature/switched');
    const restarted = new BranchPullRequests(transport, storage);
    expect(restarted.workspaceHistoryBranch(key.projectId, workspace, { gone: true })).toBe('feature/switched');
    expect(restarted.workspaceHistoryBranch(key.projectId, workspace, { branch: 'feature/now' })).toBe('feature/now');
    expect(
        restarted.workspaceHistoryBranch(key.projectId, workspace, { branch: 'hash', detached: true })
    ).toBeUndefined();
    restarted.rememberWorkspaceBranch(key.projectId, workspace.id, null);
    expect(
        new BranchPullRequests(transport, storage).workspaceHistoryBranch(key.projectId, workspace, { gone: true })
    ).toBeUndefined();
});

it('limits concurrent branch reads and does not read queued branches that are no longer shown', async () => {
    const requests = new Map<string, ReturnType<typeof Promise.withResolvers<GitBranchPullRequests>>>();
    const read = vi.fn((_projectId: string, _folderId: string, branch: string) => {
        const pending = Promise.withResolvers<GitBranchPullRequests>();
        requests.set(branch, pending);
        return pending.promise;
    });
    const store = new BranchPullRequests({ getGitBranchPullRequests: read, setGitPullRequestArchived: vi.fn() });
    const keys = Array.from({ length: 6 }, (_, i) => ({ ...key, branch: `feature/${i}` }));
    const stops = keys.map(key => store.observe(key));
    try {
        expect(read).toHaveBeenCalledTimes(4);
        const waiting = store.of(keys[4]!).refresh();
        stops[4]!();
        requests.get(keys[0]!.branch)!.resolve(history(keys[0]!.branch));
        await waiting;
        await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(5));
        expect(requests.has(keys[4]!.branch)).toBe(false);
        expect(requests.has(keys[5]!.branch)).toBe(true);
    } finally {
        for (const stop of stops) stop();
        for (const [branch, request] of requests) request.resolve(history(branch));
    }
});

it('shares a newly discovered current PR until history catches up without duplicating it', () => {
    const store = new BranchPullRequests({ getGitBranchPullRequests: vi.fn(), setGitPullRequestArchived: vi.fn() });
    const fact = store.of(key);
    const before = history();
    const open = {
        ...before.pullRequests[0]!,
        number: 45,
        state: 'open' as const,
        url: 'https://github.com/acme/app/pull/45',
        updatedAt: 2,
    };
    fact.accept(before);
    fact.noteCurrent(before.repo!, open);
    expect(fact.pullRequests).toEqual([before.pullRequests[0], open]);
    fact.accept(before);
    expect(fact.pullRequests).toEqual([before.pullRequests[0], open]);
    fact.noteCurrent(before.repo!, { ...open, updatedAt: 1, state: 'closed' });
    expect(fact.pullRequests).toEqual([before.pullRequests[0], open]);
    fact.accept({ ...before, pullRequests: [open, ...before.pullRequests] });
    expect(fact.current).toBeUndefined();
    expect(fact.pullRequests).toEqual([open, before.pullRequests[0]]);
});

it('keeps archive marks and separates current PRs from a different branch or origin', () => {
    const store = new BranchPullRequests({ getGitBranchPullRequests: vi.fn(), setGitPullRequestArchived: vi.fn() });
    const fact = store.of(key);
    const before = history(key.branch, true);
    const merged = { ...before.pullRequests[0]!, updatedAt: 2, archived: undefined };
    fact.accept(before);
    fact.noteCurrent(before.repo!, merged);
    expect(fact.pullRequests[0]?.archived).toBe(true);
    fact.noteCurrent(before.repo!, { ...merged, head: 'feature/other' });
    expect(fact.pullRequests[0]?.head).toBe(key.branch);
    const otherRepo = { ...before.repo!, name: 'other' };
    fact.accept({ ...before, repo: otherRepo, pullRequests: [] });
    expect(fact.pullRequests).toEqual([]);
    fact.noteCurrent(before.repo!, merged);
    expect(fact.pullRequests).toEqual([]);
});

import { errorMessage } from '@clowdy/lib';
import { makeAutoObservable, observableRef, runInAction } from 'mobx';
import { useEffect } from 'react';

import { useRootStore } from '../../stores';
import { browserStorage, type KeyValueStorage, readStored, writeStored } from '../../stores/storage';
import { onFolderGitRefresh } from '../openWith/useFolderGit';
import { keepEqual } from './keepEqual';

import type { GitBranchPullRequests, GitHubRepo, GitPullRequestSummary } from '@clowdy/protocol';
import type { Transport } from '../../daemon/transport';
import type { WorkspaceHead, WorkspaceRef } from '../openWith/workspaceHead';

export interface BranchPullRequestKey {
    projectId: string;
    folderId: string;
    branch: string;
}

type HistoryTransport = Pick<Transport, 'getGitBranchPullRequests'>;
const REFRESH_MS = 60_000;
const COALESCE_MS = 1000;
const MAX_PENDING = 4;
const MAX_IDLE = 32;
const keyText = ({ projectId, folderId, branch }: BranchPullRequestKey) =>
    JSON.stringify([projectId, folderId, branch]);
const repoKey = ({ host, owner, name }: GitHubRepo) => `${host}/${owner}/${name}`.toLowerCase();
const hidden = () => typeof document !== 'undefined' && document.hidden;

/** Keep live PRs, or the newest merged PR when none are live. Legacy manual archive marks do not affect the grouping. */
export function partitionPullRequests<T extends Pick<GitPullRequestSummary, 'number' | 'state'>>(rows: readonly T[]) {
    const sorted = [...rows].sort((a, b) => b.number - a.number);
    const visible = sorted.filter(pr => pr.state === 'open' || pr.state === 'draft');
    if (!visible.length) {
        const latest = sorted.find(pr => pr.state === 'merged');
        if (latest) visible.push(latest);
    }
    const active = new Set(visible);
    return { visible, archived: sorted.filter(pr => !active.has(pr)) };
}

/** A branch has one history, regardless of which chat is observing it. */
export class BranchPullRequestFact {
    value: GitBranchPullRequests | undefined;
    /** The current-PR read may see a new PR before the branch history cache does. */
    current: { repo: GitHubRepo; pr: GitPullRequestSummary } | undefined;
    loading = false;
    stale = false;
    error: string | undefined;
    #revision = 0;
    #pending: Promise<void> | undefined;
    #lastRequested = Number.NEGATIVE_INFINITY;
    #refreshAgain = false;
    readonly #read: () => Promise<void>;

    constructor(
        readonly key: BranchPullRequestKey,
        read: (fact: BranchPullRequestFact) => Promise<void>
    ) {
        this.#read = () => read(this);
        makeAutoObservable(this, { key: false, value: observableRef, current: observableRef });
    }

    /** Use all known PRs, including a current PR that has not appeared in history yet. */
    get pullRequests(): readonly GitPullRequestSummary[] {
        const list = this.value?.pullRequests ?? [];
        const pr = this.current?.pr;
        if (!pr) return list;

        const known = list.find(item => item.url === pr.url);
        if (known && known.updatedAt >= pr.updatedAt) return list;

        return [
            ...list.filter(item => item.url !== pr.url),
            { ...pr, archived: pr.state === 'merged' || pr.state === 'closed' ? known?.archived : undefined },
        ];
    }

    get visiblePullRequests(): readonly GitPullRequestSummary[] {
        return partitionPullRequests(this.pullRequests).visible;
    }

    noteCurrent(repo: GitHubRepo, pr: GitPullRequestSummary): void {
        if (pr.head !== this.key.branch) return;
        if (this.value && (!this.value.repo || repoKey(this.value.repo) !== repoKey(repo))) return;

        const known = this.value?.pullRequests.find(item => item.url === pr.url);
        if (known && known.updatedAt >= pr.updatedAt) return;

        if (this.current?.pr.url === pr.url && this.current.pr.updatedAt > pr.updatedAt) return;
        // A place supplies the full PR, including CI checks. The shared history only keeps its summary.
        const { number, title, url, state, base, head, updatedAt } = pr;
        this.current = keepEqual(this.current, { repo, pr: { number, title, url, state, base, head, updatedAt } });
    }

    /** Reads once for all callers sharing this branch. */
    refresh(force = false): Promise<void> {
        if (this.#pending) {
            this.#refreshAgain ||= force;
            return this.#pending ?? Promise.resolve();
        }
        if (!force && Date.now() - this.#lastRequested < COALESCE_MS) return Promise.resolve();
        this.#lastRequested = Date.now();

        this.loading = true;
        const revision = ++this.#revision;
        this.#pending = this.#read().finally(() => {
            this.#pending = undefined;
            if (revision === this.#revision)
                runInAction(() => {
                    this.loading = false;
                });
            this.#refreshIfQueued();
        });
        return this.#pending;
    }

    /** Reads as a queued job. A rejected read leaves the last good answer visible. */
    async read(load: () => Promise<GitBranchPullRequests>): Promise<void> {
        const revision = this.#revision;
        try {
            const value = await load();
            if (revision === this.#revision) this.accept(value);
        } catch (error) {
            if (revision !== this.#revision) return;
            runInAction(() => {
                this.stale = true;
                this.error = errorMessage(error);
            });
        }
    }

    /** Replaces the branch's known answer; also invalidates any older read on another matching view. */
    accept(value: GitBranchPullRequests): void {
        this.#revision++;
        if (this.current) {
            const { repo, pr } = this.current;
            const known = value.pullRequests.find(item => item.url === pr.url);
            if (!value.repo || repoKey(value.repo) !== repoKey(repo) || (known && known.updatedAt >= pr.updatedAt))
                this.current = undefined;
        }
        this.value = keepEqual(this.value, value);
        this.stale = value.stale === true;
        this.error = undefined;
        this.loading = false;
    }

    #refreshIfQueued(): void {
        if (!this.#refreshAgain || this.#pending) return;
        this.#refreshAgain = false;
        void this.refresh(true);
    }
}

interface Slot {
    fact: BranchPullRequestFact;
    observers: number;
    startedAt: number;
}

/** Only observed branches get network reads. The shared queue caps the number of simultaneous requests. */
export class BranchPullRequests {
    readonly #slots = new Map<string, Slot>();
    readonly #workspaceBranches = new Map<string, string | null | undefined>();
    readonly #queue: Array<() => Promise<void>> = [];
    #active = 0;
    #timer: ReturnType<typeof setInterval> | undefined;
    #stopFolder: (() => void) | undefined;
    #lastWindowRead = Number.NEGATIVE_INFINITY;

    constructor(
        private readonly transport: HistoryTransport,
        private readonly storage: KeyValueStorage | undefined = browserStorage()
    ) {}

    /** Retain the last actual head even when a workspace's folder has gone, including after an app restart. */
    rememberWorkspaceBranch(projectId: string, workspaceId: string, branch: string | null): void {
        const key = this.#workspaceBranchKey(projectId, workspaceId);
        if (this.#rememberedBranch(key) === branch) return;
        this.#workspaceBranches.set(key, branch);
        writeStored(this.storage, key, branch);
    }

    workspaceHistoryBranch(
        projectId: string,
        workspace: WorkspaceRef,
        head: WorkspaceHead | undefined
    ): string | undefined {
        if (!workspace.ready || !head) return undefined;
        if (!head.gone) return head.detached ? undefined : head.branch;
        const remembered = this.#rememberedBranch(this.#workspaceBranchKey(projectId, workspace.id));
        return remembered === undefined ? workspace.branch : (remembered ?? undefined);
    }

    #workspaceBranchKey(projectId: string, workspaceId: string): string {
        return `clowdy:branch-pull-requests:workspace:${JSON.stringify([projectId, workspaceId])}`;
    }

    #rememberedBranch(key: string): string | null | undefined {
        if (!this.#workspaceBranches.has(key)) {
            const stored = readStored(this.storage, key);
            this.#workspaceBranches.set(key, typeof stored === 'string' || stored === null ? stored : undefined);
        }
        return this.#workspaceBranches.get(key);
    }

    of(key: BranchPullRequestKey): BranchPullRequestFact {
        return this.#slot(key).fact;
    }

    observe(key: BranchPullRequestKey): () => void {
        const slot = this.#slot(key);
        slot.observers++;
        this.#listen();
        if (slot.observers === 1 && Date.now() - slot.startedAt >= COALESCE_MS && !hidden()) void slot.fact.refresh();

        let released = false;
        return () => {
            if (released) return;
            released = true;
            if (--slot.observers > 0) return;

            // Retain a short cache of the branches the person recently left.
            const text = keyText(key);
            this.#slots.delete(text);
            this.#slots.set(text, slot);
            const idle = [...this.#slots].filter(([, candidate]) => candidate.observers === 0);
            for (const [id] of idle.slice(0, Math.max(0, idle.length - MAX_IDLE))) this.#slots.delete(id);
            if (![...this.#slots.values()].some(candidate => candidate.observers > 0)) this.#unlisten();
        };
    }

    refreshFolder(projectId: string, folderId: string): void {
        for (const { fact, observers } of this.#slots.values())
            if (observers && fact.key.projectId === projectId && fact.key.folderId === folderId && !hidden())
                void fact.refresh(true);
    }

    #slot(key: BranchPullRequestKey): Slot {
        const text = keyText(key);
        let slot = this.#slots.get(text);
        if (!slot) {
            const { projectId, folderId, branch } = key;
            const fact = new BranchPullRequestFact({ ...key }, fact =>
                this.#enqueue(async () => {
                    const current = this.#slots.get(text);
                    if (!current?.observers || current.fact !== fact || hidden()) return;
                    current.startedAt = Date.now();
                    await fact.read(() => this.transport.getGitBranchPullRequests(projectId, folderId, branch));
                })
            );
            slot = { fact, observers: 0, startedAt: Number.NEGATIVE_INFINITY };
            this.#slots.set(text, slot);
        }
        return slot;
    }

    #enqueue(run: () => Promise<void>): Promise<void> {
        return new Promise(resolve => {
            this.#queue.push(async () => {
                try {
                    await run();
                } finally {
                    resolve();
                }
            });
            this.#pump();
        });
    }

    #pump(): void {
        while (this.#active < MAX_PENDING && this.#queue.length > 0) {
            const next = this.#queue.shift()!;
            this.#active++;
            void next().finally(() => {
                this.#active--;
                this.#pump();
            });
        }
    }

    readonly #onWindow = (): void => {
        if (hidden() || Date.now() - this.#lastWindowRead < COALESCE_MS) return;
        this.#lastWindowRead = Date.now();
        for (const { fact, observers } of this.#slots.values()) if (observers) void fact.refresh();
    };

    #listen(): void {
        if (this.#timer !== undefined || typeof window === 'undefined') return;
        this.#timer = setInterval(this.#onWindow, REFRESH_MS);
        window.addEventListener('focus', this.#onWindow);
        document.addEventListener('visibilitychange', this.#onWindow);
        this.#stopFolder = onFolderGitRefresh((projectId, folderId) => this.refreshFolder(projectId, folderId));
    }

    #unlisten(): void {
        clearInterval(this.#timer);
        this.#timer = undefined;
        if (typeof window === 'undefined') return;
        window.removeEventListener('focus', this.#onWindow);
        document.removeEventListener('visibilitychange', this.#onWindow);
        this.#stopFolder?.();
        this.#stopFolder = undefined;
    }
}

const stores = new WeakMap<HistoryTransport, BranchPullRequests>();
export function branchPullRequestsOf(transport: HistoryTransport): BranchPullRequests {
    let store = stores.get(transport);
    if (!store) {
        store = new BranchPullRequests(transport);
        stores.set(transport, store);
    }
    return store;
}

export function useBranchPullRequests(key: BranchPullRequestKey | undefined): BranchPullRequestFact | undefined {
    const store = branchPullRequestsOf(useRootStore().transport);
    const fact = key && store.of(key);
    useEffect(() => (fact ? store.observe(fact.key) : undefined), [store, fact]);
    return fact;
}

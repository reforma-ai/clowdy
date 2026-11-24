import { errorMessage } from '@clowdy/lib';
import { makeAutoObservable, observableRef, runInAction } from 'mobx';

import { type PlaceRef, type Transport, TransportError } from '../../daemon/transport';
import { keepEqual } from './keepEqual';

import type {
    FolderId,
    GitBase,
    GitBaseState,
    GitChanges,
    GitHubAccess,
    GitHubRepo,
    GitPullRequest,
    GitPullRequestInfo,
    GitStatus,
    ProjectId,
    WorkspaceId,
} from '@clowdy/protocol';

/** How often the pull request is read again while one of its checks is not finished and the window is visible. */
export const GIT_POLL_MS = 60_000;

/**
 * A window that comes back gets a `focus` and a `visibilitychange` together (`UsageStatus` has the same guard): one read answers every trigger of the window that
 * arrives within this time of the one before it. A place that is observed again right after a read of it started does not read again either.
 */
export const GIT_COALESCE_MS = 1_000;

/** How many places keep their last answer after nothing observes them any more: coming back to a chat of a place shows what it knew while the new read is on its way. */
const MAX_IDLE_PLACES = 8;

/** The place of a project the facts are of: a folder's own checkout, or the worktree of it that a chat works in. */
export interface GitPlaceKey {
    projectId: ProjectId;
    folderId: FolderId;
    workspaceId?: WorkspaceId;
}

const keyText = ({ projectId, folderId, workspaceId }: GitPlaceKey) => `${projectId}/${folderId}/${workspaceId ?? ''}`;

/** What the daemon takes of a place in a git read. */
export const placeRef = ({ folderId, workspaceId }: GitPlaceKey): PlaceRef =>
    workspaceId === undefined ? { folderId } : { folderId, workspaceId };

/** What the app keeps of the changes of the branch (the `branch` scope: what is committed on it, against its base): the counts, never the files. */
export interface BranchSummary {
    /** Files that changed, whether or not the daemon listed them all. */
    files: number;
    additions: number;
    deletions: number;
    /** How the base stood: anything but `ready` means there was nothing to count from, so the counts say nothing. */
    baseState: GitBaseState | undefined;
    /** Every file's lines were counted: when false the additions and deletions are a lower bound. */
    complete: boolean;
}

/** The counts of a `branch` read, or `null` for a place that is no repository. */
export function summarize(changes: GitChanges): BranchSummary | null {
    if (!changes.isRepository) return null;

    return {
        files: changes.fileCount,
        additions: changes.additions,
        deletions: changes.deletions,
        baseState: changes.baseState,
        complete: changes.statsComplete,
    };
}

/**
 * One kind of fact of a place, as the last good answer and what became of the reads since: `value` is the newest answer there was, kept when a later read fails (`stale`,
 * with the reason in `error`, and the daemon's status in `errorStatus` when it gave one), `loading` while a read is on its way and `settled` once the first read has ended, one
 * way or the other. A read that starts makes the answers of the reads before it, that did not end yet, out of date: they are dropped when they come.
 */
export class Fact<T> {
    value: T | undefined;
    stale = false;
    error: string | undefined;
    errorStatus: number | undefined;
    loading = false;
    settled = false;
    #request = 0;

    constructor(private readonly read: () => Promise<T>) {
        makeAutoObservable<Fact<T>, 'read'>(this, { read: false, value: observableRef });
    }

    /** Reads again. Never rejects: a failure is `stale` and `error`. */
    async refresh(): Promise<void> {
        const request = ++this.#request;

        this.loading = true;

        try {
            const value = await this.read();

            if (request !== this.#request) return;

            runInAction(() => {
                // An answer that says what the last one said keeps its objects, so what draws them is not drawn again.
                this.value = keepEqual<T | undefined>(this.value, value);
                this.stale = false;
                this.error = undefined;
                this.errorStatus = undefined;
                this.loading = false;
                this.settled = true;
            });
        } catch (error) {
            if (request !== this.#request) return;

            runInAction(() => {
                this.stale = true;
                this.error = errorMessage(error);
                this.errorStatus = error instanceof TransportError ? error.status : undefined;
                this.loading = false;
                this.settled = true;
            });
        }
    }
}

/** What `GET git/pull-request` says of a place that is a repository. */
type GitHubFacts = Extract<GitPullRequestInfo, { isRepository: true }>;

/** The facts of one place: its status, the summary of the branch's changes, and its pull request, each with its own reads. Nothing here ever holds the answer for another place. */
export class PlaceFacts {
    readonly status: Fact<GitStatus>;
    readonly changes: Fact<BranchSummary | null>;
    readonly pullRequest: Fact<GitPullRequestInfo>;
    /**
     * How many rounds of reads of the whole place the store has started (the first observer, the window's focus, a `refresh`): a view that draws more than the store keeps, such as
     * the Changes tab's files, reads again when this changes, so it has no triggers of its own. Not counted while the window is hidden, since nothing is read then.
     */
    generation = 0;
    /**
     * A change of the place's branch is under way (`BranchSwitch`). The daemon runs a switch and the moves to and from `origin` one at a time, so a fetch, pull or push pressed meanwhile would
     * act on the NEW branch once the switch ended: while this is set the buttons of those moves are off (`RemoteActions.busy`).
     */
    switching = false;

    constructor(
        readonly key: GitPlaceKey,
        transport: Pick<Transport, 'getGitStatus' | 'getGitChanges' | 'getGitPullRequest'>
    ) {
        const place = placeRef(key);

        this.status = new Fact(() => transport.getGitStatus(key.projectId, place));
        this.changes = new Fact(async () => summarize(await transport.getGitChanges(key.projectId, place, 'branch')));
        this.pullRequest = new Fact(() => transport.getGitPullRequest(key.projectId, place));
        makeAutoObservable(this, { key: false, status: false, changes: false, pullRequest: false });
    }

    /** Notes that a round of reads has started. */
    startRound(): void {
        this.generation++;
    }

    /** Whether the place is a repository: `undefined` until the status has answered. */
    get isRepository(): boolean | undefined {
        return this.status.value?.isRepository;
    }

    /**
     * Enough has been read to draw: the status and the changes (both are the daemon's own `git`, quick) have each ended once, either way. The pull request is not waited for, since
     * it goes to the network through `gh`; what it says comes in when it does.
     */
    get ready(): boolean {
        return this.status.settled && this.changes.settled;
    }

    /** The tree has uncommitted files. */
    get dirty(): boolean {
        const { value } = this.status;

        return value?.isRepository === true && value.entries.length > 0;
    }

    /** How the branch stands against its base. */
    get base(): GitBase | undefined {
        const { value } = this.status;

        return value?.isRepository === true ? value.base : undefined;
    }

    /** The summary of what is committed on the branch, when the place is a repository. */
    get branch(): BranchSummary | undefined {
        return this.changes.value ?? undefined;
    }

    /** What GitHub says of the place, when it is a repository: whether `gh` can be asked, and the pull request of the branch. */
    get github(): GitHubFacts | undefined {
        const { value } = this.pullRequest;

        return value?.isRepository === true ? value : undefined;
    }

    /** The pull request of the branch, when there is one. */
    get pr(): GitPullRequest | undefined {
        return this.github?.pullRequest;
    }

    /** Why GitHub cannot be asked, when `gh` is missing or not signed in. */
    get access(): GitHubAccess | undefined {
        return this.github?.access;
    }

    /** The repository `origin` names, when it names one. */
    get repo(): GitHubRepo | undefined {
        return this.github?.repo;
    }

    /** A check of an open pull request is not finished: the reason to read it again soon. */
    get checksPending(): boolean {
        const { pr } = this;

        return pr !== undefined && (pr.state === 'open' || pr.state === 'draft') && pr.checks.state === 'pending';
    }
}

interface Slot {
    facts: PlaceFacts;
    /** How many components read this place now. */
    observers: number;
    /** A branch operation may have moved this checkout while it was idle. */
    invalidated?: true;
    /** When the newest round of reads started. */
    startedAt: number;
    /** The wait for the next read of the pull request while a check is pending. */
    timer: ReturnType<typeof setTimeout> | undefined;
}

const isHidden = () => typeof document !== 'undefined' && document.hidden;

/**
 * The git facts of the places the window shows, shared by everything that draws them (the Info tab and the Changes tab): one answer per
 * place instead of one per component. A place is read only while something observes it (`observe`, counted, so the Info tab and the Changes tab together are one reader), and then:
 *
 * - once when the first observer comes (not when another place's observer is added, and not again within a second of a read that just started);
 * - when the window gets focus or becomes visible again (the branch changes in a terminal or by an agent while the app is in the background), one read for both events;
 * - when the caller says so (`refresh`): the end of a run of the open chat, a commit, a fetch, a pull or a push;
 * - every `GIT_POLL_MS` while a check of the place's pull request is not finished, and for the pull request alone.
 *
 * Nothing is read while the window is hidden: the read that was due waits for the window to be visible again, which asks for all of them. A place that turned out to be no repository
 * is asked about its status alone on later reads, until it is one. A failed read keeps the last good answer, marked stale.
 */
export class GitFacts {
    readonly #slots = new Map<string, Slot>();
    #listening = false;
    #lastWindowRead = Number.NEGATIVE_INFINITY;

    constructor(private readonly transport: Pick<Transport, 'getGitStatus' | 'getGitChanges' | 'getGitPullRequest'>) {}

    /** The facts of a place, made when it is first asked for. Asking reads nothing: `observe` does. */
    of(key: GitPlaceKey): PlaceFacts {
        return this.#slot(key).facts;
    }

    /**
     * Reads the place while the caller needs it. Gives back what ends that: a place nobody observes is not read again, keeps its last answer for a while, and is
     * dropped in the end, so a person who visits many places keeps only the latest ones.
     */
    observe(key: GitPlaceKey): () => void {
        const slot = this.#slot(key);
        const { facts } = slot;

        slot.observers++;

        if (slot.observers === 1) this.#listen();

        const reading = facts.status.loading || facts.changes.loading || facts.pullRequest.loading;
        const known = facts.status.settled;

        // A first observer asks unless a read has just begun for another; a later one only when nothing was ever read (the window was hidden, or the read ended before it came).
        if (
            slot.invalidated ||
            (!reading && (!known || (slot.observers === 1 && Date.now() - slot.startedAt >= GIT_COALESCE_MS)))
        )
            this.#readAll(slot);
        // A place that is back within the second of its last read reads nothing, and the wait that its last observer's leaving ended is made again.
        else if (slot.observers === 1) this.#schedule(slot);

        let released = false;

        return () => {
            if (released) return;

            released = true;
            this.#release(key, slot);
        };
    }

    /** Reads the place again now, when something observes it and the window is visible. */
    refresh(key: GitPlaceKey): void {
        const slot = this.#slots.get(keyText(key));

        if (slot && slot.observers > 0) this.#readAll(slot);
    }

    /** Refreshes the observed checkouts and invalidates the idle ones after an operation that can move either. */
    refreshFolder({ projectId, folderId }: GitPlaceKey): void {
        for (const slot of this.#slots.values()) {
            const { key } = slot.facts;

            if (key.projectId !== projectId || key.folderId !== folderId) continue;

            slot.invalidated = true;
            if (slot.observers > 0) this.#readAll(slot);
        }
    }

    /** Ends every wait and listener. */
    dispose(): void {
        for (const slot of this.#slots.values()) clearTimeout(slot.timer);

        this.#slots.clear();
        this.#unlisten();
    }

    #slot(key: GitPlaceKey): Slot {
        const text = keyText(key);
        let slot = this.#slots.get(text);

        if (!slot) {
            slot = {
                facts: new PlaceFacts({ ...key }, this.transport),
                observers: 0,
                startedAt: Number.NEGATIVE_INFINITY,
                timer: undefined,
            };
            this.#slots.set(text, slot);
        }

        return slot;
    }

    #release(key: GitPlaceKey, slot: Slot): void {
        slot.observers--;

        if (slot.observers > 0) return;

        clearTimeout(slot.timer);
        slot.timer = undefined;

        // Idle places stay in the order they were left, the one left longest ago first, and only the latest few are kept.
        const text = keyText(key);

        if (this.#slots.get(text) === slot) {
            this.#slots.delete(text);
            this.#slots.set(text, slot);
        }

        const idle = [...this.#slots].filter(([, candidate]) => candidate.observers === 0);

        for (const [name] of idle.slice(0, Math.max(0, idle.length - MAX_IDLE_PLACES))) this.#slots.delete(name);

        if (![...this.#slots.values()].some(candidate => candidate.observers > 0)) this.#unlisten();
    }

    readonly #onWindow = (): void => {
        if (isHidden()) return;

        const at = Date.now();

        if (at - this.#lastWindowRead < GIT_COALESCE_MS) return;

        this.#lastWindowRead = at;

        for (const slot of this.#slots.values()) if (slot.observers > 0) this.#readAll(slot);
    };

    #listen(): void {
        if (this.#listening || typeof window === 'undefined') return;

        this.#listening = true;
        window.addEventListener('focus', this.#onWindow);
        document.addEventListener('visibilitychange', this.#onWindow);
    }

    #unlisten(): void {
        if (!this.#listening) return;

        this.#listening = false;
        window.removeEventListener('focus', this.#onWindow);
        document.removeEventListener('visibilitychange', this.#onWindow);
    }

    #readAll(slot: Slot): void {
        if (isHidden()) return;

        slot.invalidated = undefined;
        const { facts } = slot;
        const wasNoRepository = facts.isRepository === false;

        facts.startRound();

        const status = facts.status.refresh();

        slot.startedAt = Date.now();

        if (!wasNoRepository) return this.#readRest(slot);

        // A folder that is no repository is asked about its status alone, until it becomes one.
        void status.then(() => {
            if (facts.isRepository === true) this.#readRest(slot);
        });
    }

    #readRest(slot: Slot): void {
        void slot.facts.changes.refresh();
        this.#readPullRequest(slot);
    }

    #readPullRequest(slot: Slot): void {
        void slot.facts.pullRequest.refresh().then(() => this.#schedule(slot));
    }

    /** Waits for the next read of the pull request when a check is not finished and somebody is looking. The wait is not renewed while the window is hidden: the window's return reads again, and that renews it. */
    #schedule(slot: Slot): void {
        clearTimeout(slot.timer);
        slot.timer = undefined;

        if (slot.observers === 0 || !slot.facts.checksPending) return;

        slot.timer = setTimeout(() => {
            slot.timer = undefined;

            if (isHidden() || slot.observers === 0) return;

            this.#readPullRequest(slot);
        }, GIT_POLL_MS);
    }
}

const stores = new WeakMap<object, GitFacts>();

/** The git facts of a transport: made on first use and kept while the app runs, so the Info tab and the Changes tab read the same ones. */
export function gitFactsOf(
    transport: Pick<Transport, 'getGitStatus' | 'getGitChanges' | 'getGitPullRequest'>
): GitFacts {
    let store = stores.get(transport);

    if (!store) {
        store = new GitFacts(transport);
        stores.set(transport, store);
    }

    return store;
}

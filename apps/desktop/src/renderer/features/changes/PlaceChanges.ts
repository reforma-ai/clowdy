import { commitScope } from '@clowdy/protocol';
import { makeAutoObservable, observable, runInAction } from 'mobx';

import { compileChangeFilter } from './changeFilter';
import { isCommitScope, usableScope } from './changeScopes';
import { SidesCache, type SidesRequest } from './fileSides';
import { Fact, placeRef, type PlaceFacts } from './gitFacts';
import { ViewedMarks, type ViewedTransport } from './viewedMarks';

import type { GitBase, GitChangedFile, GitChanges, GitScope } from '@clowdy/protocol';
import type { Transport } from '../../daemon/transport';

/** What the tab's model of a place reads and writes with: the lists, the files' texts and the viewed marks. */
export type PlaceChangesTransport = Pick<Transport, 'getGitChanges' | 'getGitFile'> & ViewedTransport;

/** A list of a place that is a repository. */
export type RepositoryChanges = Extract<GitChanges, { isRepository: true }>;

/** How many scopes keep their last list for the person to come back to: the current one and the ones visited last. */
const MAX_KEPT_LISTS = 8;

/**
 * What the Changes tab shows of one place, apart from what the git facts store keeps for everything that draws the place (the branch, its base and commits, the pull request):
 * the scope the person chose, the filter typed above the cards, the cards that are folded, the files of the scope (`getGitChanges`, one list kept for each scope that was looked
 * at, so a scope that is chosen again shows its last list while it is read again), the texts of the files (`sides`) and the files the person marked as viewed (`viewed`, read with
 * each list; a file is viewed only while its revision is the one it was marked at, so an edit clears it). The tab reads the facts' `generation` and calls `sync`
 * with it, which is how a focus, the end of a run or a `refresh` of the store reach it: it has no timers or window listeners of its own, and reads nothing while the window is hidden.
 * A list that fails to be read keeps its last answer, and says so in the fact's `error`.
 */
export class PlaceChanges {
    /** What the person chose; `effectiveScope` is what is read. */
    scope: GitScope = 'all';
    /** The text of the filter field. */
    filter = '';
    /** Viewed files are not drawn from the list: the cards of the files the person marked as viewed are gone from the list and from the sidebar. */
    hideViewed = false;
    /** The paths of the cards the person shut; every other card is open, so a file that comes with a refresh is open. A viewed file's card is shut as well (`isFolded`). */
    readonly folded = observable.set<string>();
    /** The paths of viewed files whose card the person opened: a viewed card is shut until they do. */
    readonly openedViewed = observable.set<string>();
    /** The files' texts. */
    readonly sides: SidesCache;
    /** The files marked as viewed, and what is on its way to the daemon about them: not the texts' business, so it lives beside the cache and not in it. */
    readonly viewed: ViewedMarks;
    readonly #lists = new Map<GitScope, Fact<GitChanges>>();
    /** What the last read was for (`<scope>@<generation>`), so the same round of reads is not made twice. */
    #stamp = '';

    constructor(
        readonly facts: PlaceFacts,
        private readonly transport: PlaceChangesTransport
    ) {
        const { key } = facts;
        const place = placeRef(key);

        this.sides = new SidesCache(({ scope, path, oldPath, from }) => transport.getGitFile(key.projectId, place, scope, path, oldPath, from));
        this.viewed = new ViewedMarks(key, transport);
        makeAutoObservable<PlaceChanges, 'transport'>(this, { facts: false, transport: false, sides: false, folded: false, openedViewed: false, viewed: false });
    }

    /** The place's base, as the status read says: the branch it is compared with and the commits of its work. */
    get base(): GitBase | undefined {
        return this.facts.base;
    }

    /** The scope that is read: the one chosen, except `branch` where there is no base to count it against. */
    get effectiveScope(): GitScope {
        return usableScope(this.scope, this.base);
    }

    /** The fact of the scope that is read: its last list, and how the reads of it have gone. */
    get list(): Fact<GitChanges> {
        return this.#listOf(this.effectiveScope);
    }

    /** The list of the scope that is read, when there is one: it is never the answer of another scope. */
    get changes(): RepositoryChanges | undefined {
        const { value } = this.list;

        return value?.isRepository === true ? value : undefined;
    }

    /** Whether the place is a repository: the status says it, and so does a list that was read. `undefined` until one has answered. */
    get isRepository(): boolean | undefined {
        return this.facts.isRepository ?? this.list.value?.isRepository;
    }

    /** The files of the scope that the filter lets through, in the daemon's order (by path), whether they are viewed or not. */
    get matchingFiles(): readonly GitChangedFile[] {
        const files = this.changes?.files ?? [];
        const filter = compileChangeFilter(this.filter);

        return filter.isEmpty ? files : files.filter(file => filter.matches(file.path));
    }

    /** The files the list and the sidebar show: the ones the filter lets through, without the viewed ones while they are hidden. */
    get files(): readonly GitChangedFile[] {
        return this.hideViewed ? this.matchingFiles.filter(file => !this.isViewed(file.path)) : this.matchingFiles;
    }

    /** The paths of the files of the list that are viewed now: marked, and at the revision the list has for them. A mark made on its way counts. */
    get viewedPaths(): ReadonlySet<string> {
        const scope = this.effectiveScope;

        return new Set((this.changes?.files ?? []).filter(file => this.viewed.isViewed(scope, file)).map(file => file.path));
    }

    /** Whether the file of the list is viewed. */
    isViewed(path: string): boolean {
        return this.viewedPaths.has(path);
    }

    /** How many files of the list are viewed. */
    get viewedCount(): number {
        return this.viewedPaths.size;
    }

    /** Hides the viewed files from the list and the sidebar, or shows them again. */
    setHideViewed(hide: boolean): void {
        this.hideViewed = hide;
    }

    /**
     * Marks the file as viewed or takes the mark back, and shuts its card or opens it (a viewed card is shut until it is opened, and the file shows as viewed as soon as the choice is made,
     * before the daemon has answered). When the daemon refuses, the file is as it was, and so is its card, unless the person has moved it since.
     */
    async setViewed(file: Pick<GitChangedFile, 'path' | 'revision'>, viewed: boolean): Promise<void> {
        const { path } = file;
        const wasFolded = this.folded.has(path);
        const wasOpened = this.openedViewed.has(path);
        const scope = this.effectiveScope;

        this.folded.delete(path);
        this.openedViewed.delete(path);

        const kept = await (viewed ? this.viewed.mark(scope, file) : this.viewed.unmark(scope, path));

        if (kept) return;

        runInAction(() => {
            if (wasFolded && !this.folded.has(path)) this.folded.add(path);

            if (wasOpened && !this.openedViewed.has(path)) this.openedViewed.add(path);
        });
    }

    /** What a card asks the cache for when it wants a file's texts. */
    requestOf(file: GitChangedFile): SidesRequest {
        const from = this.changes?.from;

        return { scope: this.effectiveScope, path: file.path, ...(file.oldPath !== undefined && { oldPath: file.oldPath }), revision: file.revision, ...(from !== undefined && { from }) };
    }

    /** Whether the card of the file is shut: the person shut it, or the file is viewed and the person has not opened it since. */
    isFolded(path: string): boolean {
        return this.folded.has(path) || (this.isViewed(path) && !this.openedViewed.has(path));
    }

    toggleFolded(path: string): void {
        if (this.isFolded(path)) {
            this.reveal(path);
        }
        else {
            this.#fold(path);
        }
    }

    /** Shuts a card: a viewed file's goes back to being shut by being viewed, so it opens by itself once the file is edited and is no longer viewed; any other is shut by the person. */
    #fold(path: string): void {
        if (this.isViewed(path)) {
            this.openedViewed.delete(path);
        }
        else {
            this.folded.add(path);
        }
    }

    /** Opens a card, for a click on its file in the sidebar. */
    reveal(path: string): void {
        this.folded.delete(path);

        if (this.isViewed(path)) this.openedViewed.add(path);
    }

    /** Shuts the cards the filter shows. */
    foldAll(): void {
        for (const file of this.files) this.#fold(file.path);
    }

    /** Opens every card, those the filter hides and the viewed ones too. */
    unfoldAll(): void {
        this.folded.clear();

        for (const path of this.viewedPaths) this.openedViewed.add(path);
    }

    /** The cards as they are when the tab appears: the viewed ones are shut and every other is open. */
    resetFolds(): void {
        this.folded.clear();
        this.openedViewed.clear();
    }

    /** Every card the filter shows is shut. */
    get allFolded(): boolean {
        const { files } = this;

        return files.length > 0 && files.every(file => this.isFolded(file.path));
    }

    /** No card of the list is shut. */
    get noneFolded(): boolean {
        return !(this.changes?.files ?? []).some(file => this.isFolded(file.path));
    }

    setScope(scope: GitScope): void {
        this.scope = scope;
    }

    /** Shows one commit of the branch alone, or all changes again when that commit is the one that is shown: a second press on it. */
    pickCommit(sha: string): void {
        const scope = commitScope(sha);

        this.scope = this.effectiveScope === scope ? 'all' : scope;
    }

    setFilter(filter: string): void {
        this.filter = filter;
    }

    /**
     * Reads the list of the scope that is read, unless this round of reads has done it (the same scope and the same `generation` of the facts). Called by the tab when it appears,
     * when the scope changes and when the facts start a round, which is what makes one read of a first round and not two.
     */
    sync(generation: number): void {
        const stamp = `${ this.effectiveScope }@${ generation }`;

        if (stamp === this.#stamp) return;

        this.#stamp = stamp;
        void this.#read(this.effectiveScope);
        this.#readViewed(this.effectiveScope);
    }

    /** Reads the list of the scope that is read now, whatever was read before: a retry. */
    reload(): void {
        this.#stamp = '';
        void this.#read(this.effectiveScope);
        this.#readViewed(this.effectiveScope);
    }

    /** Reads the marks of the scope with its list: a mark made in another window shows with the next round of the facts. Nothing to read for a folder that is no repository. */
    #readViewed(scope: GitScope): void {
        if (this.isRepository !== false) void this.viewed.read(scope);
    }

    #listOf(scope: GitScope): Fact<GitChanges> {
        let fact = this.#lists.get(scope);

        if (!fact) {
            const { key } = this.facts;
            const place = placeRef(key);

            fact = new Fact(() => this.transport.getGitChanges(key.projectId, place, scope));
            this.#lists.set(scope, fact);

            // The oldest lists go, the one that is read and the one before it never.
            for (const [kept] of [...this.#lists].slice(0, Math.max(0, this.#lists.size - MAX_KEPT_LISTS))) {
                if (kept !== scope && kept !== this.effectiveScope) this.#lists.delete(kept);
            }
        }

        return fact;
    }

    async #read(scope: GitScope): Promise<void> {
        const fact = this.#listOf(scope);

        await fact.refresh();

        // A commit that is gone (the branch was rewritten) leaves the scope that was on it, which would only say the same thing again.
        if (fact.errorStatus === 404 && isCommitScope(scope) && this.scope === scope) {
            runInAction(() => {
                this.scope = 'all';
            });
        }
    }
}

/** How many places keep what the tab shows of them (the scope, the filter, the lists and the texts), for the person to come back to the tab and find it as it was. */
const MAX_KEPT_PLACES = 4;

const kept = new WeakMap<object, Map<string, PlaceChanges>>();

/**
 * What the tab shows of a place, made when it is first asked for and kept for the latest few places, so a tab that is shut (the panel keeps no tab built that is not on show)
 * comes back with its scope, its filter and the texts it had read. Made again when the git facts of the place were dropped and made again, since it follows those.
 */
export function placeChangesOf(transport: PlaceChangesTransport, facts: PlaceFacts): PlaceChanges {
    let places = kept.get(transport);

    if (!places) {
        places = new Map();
        kept.set(transport, places);
    }

    const { projectId, folderId, workspaceId } = facts.key;
    const name = `${ projectId }/${ folderId }/${ workspaceId ?? '' }`;
    const found = places.get(name);
    const model = found?.facts === facts ? found : new PlaceChanges(facts, transport);

    // Used last stands last, and the one used longest ago goes.
    places.delete(name);
    places.set(name, model);

    for (const [oldest] of [...places].slice(0, Math.max(0, places.size - MAX_KEPT_PLACES))) places.delete(oldest);

    return model;
}

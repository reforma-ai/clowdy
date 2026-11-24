import { commitScope, turnScopeTrees } from '@clowdy/protocol';
import { makeAutoObservable, observable, runInAction } from 'mobx';

import { compileChangeFilter } from './changeFilter';
import { isCommitScope, usableScope } from './changeScopes';
import { discardableFiles } from './discardRules';
import { SidesCache, type SidesRequest } from './fileSides';
import { Fact, type PlaceFacts, placeRef } from './gitFacts';
import { sourceControlPreferences } from './sourceControlPreferences';
import { ViewedMarks, type ViewedTransport } from './viewedMarks';

import type { GitBase, GitChangedFile, GitChanges, GitScope } from '@clowdy/protocol';
import type { Transport } from '../../daemon/transport';

/** What the tab's model of a place reads and writes with: the lists, the files' texts and the viewed marks. */
export type PlaceChangesTransport = Pick<Transport, 'getGitChanges' | 'getGitFile'> & ViewedTransport;

/** A file of the list, or its path: a card passes its own file, which ties what it reads to that file alone. */
export type FileRef = string | Pick<GitChangedFile, 'path' | 'revision'>;

const pathOfRef = (file: FileRef): string => (typeof file === 'string' ? file : file.path);

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
    /** Viewed files are omitted from the diff list while this is on. */
    hideViewed = false;
    /** The explicit fold choices for this view, by path. */
    readonly #folds = observable.map<string, boolean>();
    /** The scope of the open chat's latest run (`turnScope`), which the tab is told (`setRun`) and the scope menu offers as `Last run`; none while the chat has no run that changed files. */
    runScope: GitScope | undefined = undefined;
    /** The chat `runScope` is the run of. */
    #runChatId: string | undefined;
    /** The person chose the run's scope, so the tab follows the chat's run: a newer run replaces it. */
    followsRun = false;
    /** A file a press on the last run plate asked to be brought up, once the list that has it is read (`ChangesView`). */
    revealRequest: string | undefined = undefined;
    /** The files' texts. */
    readonly sides: SidesCache;
    /** The files marked as viewed, and what is on its way to the daemon about them: not the texts' business, so it lives beside the cache and not in it. */
    readonly viewed: ViewedMarks;
    readonly #lists = new Map<GitScope, Fact<GitChanges>>();
    /** What the last read was for (`<scope>@<generation>`), so the same round of reads is not made twice. */
    #stamp = '';
    /** The round of reads (`syncUncommitted`) the uncommitted files were last read for. */
    #uncommittedStamp = '';

    constructor(
        readonly facts: PlaceFacts,
        private readonly transport: PlaceChangesTransport,
        private readonly preferences: { readonly collapseDiffs: boolean } = sourceControlPreferences
    ) {
        const { key } = facts;
        const place = placeRef(key);

        this.sides = new SidesCache(({ scope, path, oldPath, from }) =>
            transport.getGitFile(key.projectId, place, scope, path, oldPath, from)
        );
        this.viewed = new ViewedMarks(key, transport);
        makeAutoObservable<PlaceChanges, 'transport' | 'preferences'>(this, {
            facts: false,
            transport: false,
            sides: false,
            preferences: false,
            viewed: false,
        });
    }

    /** The place's base, as the status read says: the branch it is compared with and the commits of its work. */
    get base(): GitBase | undefined {
        return this.facts.base;
    }

    /** The scope that is read: the open chat's run while the person follows it, else the one chosen, except `branch` where there is no base to count it against. */
    get effectiveScope(): GitScope {
        return this.followsRun && this.runScope ? this.runScope : usableScope(this.scope, this.base);
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

    /**
     * The uncommitted files of the place, whichever scope is shown: what the commit box lists and ticks from. It is the list of the `uncommitted` scope, so it is the one
     * `list` is when that scope is shown. `undefined` until it has been read.
     */
    get uncommitted(): RepositoryChanges | undefined {
        const { value } = this.#listOf('uncommitted');

        return value?.isRepository === true ? value : undefined;
    }

    /**
     * The files whose changes can be discarded from the scope that is shown, by path: the place's uncommitted files in `all` and `uncommitted`, and none in the branch or a commit (`discardableFiles`).
     * What each maps to is the file's uncommitted entry, which is what a discard acts on and the dialog speaks of. None while the branch is being changed.
     */
    get discardable(): ReadonlyMap<string, GitChangedFile> {
        // While the branch is being changed what is uncommitted is in motion: nothing is offered until the list is read again.
        return this.facts.switching ? new Map() : discardableFiles(this.effectiveScope, this.uncommitted);
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

    /** The files the diff list shows: the ones the filter lets through, without the viewed ones while they are hidden. */
    get files(): readonly GitChangedFile[] {
        return this.hideViewed ? this.matchingFiles.filter(file => !this.isViewed(file)) : this.matchingFiles;
    }

    /** The paths of the files of the list that are viewed now: marked, and at the revision the list has for them. A mark made on its way counts. */
    get viewedPaths(): ReadonlySet<string> {
        const scope = this.effectiveScope;

        return new Set(
            (this.changes?.files ?? []).filter(file => this.viewed.isViewed(scope, file)).map(file => file.path)
        );
    }

    /**
     * Whether the file of the list is viewed. Given the file, it reads that file's mark alone, so a mark on another file does not touch the card that asks; given a path, the
     * revision is the list's.
     */
    isViewed(file: FileRef): boolean {
        return typeof file === 'string' ? this.viewedPaths.has(file) : this.viewed.isViewed(this.effectiveScope, file);
    }

    /** How many files of the list are viewed. */
    get viewedCount(): number {
        return this.viewedPaths.size;
    }

    /** Hides the viewed files from the list, or shows them again. */
    setHideViewed(hide: boolean): void {
        this.hideViewed = hide;
    }

    /**
     * Marks the file as viewed or takes the mark back, and shuts its card or opens it (a viewed card is shut until it is opened, and the file shows as viewed as soon as the choice is made,
     * before the daemon has answered). When the daemon refuses, the file is as it was, and so is its card, unless the person has moved it since.
     */
    async setViewed(file: Pick<GitChangedFile, 'path' | 'revision'>, viewed: boolean): Promise<void> {
        const { path } = file;
        const previous = this.#folds.get(path);
        const scope = this.effectiveScope;

        if (viewed) this.#folds.delete(path);
        else this.reveal(path);

        const pending = this.#folds.get(path);
        const kept = await (viewed ? this.viewed.mark(scope, file) : this.viewed.unmark(scope, path));

        if (kept) return;

        runInAction(() => {
            if (this.effectiveScope !== scope || this.#folds.get(path) !== pending) return;

            if (previous === undefined) this.#folds.delete(path);
            else this.#folds.set(path, previous);
        });
    }

    /** `GitChanges.from` of the list: a value of its own, so a card that reads it is not drawn again for each new list that has the same one. */
    get from(): string | undefined {
        return this.changes?.from;
    }

    /** What a card asks the cache for when it wants a file's texts. */
    requestOf(file: GitChangedFile): SidesRequest {
        const { from } = this;

        return {
            scope: this.effectiveScope,
            path: file.path,
            ...(file.oldPath !== undefined && { oldPath: file.oldPath }),
            revision: file.revision,
            ...(from !== undefined && { from }),
        };
    }

    isFolded(file: FileRef): boolean {
        return this.#folds.get(pathOfRef(file)) ?? (this.preferences.collapseDiffs || this.isViewed(file));
    }

    toggleFolded(file: FileRef): void {
        if (this.isFolded(file)) {
            this.reveal(pathOfRef(file));
        } else {
            this.#fold(file);
        }
    }

    #fold(file: FileRef): void {
        const path = pathOfRef(file);

        if (this.isViewed(file)) this.#folds.delete(path);
        else this.#folds.set(path, true);
    }

    /** Opens a card, including one linked from the last run summary. */
    reveal(path: string): void {
        this.#folds.set(path, false);
    }

    /** Shuts the cards the filter shows. */
    foldAll(): void {
        for (const file of this.files) this.#fold(file);
    }

    /** Opens every card, including the ones the filter hides. */
    unfoldAll(): void {
        this.#folds.clear();

        for (const file of this.changes?.files ?? []) this.reveal(file.path);
    }

    /** Restore the default fold state when the view is opened again. */
    resetFolds(): void {
        this.#folds.clear();
    }

    /** Every card the filter shows is shut. */
    get allFolded(): boolean {
        const { files } = this;

        return files.length > 0 && files.every(file => this.isFolded(file));
    }

    /** The scope the person picked in the menu. The open chat's run (the one entry of the menu that is no choice of `scope`) is followed, so a newer run of the chat replaces it. */
    setScope(scope: GitScope): void {
        if (turnScopeTrees(scope)) {
            this.followsRun = this.runScope === scope;

            return;
        }

        this.followsRun = false;
        this.revealRequest = undefined;
        this.scope = scope;
    }

    /** Shows one commit of the branch alone, or all changes again when that commit is the one that is shown: a second press on it. */
    pickCommit(sha: string): void {
        const scope = commitScope(sha);

        this.scope = this.effectiveScope === scope ? 'all' : scope;
        this.followsRun = false;
        this.revealRequest = undefined;
    }

    /**
     * Tells the tab which chat is open and the scope of that chat's latest run (none when it changed no file). The tab is the place's, which several chats share, so a run is the open
     * chat's alone: another chat that is opened is not shown the last one's run, and the choice of following it goes with the chat.
     */
    setRun(chatId: string | undefined, scope: GitScope | undefined): void {
        if (chatId !== this.#runChatId) this.followsRun = false;

        this.#runChatId = chatId;
        this.runScope = scope;
    }

    /**
     * Shows what the chat's latest run changed, and asks for one of its files to be brought up when the list has it (a press on a row of the last run plate): the run is followed, and
     * `ChangesView` opens the card and scrolls to it once the list of the run is read.
     */
    showRun(chatId: string, scope: GitScope, path?: string): void {
        this.setRun(chatId, scope);
        this.followsRun = true;
        this.revealRequest = path;
    }

    /** Shows a merge file in the uncommitted diff list. */
    showUncommittedFile(path: string): void {
        this.setScope('uncommitted');
        this.setFilter('');
        this.revealRequest = path;
    }

    /** The request of `showRun` is answered or no longer wanted. */
    clearRevealRequest(): void {
        this.revealRequest = undefined;
    }

    setFilter(filter: string): void {
        this.filter = filter;
    }

    /**
     * Reads the list of the scope that is read, unless this round of reads has done it (the same scope and the same `generation` of the facts). Called by the tab when it appears,
     * when the scope changes and when the facts start a round, which is what makes one read of a first round and not two.
     */
    sync(generation: number): void {
        const stamp = `${this.effectiveScope}@${generation}`;

        if (stamp === this.#stamp) return;

        this.#stamp = stamp;
        void this.#read(this.effectiveScope);
        this.#readViewed(this.effectiveScope);
    }

    /**
     * Reads the uncommitted files for the commit box, which shows them whatever scope is shown: once for each `generation` of the facts, as `sync` does. The `uncommitted` scope is read by
     * `sync` itself when it is the one shown, so then there is nothing to do here.
     */
    syncUncommitted(generation: number): void {
        const stamp = String(generation);

        if (this.effectiveScope === 'uncommitted' || stamp === this.#uncommittedStamp) return;

        this.#uncommittedStamp = stamp;
        void this.#read('uncommitted');
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
                if (kept !== scope && kept !== this.effectiveScope && kept !== 'uncommitted') this.#lists.delete(kept);
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
    const name = `${projectId}/${folderId}/${workspaceId ?? ''}`;
    const found = places.get(name);
    const model = found?.facts === facts ? found : new PlaceChanges(facts, transport);

    // Used last stands last, and the one used longest ago goes.
    places.delete(name);
    places.set(name, model);

    for (const [oldest] of [...places].slice(0, Math.max(0, places.size - MAX_KEPT_PLACES))) places.delete(oldest);

    return model;
}

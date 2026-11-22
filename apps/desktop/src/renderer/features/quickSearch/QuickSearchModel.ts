import { errorMessage } from '@clowdy/lib';
import { makeAutoObservable, runInAction } from 'mobx';

import type { SearchResult } from '@clowdy/file-manager/provider';
import type { Chat, ChatId, Run } from '@clowdy/protocol';

export type QuickSearchTab = 'all' | 'chats' | 'files' | 'text';

export const QUICK_SEARCH_TABS: ReadonlyArray<{ value: QuickSearchTab; label: string }> = [
    { value: 'all', label: 'All' },
    { value: 'chats', label: 'Chats' },
    { value: 'files', label: 'Files' },
    { value: 'text', label: 'Text' },
];

/** A chat of the project whose title has the words typed, or, with nothing typed, one of the latest. */
export interface FoundChat {
    kind: 'chat';
    id: string;
    chatId: ChatId;
    chat: Chat;
    /** The run that answers the chat, for the icon of its row. */
    run: Run | undefined;
    /** What the row says at its right: the folder of the chat, when the project has several. */
    note?: string;
}

/** A file whose name matches. */
export interface FoundFile {
    kind: 'file';
    id: string;
    path: string;
}

/** A line of a file's content that matches: `line` and `column` are 1-based, `ranges` are offsets into `preview`. */
export interface FoundLine {
    kind: 'line';
    id: string;
    path: string;
    line: number;
    column: number;
    preview: string;
    ranges: ReadonlyArray<{ start: number; end: number }>;
}

export type Found = FoundChat | FoundFile | FoundLine;

export interface FoundSection {
    id: 'chats' | 'archived' | 'files' | 'text';
    title: string;
    items: Found[];
}

/** Where the search looks and what choosing a result does. A source fails with an `Error` whose message the palette shows. */
export interface QuickSearchSource {
    /**
     * The chats that answer `query`, best first, all of them: the model takes as many as its tab shows. Read at once and not waited for, from what the app holds, so the
     * list follows the chats as they change; a blank query is the chats of the person's latest work.
     */
    chats: (query: string) => FoundChat[];
    /** The paths of the files whose name or folder matches `query`, the best match first. */
    files: (query: string) => Promise<string[]>;
    /** The lines of the files' content that have `query`. */
    text: (query: string) => Promise<SearchResult>;
    open: (found: Found) => void;
    /** Whatever the source holds while the palette is open. */
    dispose?: () => void;
}

/** Typing searches once it pauses this long. */
export const TYPING_DELAY = 150;
/** The rows of each list: the tab of one kind lists up to its own, the All tab a few of each. */
export const CHAT_ROWS = 50;
export const FILE_ROWS = 50;
export const LINE_ROWS = 200;
export const ALL_CHAT_ROWS = 4;
export const ALL_ARCHIVED_ROWS = 3;
/** With nothing typed the All tab lists the latest chats and nothing else, so it has room for more of them. */
export const ALL_RECENT_CHAT_ROWS = 8;
export const ALL_FILE_ROWS = 6;
export const ALL_LINE_ROWS = 12;

interface Done<T> {
    query: string;
    value: T;
}

/**
 * What the quick search palette shows and does, apart from how it is drawn: the query and the tab, the files and the lines found for the query (each kind
 * is searched on its own and shows up as it arrives, and only as the tab needs it), and the row the keys are on. A search that is not the latest is dropped.
 */
export class QuickSearchModel {
    query = '';
    tab: QuickSearchTab;
    /** What the latest finished searches found, with the query each was for. */
    files: Done<string[]> | null = null;
    lines: Done<SearchResult> | null = null;
    filesError: string | null = null;
    linesError: string | null = null;
    filesPending = false;
    linesPending = false;
    /** The id of the row the keys moved to; `null` while they have not. */
    activeId: string | null = null;
    #typing: ReturnType<typeof setTimeout> | undefined;
    #filesRun = 0;
    #linesRun = 0;

    constructor(private readonly source: QuickSearchSource, tab: QuickSearchTab = 'all', query = '') {
        this.tab = tab;
        this.query = query;
        makeAutoObservable<QuickSearchModel, 'source'>(this, { source: false });

        if (query.trim() !== '') this.#search();
    }

    get blank(): boolean {
        return this.query.trim() === '';
    }

    /** Some search for the tab is still running. */
    get pending(): boolean {
        return (this.#wantsFiles && this.filesPending) || (this.#wantsLines && this.linesPending);
    }

    /** Every search the tab needs has answered for the query as it is now: an empty list is then an empty answer, and not one still to come. */
    get answered(): boolean {
        return (!this.#wantsFiles || this.files?.query === this.query) && (!this.#wantsLines || this.lines?.query === this.query);
    }

    /** The reason the tab has nothing to list, when a search it needs failed: a list that came is shown, and the failure of the other kind is not in its way. */
    get error(): string | null {
        if (this.rows.length > 0) return null;

        return (this.#wantsFiles && this.filesError) || (this.#wantsLines && this.linesError) || null;
    }

    /** The lists the tab shows, with what each found. */
    get sections(): FoundSection[] {
        const all = this.tab === 'all';
        const sections: FoundSection[] = [];

        if (this.#wantsChats) {
            // The archive is a list of its own, after the chats in use.
            const found = this.source.chats(this.query);
            const chats = found.filter(({ chat }) => chat.archivedAt === undefined).slice(0, all ? (this.blank ? ALL_RECENT_CHAT_ROWS : ALL_CHAT_ROWS) : CHAT_ROWS);
            const archived = found.filter(({ chat }) => chat.archivedAt !== undefined).slice(0, all ? ALL_ARCHIVED_ROWS : CHAT_ROWS);

            if (chats.length > 0) sections.push({ id: 'chats', title: this.blank ? 'Recent chats' : 'Chats', items: chats });

            if (archived.length > 0) sections.push({ id: 'archived', title: 'Archived chats', items: archived });
        }

        if (this.#wantsFiles && this.files) {
            const paths = this.files.value.slice(0, all ? ALL_FILE_ROWS : FILE_ROWS);

            if (paths.length > 0) sections.push({ id: 'files', title: 'Files', items: paths.map((path): Found => ({ kind: 'file', id: `file:${ path }`, path })) });
        }

        if (this.#wantsLines && this.lines) {
            const items: Found[] = [];

            for (const { path, matches } of this.lines.value.files) {
                for (const { line, column, preview, ranges } of matches) {
                    if (items.length >= (all ? ALL_LINE_ROWS : LINE_ROWS)) break;

                    items.push({ kind: 'line', id: `line:${ path }:${ line }`, path, line, column, preview, ranges });
                }
            }

            if (items.length > 0) sections.push({ id: 'text', title: 'Text', items });
        }

        return sections;
    }

    /** Every row the keys can reach, in the order they are drawn. */
    get rows(): Found[] {
        return this.sections.flatMap(section => section.items);
    }

    /** The row the keys are on: the first, until one is moved to. */
    get active(): Found | undefined {
        return this.rows.find(row => row.id === this.activeId) ?? this.rows[0];
    }

    setQuery(query: string): void {
        this.query = query;
        this.activeId = null;
        clearTimeout(this.#typing);

        if (this.blank) {
            this.#clear();

            return;
        }

        this.#typing = setTimeout(() => this.#search(), TYPING_DELAY);
    }

    setTab(tab: QuickSearchTab): void {
        this.tab = tab;
        this.activeId = null;

        // Right away: the person asked for this list, and the pause of typing is not theirs to wait out.
        if (!this.blank) {
            clearTimeout(this.#typing);
            this.#search();
        }
    }

    /** The tab after (or, with a negative `step`, before) this one. */
    stepTab(step: number): void {
        const index = QUICK_SEARCH_TABS.findIndex(({ value }) => value === this.tab);

        this.setTab(QUICK_SEARCH_TABS[(index + step + QUICK_SEARCH_TABS.length) % QUICK_SEARCH_TABS.length]!.value);
    }

    /** Moves to the row `step` rows on, round to the other end. */
    move(step: number): void {
        const { rows } = this;

        if (rows.length === 0) return;

        const index = this.active ? rows.indexOf(this.active) : 0;

        this.activeId = rows[(index + step + rows.length) % rows.length]!.id;
    }

    activate(found: Found): void {
        this.activeId = found.id;
    }

    /** Opens a row (the one the keys are on, without one). Whether there was any. */
    open(found: Found | undefined = this.active): boolean {
        if (!found) return false;

        this.source.open(found);

        return true;
    }

    dispose(): void {
        clearTimeout(this.#typing);
        this.#filesRun++;
        this.#linesRun++;
        this.source.dispose?.();
    }

    get #wantsChats(): boolean {
        return this.tab === 'all' || this.tab === 'chats';
    }

    get #wantsFiles(): boolean {
        return this.tab === 'all' || this.tab === 'files';
    }

    get #wantsLines(): boolean {
        return this.tab === 'all' || this.tab === 'text';
    }

    #clear(): void {
        this.#filesRun++;
        this.#linesRun++;
        this.files = null;
        this.lines = null;
        this.filesError = null;
        this.linesError = null;
        this.filesPending = false;
        this.linesPending = false;
        this.activeId = null;
    }

    /** Searches what the tab shows and has no answer for yet. */
    #search(): void {
        const { query } = this;

        if (this.#wantsFiles && this.files?.query !== query) void this.#searchFiles(query);

        if (this.#wantsLines && this.lines?.query !== query) void this.#searchLines(query);
    }

    async #searchFiles(query: string): Promise<void> {
        const run = ++this.#filesRun;

        runInAction(() => {
            this.filesPending = true;
        });

        await this.source.files(query).then(
            value => run === this.#filesRun && runInAction(() => {
                this.files = { query, value };
                this.filesError = null;
                this.filesPending = false;
                this.activeId = null;
            }),
            (error: unknown) => run === this.#filesRun && runInAction(() => {
                this.files = null;
                this.filesError = errorMessage(error);
                this.filesPending = false;
            })
        );
    }

    async #searchLines(query: string): Promise<void> {
        const run = ++this.#linesRun;

        runInAction(() => {
            this.linesPending = true;
        });

        await this.source.text(query).then(
            value => run === this.#linesRun && runInAction(() => {
                this.lines = { query, value };
                this.linesError = null;
                this.linesPending = false;
                this.activeId = null;
            }),
            (error: unknown) => run === this.#linesRun && runInAction(() => {
                this.lines = null;
                this.linesError = errorMessage(error);
                this.linesPending = false;
            })
        );
    }
}

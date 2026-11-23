import { unavailable } from '../errors';
import { Collector } from './search-collect';
import { RipgrepLocator, RipgrepMissing, ripgrepSearch } from './search-ripgrep';
import { ALWAYS_EXCLUDED, checkExcludes, checkQuery, PathFilter, queryMatcher } from './search-rules';
import { scanSearch } from './search-scan';

import type { FsSearchRequest, FsSearchResult } from '@clowdy/protocol';

/** A search that has not finished by now ends with what it has found and `truncated`. */
export const SEARCH_TIME_LIMIT_MS = 60_000;
/** Searches that run at once; the next ones wait their turn, up to `MAX_WAITING` of them, and the rest are refused. */
export const MAX_RUNNING_SEARCHES = 4;
export const MAX_WAITING_SEARCHES = 16;

export interface SearchOptions {
    /**
     * The ripgrep executable (`CLOWDY_RG`): an absolute path; `false` for none, so the daemon scans the files itself; absent, the `rg` on the
     * PATH. Ripgrep that cannot be found or started is not an error, the scan answers instead.
     */
    ripgrep?: string | false;
}

/** The part of a request the search needs: the folder and its worktree are resolved by the caller. */
export type SearchQuery = Omit<FsSearchRequest, 'folderId' | 'workspaceId'>;

/**
 * The search of a folder's file contents (`POST fs/search`): the literal text, case and whole word options, the folders and files that are
 * never searched and the request's own `exclude` globs. It runs ripgrep and, where there is none, a scan of the daemon's own that answers
 * the same. The caller names the real path of the folder.
 *
 * A few searches run at once; more wait in line and a search that is aborted while it waits leaves it. A search that is aborted (the client
 * went away), runs out of time, or is cut by the daemon stopping answers with what it has found and `truncated`.
 */
export class ContentSearch {
    /** A test lowers these. */
    timeLimitMs = SEARCH_TIME_LIMIT_MS;
    maxRunning = MAX_RUNNING_SEARCHES;
    maxWaiting = MAX_WAITING_SEARCHES;
    /** The engine the last search ran on. */
    lastEngine: 'ripgrep' | 'scan' | undefined;

    private locator: RipgrepLocator;
    private running = 0;
    private waiting: Array<() => void> = [];
    private stopped = new AbortController();

    constructor(options: SearchOptions = {}) {
        this.locator = new RipgrepLocator(options.ripgrep);
    }

    /** How many searches are running now. */
    get active(): number {
        return this.running;
    }

    async search(root: string, request: SearchQuery, signal?: AbortSignal): Promise<FsSearchResult> {
        const { query, matchCase = false, wholeWord = false, exclude = [] } = request;

        checkQuery(query);
        checkExcludes(exclude);

        const caller = signal ? AbortSignal.any([signal, this.stopped.signal]) : this.stopped.signal;

        if (!await this.enter(caller)) {
            return { files: [], truncated: true };
        }

        try {
            const ending = AbortSignal.any([caller, AbortSignal.timeout(this.timeLimitMs)]);
            const globs = [...ALWAYS_EXCLUDED, ...exclude];
            const collector = new Collector();

            if (!await this.withRipgrep({ root, query, matchCase, wholeWord, globs }, collector, ending)) {
                this.lastEngine = 'scan';
                await scanSearch(root, queryMatcher(query, matchCase, wholeWord), new PathFilter(globs), collector, ending);
            }

            collector.truncated ||= ending.aborted;

            return collector.result();
        }
        finally {
            this.leave();
        }
    }

    /** Ends every search that is running or waiting: the daemon is stopping. */
    stop(): void {
        this.stopped.abort();
    }

    /** Runs ripgrep when there is one. Answers `false` when there is none, or it could not be started. */
    private async withRipgrep(run: { root: string; query: string; matchCase: boolean; wholeWord: boolean; globs: string[] }, collector: Collector, signal: AbortSignal): Promise<boolean> {
        const program = this.locator.find();

        if (program === null) {
            return false;
        }

        try {
            await ripgrepSearch({ ...run, program }, collector, signal);
            this.lastEngine = 'ripgrep';

            return true;
        }
        catch (error) {
            if (error instanceof RipgrepMissing) {
                this.locator.forget();

                return false;
            }

            throw error;
        }
    }

    /** Waits for a place among the running searches. `false` when the signal fired while waiting; refuses when too many wait already. */
    private async enter(signal: AbortSignal): Promise<boolean> {
        if (signal.aborted) {
            return false;
        }

        if (this.running < this.maxRunning) {
            this.running += 1;

            return true;
        }

        if (this.waiting.length >= this.maxWaiting) {
            throw unavailable('Too many searches are running, try again in a moment');
        }

        return new Promise<boolean>((resolve) => {
            const turn = () => {
                signal.removeEventListener('abort', give);
                this.running += 1;
                resolve(true);
            };
            const give = () => {
                const at = this.waiting.indexOf(turn);

                if (at !== -1) {
                    this.waiting.splice(at, 1);
                }

                resolve(false);
            };

            this.waiting.push(turn);
            signal.addEventListener('abort', give, { once: true });
        });
    }

    private leave(): void {
        this.running -= 1;
        this.waiting.shift()?.();
    }
}

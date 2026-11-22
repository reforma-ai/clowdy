import { action, observable, observableRef, runInAction } from 'mobx';

import { mediaKind } from '../paths';

import type { FileManager } from '../FileManager';
import type { SearchMatch, SearchQuery, SearchResult, SearchService } from '../provider';

/** The scan stops after this many matches, as the sandbox search does. */
const MAX_MATCHES = 2_000;
/** The scan skips larger files, as the sandbox search does. */
const MAX_FILE_SIZE = 1024 * 1024;
/** Characters of a long line a match keeps, from a little before its first match. */
const PREVIEW_CHARS = 250;

type Range = { start: number; end: number };

/** What the Search tab edits. */
interface SearchOptions {
    query: string;
    matchCase: boolean;
    wholeWord: boolean;
}

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The literal query as a JavaScript pattern with ripgrep's options. */
function patternOf({ query, matchCase, wholeWord }: SearchQuery): RegExp {
    const flags = matchCase ? 'g' : 'gi';
    const source = escapeRegExp(query);

    // ripgrep's `-w`: no word character right before or after a match.
    return new RegExp(wholeWord ? `(?<!\\w)(?:${source})(?!\\w)` : source, flags);
}

/** A matching line as the Search tab shows it; a long line keeps the part around its first match. */
function matchOf(line: number, text: string, ranges: readonly Range[]): SearchMatch {
    const first = ranges[0]!.start;
    const from = text.length > PREVIEW_CHARS ? Math.max(0, first - 40) : 0;
    const preview = text.slice(from, from + PREVIEW_CHARS);

    return {
        line,
        column: first + 1,
        preview,
        ranges: ranges
            .filter(range => range.start - from < preview.length)
            .map(range => ({ start: range.start - from, end: Math.min(range.end - from, preview.length) })),
    };
}

/**
 * Searches without a search service: reads every shown text file through the provider, in path
 * order, skipping media and files over 1 MB, up to the same match cap as the sandbox search.
 */
async function scan(manager: FileManager, query: SearchQuery, signal: AbortSignal): Promise<SearchResult> {
    const pattern = patternOf(query);
    const paths = (await manager.provider.list())
        .filter(
            ({ path, kind, size }) =>
                kind === 'file' &&
                !mediaKind(path) &&
                (size === undefined || size <= MAX_FILE_SIZE) &&
                manager.tree.isVisible(path)
        )
        .map(({ path }) => path)
        .sort((a, b) => a.localeCompare(b));
    const files: SearchResult['files'] = [];
    let count = 0;

    for (const path of paths) {
        signal.throwIfAborted();

        // A file deleted since the listing is skipped.
        const content = await manager.provider.read(path).catch(() => null);

        if (content?.kind !== 'text' || content.text.length > MAX_FILE_SIZE) {
            continue;
        }

        const matches: SearchMatch[] = [];
        let truncated = false;

        for (const [index, text] of content.text.split('\n').entries()) {
            const line = text.endsWith('\r') ? text.slice(0, -1) : text;
            const ranges = [...line.matchAll(pattern)]
                .filter(match => match[0] !== '')
                .map(match => ({ start: match.index, end: match.index + match[0].length }));

            if (ranges.length === 0) {
                continue;
            }

            if (count >= MAX_MATCHES) {
                truncated = true;
                break;
            }

            count += ranges.length;
            matches.push(matchOf(index + 1, line, ranges));
        }

        if (matches.length > 0) {
            files.push({ path, matches });
        }

        if (truncated) {
            return { files, truncated };
        }
    }

    return { files, truncated: false };
}

/**
 * Content search: the query and options the Search tab edits, and the latest result. It runs
 * through the host's search service, or scans files through the provider when there is none.
 * A new search cancels the one still running.
 */
export class TextSearch implements SearchOptions {
    @observable accessor query = '';
    @observable accessor matchCase = false;
    @observable accessor wholeWord = false;
    /** The latest finished search; `null` before one, for an empty query and after an error. */
    @observableRef accessor result: SearchResult | null = null;
    @observable accessor loading = false;
    /** Why the latest search failed. */
    @observable accessor error: string | null = null;

    readonly #manager: FileManager;
    readonly #service: SearchService;
    #running: AbortController | null = null;

    constructor(manager: FileManager, service?: SearchService) {
        this.#manager = manager;
        this.#service = service ?? ((query, signal) => scan(manager, query, signal));
    }

    /** Changes the query or its options; `run` searches with them. */
    @action
    set(options: Partial<SearchOptions>): void {
        Object.assign(this, options);
    }

    /** Searches with the current query and options, cancelling a search still running. An empty query clears the result. */
    async run(): Promise<void> {
        const running = new AbortController();

        this.#running?.abort();
        this.#running = running;

        if (this.query === '') {
            this.#finish(null, null);

            return;
        }

        runInAction(() => {
            this.loading = true;
        });

        try {
            const result = await this.#service(
                {
                    query: this.query,
                    matchCase: this.matchCase,
                    wholeWord: this.wholeWord,
                    exclude: this.#manager.tree.unshownGlobs,
                },
                running.signal
            );

            if (this.#running === running) {
                this.#finish(result, null);
            }
        }
        catch (error) {
            if (this.#running === running) {
                this.#finish(null, error instanceof Error ? error.message : String(error));
            }
        }
    }

    /** Cancels a search still running. */
    dispose(): void {
        this.#running?.abort();
        this.#running = null;
    }

    @action
    #finish(result: SearchResult | null, error: string | null): void {
        this.result = result;
        this.error = error;
        this.loading = false;
    }
}

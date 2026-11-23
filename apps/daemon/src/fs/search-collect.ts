import { MAX_FS_SEARCH_LINES_PER_FILE, MAX_FS_SEARCH_MATCHES } from '@clowdy/protocol';

import type { FsSearchMatch, FsSearchResult } from '@clowdy/protocol';

/** Characters of a long line a result keeps around its first match, and how many of them come before it. */
const PREVIEW_CHARS = 250;
const PREVIEW_LEAD = 40;

/** A match inside a line, as offsets into the line's string (UTF-16 code units, as the client slices it). */
export interface LineRange {
    start: number;
    end: number;
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** A matching line as the client shows it: the line (a long one cut around its first match, never inside a surrogate pair) and the ranges that fall in it. */
export function searchMatch(line: number, text: string, ranges: readonly LineRange[]): FsSearchMatch {
    const first = ranges[0]?.start ?? 0;
    let from = text.length > PREVIEW_CHARS ? Math.max(0, first - PREVIEW_LEAD) : 0;
    let to = Math.min(text.length, from + PREVIEW_CHARS);

    if (from > 0 && isLowSurrogate(text.charCodeAt(from))) {
        from -= 1;
    }

    if (to < text.length && isHighSurrogate(text.charCodeAt(to - 1))) {
        to -= 1;
    }

    return {
        line,
        column: first + 1,
        preview: text.slice(from, to),
        ranges: ranges
            .filter(range => range.start < to)
            .map(range => ({ start: range.start - from, end: Math.min(range.end, to) - from })),
    };
}

/** Orders paths as a tree: folder by folder, names compared as the listing sorts them. */
export function byPath(a: string, b: string): number {
    const left = a.split('/');
    const right = b.split('/');

    for (let index = 0; index < left.length && index < right.length; index++) {
        if (left[index] !== right[index]) {
            return left[index]! < right[index]! ? -1 : 1;
        }
    }

    return left.length - right.length;
}

/**
 * What a search found, with its caps, whichever engine feeds it. A line counts once however many times it matches. At most
 * `MAX_FS_SEARCH_LINES_PER_FILE` lines of a file are kept and the search ends at `MAX_FS_SEARCH_MATCHES` lines; a line that does not fit
 * sets `truncated` (a file or a result that has exactly that many is not cut).
 */
export class Collector {
    /** Set when a cap cut the result, and by a search that was stopped before it was done. */
    truncated = false;
    private files = new Map<string, FsSearchMatch[]>();
    private count = 0;

    /** Takes one matching line of a file. Answers `false` when the result is full: nothing more is wanted. */
    add(path: string, line: number, text: string, ranges: readonly LineRange[]): boolean {
        if (this.count >= MAX_FS_SEARCH_MATCHES) {
            this.truncated = true;

            return false;
        }

        const matches = this.files.get(path) ?? [];

        if (matches.length >= MAX_FS_SEARCH_LINES_PER_FILE) {
            this.truncated = true;

            return true;
        }

        matches.push(searchMatch(line, text, ranges));
        this.files.set(path, matches);
        this.count += 1;

        return true;
    }

    get isEmpty(): boolean {
        return this.count === 0;
    }

    /** The files in path order, the lines of each in file order (the order they were added in). */
    result(): FsSearchResult {
        const files = [...this.files]
            .sort(([a], [b]) => byPath(a, b))
            .map(([path, matches]) => ({ path, matches: matches.sort((a, b) => a.line - b.line) }));

        return { files, truncated: this.truncated };
    }
}

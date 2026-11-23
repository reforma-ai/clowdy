import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { MAX_FS_SEARCH_LINES_PER_FILE } from '@clowdy/protocol';

import { listProjectFiles } from '../files/list';
import { byPath } from './search-collect';
import { MAX_SEARCHED_BYTES } from './search-rules';
import { walkTree } from './walk';

import type { Collector, LineRange } from './search-collect';
import type { PathFilter } from './search-rules';

const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
/** What `walkTree` may list of a folder nested in the one searched (a clone, say) that the file list names as one entry. */
const NESTED_CAP = 50_000;

const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** The text of a file's bytes, or nothing when it is not text: a NUL byte anywhere (ripgrep's own test of a binary file) skips it. A line that is not UTF-8 reads as empty, so it cannot match but still counts. */
function textOf(bytes: Uint8Array): string | undefined {
    if (bytes.includes(0)) {
        return undefined;
    }

    // Ripgrep does not show a UTF-8 byte order mark either.
    const start = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
    const body = bytes.subarray(start);

    try {
        return UTF8.decode(body);
    } catch {
        const lines: string[] = [];

        for (let from = 0; ; ) {
            const newline = body.indexOf(10, from);
            const to = newline === -1 ? body.length : newline;

            try {
                lines.push(UTF8.decode(body.subarray(from, to)));
            } catch {
                lines.push('');
            }

            if (newline === -1) {
                return lines.join('\n');
            }

            from = newline + 1;
        }
    }
}

interface Hit {
    line: number;
    text: string;
    ranges: LineRange[];
}

/** A matching line while its matches are still being gathered: where it starts and ends in the text. */
interface Pending {
    line: number;
    start: number;
    end: number;
    ranges: LineRange[];
}

const countLines = (text: string, from: number, to: number) => {
    let count = 0;

    for (let at = text.indexOf('\n', from); at !== -1 && at < to; at = text.indexOf('\n', at + 1)) {
        count += 1;
    }

    return count;
};

/**
 * The lines of `text` that `matcher` finds, with the matches in them, in file order. A line ends at `\n`; the `\r` before it is not part of
 * the line, and a last line without `\n` keeps its own (as ripgrep gives them). The matcher is global and must not match a line break.
 */
export function* matchingLines(text: string, matcher: RegExp): Generator<Hit> {
    matcher.lastIndex = 0;

    let current: Pending | undefined;
    let counted = 0;
    let line = 1;

    const hit = (found: Pending): Hit => {
        const raw = text.slice(found.start, found.end);

        return {
            line: found.line,
            ranges: found.ranges,
            text: found.end < text.length && raw.endsWith('\r') ? raw.slice(0, -1) : raw,
        };
    };

    for (let match = matcher.exec(text); match; match = matcher.exec(text)) {
        if (current && match.index < current.end) {
            current.ranges.push({
                start: match.index - current.start,
                end: match.index - current.start + match[0].length,
            });

            continue;
        }

        if (current) {
            yield hit(current);
        }

        const start = match.index === 0 ? 0 : text.lastIndexOf('\n', match.index - 1) + 1;
        const newline = text.indexOf('\n', match.index);

        line += countLines(text, counted, start);
        counted = start;
        current = {
            line,
            start,
            end: newline === -1 ? text.length : newline,
            ranges: [{ start: match.index - start, end: match.index - start + match[0].length }],
        };
    }

    if (current) {
        yield hit(current);
    }
}

/** What `readSearchable` found at a path that is a folder. */
const FOLDER = Symbol('folder');

/**
 * The text of a regular file of at most `MAX_SEARCHED_BYTES`, opened without following a link; `FOLDER` for a folder (a repository nested
 * in the searched one is one entry of git's list); nothing for any other file, or one that cannot be read or is not text.
 */
async function readSearchable(path: string): Promise<string | typeof FOLDER | undefined> {
    try {
        const handle = await open(path, constants.O_RDONLY | NO_FOLLOW);

        try {
            const info = await handle.stat();

            if (info.isDirectory()) {
                return FOLDER;
            }

            return info.isFile() && info.size <= MAX_SEARCHED_BYTES ? textOf(await handle.readFile()) : undefined;
        } finally {
            await handle.close();
        }
    } catch {
        return undefined;
    }
}

/** The files of a folder nested in the searched one that git lists as a single entry. */
async function nestedFiles(root: string, folder: string): Promise<string[]> {
    try {
        const { items } = await walkTree({
            root,
            start: folder,
            startReal: join(root, folder),
            depth: Number.POSITIVE_INFINITY,
            cap: NESTED_CAP,
        });

        return items.filter(item => item.entry.kind === 'file').map(item => item.entry.path);
    } catch {
        return [];
    }
}

/**
 * The search the daemon does itself where there is no ripgrep, with the same rules and caps. The files are those of `listProjectFiles` (git's
 * tracked and unignored ones, or a walk; a repository nested in the folder is then walked too), in path order, each read whole and searched
 * one after the other, so the event loop gets its turn at every file. Files that are links, over 1 MB, binary or not UTF-8 are skipped.
 * It stops, keeping what it has, when the collector is full or the signal fires.
 */
export async function scanSearch(
    root: string,
    matcher: RegExp,
    filter: PathFilter,
    collector: Collector,
    signal: AbortSignal
): Promise<void> {
    const queue = (await listProjectFiles(root)).filter(path => !filter.excludes(path)).sort(byPath);

    for (let index = 0; index < queue.length; index++) {
        if (signal.aborted) {
            return;
        }

        const path = queue[index]!;
        const text = await readSearchable(join(root, path));

        if (text === FOLDER) {
            // The files of a repository inside the folder come next in the queue.
            queue.splice(
                index + 1,
                0,
                ...(await nestedFiles(root, path)).filter(file => !filter.excludes(file)).sort(byPath)
            );

            continue;
        }

        if (text === undefined) {
            continue;
        }

        let found = 0;

        for (const { line, text: lineText, ranges } of matchingLines(text, matcher)) {
            if (!collector.add(path, line, lineText, ranges)) {
                return;
            }

            // One past the cap is enough to tell that a file was cut.
            if (++found > MAX_FS_SEARCH_LINES_PER_FILE) {
                break;
            }
        }
    }
}

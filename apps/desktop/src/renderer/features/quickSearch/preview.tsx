import type { ReactNode } from 'react';
import type { FoundLine } from './QuickSearchModel';

export interface Range {
    start: number;
    end: number;
}

/** Characters of a line kept before its first match, so the match shows in a narrow row. */
const LEAD = 24;

/** The preview of a line without its indentation, cut to start a little before its first match. */
export function visiblePreview({ preview, ranges }: Pick<FoundLine, 'preview' | 'ranges'>): {
    text: string;
    ranges: Range[];
} {
    const first = ranges[0]?.start ?? 0;
    const indent = preview.length - preview.trimStart().length;
    const cut = Math.max(Math.min(indent, first), first - LEAD);
    const ellipsis = cut > indent ? '…' : '';
    const shift = cut - ellipsis.length;

    return {
        text: ellipsis + preview.slice(cut),
        ranges: ranges.map(range => ({ start: range.start - shift, end: range.end - shift })),
    };
}

/** Where each word of `query` first shows in `text`, ignoring case, in order and without overlaps: what a file's name has of what was typed. */
export function wordRanges(text: string, query: string): Range[] {
    const lower = text.toLowerCase();
    const found: Range[] = [];

    for (const word of query.toLowerCase().split(/\s+/).filter(Boolean)) {
        const start = lower.indexOf(word);

        if (start >= 0) found.push({ start, end: start + word.length });
    }

    found.sort((a, b) => a.start - b.start);

    return found.reduce<Range[]>((merged, range) => {
        const last = merged.at(-1);

        if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
        else merged.push({ ...range });

        return merged;
    }, []);
}

/** `text` with its `ranges` (in order, not overlapping) in `<mark>`. */
export function Marked({ text, ranges }: { text: string; ranges: readonly Range[] }): ReactNode {
    const nodes: ReactNode[] = [];
    let at = 0;

    for (const { start, end } of ranges) {
        nodes.push(text.slice(at, start), <mark key={start}>{text.slice(start, end)}</mark>);
        at = end;
    }

    nodes.push(text.slice(at));

    return nodes;
}

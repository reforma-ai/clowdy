import type { ReactNode } from 'react';

/** `text` with its `ranges` (in order, not overlapping) in `<mark>`. */
export function Highlighted({ text, ranges }: { text: string; ranges: ReadonlyArray<{ start: number; end: number }> }) {
    const nodes: ReactNode[] = [];
    let at = 0;

    for (const { start, end } of ranges) {
        nodes.push(text.slice(at, start), <mark key={start}>{text.slice(start, end)}</mark>);
        at = end;
    }

    nodes.push(text.slice(at));

    return nodes;
}

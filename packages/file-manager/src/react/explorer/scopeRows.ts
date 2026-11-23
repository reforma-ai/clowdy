import { isPathWithin } from '../../paths';

import type { ExplorerFilter, ExplorerItem, ExplorerScopeRoot } from './explorerContext';

/**
 * The root a drop at the top level, before the row at `index` of `data` (the tree's top-level rows, the label rows among them), lands in: the one whose label is the
 * nearest above that place, the first root for a place above them all, and `fallback` when there is no label.
 */
export function rootAtIndex(data: readonly ExplorerItem[], index: number, fallback: string): string {
    for (let at = Math.min(index, data.length) - 1; at >= 0; at--) {
        const heading = data[at]?.heading;

        if (heading !== undefined) {
            return heading;
        }
    }

    return data.find(item => item.heading !== undefined)?.heading ?? fallback;
}

/** The roots (their folders) that hold a file a filter found: the labels of the others are filtered out with their rows. */
export function matchedRoots(
    filter: ExplorerFilter | null,
    roots: ReadonlyArray<ExplorerScopeRoot>
): ReadonlySet<string> {
    const matched = new Set<string>();

    if (filter) {
        for (const { root } of roots) {
            if ([...filter.paths].some(path => isPathWithin(path, root))) {
                matched.add(root);
            }
        }
    }

    return matched;
}

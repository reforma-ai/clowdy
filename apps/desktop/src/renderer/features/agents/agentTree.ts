import { ACTIVE_RUN_STATUSES, type Run, type RunId } from '@clowdy/protocol';

import type { RunNode } from '../../stores/runTree';

/** One line of the tree as drawn: a run and where it sits. */
export interface TreeRow {
    run: Run;
    depth: number;
    /** Children in the tree, after the filters. */
    childCount: number;
    isExpanded: boolean;
    /**
     * One entry per level up to this row's own. Entry `i` says whether the connector at level `i` goes on below
     * this row: for the levels above, because an ancestor has later siblings; for the last entry, because this
     * row has later siblings itself.
     */
    guides: boolean[];
}

/** A line under a run's summary, saying why it waits or stopped. */
export interface RowNote {
    text: string;
    tone: 'warning' | 'danger' | 'neutral';
}

/**
 * Keeps the nodes that match, and the ancestors of every match. A match does not bring its children along:
 * only the ones that match, or lead to a match, stay.
 */
export function filterTree(nodes: RunNode[], matches: (run: Run) => boolean): RunNode[] {
    return nodes.flatMap((node) => {
        const children = filterTree(node.children, matches);

        return matches(node.run) || children.length > 0 ? { run: node.run, children } : [];
    });
}

/** Whether the run's name, summary or one of its tasks' keys contains the text, ignoring case. */
export function runMatches(run: Run, taskKeys: string[], text: string): boolean {
    const needle = text.trim().toLowerCase();

    return [run.name, run.summary, ...taskKeys].some(value => value.toLowerCase().includes(needle));
}

/**
 * The tree as rows, top to bottom. A collapsed run hides what is below it unless `expandAll` is set (a search
 * shows every match, so it opens every fold).
 */
export function flattenTree(nodes: RunNode[], collapsed: ReadonlySet<RunId>, expandAll = false): TreeRow[] {
    const rows: TreeRow[] = [];
    const walk = (level: RunNode[], depth: number, ancestorGuides: boolean[]) => {
        level.forEach((node, index) => {
            const isExpanded = expandAll || !collapsed.has(node.run.id);
            const guides = depth === 0 ? [] : [...ancestorGuides, index < level.length - 1];

            rows.push({
                run: node.run,
                depth,
                childCount: node.children.length,
                isExpanded,
                guides,
            });

            if (isExpanded) walk(node.children, depth + 1, guides);
        });
    };

    walk(nodes, 0, []);

    return rows;
}

/** How many children of each run are still going. Counted over every run, so a filter does not change it. */
export function countActiveChildren(runs: Iterable<Run>): Map<RunId, number> {
    const counts = new Map<RunId, number>();

    for (const run of runs) {
        if (run.parentRunId !== undefined && ACTIVE_RUN_STATUSES.includes(run.status)) counts.set(run.parentRunId, (counts.get(run.parentRunId) ?? 0) + 1);
    }

    return counts;
}

/** Every run id of the forest, parents before their children, in the order the tree shows them. */
export function treeOrder(nodes: RunNode[]): RunId[] {
    return nodes.flatMap(node => [node.run.id, ...treeOrder(node.children)]);
}

/**
 * The run to show when the selected one is not in the tree any more, because it finished and finished runs are
 * hidden or it is gone: the closest visible run in tree order (the earlier one on a tie), or none.
 * `order` lists every run, `visible` those that are shown.
 */
export function settleSelection(selected: RunId | null, order: RunId[], visible: RunId[]): RunId | null {
    if (selected !== null && visible.includes(selected)) return selected;

    const index = selected === null ? -1 : order.indexOf(selected);

    if (index === -1) return visible[0] ?? null;

    const shown = new Set(visible);

    for (let distance = 1; distance < order.length; distance++) {
        const candidates = [order[index - distance], order[index + distance]];
        const found = candidates.find(candidate => candidate !== undefined && shown.has(candidate));

        if (found !== undefined) return found;
    }

    return null;
}

/** What to do about the selection once the tree is known. */
export type SelectionStep = { kind: 'keep' } | { kind: 'show-finished' } | { kind: 'select'; runId: RunId | null };

/**
 * A selection that the tree hides is dealt with by how it came to be hidden. One that has just arrived (a link
 * from another section, or one remembered from the last visit) is a request to see that run, so finished runs
 * must come back. One that was shown and then turned hidden (the switch went off, or its run finished) moves to
 * the closest visible run, see `settleSelection`.
 * `arrived` is whether the selection changed since the tree last looked.
 */
export function reconcileSelection(selected: RunId | null, arrived: boolean, order: RunId[], visible: RunId[]): SelectionStep {
    if (selected !== null && visible.includes(selected)) return { kind: 'keep' };

    if (arrived && selected !== null && order.includes(selected)) return { kind: 'show-finished' };

    const settled = settleSelection(selected, order, visible);

    return settled === selected ? { kind: 'keep' } : { kind: 'select', runId: settled };
}

/** The run's parents, nearest first. */
export function ancestorIds(runs: ReadonlyMap<RunId, Run>, runId: RunId): RunId[] {
    const ancestors: RunId[] = [];

    for (let parent = runs.get(runId)?.parentRunId; parent !== undefined && !ancestors.includes(parent); parent = runs.get(parent)?.parentRunId) {
        ancestors.push(parent);
    }

    return ancestors;
}

/** Why the run waits or stopped, for the line under its summary. Nothing for a run that is simply working or done. */
export function describeRun(run: Run, activeChildCount: number): RowNote | undefined {
    switch (run.status) {
        case 'waiting_children':
            return { text: activeChildCount > 0 ? `Waiting for sub-agents · ${ activeChildCount } active` : 'Waiting for sub-agents', tone: 'warning' };
        case 'waiting_user':
            return { text: run.statusReason ?? 'Waiting for your answer', tone: 'warning' };
        case 'blocked':
            return run.statusReason ? { text: run.statusReason, tone: 'warning' } : undefined;
        case 'queued':
        case 'cancelled':
        case 'interrupted':
            return run.statusReason ? { text: run.statusReason, tone: 'neutral' } : undefined;
        case 'failed': {
            const reason = run.error ?? run.statusReason;

            return reason ? { text: reason, tone: 'danger' } : undefined;
        }
        case 'running':
        case 'succeeded':
            return undefined;
    }
}

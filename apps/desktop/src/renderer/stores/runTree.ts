import { isTerminalRunStatus, type Run } from '@clowdy/protocol';

export interface RunNode {
    run: Run;
    children: RunNode[];
}

const byCreatedAt = (a: Run, b: Run) => a.createdAt - b.createdAt || a.id.localeCompare(b.id);

/**
 * Runs as a forest: roots (no parent, or a parent that is not in the list) newest first, children in the order
 * they were spawned. Without `showFinished`, a finished run stays only while a run below it is still active.
 * Native sub-agents are not in it: each is a card on the call that started it, in its parent's stream.
 */
export function buildRunTree(runs: Iterable<Run>, { showFinished = true }: { showFinished?: boolean } = {}): RunNode[] {
    const all = [...runs].filter(run => run.origin !== 'native');
    const ids = new Set(all.map(run => run.id));
    const childrenOf = new Map<string, Run[]>();
    const roots: Run[] = [];

    for (const run of all) {
        if (run.parentRunId && ids.has(run.parentRunId)) childrenOf.set(run.parentRunId, [...childrenOf.get(run.parentRunId) ?? [], run]);
        else roots.push(run);
    }

    const visited = new Set<string>();
    const build = (run: Run): RunNode | undefined => {
        // Runs form a tree by contract; the guard keeps a corrupt parent cycle from looping.
        if (visited.has(run.id)) return undefined;

        visited.add(run.id);

        const children = (childrenOf.get(run.id) ?? []).sort(byCreatedAt).flatMap(child => build(child) ?? []);

        return showFinished || !isTerminalRunStatus(run.status) || children.length > 0 ? { run, children } : undefined;
    };

    return roots.sort((a, b) => byCreatedAt(b, a)).flatMap(root => build(root) ?? []);
}

import { describe, expect, it } from 'vitest';

import { buildRunTree } from '../../stores/runTree';
import { ancestorIds, countActiveChildren, describeRun, filterTree, flattenTree, reconcileSelection, runMatches, settleSelection, treeOrder } from './agentTree';

import type { Run, RunStatus } from '@clowdy/protocol';

let clock = 0;

function run(id: string, status: RunStatus = 'running', rest: Partial<Run> = {}): Run {
    return { id, projectId: 'p', rootRunId: id, role: 'executor', name: `Name ${ id }`, summary: `Summary ${ id }`, status, engine: 'fake', createdAt: ++clock, ...rest };
}

/** orch, with a (running, with a1 below it), b (done) and c (waiting). */
const runs = [
    run('orch', 'running', { createdAt: 1 }),
    run('a', 'running', { parentRunId: 'orch', createdAt: 2 }),
    run('a1', 'running', { parentRunId: 'a', createdAt: 3 }),
    run('b', 'succeeded', { parentRunId: 'orch', createdAt: 4 }),
    run('c', 'waiting_user', { parentRunId: 'orch', createdAt: 5 }),
];

const ids = (nodes: ReturnType<typeof buildRunTree>) => treeOrder(nodes);

describe('flattenTree', () => {
    it('lists parents before their children with depth and child counts', () => {
        const rows = flattenTree(buildRunTree(runs), new Set());

        expect(rows.map(row => [row.run.id, row.depth, row.childCount])).toEqual([
            ['orch', 0, 3],
            ['a', 1, 1],
            ['a1', 2, 0],
            ['b', 1, 0],
            ['c', 1, 0],
        ]);
    });

    it('marks which connectors go on below each row', () => {
        const rows = flattenTree(buildRunTree(runs), new Set());
        const guides = Object.fromEntries(rows.map(row => [row.run.id, row.guides]));

        expect(guides).toEqual({
            orch: [],
            a: [true],
            // The connector of level 1 passes a1 because b and c follow a; a1 itself is the last child of a.
            a1: [true, false],
            b: [true],
            c: [false],
        });
    });

    it('hides what is below a collapsed run, and shows it all when expanding everything', () => {
        const tree = buildRunTree(runs);

        expect(flattenTree(tree, new Set(['a'])).map(row => row.run.id)).toEqual(['orch', 'a', 'b', 'c']);
        expect(flattenTree(tree, new Set(['orch'])).map(row => row.run.id)).toEqual(['orch']);
        expect(flattenTree(tree, new Set(['orch', 'a']), true).map(row => row.run.id)).toEqual(['orch', 'a', 'a1', 'b', 'c']);
    });

    it('reports a collapsed run as not expanded', () => {
        const [orch] = flattenTree(buildRunTree(runs), new Set(['orch']));

        expect(orch.isExpanded).toBe(false);
        expect(orch.childCount).toBe(3);
    });
});

describe('filterTree', () => {
    const matching = (text: string) => (candidate: Run) => runMatches(candidate, [], text);

    it('keeps the ancestors of a match but not its non-matching children', () => {
        const filtered = filterTree(buildRunTree(runs), matching('name a1'));

        expect(ids(filtered)).toEqual(['orch', 'a', 'a1']);
    });

    it('keeps only the matching children of a match', () => {
        const filtered = filterTree(buildRunTree(runs), candidate => candidate.id === 'a' || candidate.id === 'orch');

        expect(ids(filtered)).toEqual(['orch', 'a']);
    });

    it('is empty when nothing matches', () => {
        expect(filterTree(buildRunTree(runs), matching('zzz'))).toEqual([]);
    });
});

describe('runMatches', () => {
    it('matches the name, the summary and the task keys, ignoring case', () => {
        const target = run('x', 'running', { name: 'Executor 07', summary: 'Update the booking form' });

        expect(runMatches(target, [], 'executor')).toBe(true);
        expect(runMatches(target, [], 'BOOKING')).toBe(true);
        expect(runMatches(target, ['CAR-24'], 'car-24')).toBe(true);
        expect(runMatches(target, ['CAR-24'], 'car-25')).toBe(false);
    });

    it('ignores spaces around the text', () => {
        expect(runMatches(run('x', 'running', { name: 'Executor 07' }), [], '  executor ')).toBe(true);
    });
});

describe('settleSelection', () => {
    const order = ['orch', 'a', 'a1', 'b', 'c'];

    it('keeps a selection that is visible', () => {
        expect(settleSelection('a', order, ['orch', 'a', 'c'])).toBe('a');
    });

    it('moves a hidden selection to the closest visible run', () => {
        expect(settleSelection('b', order, ['orch', 'a', 'a1', 'c'])).toBe('a1');
        expect(settleSelection('a1', order, ['orch', 'c'])).toBe('orch');
    });

    it('prefers the earlier run when two are equally close', () => {
        expect(settleSelection('b', order, ['a1', 'c'])).toBe('a1');
    });

    it('falls back to the first visible run when the selection is gone, or when nothing is selected', () => {
        expect(settleSelection('gone', order, ['a', 'c'])).toBe('a');
        expect(settleSelection(null, order, ['a', 'c'])).toBe('a');
    });

    it('selects nothing when no run is visible', () => {
        expect(settleSelection('b', order, [])).toBeNull();
        expect(settleSelection(null, [], [])).toBeNull();
    });
});

describe('reconcileSelection', () => {
    const order = ['orch', 'a', 'a1', 'b', 'c'];
    const visible = ['orch', 'a', 'a1', 'c'];

    it('keeps a visible selection, whether it just arrived or not', () => {
        expect(reconcileSelection('a', true, order, visible)).toEqual({ kind: 'keep' });
        expect(reconcileSelection('a', false, order, visible)).toEqual({ kind: 'keep' });
    });

    it('brings finished runs back when a hidden run is opened from elsewhere', () => {
        expect(reconcileSelection('b', true, order, visible)).toEqual({ kind: 'show-finished' });
    });

    it('moves to the closest visible run when the shown selection turns hidden', () => {
        expect(reconcileSelection('b', false, order, visible)).toEqual({ kind: 'select', runId: 'a1' });
    });

    it('selects nothing when the selection turns hidden and nothing else is visible', () => {
        expect(reconcileSelection('b', false, order, [])).toEqual({ kind: 'select', runId: null });
    });

    it('falls back to the first visible run for a selection that is gone, even one that just arrived', () => {
        expect(reconcileSelection('gone', true, order, visible)).toEqual({ kind: 'select', runId: 'orch' });
        expect(reconcileSelection('gone', false, order, visible)).toEqual({ kind: 'select', runId: 'orch' });
    });

    it('selects the first run when none is selected, and keeps none when there are none', () => {
        expect(reconcileSelection(null, true, order, visible)).toEqual({ kind: 'select', runId: 'orch' });
        expect(reconcileSelection(null, true, [], [])).toEqual({ kind: 'keep' });
    });
});

describe('ancestorIds', () => {
    const byId = new Map(runs.map(candidate => [candidate.id, candidate]));

    it('lists the parents, nearest first', () => {
        expect(ancestorIds(byId, 'a1')).toEqual(['a', 'orch']);
        expect(ancestorIds(byId, 'orch')).toEqual([]);
        expect(ancestorIds(byId, 'unknown')).toEqual([]);
    });

    it('stops at a parent cycle', () => {
        const cyclic = new Map([run('x', 'running', { parentRunId: 'y' }), run('y', 'running', { parentRunId: 'x' })].map(candidate => [candidate.id, candidate]));

        expect(ancestorIds(cyclic, 'x')).toEqual(['y', 'x']);
    });
});

describe('countActiveChildren', () => {
    it('counts the children that are still going', () => {
        const counts = countActiveChildren(runs);

        expect(counts.get('orch')).toBe(2);
        expect(counts.get('a')).toBe(1);
        expect(counts.has('b')).toBe(false);
    });
});

describe('describeRun', () => {
    it('says a parent waits for its sub-agents, with how many are active', () => {
        const parent = run('p', 'waiting_children');

        expect(describeRun(parent, 3)).toEqual({ text: 'Waiting for sub-agents · 3 active', tone: 'warning' });
        expect(describeRun(parent, 0)).toEqual({ text: 'Waiting for sub-agents', tone: 'warning' });
    });

    it('shows the reason of waiting, blocked, queued and interrupted runs', () => {
        expect(describeRun(run('r', 'waiting_user', { statusReason: 'Asked which mail provider' }), 0)).toEqual({ text: 'Asked which mail provider', tone: 'warning' });
        expect(describeRun(run('r', 'blocked', { statusReason: 'Blocked by CAR-24' }), 0)).toEqual({ text: 'Blocked by CAR-24', tone: 'warning' });
        expect(describeRun(run('r', 'queued', { statusReason: 'Waiting for a free slot' }), 0)).toEqual({ text: 'Waiting for a free slot', tone: 'neutral' });
        expect(describeRun(run('r', 'interrupted', { statusReason: 'The daemon restarted' }), 0)).toEqual({ text: 'The daemon restarted', tone: 'neutral' });
    });

    it('still says what a run waits for when the daemon sent no reason', () => {
        expect(describeRun(run('r', 'waiting_user'), 0)?.text).toBe('Waiting for your answer');
        expect(describeRun(run('r', 'blocked'), 0)).toBeUndefined();
    });

    it('shows the error of a failed run', () => {
        expect(describeRun(run('r', 'failed', { error: 'Typecheck failed' }), 0)).toEqual({ text: 'Typecheck failed', tone: 'danger' });
    });

    it('says nothing about a run that is working or done', () => {
        expect(describeRun(run('r', 'running'), 0)).toBeUndefined();
        expect(describeRun(run('r', 'succeeded', { result: 'Done.' }), 0)).toBeUndefined();
    });
});

import { describe, expect, it } from 'vitest';

import { buildRunTree } from './runTree';

import type { Run } from '@clowdy/protocol';

function run(id: string, status: Run['status'], rest: Partial<Run> = {}): Run {
    return { id, projectId: 'p', rootRunId: id, role: 'executor', name: id, summary: '', status, engine: 'fake', createdAt: 0, ...rest };
}

const ids = (nodes: ReturnType<typeof buildRunTree>): unknown[] => nodes.map(node => (node.children.length > 0 ? [node.run.id, ids(node.children)] : node.run.id));

describe('buildRunTree', () => {
    it('nests children under their parent, newest roots first and children in spawn order', () => {
        const tree = buildRunTree([
            run('old-root', 'succeeded', { createdAt: 1 }),
            run('new-root', 'running', { createdAt: 5 }),
            run('child-b', 'running', { parentRunId: 'new-root', createdAt: 8 }),
            run('child-a', 'running', { parentRunId: 'new-root', createdAt: 6 }),
            run('grandchild', 'queued', { parentRunId: 'child-a', createdAt: 9 }),
        ]);

        expect(ids(tree)).toEqual([['new-root', [['child-a', ['grandchild']], 'child-b']], 'old-root']);
    });

    it('treats a run whose parent is unknown as a root', () => {
        expect(ids(buildRunTree([run('orphan', 'running', { parentRunId: 'missing' })]))).toEqual(['orphan']);
    });

    it('hides finished runs unless asked, but keeps a finished run that still has an active descendant', () => {
        const runs = [
            run('done-root', 'succeeded', { createdAt: 1 }),
            run('root', 'running', { createdAt: 2 }),
            run('done-child', 'failed', { parentRunId: 'root', createdAt: 3 }),
            run('live-child', 'waiting_user', { parentRunId: 'root', createdAt: 4 }),
            run('finished-parent', 'succeeded', { parentRunId: 'root', createdAt: 5 }),
            run('live-grandchild', 'running', { parentRunId: 'finished-parent', createdAt: 6 }),
        ];

        expect(ids(buildRunTree(runs, { showFinished: false }))).toEqual([['root', ['live-child', ['finished-parent', ['live-grandchild']]]]]);
        expect(ids(buildRunTree(runs, { showFinished: true }))).toHaveLength(2);
    });

    it('leaves native sub-agents out: each is a card on the call that started it', () => {
        const tree = buildRunTree([
            run('root', 'running', { createdAt: 1 }),
            run('spawned', 'running', { parentRunId: 'root', origin: 'spawned', createdAt: 2 }),
            run('native', 'running', { parentRunId: 'root', origin: 'native', parentToolCallId: 'call-1', createdAt: 3 }),
            run('native-of-spawned', 'succeeded', { parentRunId: 'spawned', origin: 'native', createdAt: 4 }),
        ]);

        expect(ids(tree)).toEqual([['root', ['spawned']]]);
    });

    it('does not loop on a parent cycle', () => {
        const tree = buildRunTree([run('a', 'running', { parentRunId: 'b' }), run('b', 'running', { parentRunId: 'a' })]);

        expect(tree).toEqual([]);
    });
});

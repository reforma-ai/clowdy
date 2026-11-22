import { describe, expect, it } from 'vitest';

import { archiveBatches, offersRestore } from './archiveBatches';

import type { Task } from '@clowdy/protocol';

const task = (number: number, archivedAt: number | undefined, parentId?: string): Task => ({
    id: `t-${ number }`,
    projectId: 'p',
    number,
    key: `X-${ number }`,
    title: `Task ${ number }`,
    description: '',
    statusId: 'done',
    dependsOn: [],
    createdBy: { kind: 'user' },
    createdAt: 0,
    updatedAt: 0,
    ...(archivedAt !== undefined && { archivedAt }),
    ...(parentId !== undefined && { parentId }),
});

describe('archiveBatches', () => {
    it('groups the tasks by the time they were archived, keeping the order the daemon gave: the newest batch first', () => {
        const batches = archiveBatches([task(9, 300), task(10, 300, 't-9'), task(3, 200), task(1, 100), task(2, 100, 't-1')]);

        expect(batches.map(batch => [batch.archivedAt, batch.tasks.map(candidate => candidate.number)])).toEqual([
            [300, [9, 10]],
            [200, [3]],
            [100, [1, 2]],
        ]);
    });

    it('leaves out a task that is not archived, and has no batches for nothing', () => {
        expect(archiveBatches([task(1, undefined)])).toEqual([]);
        expect(archiveBatches([])).toEqual([]);
    });
});

describe('offersRestore', () => {
    const onBoard = (ids: string[]) => (id: string) => ids.includes(id);

    it('offers it on every top once the whole batch is loaded', () => {
        expect(offersRestore({ parentId: 't-1' }, false, onBoard([]))).toBe(true);
        expect(offersRestore({ parentId: undefined }, false, onBoard([]))).toBe(true);
    });

    it('waits, in the batch the end of the list cuts, for a top whose parent may be in the part that is not loaded', () => {
        expect(offersRestore({ parentId: 't-1' }, true, onBoard([]))).toBe(false);
    });

    it('offers it, in a cut batch, where the task has no parent or its parent is on the board, which no later page can change', () => {
        expect(offersRestore({ parentId: undefined }, true, onBoard([]))).toBe(true);
        expect(offersRestore({ parentId: 't-1' }, true, onBoard(['t-1']))).toBe(true);
    });
});

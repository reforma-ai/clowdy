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

    it('offers it on a top that has no parent', () => {
        expect(offersRestore({ parentId: undefined }, onBoard([]))).toBe(true);
    });

    it('offers it on a top whose parent is on the board', () => {
        expect(offersRestore({ parentId: 't-1' }, onBoard(['t-1']))).toBe(true);
    });

    it('does not offer it on a top whose parent is not on the board: the parent is archived, in this batch or another, and the daemon refuses the restore', () => {
        expect(offersRestore({ parentId: 't-1' }, onBoard([]))).toBe(false);
        expect(offersRestore({ parentId: 't-1' }, onBoard(['t-2']))).toBe(false);
    });
});

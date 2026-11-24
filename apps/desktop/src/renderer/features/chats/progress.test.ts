import { describe, expect, it } from 'vitest';

import { chatProgress } from './progress';

import type { Task, TaskStatus } from '@clowdy/protocol';

const statuses: TaskStatus[] = [
    { id: 'backlog', name: 'Backlog', category: 'backlog' },
    { id: 'todo', name: 'To do', category: 'todo' },
    { id: 'active', name: 'In progress', category: 'active' },
    { id: 'review', name: 'Review', category: 'review' },
    { id: 'done', name: 'Done', category: 'done' },
    { id: 'canceled', name: 'Canceled', category: 'canceled' },
];

const task = (number: number, statusId: string): Task => ({
    id: `t-${number}`,
    projectId: 'p',
    number,
    key: `CAR-${number}`,
    title: `Task ${number}`,
    description: '',
    statusId,
    dependsOn: [],
    createdBy: { kind: 'user' },
    createdAt: 0,
    updatedAt: 0,
});

describe('chatProgress', () => {
    it('puts actionable statuses first and keeps task order within each category', () => {
        const progress = chatProgress(
            [
                task(1, 'done'),
                task(2, 'active'),
                task(3, 'review'),
                task(4, 'done'),
                task(5, 'todo'),
                task(6, 'backlog'),
                task(7, 'todo'),
            ],
            statuses
        );

        expect(progress?.summary).toBe('2 to do, 1 in progress, 1 in review, 1 in backlog, 2 done');
        expect(progress?.tasks.map(item => item.key)).toEqual([
            'CAR-5',
            'CAR-7',
            'CAR-2',
            'CAR-3',
            'CAR-6',
            'CAR-1',
            'CAR-4',
        ]);
    });

    it('leaves canceled tasks out of the count and the list', () => {
        const progress = chatProgress([task(1, 'done'), task(2, 'canceled'), task(3, 'todo')], statuses);

        expect(progress?.summary).toBe('1 to do, 1 done');
        expect(progress?.tasks.map(item => item.key)).toEqual(['CAR-3', 'CAR-1']);
    });

    it('treats a task whose status left the workflow as not done', () => {
        expect(chatProgress([task(1, 'done'), task(2, 'removed-status')], statuses)?.summary).toBe(
            '1 with unknown status, 1 done'
        );
    });

    it('has no progress without tasks, or with only canceled ones', () => {
        expect(chatProgress([], statuses)).toBeUndefined();
        expect(chatProgress([task(1, 'canceled')], statuses)).toBeUndefined();
    });
});

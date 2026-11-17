import { describe, expect, it } from 'vitest';

import { chatProgress } from './progress';

import type { Task, TaskStatus } from '@clowdy/protocol';

const statuses: TaskStatus[] = [
    { id: 'todo', name: 'To do', category: 'todo' },
    { id: 'active', name: 'In progress', category: 'active' },
    { id: 'review', name: 'Review', category: 'review' },
    { id: 'done', name: 'Done', category: 'done' },
    { id: 'canceled', name: 'Canceled', category: 'canceled' },
];

const task = (number: number, statusId: string): Task => ({
    id: `t-${ number }`,
    projectId: 'p',
    number,
    key: `CAR-${ number }`,
    title: `Task ${ number }`,
    description: '',
    statusId,
    dependsOn: [],
    createdBy: { kind: 'user' },
    createdAt: 0,
    updatedAt: 0,
});

describe('chatProgress', () => {
    it('counts the done tasks against all of them', () => {
        const progress = chatProgress([task(1, 'done'), task(2, 'active'), task(3, 'review'), task(4, 'done')], statuses);

        expect(progress).toMatchObject({ done: 2, total: 4 });
        expect(progress?.tasks.map(item => item.key)).toEqual(['CAR-1', 'CAR-2', 'CAR-3', 'CAR-4']);
    });

    it('leaves canceled tasks out of the count and out of the chips', () => {
        const progress = chatProgress([task(1, 'done'), task(2, 'canceled'), task(3, 'todo')], statuses);

        expect(progress).toMatchObject({ done: 1, total: 2 });
        expect(progress?.tasks.map(item => item.key)).toEqual(['CAR-1', 'CAR-3']);
    });

    it('treats a task whose status left the workflow as not done', () => {
        expect(chatProgress([task(1, 'done'), task(2, 'removed-status')], statuses)).toMatchObject({ done: 1, total: 2 });
    });

    it('has no progress without tasks, or with only canceled ones', () => {
        expect(chatProgress([], statuses)).toBeUndefined();
        expect(chatProgress([task(1, 'canceled')], statuses)).toBeUndefined();
    });
});

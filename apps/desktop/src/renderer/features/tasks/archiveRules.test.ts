import { describe, expect, it } from 'vitest';

import { DEFAULT_STATUSES } from '../../daemon/fixtureData';
import { archiveReply, archiveWording, cancelDialog, openWork } from './archiveRules';
import { TaskTree } from './taskTree';

import type { Task } from '@clowdy/protocol';

function task(number: number, statusId: string, parentId?: number, rest: Partial<Task> = {}): Task {
    return {
        id: `t-${ number }`,
        projectId: 'p',
        number,
        key: `X-${ number }`,
        title: `Task ${ number }`,
        description: '',
        statusId,
        dependsOn: [],
        createdBy: { kind: 'user' },
        createdAt: 0,
        updatedAt: 0,
        ...(parentId !== undefined && { parentId: `t-${ parentId }` }),
        ...rest,
    };
}

/**
 * 1 (done)           a closed tree: 2 done, 3 canceled
 * 4 (active)         open work: 5 done, 6 todo, 7 (a status the workflow lost) inside 6
 * 8 (done)           closed, with an open task inside it: 9 review
 */
const TASKS = [
    task(1, 'done'),
    task(2, 'done', 1),
    task(3, 'canceled', 1),
    task(4, 'active'),
    task(5, 'done', 4),
    task(6, 'todo', 4),
    task(7, 'gone', 6),
    task(8, 'done'),
    task(9, 'review', 8),
];

const keys = (tasks: readonly Task[]) => tasks.map(candidate => candidate.number).sort((a, b) => a - b);
const open = (taskId: string) => keys(openWork(TASKS.find(candidate => candidate.id === taskId)!, new TaskTree(TASKS, DEFAULT_STATUSES), DEFAULT_STATUSES));

describe('openWork', () => {
    it('is empty for a closed task with only closed tasks inside it, canceled ones too', () => {
        expect(open('t-1')).toEqual([]);
        expect(open('t-2')).toEqual([]);
    });

    it('is the task and every task inside it that is not closed, at any depth, and counts a task whose status the workflow lost as open', () => {
        expect(open('t-4')).toEqual([4, 6, 7]);
        expect(open('t-6')).toEqual([6, 7]);
    });

    it('counts open work inside a closed task, which the daemon would refuse without cancel', () => {
        expect(open('t-8')).toEqual([9]);
    });
});

describe('archiveWording', () => {
    it('says Archive for closed work and Cancel and archive for open work, with the count of a selection', () => {
        expect(archiveWording([task(1, 'done')], false).action).toBe('Archive');
        expect(archiveWording([task(4, 'active')], true).action).toBe('Cancel and archive');
        expect(archiveWording([task(1, 'done'), task(2, 'done')], false).action).toBe('Archive 2 tasks');
        expect(archiveWording([task(1, 'done'), task(4, 'active'), task(8, 'done')], true).action).toBe('Cancel and archive 3 tasks');
    });

    it('names the task in the offer to undo, or counts the tasks', () => {
        expect(archiveWording([task(1, 'done')], false).done).toBe('Archived X-1');
        expect(archiveWording([task(4, 'active')], true).done).toBe('Canceled and archived X-4');
        expect(archiveWording([task(1, 'done'), task(2, 'done')], false).done).toBe('Archived 2 tasks');
    });
});

describe('cancelDialog', () => {
    it('asks for one task by its key, and says how many open tasks are canceled and what goes to the archive', () => {
        const dialog = cancelDialog([task(4, 'active')], 3);

        expect(dialog.title).toBe('Cancel and archive X-4?');
        expect(dialog.confirmLabel).toBe('Cancel and archive');
        expect(dialog.message).toContain('"Task 4" and everything inside it will go to the archive');
        expect(dialog.message).toContain('3 open tasks will be canceled first.');
    });

    it('says 1 open task for one, and counts a selection', () => {
        expect(cancelDialog([task(4, 'active')], 1).message).toContain('1 open task will be canceled first.');

        const dialog = cancelDialog([task(4, 'active'), task(8, 'done')], 2);

        expect(dialog.title).toBe('Cancel and archive 2 tasks?');
        expect(dialog.message).toContain('The 2 selected tasks and everything inside them will go to the archive');
    });
});

describe('archiveReply', () => {
    it('reads the ids the daemon answers with, for an archive and for a restore', () => {
        expect(archiveReply({ task: {}, archived: ['t-1', 't-2'], canceled: ['t-2'] })).toEqual({ archived: ['t-1', 't-2'], canceled: ['t-2'], restored: [] });
        expect(archiveReply({ task: {}, restored: ['t-1'] })).toEqual({ archived: [], canceled: [], restored: ['t-1'] });
    });

    it('reads nothing from an answer that is not one, and ignores what is not an id', () => {
        expect(archiveReply(undefined)).toEqual({ archived: [], canceled: [], restored: [] });
        expect(archiveReply('no')).toEqual({ archived: [], canceled: [], restored: [] });
        expect(archiveReply({ archived: ['t-1', 5, null], canceled: 'x' })).toEqual({ archived: ['t-1'], canceled: [], restored: [] });
    });
});

import { describe, expect, test } from 'vitest';

import { ROUTES } from './api';

describe('ROUTES', () => {
    test('a task\'s comments are read from beside its detail, with the id made safe for a path', () => {
        expect(ROUTES.taskComments('tsk_1')).toBe('/v1/tasks/tsk_1/comments');
        expect(ROUTES.taskDetail('tsk_1')).toBe('/v1/tasks/tsk_1/detail');
        expect(ROUTES.taskComments('a/b?c')).toBe('/v1/tasks/a%2Fb%3Fc/comments');
    });
});

describe('ROUTES.projectArchivedTasks', () => {
    test('the archive of a project is read from beside its snapshot, with the id made safe for a path', () => {
        expect(ROUTES.projectArchivedTasks('prj_1')).toBe('/v1/projects/prj_1/archived-tasks');
        expect(ROUTES.projectSnapshot('prj_1')).toBe('/v1/projects/prj_1/snapshot');
        expect(ROUTES.projectArchivedTasks('a/b?c')).toBe('/v1/projects/a%2Fb%3Fc/archived-tasks');
    });
});

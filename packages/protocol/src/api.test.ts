import { describe, expect, test } from 'vitest';

import { ROUTES } from './api';

describe('ROUTES', () => {
    test('a task\'s comments are read from beside its detail, with the id made safe for a path', () => {
        expect(ROUTES.taskComments('tsk_1')).toBe('/v1/tasks/tsk_1/comments');
        expect(ROUTES.taskDetail('tsk_1')).toBe('/v1/tasks/tsk_1/detail');
        expect(ROUTES.taskComments('a/b?c')).toBe('/v1/tasks/a%2Fb%3Fc/comments');
    });
});

describe('ROUTES.projectTaskDetail', () => {
    test('a task is read by its key from beside its project, with both segments made safe for a path', () => {
        expect(ROUTES.projectTaskDetail('prj_1', 'CAR-12')).toBe('/v1/projects/prj_1/tasks/CAR-12/detail');
        expect(ROUTES.projectTaskDetail('a/b?c', 'x/y?z')).toBe('/v1/projects/a%2Fb%3Fc/tasks/x%2Fy%3Fz/detail');
    });
});

describe('ROUTES.projectArchivedTasks', () => {
    test('the archive of a project is read from beside its snapshot, with the id made safe for a path', () => {
        expect(ROUTES.projectArchivedTasks('prj_1')).toBe('/v1/projects/prj_1/archived-tasks');
        expect(ROUTES.projectSnapshot('prj_1')).toBe('/v1/projects/prj_1/snapshot');
        expect(ROUTES.projectArchivedTasks('a/b?c')).toBe('/v1/projects/a%2Fb%3Fc/archived-tasks');
    });
});

describe('ROUTES.projectWorktrees', () => {
    test('the worktrees of a project are read from beside its git route, with the id made safe for a path', () => {
        expect(ROUTES.projectWorktrees('prj_1')).toBe('/v1/projects/prj_1/worktrees');
        expect(ROUTES.projectWorktrees('a/b?c')).toBe('/v1/projects/a%2Fb%3Fc/worktrees');
    });
});

import { describe, expect, test } from 'vitest';

import { ROUTES } from './api';

describe('ROUTES', () => {
    test('a task\'s comments are read from beside its detail, with the id made safe for a path', () => {
        expect(ROUTES.taskComments('tsk_1')).toBe('/v1/tasks/tsk_1/comments');
        expect(ROUTES.taskDetail('tsk_1')).toBe('/v1/tasks/tsk_1/detail');
        expect(ROUTES.taskComments('a/b?c')).toBe('/v1/tasks/a%2Fb%3Fc/comments');
    });
});

import { describe, expect, test } from 'vitest';

import { ACTIVE_RUN_STATUSES, folderNames, isBusyRunStatus, isTerminalRunStatus } from './domain';

const named = (...paths: string[]) => folderNames(paths.map(path => ({ path })));

describe('folderNames', () => {
    test('names each folder after the last part of its path, on any platform', () => {
        expect(named('/work/web', '/work/api/', 'C:\\code\\docs')).toEqual(['web', 'api', 'docs']);
    });

    test('numbers a name an earlier folder already has, and never repeats one', () => {
        expect(named('/a/app', '/b/app', '/c/app')).toEqual(['app', 'app-2', 'app-3']);
        expect(named('/a/app', '/b/app', '/c/app-2')).toEqual(['app', 'app-2', 'app-2-2']);
        expect(named('/c/app-2', '/a/app', '/b/app')).toEqual(['app-2', 'app', 'app-3']);
    });
});

describe('run statuses', () => {
    test('a run that waits for background work is active, not finished, and takes a message at once', () => {
        expect(ACTIVE_RUN_STATUSES).toContain('waiting_background');
        expect(isTerminalRunStatus('waiting_background')).toBe(false);
        expect(isBusyRunStatus('waiting_background')).toBe(false);
    });

    test('only a run that works, or waits for a slot, an answer or a reset, is busy', () => {
        for (const status of ['queued', 'running', 'waiting_user', 'blocked'] as const) {
            expect(isBusyRunStatus(status)).toBe(true);
        }

        for (const status of ['waiting_children', 'waiting_background', 'succeeded', 'failed', 'cancelled', 'interrupted'] as const) {
            expect(isBusyRunStatus(status)).toBe(false);
        }
    });
});

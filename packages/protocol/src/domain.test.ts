import { describe, expect, test } from 'vitest';

import {
    ACTIVE_RUN_STATUSES,
    branchPrefixOf,
    branchPrefixProblem,
    DEFAULT_BRANCH_PREFIX,
    folderNames,
    isBusyRunStatus,
    isClosedCategory,
    isTerminalRunStatus,
    MAX_TASK_DEPTH,
    shownRunReason,
    shownRunStatus,
} from './domain';

import type { TaskStatusCategory } from './domain';

const named = (...paths: string[]) => folderNames(paths.map(path => ({ path })));

describe('folderNames', () => {
    test('names each folder after the last part of its path, on any platform', () => {
        expect(named('/work/web', '/work/api/', 'C:\\code\\docs')).toEqual(['web', 'api', 'docs']);
    });

    test('uses custom names and keeps them distinct', () => {
        expect(
            folderNames([
                { path: '/a/app', settings: { name: 'Client' } },
                { path: '/b/app' },
                { path: '/c/app', settings: { name: 'Client' } },
            ])
        ).toEqual(['Client', 'app', 'Client-2']);
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

        for (const status of ['waiting_background', 'succeeded', 'failed', 'cancelled', 'interrupted'] as const) {
            expect(isBusyRunStatus(status)).toBe(false);
        }
    });
});

describe('shownRunStatus', () => {
    test('a run that works or rests for its background work reads waiting_user while a card is open to the person', () => {
        expect(shownRunStatus({ status: 'waiting_background', awaitingUser: true })).toBe('waiting_user');
        expect(shownRunStatus({ status: 'running', awaitingUser: true })).toBe('waiting_user');
        expect(shownRunStatus({ status: 'waiting_user', awaitingUser: true })).toBe('waiting_user');
    });

    test('every status reads as its own when nothing is open, and a run that is over, queued or blocked is never called waiting', () => {
        for (const status of [
            'queued',
            'running',
            'waiting_background',
            'waiting_user',
            'blocked',
            'succeeded',
            'failed',
            'cancelled',
            'interrupted',
        ] as const) {
            expect(shownRunStatus({ status })).toBe(status);
            expect(shownRunStatus({ status, awaitingUser: false })).toBe(status);
        }

        for (const status of ['queued', 'blocked', 'succeeded', 'failed', 'cancelled', 'interrupted'] as const) {
            expect(shownRunStatus({ status, awaitingUser: true })).toBe(status);
        }
    });

    test("the reason is the run's own while its status reads as it is, and says the person is waited for where the card overrides the status", () => {
        expect(shownRunReason({ status: 'waiting_background', statusReason: 'Waiting for background work' })).toBe(
            'Waiting for background work'
        );
        expect(
            shownRunReason({ status: 'waiting_user', statusReason: 'Waiting for your approval', awaitingUser: true })
        ).toBe('Waiting for your approval');
        expect(shownRunReason({ status: 'queued', statusReason: 'Waiting for a free slot', awaitingUser: true })).toBe(
            'Waiting for a free slot'
        );
        expect(
            shownRunReason({
                status: 'waiting_background',
                statusReason: 'Waiting for background work',
                awaitingUser: true,
            })
        ).toBe('Waiting for you');
        expect(shownRunReason({ status: 'running', awaitingUser: true })).toBe('Waiting for you');
        expect(shownRunReason({ status: 'running' })).toBeUndefined();
    });
});

describe('task categories', () => {
    test('done and canceled are closed; everything else, the parked backlog included, is not', () => {
        const categories: TaskStatusCategory[] = ['backlog', 'todo', 'active', 'review', 'done', 'canceled'];

        expect(categories.filter(category => isClosedCategory(category))).toEqual(['done', 'canceled']);
    });

    test('a tree of tasks has at most 8 levels, the limit of GitHub', () => {
        expect(MAX_TASK_DEPTH).toBe(8);
    });
});

describe('the branch prefix of a new worktree', () => {
    test('is clowdy when none is given, and the text without the space around it otherwise', () => {
        expect(DEFAULT_BRANCH_PREFIX).toBe('clowdy');
        expect([branchPrefixOf(undefined), branchPrefixOf(''), branchPrefixOf('   ')]).toEqual([
            'clowdy',
            'clowdy',
            'clowdy',
        ]);
        expect(branchPrefixOf(' max ')).toBe('max');
    });

    test('takes what git takes at the start of a branch name, slashes inside included', () => {
        for (const prefix of [
            '',
            ' ',
            'clowdy',
            'max',
            ' max ',
            'max/work',
            'feature-1_x',
            'v1.2',
            'ivan/@home',
            'a.b',
            'ünïcode',
            'x'.repeat(64),
        ]) {
            expect(branchPrefixProblem(prefix)).toBeUndefined();
        }
    });

    test('refuses a space or a control character inside, and the characters git refuses in a ref name', () => {
        for (const prefix of [
            'two words',
            'tab\there',
            'new\nline',
            'nul\u0000',
            'del\u007f',
            'a~b',
            'a^b',
            'a:b',
            'a?b',
            'a*b',
            'a[b',
            'a\\b',
        ]) {
            expect(branchPrefixProblem(prefix), prefix).toBeDefined();
        }
    });

    test('refuses an invisible character, which a person cannot see to fix, and the characters Windows does not take in a file name', () => {
        for (const prefix of ['\u200b', 'a\u200bb', 'a\u202eb', 'a\ufeffb', 'a\u00adb', 'a"b', 'a<b', 'a>b', 'a|b']) {
            expect(branchPrefixProblem(prefix), prefix).toBeDefined();
        }
    });

    test('refuses two dots, @{, an empty part, a part that starts with a dot or ends with .lock, and a slash, a dot or a dash at the wrong end', () => {
        const refused = [
            'a..b',
            'a@{b',
            'a//b',
            '/a',
            'a/',
            '.a',
            'a.',
            'a/.b',
            'a.lock',
            'a.lock/b',
            '-a',
            '-',
            '/',
            '.',
            'x'.repeat(65),
        ];

        for (const prefix of refused) {
            expect(branchPrefixProblem(prefix), prefix).toBeDefined();
        }
    });

    test('says which rule it is, as a phrase with no period', () => {
        expect(branchPrefixProblem('two words')).toBe('The branch prefix cannot have a space or a control character');
        expect(branchPrefixProblem('a..b')).toBe('The branch prefix cannot have two dots in a row');
        expect(branchPrefixProblem('x'.repeat(65))).toBe('The branch prefix is longer than 64 characters');
    });
});

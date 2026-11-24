import { turnScope } from '@clowdy/protocol';
import { describe, expect, it } from 'vitest';

import {
    chevronWords,
    hiddenRows,
    isLastRunCurrent,
    lastRunScope,
    MAX_PLATE_ROWS,
    plateFilesOf,
    plateTitle,
    plateTotals,
    rowCounts,
    rowLabel,
    visibleRows,
} from './lastRunRows';

import type { GitChangedFile, GitChanges } from '@clowdy/protocol';
import type { PlateFacts } from './lastRunRows';

const lastRun = { startTree: 'a'.repeat(40), endTree: 'b'.repeat(40), seq: 10, at: 1 };
const file = (path: string, more: Partial<GitChangedFile> = {}): GitChangedFile => ({
    path,
    kind: 'modified',
    additions: 1,
    deletions: 0,
    revision: 'r',
    ...more,
});
const files = (count: number) => Array.from({ length: count }, (_, index) => file(`src/f${index}.ts`));
const changes = (
    list: GitChangedFile[],
    more: Partial<Extract<GitChanges, { isRepository: true }>> = {}
): GitChanges => ({
    isRepository: true,
    scope: 'all',
    files: list,
    fileCount: list.length,
    additions: 152,
    deletions: 22,
    statsComplete: true,
    ...more,
});

const facts = (more: Partial<PlateFacts> = {}): PlateFacts => ({
    chat: { lastRun },
    run: { status: 'succeeded' },
    items: [
        { seq: 9, body: { kind: 'user', text: 'Do it' } },
        { seq: 10, body: { kind: 'assistant', text: 'Done', done: true } },
    ],
    ...more,
});

describe('the scope of the last run', () => {
    it("is the two trees of the chat's latest turn, and none for a chat that has none", () => {
        expect(lastRunScope({ lastRun })).toBe(turnScope(lastRun.startTree, lastRun.endTree));
        expect(lastRunScope({})).toBeUndefined();
    });
});

describe('isLastRunCurrent', () => {
    it('is true for a chat at rest after a run that changed files, whichever way the run came to rest', () => {
        for (const status of ['succeeded', 'failed', 'cancelled', 'interrupted', 'waiting_background'] as const) {
            expect(isLastRunCurrent(facts({ run: { status } }))).toBe(true);
        }
    });

    it('is false for a chat whose latest turn changed no file, or that has no run yet', () => {
        expect(isLastRunCurrent(facts({ chat: {} }))).toBe(false);
        expect(isLastRunCurrent(facts({ chat: {}, run: undefined, items: [] }))).toBe(false);
    });

    it('is false while a run works, waits for a slot or for the person: the plate is about the run that ended', () => {
        for (const status of ['running', 'queued', 'blocked', 'waiting_user'] as const) {
            expect(isLastRunCurrent(facts({ run: { status } }))).toBe(false);
        }
    });

    it('is false once the person wrote after the run, and while a message of theirs waits in the queue', () => {
        const after = facts({
            items: [...facts().items!, { seq: 11, body: { kind: 'user', text: 'And another thing' } }],
        });

        expect(isLastRunCurrent(after)).toBe(false);
        expect(
            isLastRunCurrent(facts({ chat: { lastRun, queue: [{ id: 'q1', text: 'Next', createdAt: 1 }] as never } }))
        ).toBe(false);
        expect(isLastRunCurrent(facts({ chat: { lastRun, queue: [] } }))).toBe(true);
    });

    it("is not taken down by what is not a message of the person's: a report of a thread, a note, the agent's words after the run", () => {
        const after = facts({
            items: [
                ...facts().items!,
                {
                    seq: 11,
                    body: { kind: 'user', text: 'Thread finished', from: { kind: 'thread', chatId: 'c-2' } as never },
                },
                { seq: 12, body: { kind: 'note', text: 'A note' } },
                { seq: 13, body: { kind: 'assistant', text: 'Late words', done: true } },
            ],
        });

        expect(isLastRunCurrent(after)).toBe(true);
    });

    it('is not taken down by the message that started the run, nor by any message before the run ended', () => {
        expect(
            isLastRunCurrent(
                facts({
                    items: [
                        { seq: 1, body: { kind: 'user', text: 'first' } },
                        { seq: 10, body: { kind: 'user', text: 'a steer in the run' } },
                    ],
                })
            )
        ).toBe(true);
    });

    it('is false while the stream is not loaded: nothing can be said of what the person wrote', () => {
        expect(isLastRunCurrent(facts({ items: undefined }))).toBe(false);
    });
});

describe('plateFilesOf', () => {
    it('keeps a list of a repository that has files, and nothing for a run that changed none, a folder that is no repository and a read that failed', () => {
        expect(plateFilesOf(changes(files(2)))?.fileCount).toBe(2);
        expect(plateFilesOf(changes([]))).toBeUndefined();
        expect(plateFilesOf({ isRepository: false })).toBeUndefined();
        expect(plateFilesOf(undefined)).toBeUndefined();
    });
});

describe('the rows', () => {
    it('are the first five files, and all of them once the chevron unfolds them', () => {
        expect(MAX_PLATE_ROWS).toBe(5);
        expect(visibleRows(files(7), false).map(entry => entry.path)).toEqual([
            'src/f0.ts',
            'src/f1.ts',
            'src/f2.ts',
            'src/f3.ts',
            'src/f4.ts',
        ]);
        expect(visibleRows(files(7), true)).toHaveLength(7);
        expect(visibleRows(files(3), false)).toHaveLength(3);
        expect(hiddenRows(files(7))).toBe(2);
        expect(hiddenRows(files(5))).toBe(0);
        expect(hiddenRows(files(0))).toBe(0);
    });

    it('say how many are behind the chevron, and how to fold them again', () => {
        expect(chevronWords({ files: files(7) }, false)).toBe('2 more files');
        expect(chevronWords({ files: files(6) }, false)).toBe('1 more file');
        expect(chevronWords({ files: files(7) }, true)).toBe('Show fewer');
    });

    it("write a file's lines with the signs the Changes tab uses, and none for a binary file", () => {
        expect(rowCounts({ additions: 101, deletions: 15 })).toEqual({ additions: '+101', deletions: '−15' });
        expect(rowCounts({ additions: 0, deletions: 8 })).toEqual({ additions: '+0', deletions: '−8' });
        expect(rowCounts({})).toBeUndefined();
    });

    it('are named for a screen reader by what happened, the path and the lines', () => {
        expect(rowLabel(file('apps/daemon/src/domain/workspaces.ts', { additions: 101, deletions: 15 }))).toBe(
            'Modified, apps/daemon/src/domain/workspaces.ts, 101 added, 15 removed'
        );
        expect(rowLabel(file('src/new.ts', { kind: 'added', additions: 3, deletions: 0 }))).toBe(
            'Added, src/new.ts, 3 added, 0 removed'
        );
        expect(rowLabel(file('src/gone.ts', { kind: 'deleted', additions: 0, deletions: 8 }))).toBe(
            'Deleted, src/gone.ts, 0 added, 8 removed'
        );
        expect(rowLabel({ path: 'logo.png', kind: 'added', binary: true, revision: 'r' })).toBe(
            'Added, logo.png, binary'
        );
        expect(rowLabel({ path: 'big.json', kind: 'modified', revision: 'r' })).toBe('Modified, big.json');
    });
});

describe('the header', () => {
    it('says Last run, how many files, and the totals as the Changes tab writes them, none of it ending in a period', () => {
        const list = changes(files(7));

        expect(plateTitle(list as Extract<GitChanges, { isRepository: true }>)).toBe('Last run · 7 files');
        expect(plateTitle({ fileCount: 1 })).toBe('Last run · 1 file');
        expect(plateTotals(list as Extract<GitChanges, { isRepository: true }>)).toEqual({
            additions: '+152',
            deletions: '−22',
        });
    });
});

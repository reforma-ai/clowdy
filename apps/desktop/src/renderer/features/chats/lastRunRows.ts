import { isBusyRunStatus, turnScope } from '@clowdy/protocol';

import { CHANGE_KIND_VIEW, filesWords } from '../changes/gitSummary';

import type { Chat, GitChangedFile, GitChanges, GitScope, Run, StreamItem } from '@clowdy/protocol';

/** The files the plate lists before its chevron unfolds the rest. */
export const MAX_PLATE_ROWS = 5;

/** A list of a place that is a repository. */
type RepositoryChanges = Extract<GitChanges, { isRepository: true }>;

/** The scope of what the chat's latest turn changed, and nothing for a chat that has none. */
export const lastRunScope = (chat: Pick<Chat, 'lastRun'>): GitScope | undefined => (chat.lastRun ? turnScope(chat.lastRun.startTree, chat.lastRun.endTree) : undefined);

/** What the plate asks to be sure of that the chat says: the run and the stream that tell whether the person has gone on since. */
export interface PlateFacts {
    chat: Pick<Chat, 'lastRun' | 'queue'>;
    /** The chat's orchestrator, when it has one. */
    run: Pick<Run, 'status'> | undefined;
    /** The orchestrator's stream, once it is loaded: what the person wrote after the turn is told from it. `undefined` while it is not. */
    items: readonly Pick<StreamItem, 'seq' | 'body'>[] | undefined;
}

/**
 * Whether the chat is at rest after a run that changed files and the person has not gone on: the daemon kept the trees of the latest turn (`Chat.lastRun`), no run works (a run
 * that waits for its background work is at rest, as the composer takes a message at once), no message waits in the queue, and the stream has no message of the person's after
 * the turn ended (a message of theirs has a `seq` above the turn's, a thread's report or a note does not count). The stream has to be there to say so. What the files are is a
 * question for the list (`plateFilesOf`).
 */
export function isLastRunCurrent({ chat, run, items }: PlateFacts): boolean {
    const { lastRun } = chat;

    if (!lastRun || items === undefined || (run !== undefined && isBusyRunStatus(run.status))) return false;

    if ((chat.queue?.length ?? 0) > 0) return false;

    return !items.some(item => item.seq > lastRun.seq && item.body.kind === 'user' && item.body.from === undefined);
}

/** The files of a list that the plate may draw: a list of a repository that has some. */
export function plateFilesOf(changes: GitChanges | undefined): RepositoryChanges | undefined {
    return changes?.isRepository === true && changes.fileCount > 0 && changes.files.length > 0 ? changes : undefined;
}

/** The rows the plate draws: the first few files, or all of them once it is unfolded. */
export const visibleRows = (files: readonly GitChangedFile[], unfolded: boolean): readonly GitChangedFile[] => (unfolded ? files : files.slice(0, MAX_PLATE_ROWS));

/** How many files the chevron has behind it. */
export const hiddenRows = (files: readonly GitChangedFile[]): number => Math.max(0, files.length - MAX_PLATE_ROWS);

/** The header's words: `Last run · 7 files`, the counts of lines after it are drawn in their own colours (`plateTotals`). */
export const plateTitle = (changes: Pick<RepositoryChanges, 'fileCount'>): string => `Last run · ${ filesWords(changes.fileCount) }`;

/** The totals of the header as the Changes tab writes them: `+152` and `−22` with a real minus sign. */
export const plateTotals = (changes: Pick<RepositoryChanges, 'additions' | 'deletions'>): { additions: string; deletions: string } => ({ additions: `+${ changes.additions }`, deletions: `−${ changes.deletions }` });

/** What the chevron says: how many files are behind it, or that they can be folded away again. */
export const chevronWords = (changes: Pick<RepositoryChanges, 'files'>, unfolded: boolean): string => (unfolded ? 'Show fewer' : `${ hiddenRows(changes.files) } more ${ hiddenRows(changes.files) === 1 ? 'file' : 'files' }`);

/** The lines of a file as the row writes them (`+101`, `−15`), none for a binary file and for one whose lines were not counted. */
export function rowCounts(file: Pick<GitChangedFile, 'additions' | 'deletions'>): { additions: string; deletions: string } | undefined {
    return file.additions !== undefined && file.deletions !== undefined ? { additions: `+${ file.additions }`, deletions: `−${ file.deletions }` } : undefined;
}

/** What a screen reader hears of a row: how the file changed, its path and its lines. `Modified, apps/daemon/src/db.ts, 101 added, 15 removed`. */
export function rowLabel(file: GitChangedFile): string {
    const parts = [CHANGE_KIND_VIEW[file.kind].label, file.path];

    if (file.additions !== undefined && file.deletions !== undefined) parts.push(`${ file.additions } added`, `${ file.deletions } removed`);
    else if (file.binary) parts.push('binary');

    return parts.join(', ');
}

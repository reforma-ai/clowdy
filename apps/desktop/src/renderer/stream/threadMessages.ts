import type { ThreadNotice, ThreadOutcome } from '@clowdy/protocol';

/** How a notice's title ends after the thread's name: `Fix login finished`, `… failed`, `… was interrupted`. */
export const OUTCOME_WORDS: Record<ThreadOutcome, string> = {
    finished: 'finished',
    failed: 'failed',
    interrupted: 'was interrupted',
};

/** One line for a thread that stopped: `Fix login finished`. */
export function noticeLine(notice: Pick<ThreadNotice, 'title' | 'outcome'>): string {
    return `${notice.title} ${OUTCOME_WORDS[notice.outcome]}`;
}

import type { ThreadNotice, ThreadOutcome } from '@clowdy/protocol';

/** How a notice's title ends after the thread's name: `Fix login finished`, `… failed`, `… was interrupted`. */
export const OUTCOME_WORDS: Record<ThreadOutcome, string> = {
    finished: 'finished',
    failed: 'failed',
    interrupted: 'was interrupted',
};

/** What the threads of one notice ended as, said once: a failure shows over an interruption, and an interruption over a finish, so a mark for several threads never hides that one did not go well. */
export function worstOutcome(notices: readonly Pick<ThreadNotice, 'outcome'>[]): ThreadOutcome {
    if (notices.some(notice => notice.outcome === 'failed')) return 'failed';

    return notices.some(notice => notice.outcome === 'interrupted') ? 'interrupted' : 'finished';
}

/** One line for a thread that stopped: `Fix login finished`. */
export function noticeLine(notice: Pick<ThreadNotice, 'title' | 'outcome'>): string {
    return `${notice.title} ${OUTCOME_WORDS[notice.outcome]}`;
}

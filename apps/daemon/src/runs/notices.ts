import { getChat } from '../db/chats';
import { getRun } from '../db/runs';
import { queueOf } from '../domain/queue';
import { errorMessage } from '../errors';
import { sendMessage } from './messages';
import { clipOutput } from './threads';

import type { Run, ThreadNotice, ThreadOutcome } from '@clowdy/protocol';
import type { Config } from '../config';
import type { MessageDeps } from './messages';

/** The line every notice ends with: a parent that answers each one, or pings its threads back, burns turns on nothing. */
const NOTICE_RULE =
    'Do not reply to this message just to acknowledge it, and do not message a thread unless you need something from it.';

/** How the queue's one line ends after a thread's name. */
const OUTCOME_WORDS: Record<ThreadOutcome, string> = {
    finished: 'finished',
    failed: 'failed',
    interrupted: 'was interrupted',
};

/** What a queued notice shows: `Thread "Fix login" finished`, or how many threads stopped. */
export function noticeSummary(threads: readonly ThreadNotice[]): string {
    return threads.length === 1
        ? `Thread "${threads[0].title}" ${OUTCOME_WORDS[threads[0].outcome]}`
        : `${threads.length} threads stopped`;
}

/** One thread's block of a notice, as its parent's agent reads it. */
function noticeBlock(notice: ThreadNotice): string {
    const name = `Thread "${notice.title}" (${notice.chatId})`;

    switch (notice.outcome) {
        case 'failed':
            return [
                `[${name} failed]`,
                notice.text,
                `Look at it with clowdy thread log ${notice.chatId} before deciding what to do.`,
            ]
                .filter(Boolean)
                .join('\n\n');
        case 'interrupted':
            return `[${name} was interrupted because the daemon restarted]`;
        case 'finished':
            if (notice.background?.length) {
                return [
                    `[${name} finished its turn and still has work running in the background: ${notice.background.join(', ')}]`,
                    notice.text,
                    'This is not its final result; it will report again when that work finishes.',
                ]
                    .filter(Boolean)
                    .join('\n\n');
            }

            return [`[${name} finished]`, notice.text].filter(Boolean).join('\n\n');
    }
}

/** What the parent's agent is told of threads that stopped: one block per thread, under a heading when there are several, and the rule. */
export function noticeContent(threads: readonly ThreadNotice[]): string {
    const blocks = threads.map(noticeBlock);

    return [...(blocks.length > 1 ? ['Threads that stopped:'] : []), ...blocks, NOTICE_RULE].join('\n\n');
}

/** `earlier` with each notice of `later` in place of the one of the same thread, the threads it did not have added at the end: the latest wins. */
export function mergeNotices(earlier: readonly ThreadNotice[], later: readonly ThreadNotice[]): ThreadNotice[] {
    const merged = earlier.map(notice => later.find(entry => entry.chatId === notice.chatId) ?? notice);

    return [...merged, ...later.filter(entry => !earlier.some(notice => notice.chatId === entry.chatId))];
}

export interface NoticeDeps extends MessageDeps {
    config: Config;
}

/** The notices one parent has not been told yet, and the end of their window. */
interface Pending {
    notices: Map<string, ThreadNotice>;
    timer: ReturnType<typeof setTimeout>;
}

/**
 * Tells a parent chat that threads below it stopped. Every turn end of a thread's orchestrator that has something to tell (`RunDriver.onTurnEnd`: it said
 * something, left background work open, or ended the work an earlier notice said was open) is a notice, and so is a thread that failed or was interrupted
 * by a restart (the status hook); a Stop, a turn ended to send a message and a compact turn say nothing. Notices wait in memory for `noticeWindowMs` after the first one of a parent, the same thread's latest
 * replacing its earlier one, and then go out as one message: a parent at rest with nothing waiting in its queue starts a turn on it, any other gets it
 * in its queue (`ChatQueue.enqueueNotice`), merged with the notice already waiting there. A daemon stop inside the window loses what waits.
 */
export class ThreadNotices {
    private pending = new Map<string, Pending>();
    private stopped = false;

    /** Built after the chat's queue, whose status hook it extends, and before the recovery, whose interrupted threads it announces. */
    constructor(private deps: NoticeDeps) {
        const queueStatus = deps.runs.onOrchestratorStatus;

        deps.runs.onOrchestratorStatus = run => {
            queueStatus(run);
            this.statusChanged(run);
        };
        deps.driver.onTurnEnd = (run, text) => this.turnEnded(run, text);
    }

    /**
     * The parent read the thread's answer itself (`thread_wait`, `thread_output`): the thread's notice it has not been told yet is dropped, from the window
     * and from its queue.
     */
    consume(parentChatId: string, threadId: string): void {
        this.pending.get(parentChatId)?.notices.delete(threadId);
        this.deps.queue.dropNotice(parentChatId, threadId);
    }

    /** The daemon stops: what waits in a window is lost, and nothing new is taken. */
    stop(): void {
        this.stopped = true;

        for (const { timer } of this.pending.values()) {
            clearTimeout(timer);
        }

        this.pending.clear();
    }

    /* --------------------------------- Sources -------------------------------- */

    /** A turn of a chat's orchestrator ended with something to tell (the driver says when it has); only a thread's tells its parent. */
    private turnEnded(run: Run, text: string | undefined): void {
        const thread = run.chatId ? getChat(this.deps.store.db, run.chatId) : undefined;
        const background = run.status === 'waiting_background' ? (run.background ?? []).map(item => item.title) : [];

        if (!thread?.parentChatId) {
            return;
        }

        this.add(thread.parentChatId, {
            chatId: thread.id,
            title: thread.title,
            outcome: 'finished',
            ...(text && { text: clipOutput(text) }),
            ...(background.length > 0 && { background }),
        });
    }

    /**
     * A thread's orchestrator failed, or a restart interrupted it: the parent always hears of it. The hook runs at each change of status, so a run is
     * told once when it arrives there; a run that was interrupted at an earlier start is not touched by the next one, and not told again.
     */
    private statusChanged(run: Run): void {
        if (run.status !== 'failed' && run.status !== 'interrupted') {
            return;
        }

        const thread = run.chatId ? getChat(this.deps.store.db, run.chatId) : undefined;

        if (!thread?.parentChatId) {
            return;
        }

        this.add(thread.parentChatId, {
            chatId: thread.id,
            title: thread.title,
            outcome: run.status,
            ...(run.status === 'failed' && { text: clipOutput(run.error ?? 'It failed without saying why') }),
        });
    }

    /* -------------------------------- Delivery -------------------------------- */

    /** Keeps the notice until the parent's window ends, which the first notice of a parent opens; the same thread's latest replaces its earlier one. */
    private add(parentChatId: string, notice: ThreadNotice): void {
        if (this.stopped) {
            return;
        }

        const pending = this.pending.get(parentChatId);

        if (pending) {
            pending.notices.set(notice.chatId, notice);

            return;
        }

        this.pending.set(parentChatId, {
            notices: new Map([[notice.chatId, notice]]),
            timer: setTimeout(() => this.flush(parentChatId), this.deps.config.timings.noticeWindowMs),
        });
    }

    /**
     * The window is over: its notices go to the parent as one message. A chat that is gone, archived (a message would bring it back) or never had an
     * orchestrator gets nothing. An orchestrator at rest and sound (its turn succeeded, or it waits for background work) whose queue is empty and not held
     * starts a turn on the message, in its live session when it has one. Any other gets it in its queue, as the next turn once it rests, or held with the
     * queue by a Stop or a failure; no notice ever steers a running turn.
     */
    private flush(parentChatId: string): void {
        const { store, queue } = this.deps;
        const threads = [...(this.pending.get(parentChatId)?.notices.values() ?? [])];

        this.pending.delete(parentChatId);

        if (threads.length === 0) {
            return;
        }

        try {
            store.tx(() => {
                const chat = getChat(store.db, parentChatId);
                const run = chat?.orchestratorRunId ? getRun(store.db, chat.orchestratorRunId) : undefined;

                if (!chat || !run || chat.archivedAt !== undefined) {
                    return;
                }

                const atRest = run.status === 'succeeded' || run.status === 'waiting_background';

                if (atRest && chat.queuePaused === undefined && queueOf(chat).length === 0) {
                    // A notice has no words of its own: the stream draws it from `from`, and the agent reads `content`.
                    sendMessage(this.deps, chat.id, {
                        text: '',
                        content: noticeContent(threads),
                        mode: 'queue',
                        from: { kind: 'threadNotice', threads },
                    });
                } else {
                    queue.enqueueNotice(chat, run, threads);
                }
            });
        } catch (error) {
            console.error(
                `[clowdy] telling chat ${parentChatId} that its threads stopped failed: ${errorMessage(error)}`
            );
        }
    }
}

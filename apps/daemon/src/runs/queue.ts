import { isBusyRunStatus, isTerminalRunStatus } from '@clowdy/protocol';

import { toAttachment } from '../attachments/service';
import { chatIdsWithQueue, getChat } from '../db/chats';
import { getRun } from '../db/runs';
import { requireChat, saveChat } from '../domain/chats';
import { appendItem } from '../domain/items';
import { placeQueued, queueOf, settleSteers, userItemOf, withQueue } from '../domain/queue';
import { conflict, errorMessage, notFound } from '../errors';
import { newId } from '../ids';
import { mergeNotices, noticeContent, noticeSummary } from './notices';
import { STOPPED_TURN_MESSAGE } from './prompts';
import { STOPPED_TO_SEND_REASON } from './transitions';

import type {
    Chat,
    MessageSource,
    QueuedMessage,
    QueuedMessageMode,
    QueuePause,
    Run,
    ThreadNotice,
} from '@clowdy/protocol';
import type { AttachmentsService } from '../attachments/service';
import type { AttachmentRecord } from '../db/attachments';
import type { Store } from '../store';
import type { RunDriver } from './driver';
import type { RunService } from './service';

export interface QueueDeps {
    store: Store;
    runs: RunService;
    driver: RunDriver;
    attachments: AttachmentsService;
}

/** A message for a busy orchestrator, as `sendMessage` read it. */
export interface QueueInput {
    mode: QueuedMessageMode;
    text: string;
    /** The files, claimed already; the queue keeps them for the message. */
    files: readonly AttachmentRecord[];
    /** What the agent is told. */
    content: string;
    /** Who wrote it when the person did not (another thread); the stream's `user` item carries it once the agent gets the message. */
    from?: MessageSource;
}

/**
 * Whether a chat's orchestrator takes a message at once: its work is over, or it only waits for background work its session keeps open (`isBusyRunStatus`).
 * A message to one whose session is open goes into that session (`RunDriver.launch`), not into a new one.
 */
export function isAtRest(run: Run): boolean {
    return !isBusyRunStatus(run.status);
}

/** What the queue shows for a compact item. */
const COMPACT_TEXT = 'Compact the conversation';

const isCompact = (item: QueuedMessage) => item.command === 'compact';

/** The threads a queued notice reports; none for any other message. */
const noticesOf = (item: QueuedMessage): ThreadNotice[] =>
    item.from?.kind === 'threadNotice' ? item.from.threads : [];

/** A queued notice of `threads`: its one line, what the agent reads, and the entries the stream's card is drawn from. */
const noticeFields = (threads: ThreadNotice[]) => ({
    text: noticeSummary(threads),
    content: noticeContent(threads),
    from: { kind: 'threadNotice' as const, threads },
});

/**
 * How the queue of an orchestrator that is over already waits for a notice that arrives now: held as a Stop or a failure would have held it, since
 * the person decides what comes after those. A run that only rests until the message that stopped it goes (`STOPPED_TO_SEND_REASON`) is not held.
 */
function holdFor(run: Run): QueuePause | undefined {
    if (run.status === 'failed' || run.status === 'interrupted') {
        return 'failed';
    }

    return run.status === 'cancelled' && run.statusReason !== STOPPED_TO_SEND_REASON ? 'stopped' : undefined;
}

/**
 * What the person writes while a chat's orchestrator works waits on the chat (`Chat.queue`), and its bubble reaches the stream only when the agent gets
 * the message. When the orchestrator comes to rest the head of the queue becomes its next turn, one message per turn, steers first, exactly like a message
 * sent to a chat at rest; Stop and a failed turn hold the queue until the person sends a message from it. A steer goes to the running turn as soon as the
 * agent can take one (`RunDriver.steer`): its bubble is written at that moment, between what the agent said before and after.
 */
export class ChatQueue {
    /** Queued messages whose steer is with the agent: nothing else may hand them over, or drop them, until it answers. */
    private steering = new Set<string>();
    /** The steering of each chat, one pass after another, so steers reach the agent in their order and none goes twice. */
    private passes = new Map<string, Promise<void>>();

    constructor(private deps: QueueDeps) {
        deps.runs.onOrchestratorStatus = run => this.onStatus(run);
        deps.driver.onTurnStarted = runId => {
            const chatId = getRun(deps.store.db, runId)?.chatId;

            if (chatId) {
                this.steerAll(chatId);
            }
        };
    }

    /* -------------------------------- Commands -------------------------------- */

    /** Puts a message for the busy orchestrator `run` in the chat's queue, its files kept for it. Call it in the transaction of the command. */
    enqueue(chat: Chat, run: Run, input: QueueInput): QueuedMessage {
        const { store, attachments } = this.deps;
        const item: QueuedMessage = {
            id: newId('que'),
            mode: input.mode,
            text: input.text,
            ...(input.files.length > 0 && { attachments: input.files.map(toAttachment) }),
            content: input.content,
            ...(input.from && { from: input.from }),
            createdAt: Date.now(),
        };

        // The files belong to the chat from now on, so the message box can let go of them and the sweep of unsent files leaves them alone.
        attachments.markSent(input.files, chat.id, run.id);
        saveChat(store, withQueue(chat, placeQueued(queueOf(chat), item), chat.queuePaused));

        if (item.mode === 'steer') {
            store.afterCommit(() => this.steerAll(chat.id));
        }

        return item;
    }

    /**
     * Puts a notice of threads that stopped (`ThreadNotices`) in the queue of an orchestrator that cannot take it now. It joins the notice that waits
     * there already, the same thread's entry replaced and the others kept in their order, or becomes one at the end of the next turns: one message for
     * all of them. It goes as the next turn when the orchestrator rests, like any queued message; one that is over already (a Stop, a failure, a
     * restart) holds it for the person. Call it in a transaction.
     */
    enqueueNotice(chat: Chat, run: Run, threads: readonly ThreadNotice[]): void {
        const { store } = this.deps;
        const queue = queueOf(chat);
        // A notice the agent is taking as a steer (the person sent it now) is the agent's already.
        const waiting = queue.find(item => item.from?.kind === 'threadNotice' && !this.steering.has(item.id));
        const merged = mergeNotices(waiting ? noticesOf(waiting) : [], threads);
        const next = waiting
            ? queue.map(item => (item.id === waiting.id ? { ...item, ...noticeFields(merged) } : item))
            : placeQueued(queue, { id: newId('que'), mode: 'queue', ...noticeFields(merged), createdAt: Date.now() });
        const paused = chat.queuePaused ?? holdFor(run);

        saveChat(store, withQueue({ ...chat, updatedAt: Date.now() }, next, paused));

        // An orchestrator at rest whose queue flows (a compact item waits for its background work to end, say) takes it with its next settle, which is now.
        if (!paused && isAtRest(run)) {
            store.afterCommit(() => this.settle(run));
        }
    }

    /** Takes one thread's entry out of the notice that waits in the queue, and the notice with it when it was the last; the parent read that thread itself. */
    dropNotice(chatId: string, threadId: string): void {
        const { store } = this.deps;

        store.tx(() => {
            const chat = getChat(store.db, chatId);
            const queue = chat ? queueOf(chat) : [];
            const item = queue.find(
                entry => !this.steering.has(entry.id) && noticesOf(entry).some(notice => notice.chatId === threadId)
            );

            if (!chat || !item) {
                return;
            }

            const rest = noticesOf(item).filter(notice => notice.chatId !== threadId);
            const next =
                rest.length === 0
                    ? queue.filter(entry => entry.id !== item.id)
                    : queue.map(entry => (entry.id === item.id ? { ...entry, ...noticeFields(rest) } : entry));

            saveChat(store, withQueue(chat, next, chat.queuePaused));
        });
    }

    /**
     * `chat.compact`: the agent's own compact command (`command`) as a turn of the orchestrator, with no `user` item (the person wrote nothing). A finished
     * orchestrator gets it at once, and a compact item that waited in its queue goes with it. One that works or waits for background work gets it later, as
     * a compact item at the end of the queue (`QueuedMessage.command`), which runs once it has finished; asked again while one waits, or while the agent is
     * compacting already, it changes nothing. Call it in the transaction of the command.
     */
    compact(chat: Chat, run: Run, command: string): void {
        const { store, runs, driver } = this.deps;
        const queue = queueOf(chat);

        if (!isTerminalRunStatus(run.status)) {
            if (!queue.some(isCompact) && !driver.isCompacting(run.id)) {
                const item: QueuedMessage = {
                    id: newId('que'),
                    mode: 'queue',
                    command: 'compact',
                    text: COMPACT_TEXT,
                    content: command,
                    createdAt: Date.now(),
                };

                saveChat(store, withQueue(chat, placeQueued(queue, item), chat.queuePaused));
            }

            return;
        }

        if (queue.some(isCompact)) {
            saveChat(
                store,
                withQueue(
                    chat,
                    queue.filter(item => !isCompact(item)),
                    chat.queuePaused
                )
            );
        }

        runs.resume(run.id, command);
        driver.launch(run.id);
    }

    /** Takes a message out of the queue. Its files go with it, or back to the project unsent with `keepFiles`, for a message box that takes them again. */
    remove(chatId: string, itemId: string, keepFiles = false): Chat {
        const { store, attachments } = this.deps;

        return store.tx(() => {
            const chat = requireChat(store, chatId);
            const item = this.requireItem(chat, itemId);
            const ids = (item.attachments ?? []).map(file => file.id);

            // The agent may be reading it already; its answer decides whether it stays.
            if (this.steering.has(itemId)) {
                throw conflict('The agent is taking this message now');
            }

            if (keepFiles) {
                attachments.release(ids);
            } else {
                attachments.discard(ids);
            }

            return saveChat(
                store,
                withQueue(
                    chat,
                    queueOf(chat).filter(entry => entry.id !== itemId),
                    chat.queuePaused
                )
            );
        });
    }

    /** Moves a message to `index` among the messages of its own kind. */
    move(chatId: string, itemId: string, index: number): Chat {
        const { store } = this.deps;

        return store.tx(() => {
            const chat = requireChat(store, chatId);
            const item = this.requireItem(chat, itemId);

            return saveChat(store, withQueue(chat, placeQueued(queueOf(chat), item, index), chat.queuePaused));
        });
    }

    /**
     * Send now. A busy orchestrator gets the message as a steer: it moves to the end of the steers and goes to the running turn when the agent can take it.
     * When the orchestrator is running and its agent cannot take a steer at all (`RunDriver.cannotSteer`), the message would wait for the turn's end however
     * long that is, so Send now is stop and send, which the button says: the message moves to the head of the steers, the turn is ended on purpose
     * (`RunDriver.interrupt`), and the orchestrator's coming to rest gives the message to its next turn. Only the orchestrator's turn ends, and the queue is
     * not paused. One at rest gets the message at once as its next turn, and a paused queue flows again. A compact item steers nothing:
     * while the orchestrator is busy it keeps its place, and at rest it runs once the orchestrator has finished, and is refused while it waits for background work.
     */
    sendNow(chatId: string, itemId: string): { chatId: string; runId: string } {
        const { store, runs, driver } = this.deps;

        return store.tx(() => {
            const chat = requireChat(store, chatId);
            const item = this.requireItem(chat, itemId);
            const run = runs.require(chat.orchestratorRunId as string);

            if (!isAtRest(run)) {
                if (isCompact(item)) {
                    return { chatId, runId: run.id };
                }

                const stops = run.status === 'running' && driver.cannotSteer(run.id);

                // Sending a message from a held queue is what lets it flow again, as at rest. Stop and send puts it ahead of the steers that waited for the turn's end.
                if (item.mode !== 'steer' || chat.queuePaused || stops) {
                    saveChat(
                        store,
                        withQueue(
                            chat,
                            placeQueued(queueOf(chat), { ...item, mode: 'steer' }, stops ? 0 : undefined),
                            undefined
                        )
                    );
                }

                // A turn that cannot be ended (it ended on its own meanwhile) leaves the message to the steering pass, which settles the queue as the run rests.
                store.afterCommit(() => {
                    if (!stops || !driver.interrupt(run.id)) {
                        this.steerAll(chat.id);
                    }
                });

                return { chatId, runId: run.id };
            }

            if (this.steering.has(item.id)) {
                throw conflict('The agent is taking this message now');
            }

            // Like `chat.compact`, it is not activity: the chat keeps its place.
            if (isCompact(item)) {
                // At rest but not finished: the session waits for background work, and the command must be a turn of its own.
                if (!this.canCompact(run)) {
                    throw conflict(
                        'The orchestrator is waiting for background work. Compact the chat when it has finished'
                    );
                }

                this.dispatch(chat, run, item);

                return { chatId, runId: run.id };
            }

            // Writing to a chat brings it back from the archive, as `chat.send` does.
            const { archivedAt: _, ...rest } = chat;

            this.dispatch({ ...rest, updatedAt: Date.now() }, run, item);

            return { chatId, runId: run.id };
        });
    }

    /** Holds the queue until the person sends a message from it. An empty queue has nothing to hold. Call it in the transaction that stopped the work. */
    pause(chatId: string, reason: QueuePause): void {
        const { store } = this.deps;

        store.tx(() => {
            const chat = getChat(store.db, chatId);

            if (chat && queueOf(chat).length > 0 && chat.queuePaused === undefined) {
                saveChat(store, { ...chat, queuePaused: reason });
            }
        });
    }

    /** After a restart: an orchestrator that came to rest just before the daemon stopped still owes its queue the next turn. */
    resumePending(): void {
        for (const chatId of chatIdsWithQueue(this.deps.store.db)) {
            const chat = getChat(this.deps.store.db, chatId);
            const run = chat?.orchestratorRunId ? getRun(this.deps.store.db, chat.orchestratorRunId) : undefined;

            if (run && isAtRest(run)) {
                this.settle(run);
            }
        }
    }

    /* --------------------------------- Turns ---------------------------------- */

    private onStatus(run: Run): void {
        if (isAtRest(run)) {
            this.settle(run);
        }
        // Back at work, after a question was answered (it goes through `queued`), a reset or a retry: the turn can take what was steered meanwhile.
        // A turn that only starts has no session yet; `onTurnStarted` steers it once it has.
        else if (run.status === 'running' && run.chatId) {
            this.steerAll(run.chatId);
        }
    }

    /**
     * The orchestrator came to rest. Steers it did not take become the next turns, a failed turn holds the queue, and a queue that is not held gives the
     * orchestrator its head as the next turn. While a steer is with the agent nothing goes: its answer settles the queue again.
     */
    private settle(run: Run): void {
        const { store } = this.deps;

        store.tx(() => {
            const chat = run.chatId ? getChat(store.db, run.chatId) : undefined;
            const current = getRun(store.db, run.id);
            const queue = chat ? queueOf(chat) : [];

            if (!chat || !current || chat.orchestratorRunId !== run.id || !isAtRest(current) || queue.length === 0) {
                return;
            }

            // A run that ended on an error, or that the daemon lost in a restart, did not do what the queue was written after: the person decides.
            const paused =
                chat.queuePaused ??
                (current.status === 'failed' || current.status === 'interrupted' ? 'failed' : undefined);

            // A steer still with the agent settles the queue again when it is answered. The hold is written now all the same, or a message the person
            // sends meanwhile would start a turn that the held messages (and that steer) then flow into.
            if (queue.some(item => this.steering.has(item.id))) {
                if (paused !== chat.queuePaused) {
                    saveChat(store, withQueue(chat, queue, paused));
                }

                return;
            }
            const settled = withQueue(chat, settleSteers(queue), paused);
            // One item per turn, in order. A compact item waits for an orchestrator that can compact (finished, its session over), and the messages
            // behind it go first meanwhile.
            const next = paused
                ? undefined
                : queueOf(settled).find(item => !isCompact(item) || this.canCompact(current));

            if (next) {
                this.dispatch(settled, current, next);
            }
            // A queue that does not move is written only when this changes it (every start of the daemon settles it again): it starts to hold, or steers
            // become next turns.
            else if (paused !== chat.queuePaused || queue.some(item => item.mode === 'steer')) {
                saveChat(store, settled);
            }
        });
    }

    /**
     * Gives the orchestrator a queued message as its next turn, as `chat.send` does for a chat at rest: the person's bubble, then the turn. A compact item's
     * turn is the command alone, with no bubble. Sending a message from the queue is what lets a paused one flow again.
     */
    private dispatch(chat: Chat, run: Run, item: QueuedMessage): void {
        const { store, runs, driver } = this.deps;

        saveChat(
            store,
            withQueue(
                chat,
                queueOf(chat).filter(entry => entry.id !== item.id),
                undefined
            )
        );

        if (!isCompact(item)) {
            appendItem(store, run.id, userItemOf(item));
        }

        // A turn that stop and send ended: the agent is told it did not end it itself.
        const stopped = run.status === 'cancelled' && run.statusReason === STOPPED_TO_SEND_REASON && !isCompact(item);

        runs.resume(run.id, stopped ? `${STOPPED_TURN_MESSAGE}\n\n${item.content}` : item.content);
        driver.launch(run.id);
    }

    /**
     * Whether the orchestrator can take a compact turn now: it has finished. One that waits for background work has its session open, and the command must
     * be a turn of its own.
     */
    private canCompact(run: Run): boolean {
        return isTerminalRunStatus(run.status);
    }

    /* -------------------------------- Steering -------------------------------- */

    /** Starts a pass over the chat's steers, behind the one that may be running. */
    private steerAll(chatId: string): void {
        const previous = this.passes.get(chatId) ?? Promise.resolve();
        const pass: Promise<void> = previous
            .then(() => this.steerPass(chatId))
            .catch(error =>
                console.error(`[clowdy] steering the queue of chat ${chatId} failed: ${errorMessage(error)}`)
            )
            .finally(() => {
                if (this.passes.get(chatId) === pass) {
                    this.passes.delete(chatId);
                }
            });

        this.passes.set(chatId, pass);
    }

    /**
     * Hands the queue's steers to the orchestrator's running turn, in order, until the agent takes none: one that is refused, and every steer after it,
     * keeps its place for the next turn. The orchestrator may have come to rest while a steer was out, which the queue did not settle then; it does now.
     */
    private async steerPass(chatId: string): Promise<void> {
        const { store, driver } = this.deps;
        const tried = new Set<string>();
        let runId: string | undefined;

        for (;;) {
            const chat = getChat(store.db, chatId);
            // A held queue steers nothing: a turn the person started by hand after a Stop or a failure gets only what they send now.
            const item =
                chat && !chat.queuePaused
                    ? queueOf(chat).find(entry => entry.mode === 'steer' && !tried.has(entry.id))
                    : undefined;

            runId = chat?.orchestratorRunId;

            if (!runId || !item) {
                break;
            }

            tried.add(item.id);
            this.steering.add(item.id);

            let taken = false;
            const target = runId;

            try {
                taken = await driver.steer(target, item.content, () => this.taken(chatId, target, item));
            } finally {
                this.steering.delete(item.id);
            }

            if (!taken) {
                break;
            }
        }

        const run = runId ? getRun(store.db, runId) : undefined;

        if (run && isAtRest(run)) {
            this.settle(run);
        }
    }

    /** The agent took a steer: it leaves the queue, and the person's bubble goes into the stream where the agent got it. */
    private taken(chatId: string, runId: string, item: QueuedMessage): void {
        const { store } = this.deps;
        const chat = requireChat(store, chatId);

        saveChat(
            store,
            withQueue(
                chat,
                queueOf(chat).filter(entry => entry.id !== item.id),
                chat.queuePaused
            )
        );
        appendItem(store, runId, userItemOf(item));
    }

    private requireItem(chat: Chat, itemId: string): QueuedMessage {
        const item = queueOf(chat).find(entry => entry.id === itemId);

        if (!item) {
            throw notFound('Queued message', itemId);
        }

        return item;
    }
}

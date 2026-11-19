import { isBusyRunStatus } from '@clowdy/protocol';

import { toAttachment } from '../attachments/service';
import { chatIdsWithQueue, getChat } from '../db/chats';
import { getRun } from '../db/runs';
import { requireChat, saveChat } from '../domain/chats';
import { appendItem } from '../domain/items';
import { placeQueued, queueOf, settleSteers, userItemOf, withQueue } from '../domain/queue';
import { conflict, errorMessage, notFound } from '../errors';
import { newId } from '../ids';

import type { Chat, QueuedMessage, QueuedMessageMode, QueuePause, Run } from '@clowdy/protocol';
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

/** A message for a busy orchestrator, as `chat.send` read it. */
export interface QueueInput {
    mode: QueuedMessageMode;
    text: string;
    /** The files, claimed already; the queue keeps them for the message. */
    files: readonly AttachmentRecord[];
    /** What the agent is told. */
    content: string;
}

/** Whether a chat's orchestrator takes a message at once: its work is over, or it only waits for its children (`isBusyRunStatus`). */
export function isAtRest(run: Run): boolean {
    return !isBusyRunStatus(run.status);
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
        deps.driver.onTurnStarted = (runId) => {
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
            }
            else {
                attachments.discard(ids);
            }

            return saveChat(store, withQueue(chat, queueOf(chat).filter(entry => entry.id !== itemId), chat.queuePaused));
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
     * One at rest gets it at once as its next turn, and a paused queue flows again.
     */
    sendNow(chatId: string, itemId: string): { chatId: string; runId: string } {
        const { store, runs } = this.deps;

        return store.tx(() => {
            const chat = requireChat(store, chatId);
            const item = this.requireItem(chat, itemId);
            const run = runs.require(chat.orchestratorRunId as string);

            if (!isAtRest(run)) {
                if (item.mode !== 'steer') {
                    saveChat(store, withQueue(chat, placeQueued(queueOf(chat), { ...item, mode: 'steer' }), chat.queuePaused));
                }

                store.afterCommit(() => this.steerAll(chat.id));

                return { chatId, runId: run.id };
            }

            if (this.steering.has(item.id)) {
                throw conflict('The agent is taking this message now');
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

            if (!chat || !current || chat.orchestratorRunId !== run.id || !isAtRest(current) || queue.length === 0 || queue.some(item => this.steering.has(item.id))) {
                return;
            }

            // A run that ended on an error, or that the daemon lost in a restart, did not do what the queue was written after: the person decides.
            const paused = chat.queuePaused ?? (current.status === 'failed' || current.status === 'interrupted' ? 'failed' : undefined);
            const settled = withQueue(chat, settleSteers(queue), paused);

            if (!paused) {
                this.dispatch(settled, current, queueOf(settled)[0]);
            }
            // A held queue is written only when this changes it (every start of the daemon settles it again): it starts to hold, or steers become next turns.
            else if (paused !== chat.queuePaused || queue.some(item => item.mode === 'steer')) {
                saveChat(store, settled);
            }
        });
    }

    /**
     * Gives the orchestrator a queued message as its next turn, as `chat.send` does for a chat at rest: the person's bubble, then the turn. Sending a message
     * from the queue is what lets a paused one flow again.
     */
    private dispatch(chat: Chat, run: Run, item: QueuedMessage): void {
        const { store, runs, driver } = this.deps;

        saveChat(store, withQueue(chat, queueOf(chat).filter(entry => entry.id !== item.id), undefined));
        appendItem(store, run.id, userItemOf(item));
        runs.resume(run.id, item.content);
        driver.launch(run.id);
    }

    /* -------------------------------- Steering -------------------------------- */

    /** Starts a pass over the chat's steers, behind the one that may be running. */
    private steerAll(chatId: string): void {
        const previous = this.passes.get(chatId) ?? Promise.resolve();
        const pass: Promise<void> = previous
            .then(() => this.steerPass(chatId))
            .catch(error => console.error(`[clowdy] steering the queue of chat ${ chatId } failed: ${ errorMessage(error) }`))
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
            const item = chat && queueOf(chat).find(entry => entry.mode === 'steer' && !tried.has(entry.id));

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
            }
            finally {
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

        saveChat(store, withQueue(chat, queueOf(chat).filter(entry => entry.id !== item.id), chat.queuePaused));
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

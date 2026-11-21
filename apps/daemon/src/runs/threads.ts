import { isTerminalRunStatus } from '@clowdy/protocol';
import { isAbsolute } from 'node:path';

import { getChat, listChatDescendants, listChildChats } from '../db/chats';
import { lastUserSeq, listItems, nextSeq } from '../db/items';
import { getRun } from '../db/runs';
import { chatDepth, createChat, inSameTree, isBelow, requireChat } from '../domain/chats';
import { linkChatTask, resolveTask } from '../domain/tasks';
import { CommandError, conflict, invalid, notFound } from '../errors';
import { isFolder } from './driver';
import { sendMessage } from './messages';
import { clip, cut } from './tool-kit';
import { STOPPED_TO_SEND_REASON } from './transitions';

import type { Chat, ChatMode, MessageSource, QueuedMessageMode, Run, StreamItem, Task } from '@clowdy/protocol';
import type { Database } from 'bun:sqlite';
import type { AttachmentsService } from '../attachments/service';
import type { Config } from '../config';
import type { AgentRegistry } from '../engine/acp/registry';
import type { Store } from '../store';
import type { RunDriver } from './driver';
import type { Delivery } from './messages';
import type { ThreadNotices } from './notices';
import type { ChatQueue } from './queue';
import type { RunService } from './service';

/**
 * How a thread stands, in one word, as its parent reads it: `working` (its turn runs, or waits for a slot or a task it depends on), `asking` (it waits for
 * the person's answer), `idle` (its turn is over; it may still have background work open), `failed`, `stopped` (a Stop ended it), `interrupted` (a
 * restart cut it off), `new` (no message has started it yet).
 */
export type ThreadState = 'working' | 'asking' | 'idle' | 'failed' | 'stopped' | 'interrupted' | 'new';

/** The state of a thread from its orchestrator run (`undefined` for a thread whose first message has not made one). */
export function threadState(run: Run | undefined): ThreadState {
    switch (run?.status) {
        case undefined:
            return 'new';
        case 'queued':
        case 'running':
        case 'blocked':
            return 'working';
        case 'waiting_user':
            return 'asking';
        case 'succeeded':
        case 'waiting_background':
            return 'idle';
        case 'failed':
            return 'failed';
        case 'cancelled':
            // Stop and send rests the run only until the message it made room for starts the next turn.
            return run.statusReason === STOPPED_TO_SEND_REASON ? 'working' : 'stopped';
        case 'interrupted':
            return 'interrupted';
    }
}

/** The most of a thread's last words its parent reads at once. */
export const THREAD_OUTPUT_CHARS = 4000;

/** A thread's words as its parent reads them: at most `THREAD_OUTPUT_CHARS`, with a line that says how much was cut. */
export function clipOutput(text: string): string {
    if (text.length <= THREAD_OUTPUT_CHARS) {
        return text;
    }

    const kept = cut(text, THREAD_OUTPUT_CHARS);

    return `${ kept }\n\n[... ${ text.length - kept.length } more characters cut ...]`;
}

/**
 * The final answer of the thread's latest turn: the last message its orchestrator said after the last `user` item (the message that turn answers), which
 * is what the engines report as a turn's result. What it said on the way (between its tool calls) is not part of it. `undefined` when it said nothing yet;
 * mid-turn it is the latest message so far. `after` leaves out what came before it too: a turn the agent started by itself answers no `user` item.
 */
export function lastTurnText(db: Database, runId: string, after = 0): string | undefined {
    return listItems(db, runId, Math.max(lastUserSeq(db, runId), after))
        .flatMap(item => (item.body.kind === 'assistant' && item.body.text.trim() ? [item.body.text.trim()] : []))
        .at(-1);
}

/** What the agent of a chat is told before a message another thread of its tree sent it; the stream shows the message alone, with who sent it. */
export function threadMessage(sender: Chat, text: string): string {
    return `[Message from thread "${ sender.title }" (${ sender.id })]\n\n${ text }`;
}

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

/** A stream item as one short line, for `thread_log`. */
export function describeItem({ body }: StreamItem): string {
    switch (body.kind) {
        case 'user': {
            const { from } = body;

            // A notice of threads that stopped has no words of its own: the line says how each thread stopped.
            if (from?.kind === 'threadNotice') {
                return `notice: ${ from.threads.map(thread => `"${ thread.title }" ${ thread.outcome }`).join(', ') }`;
            }

            const writer = from ? `thread "${ from.title }" (${ from.chatId })` : 'person';
            const files = body.attachments?.length ? ` [files: ${ body.attachments.map(file => file.name).join(', ') }]` : '';

            return `${ writer }: ${ clip(oneLine(body.text), 300) }${ files }`;
        }
        case 'tool':
            return `tool ${ body.name } (${ body.state })${ body.error ? `: ${ clip(oneLine(body.error), 200) }` : '' }`;
        case 'question':
            return `question: ${ clip(oneLine(body.text), 200) }${ body.answer === undefined ? '' : ` (answered: ${ clip(oneLine(body.answer), 100) })` }`;
        default:
            return `${ body.kind }: ${ clip(oneLine(body.text), 300) }`;
    }
}

export interface ThreadDeps {
    store: Store;
    config: Config;
    runs: RunService;
    driver: RunDriver;
    queue: ChatQueue;
    attachments: AttachmentsService;
    agents: AgentRegistry;
    notices: ThreadNotices;
}

/** `thread_wait` waits this long unless asked for another time, and never longer than `MAX_WAIT_SECONDS`. */
export const WAIT_SECONDS = 90;
export const MAX_WAIT_SECONDS = 600;

export interface SpawnInput {
    prompt: string;
    title?: string;
    engine?: string;
    model?: string;
    effort?: string;
    mode?: ChatMode;
    /** Task keys or ids the thread's run is assigned to. */
    tasks?: readonly string[];
    cwd?: string;
}

/** A thread as `thread_list` shows it. */
export interface ThreadSummary {
    threadId: string;
    title: string;
    parent?: string;
    /** How deep below the caller, with `all`: 1 is the caller's own thread. */
    depth?: number;
    state: ThreadState;
    engine?: string;
    model?: string;
    /** Titles of what it has open in the background. */
    open: string[];
    archived?: true;
    updatedAt: string;
}

/**
 * Threads: chats that an agent of another chat started (`Chat.parentChatId`), each with its own orchestrator run, which is a root run of its own and not a
 * child of the caller's. Every operation acts as the caller, the orchestrator run whose tool was called, so its chat (`run.chatId`) is where the thread
 * tree is read from. A thread's messages go the way the person's do (`sendMessage`), so its queue, steers, archive and model work as in any chat.
 */
export class ThreadService {
    constructor(private deps: ThreadDeps) {}

    /**
     * Starts a thread below the caller's chat: a chat with the caller's chat as its parent, whose first message is `prompt`. It runs on the caller's
     * agent unless it names another, on the caller's model and level only when it keeps the caller's agent and names no model (another agent has other
     * models, and a model has its own levels), and in the caller's mode unless it names one. Tasks assign its run, which waits for their unfinished
     * dependencies, and link its chat.
     */
    spawn(caller: Run, input: SpawnInput): { threadId: string; title: string; state: ThreadState } {
        const { store, config, runs } = this.deps;

        return store.tx(() => {
            const current = this.requireLive(caller);
            const parent = this.callerChat(caller);
            const project = runs.projectOf(current);
            const depth = chatDepth(store, parent);

            if (depth + 1 > config.maxThreadDepth) {
                throw conflict(`Threads nest ${ config.maxThreadDepth } levels deep at most, counting the chat the person started, and this chat is level ${ depth }: it cannot start threads. Do this work yourself or with your own sub-agents.`);
            }

            const threads = listChildChats(store.db, parent.id);

            if (threads.length >= config.maxThreads) {
                throw conflict(`This chat has started ${ config.maxThreads } threads, the most one chat may start (finished ones count too). Give more work to the threads you have with thread_tell, or do it yourself.`);
            }

            const working = threads.filter(thread => !this.isOver(thread)).length;

            if (working >= config.maxActiveThreads) {
                throw conflict(`This chat has ${ working } threads at work, the most it may have at once; a thread whose turn is over counts while its background work runs. Start the next when one is done (you are told each time one stops), or stop one with thread_stop.`);
            }

            // The fake engine is for demos and tests: a model that picked it would report work nobody did.
            if (input.engine === 'fake') {
                throw invalid('The fake engine is not available to agents. Leave engine unset to use your own agent, or name an installed one.');
            }

            const engine = runs.resolveEngine(project, input.engine ?? current.engine);
            const inherits = engine === current.engine && input.model === undefined;

            if (input.cwd !== undefined && !(isAbsolute(input.cwd) && isFolder(input.cwd))) {
                throw invalid(`cwd must be the absolute path of an existing folder: ${ input.cwd }`);
            }

            const tasks = this.freeTasks(current, input.tasks ?? []);
            const chat = createChat(store, {
                projectId: project.id,
                title: input.title,
                mode: input.mode ?? parent.mode,
                engine,
                model: inherits ? current.model : input.model,
                effort: input.effort ?? (inherits ? current.effort : undefined),
                parentChatId: parent.id,
                // The thread works where its parent does, unless the call names a folder of its own (`cwd`, which the run keeps).
                folderId: parent.folderId,
            });

            for (const task of tasks) {
                linkChatTask(store, project.id, { chatId: chat.id, taskId: task.id });
            }

            const { runId } = sendMessage(this.deps, chat.id, { text: input.prompt, from: fromChat(parent), start: { cwd: input.cwd, assigned: tasks } });

            return { threadId: chat.id, title: requireChat(store, chat.id).title, state: threadState(runs.require(runId)) };
        });
    }

    /**
     * Sends `message` to another chat of the caller's thread tree (its parent chain, its threads and theirs, their siblings), the way the person's message
     * goes: a chat at rest starts a turn on it, a busy one gets it as a steer of the running turn (`steer`, when its agent can take one) or as its next turn.
     * The stream shows the message with who sent it; the agent is told who sent it too (`threadMessage`).
     */
    tell(caller: Run, input: { thread: string; message: string; mode?: QueuedMessageMode }): { delivery: Delivery } {
        const { store } = this.deps;

        return store.tx(() => {
            this.requireLive(caller);

            const sender = this.callerChat(caller);
            const target = this.thread(input.thread);

            if (target.id === sender.id) {
                throw invalid('That is your own chat. thread_tell sends a message to another chat of your thread tree.');
            }

            if (!inSameTree(store, sender, target)) {
                throw invalid(`Chat ${ target.id } is not in your thread tree. You can message only your parent chain, your threads and theirs, and their siblings; thread_list shows your threads.`);
            }

            if (target.archivedAt !== undefined) {
                throw conflict(`"${ target.title }" (${ target.id }) is archived and takes no messages from threads. Start a new thread for the work instead.`);
            }

            const { delivery } = sendMessage(this.deps, target.id, {
                text: input.message,
                content: threadMessage(sender, input.message.trim()),
                mode: input.mode ?? 'steer',
                from: fromChat(sender),
            });

            return { delivery };
        });
    }

    /**
     * Stops a thread below the caller as the person's Stop does: its run and the sub-agents of its session are cancelled, and its queue is held. The threads
     * below it go on. A thread whose work is over already is left as it is (`stopped: false`).
     */
    stop(caller: Run, threadId: string): { stopped: boolean; state: ThreadState } {
        const { store, runs, queue } = this.deps;

        return store.tx(() => {
            const stopper = this.callerChat(caller);
            const target = this.thread(threadId);

            if (!isBelow(store, stopper.id, target)) {
                throw invalid(`"${ target.title }" (${ target.id }) is not below you. You can stop only your own threads and theirs.`);
            }

            const run = this.runOf(target);

            if (!run || isTerminalRunStatus(run.status)) {
                return { stopped: false, state: threadState(run) };
            }

            const stopped = runs.cancel(run.id, `Stopped by ${ stopper.title }`).includes(run.id);

            if (stopped) {
                queue.pause(target.id, 'stopped');
            }

            return { stopped, state: threadState(runs.require(run.id)) };
        });
    }

    /**
     * What a chat of the caller's tree said in its latest turn (clipped), how it stands, what it has open in the background, and why it failed. The caller
     * that is the chat's parent has read the answer of the thread's latest stop when the thread rests where that stop left it (`idle`, `failed`,
     * `interrupted`): the notice of it the parent has not been told yet is dropped (`ThreadNotices.consume`). A thread at work again, asking or stopped
     * shows other words, so its notice stays, and anyone else's reading leaves the parent's notice alone.
     */
    output(caller: Run, threadId: string) {
        const target = this.inTree(caller, threadId);
        const run = this.runOf(target);
        const state = threadState(run);
        const text = run ? lastTurnText(this.deps.store.db, run.id) : undefined;

        if (target.parentChatId !== undefined && target.parentChatId === caller.chatId && (state === 'idle' || state === 'failed' || state === 'interrupted')) {
            this.deps.notices.consume(target.parentChatId, target.id);
        }

        return {
            threadId: target.id,
            title: target.title,
            state,
            ...(run?.statusReason && { reason: run.statusReason }),
            text: text === undefined ? null : clipOutput(text),
            open: openOf(run),
            ...(run?.status === 'failed' && { error: run.error ?? 'It failed without saying why' }),
        };
    }

    /**
     * Waits until a thread below the caller stops working (`threadState` other than `working`: its turn ended, it asks the person, failed, was stopped or
     * interrupted), at most `timeoutSeconds`, then answers what `output` answers, with `timedOut`. A thread that is not working answers at once. The
     * caller's turn waits meanwhile and keeps its slot. Its abort signal (the caller was stopped) ends the wait with an error.
     */
    async wait(caller: Run, input: { thread: string; timeoutSeconds?: number }, signal: AbortSignal) {
        const target = this.thread(input.thread);

        if (!isBelow(this.deps.store, this.callerChat(caller).id, target)) {
            throw invalid(`"${ target.title }" (${ target.id }) is not below you. You can wait only for your own threads and theirs.`);
        }

        const run = this.runOf(target);
        const timedOut = run !== undefined && threadState(run) === 'working' && !await this.untilRest(run.id, (input.timeoutSeconds ?? WAIT_SECONDS) * 1000, signal);

        return { ...this.output(caller, target.id), timedOut };
    }

    /** The last `limit` lines of a chat of the caller's tree, oldest first, one short line each with its number in the stream. */
    log(caller: Run, threadId: string, limit: number) {
        const { db } = this.deps.store;
        const target = this.inTree(caller, threadId);
        const run = this.runOf(target);
        // What the thread thought is not for the agent that reads its log (it is a good deal of words, and not what the thread did or said): the last `limit`
        // lines are of the rest, so the window widens until it holds that many or reaches the start.
        const shown = (from: number) => run ? listItems(db, run.id, from).filter(item => item.body.kind !== 'reasoning') : [];
        let from = run ? Math.max(0, nextSeq(db, run.id) - 1 - limit) : 0;
        let items = shown(from);

        while (items.length < limit && from > 0) {
            from = Math.max(0, from - limit);
            items = shown(from);
        }

        return { threadId: target.id, title: target.title, state: threadState(run), lines: items.slice(-limit).map(item => `#${ item.seq } ${ describeItem(item) }`) };
    }

    /** The caller's threads: the ones its chat started, or with `all` every chat below it, a parent before its threads. */
    list(caller: Run, all: boolean): { threads: ThreadSummary[] } {
        const { store } = this.deps;
        const chat = this.callerChat(caller);
        const entries = all ? listChatDescendants(store.db, chat.id) : listChildChats(store.db, chat.id).map(thread => ({ chat: thread, depth: 1 }));

        return { threads: entries.map(entry => this.summary(entry.chat, all ? entry.depth : undefined)) };
    }

    /* --------------------------------- Helpers -------------------------------- */

    /**
     * Resolves `true` at the first commit that leaves the run not working, `false` when `timeoutMs` passes first; rejects when `signal` aborts. Each commit's
     * own event is read, not the run as it is afterwards: a run that comes to rest may be given its next queued message within the same moment, and that
     * stop still counts.
     */
    private untilRest(runId: string, timeoutMs: number, signal: AbortSignal): Promise<boolean> {
        return new Promise((resolve, reject) => {
            const finish = () => {
                unsubscribe();
                clearTimeout(timer);
                signal.removeEventListener('abort', onAbort);
            };
            const onAbort = () => {
                finish();
                reject(signal.reason);
            };
            const unsubscribe = this.deps.store.subscribe((events) => {
                if (events.some(({ data }) => data.type === 'run.upserted' && data.run.id === runId && threadState(data.run) !== 'working')) {
                    finish();
                    resolve(true);
                }
            });
            const timer = setTimeout(() => {
                finish();
                resolve(false);
            }, timeoutMs);

            if (signal.aborted) {
                onAbort();
            }
            else {
                signal.addEventListener('abort', onAbort, { once: true });
            }
        });
    }

    private summary(chat: Chat, depth: number | undefined): ThreadSummary {
        const run = this.runOf(chat);
        const engine = run?.engine ?? chat.engine;
        const model = run?.model ?? chat.model;

        return {
            threadId: chat.id,
            title: chat.title,
            ...(chat.parentChatId && { parent: chat.parentChatId }),
            ...(depth !== undefined && { depth }),
            state: threadState(run),
            ...(engine && { engine }),
            ...(model && { model }),
            open: openOf(run),
            ...(chat.archivedAt !== undefined && { archived: true as const }),
            updatedAt: new Date(chat.updatedAt).toISOString(),
        };
    }

    /** The caller as it is now: its turn may have been stopped since its tools were made, and a stopped orchestrator starts no work. */
    private requireLive(caller: Run): Run {
        const current = this.deps.runs.require(caller.id);

        if (isTerminalRunStatus(current.status)) {
            throw conflict(`${ current.name } is ${ current.status } and cannot start threads or message them`);
        }

        return current;
    }

    private callerChat(caller: Run): Chat {
        if (!caller.chatId) {
            throw invalid('Only the orchestrator of a chat has threads');
        }

        return requireChat(this.deps.store, caller.chatId);
    }

    private thread(threadId: string): Chat {
        const chat = getChat(this.deps.store.db, threadId);

        if (!chat) {
            throw notFound('Thread', threadId);
        }

        return chat;
    }

    /** A chat of the caller's thread tree, the caller's own included. */
    private inTree(caller: Run, threadId: string): Chat {
        const chat = this.callerChat(caller);
        const target = this.thread(threadId);

        if (!inSameTree(this.deps.store, chat, target)) {
            throw invalid(`Chat ${ target.id } is not in your thread tree. thread_list shows your threads.`);
        }

        return target;
    }

    private runOf(chat: Chat): Run | undefined {
        return chat.orchestratorRunId ? getRun(this.deps.store.db, chat.orchestratorRunId) : undefined;
    }

    /** Whether a thread's work is over: its run has finished. A thread whose run has not been made yet is not over. */
    private isOver(chat: Chat): boolean {
        const run = this.runOf(chat);

        return run !== undefined && isTerminalRunStatus(run.status);
    }

    /**
     * The tasks a new thread is assigned to, each once. A task that another run works on is refused: the caller's own run may hand its task on (a chat
     * started from the task spawns a thread on it), but two threads on one task would do the work twice.
     */
    private freeTasks(caller: Run, references: readonly string[]): Task[] {
        const { store, runs } = this.deps;
        const tasks = new Map(references.map(reference => resolveTask(store, caller.projectId, reference)).map(task => [task.id, task]));

        for (const task of tasks.values()) {
            const [active] = runs.activeRunsOfTask(task.id, caller.id);

            if (active) {
                const chat = active.chatId ? getChat(store.db, active.chatId) : undefined;

                throw new CommandError('already_running', `Task ${ task.key } already has an active run (${ active.name }${ chat ? ` of "${ chat.title }"` : '' }). Leave the task to it, or stop that work first.`);
            }
        }

        return [...tasks.values()];
    }
}

/** A message from this chat, as the stream and the queue record who wrote it. */
const fromChat = (chat: Chat): MessageSource => ({ kind: 'thread', chatId: chat.id, title: chat.title });

/** Titles of what the run has open in the background. */
const openOf = (run: Run | undefined): string[] => run?.background?.map(item => item.title) ?? [];

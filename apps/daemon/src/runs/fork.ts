import { STOPPED_TOOL } from '@clowdy/protocol';

import { upsertChat } from '../db/chats';
import { itemRef, listItemsWithRefs } from '../db/items';
import { countRunsWithRole, getRunWork, setRunWork, upsertRun } from '../db/runs';
import { choiceOf, DEFAULT_CHAT_TITLE, requireChat } from '../domain/chats';
import { copyItems, streamItem } from '../domain/items';
import { conflict, EngineFailure, invalid, notFound, unavailable } from '../errors';
import { newId } from '../ids';
import { requireEnabled } from './messages';

import type { Attachment, Chat, Run, StreamItem, StreamItemBody } from '@clowdy/protocol';
import type { Services } from '../commands/context';

/** `(1) foo` for `foo`, `(2) foo` for `(1) foo`: the number counts the forks the title has been through. A chat with no title of its own keeps none. */
export function forkTitle(title: string): string {
    const text = title.trim();

    if (!text || text === DEFAULT_CHAT_TITLE) {
        return DEFAULT_CHAT_TITLE;
    }

    const numbered = /^\((\d{1,6})\) (\S.*)$/s.exec(text);

    return numbered ? `(${ Number(numbered[1]) + 1 }) ${ numbered[2] }` : `(1) ${ text }`;
}

/** What a fork is made of, once the refusals are behind it. */
interface ForkPlan {
    chat: Chat;
    run: Run;
    answer: StreamItem;
    ref: string;
}

/**
 * Everything that can be refused without asking the agent: the chat has a conversation, the item is a final answer the app may fork (`canFork`: it holds a
 * rewind point, its run is a chat's orchestrator, and the agent can fork), and the agent is switched on.
 */
function planFork({ store, runs, agents }: Services, chatId: string, itemId: string): ForkPlan {
    const chat = requireChat(store, chatId);

    if (!chat.orchestratorRunId) {
        throw invalid('This chat has no conversation to fork yet');
    }

    const run = runs.require(chat.orchestratorRunId);
    const answer = streamItem(store, run, itemId);

    if (!answer) {
        throw notFound('Message', itemId);
    }

    const ref = answer.canFork ? itemRef(store.db, run.id, answer.seq) : undefined;

    if (!answer.canFork || !ref) {
        throw invalid('This message cannot be forked');
    }

    if (!run.sessionId) {
        throw invalid('This chat has no conversation to fork yet');
    }

    requireEnabled(agents, run.engine);

    return { chat, run, answer, ref };
}

/** The agent's reason, as one phrase of the daemon's own: no trailing period, since the person reads it in a toast. */
const reasonOf = (error: EngineFailure) => error.message.trim().replace(/\.+$/, '');

/**
 * `chat.fork`: a new chat from a final answer of another, with the conversation through that answer. The agent forks its session first (a short job of its
 * own that takes no slot and does not touch the source session, so the source chat may be working), then, in one transaction, the chat, its at-rest
 * orchestrator run holding the copy's session, and the history are made. When the agent cannot fork nothing is created. Returns the part that changes
 * Clowdy, to run in the transaction that also stores the command's result (see `executeCommandAsync`).
 *
 * The new chat has the same project, agent, model, level and mode, is no thread, has an empty queue and no usage, is titled `forkTitle(source)`, and says where it
 * comes from in `Chat.forkedFrom`. Its run is `succeeded` like any run whose turn ended, with the copy's session id, the folder the source works in, and the
 * answer as its result, so the next message resumes the copy through the normal path (`sendMessage`: no first-message prefix, the history already has it).
 *
 * The stream is a copy of the source's items through the answer: new ids, the same `seq`, time and rewind points (the copied session holds the same
 * provider messages, so Fork and Edit work on what was inherited). Native sub-agents' runs are not copied, so a sub-agent card in the copy has no child to
 * open (the card says only that the agent ran); a call still running in the source is shown stopped, since the fork has no process of its own. The files of
 * copied messages are copied too, as files of the new chat (`AttachmentsService.copyInto`). Nothing but the new chat and its run is announced: the copied
 * items are read when the chat is opened.
 */
export async function prepareFork(services: Services, chatId: string, itemId: string): Promise<() => { chat: Chat }> {
    const { store, driver, attachments } = services;
    const plan = planFork(services, chatId, itemId);
    let sessionId: string;

    try {
        sessionId = await driver.forkSession(plan.run.id, plan.ref);
    }
    catch (error) {
        if (error instanceof EngineFailure) {
            throw unavailable(`Couldn't fork the conversation: ${ reasonOf(error) }`);
        }

        throw error;
    }

    return () => {
        // The source may have been deleted, or its stream cut, while the agent copied the session: the copy is then left in the agent's own list, unused.
        const source = requireChat(store, plan.chat.id);
        const answer = source.orchestratorRunId === plan.run.id ? streamItem(store, plan.run, plan.answer.id) : undefined;

        if (!answer) {
            throw conflict('The chat changed while it was forked. Try again.');
        }

        const stored = listItemsWithRefs(store.db, plan.run.id, answer.seq);
        const now = Date.now();
        const chatId = newId('cht');
        const runId = newId('run');
        const title = forkTitle(source.title);
        const run: Run = {
            id: runId,
            projectId: source.projectId,
            rootRunId: runId,
            chatId,
            role: 'orchestrator',
            name: `Orchestrator ${ String(countRunsWithRole(store.db, source.projectId, 'orchestrator') + 1).padStart(2, '0') }`,
            summary: title,
            status: 'succeeded',
            engine: plan.run.engine,
            ...(plan.run.model && { model: plan.run.model }),
            ...(plan.run.effort && { effort: plan.run.effort }),
            sessionId,
            ...(answer.body.kind === 'assistant' && { result: answer.body.text }),
            createdAt: now,
            startedAt: now,
            finishedAt: now,
        };
        const chat: Chat = {
            id: chatId,
            projectId: source.projectId,
            title,
            mode: source.mode,
            ...choiceOf(run),
            orchestratorRunId: runId,
            forkedFrom: { chatId: source.id, atSeq: answer.seq },
            createdAt: now,
            updatedAt: now,
        };

        // The chat's row comes first, since the run and the files point at it; it is announced last, when everything it names is there.
        upsertChat(store.db, chat);
        upsertRun(store.db, run);
        setRunWork(store.db, runId, { cwd: getRunWork(store.db, plan.run.id).cwd });
        store.emit(run.projectId, { type: 'run.upserted', run });

        const files = attachments.copyInto(
            stored.flatMap(({ item }) => item.body.kind === 'user' ? item.body.attachments ?? [] : []),
            { projectId: source.projectId, chatId, runId }
        );

        try {
            copyItems(store, stored, runId, body => inherited(body, files.copies));
            store.emit(chat.projectId, { type: 'chat.upserted', chat });

            return { chat };
        }
        catch (error) {
            files.undo();
            throw error;
        }
    };
}

/** What a copied item says in the fork: its files are the fork's own copies, and a call that was still running has no process here to finish it. */
function inherited(body: StreamItemBody, copies: ReadonlyMap<string, Attachment>): StreamItemBody {
    if (body.kind === 'user' && body.attachments?.length) {
        return { ...body, attachments: body.attachments.map(file => copies.get(file.id) ?? file) };
    }

    if (body.kind === 'tool' && body.state === 'running') {
        return { ...body, state: 'error', error: STOPPED_TOOL };
    }

    return body;
}

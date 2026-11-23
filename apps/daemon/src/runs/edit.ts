import { isTerminalRunStatus } from '@clowdy/protocol';

import { getChatLastRun, setChatLastRun, setForkPoint } from '../db/chats';
import { firstUserItem, itemBefore, listItems, nextSeq } from '../db/items';
import { firstWords, requireChat, saveChat } from '../domain/chats';
import { cutStream, streamItem } from '../domain/items';
import { conflict, EngineFailure, invalid, notFound, unavailable } from '../errors';
import { reasonOf } from './fork';
import { requireEnabled, sendMessage } from './messages';
import { STOPPED_TO_SEND_REASON } from './transitions';

import type { Chat, Run, StreamItem } from '@clowdy/protocol';
import type { Services } from '../commands/context';

/** What an edit asks of the chat: the message the person wrote in its place, with the files it carries. */
export interface EditInput {
    text: string;
    attachmentIds?: readonly string[];
}

/** What an edit is made of, once the refusals that need no agent are behind it. */
interface EditPlan {
    chat: Chat;
    run: Run;
    /** The message being rewritten: a `user` item that starts a turn. */
    item: StreamItem;
    /** The agent's rewind point of the turn before it, which the session is copied at; none for the first message of the chat, which starts a fresh session. */
    ref: string | undefined;
    /** The last number in the stream when the plan was made: a stream that moved since was written to by someone else. */
    lastSeq: number;
}

/** The chats being edited right now, per store: the agent's copy of one is being made, and a second edit of it would race the first. */
const editing = new WeakMap<object, Set<string>>();

/**
 * Whether the chat's orchestrator is at rest as an edit needs it: its work is over. A run that waits for background work still has its session open, and one
 * that was stopped only to send a queued message is about to start that turn (`STOPPED_TO_SEND_REASON`), so neither rests.
 */
const restsForEdit = (run: Run): boolean =>
    isTerminalRunStatus(run.status) && run.statusReason !== STOPPED_TO_SEND_REASON;

/** The ids of the files the messages among `items` carry. */
const filesOf = (items: readonly StreamItem[]): string[] =>
    items.flatMap(item => (item.body.kind === 'user' ? (item.body.attachments ?? []).map(file => file.id) : []));

/**
 * Everything that can be refused without asking the agent, in the order a person meets it: the chat has a conversation, the item is a message of its
 * orchestrator's stream that the app may edit (`canEdit`), the orchestrator is at rest, the new message is not empty and its files can go with it, and the
 * agent is switched on. The flag of the agent needs no rule of its own: `canEdit` is set only for an agent that can fork, and so, for the first message of a
 * chat (which needs no fork), only while the flag is on.
 */
function planEdit(services: Services, chatId: string, itemId: string, input: EditInput): EditPlan {
    const { store, runs, agents, attachments } = services;
    const chat = requireChat(store, chatId);

    if (!chat.orchestratorRunId) {
        throw invalid('This chat has no conversation to edit yet');
    }

    const run = runs.require(chat.orchestratorRunId);
    const item = streamItem(store, run, itemId);

    if (!item) {
        throw notFound('Message', itemId);
    }

    if (!item.canEdit) {
        throw invalid('This message cannot be edited');
    }

    if (!restsForEdit(run)) {
        throw conflict('Stop the agent to edit this message');
    }

    const attachmentIds = input.attachmentIds ?? [];

    if (!input.text.trim() && attachmentIds.length === 0) {
        throw invalid('The message is empty');
    }

    // The agent is asked before anything changes, so a request that the rewrite would refuse anyway must not cost a fork: the files are checked as the send will.
    attachments.claim(
        chat.projectId,
        attachmentIds,
        new Set(attachments.sentIn(chat.id, filesOf(listItems(store.db, run.id, item.seq - 1))).map(file => file.id))
    );
    requireEnabled(agents, run.engine);

    const before = itemBefore(store.db, run.id, item.seq);
    const ref = before?.ref ?? undefined;

    // `canEdit` says the message before holds a point; a stream that says otherwise is not one to rewrite. The copy is made of the session the run holds.
    if (before && !ref) {
        throw invalid('This message cannot be edited');
    }

    if (before && !run.sessionId) {
        throw invalid('This chat has no conversation to edit yet');
    }

    return { chat, run, item, ref, lastSeq: nextSeq(store.db, run.id) - 1 };
}

/**
 * `chat.edit`: the chat is rewritten from a message of the person's, which is replaced by `input` and answered anew. The agent is asked first (the copy of
 * its session cut at the point before the message, a short job of its own that takes no slot and does not touch the session the run holds), and when it
 * cannot nothing changes. The first message of a chat needs no copy: its turn starts a fresh session, which carries the first message's prefix as every first
 * message does, since nothing else gives the agent the entry skill and the mode. Returns the part that changes Clowdy, to run in the transaction that also
 * stores the command's result (see `executeCommandAsync`). That part is one transaction for the whole rewrite, the new message included, so nothing can leave
 * a cut chat without it.
 *
 * It refuses the chat that is not at rest again, at the moment of writing (the person may have sent a message from the composer meanwhile), and a stream
 * that moved or lost the message since the plan was made, as a conflict; a second edit of a chat whose agent copy is still being made is one too, and costs
 * no copy. Then, in this order: the stream from the message on goes (`cutStream`: the sub-agent runs it started, and the `stream.truncated` event), the
 * files of its messages go with their rows and folders except those the new message carries on, the run takes the copy's session (`RunService.rewind`),
 * and the new text is sent as an ordinary turn (`sendMessage`: its files claimed, a user item that takes the freed number, the run queued and launched).
 * What is not part of the dropped messages stays: the queue, threads and what they said, tasks and their links, artifacts, usage and the files the agent
 * changed (it is not told). A chat that is still named for the first words of its first message, when that message is the one rewritten, is named for the
 * first words of the new one. A fork whose inherited history the cut reaches into ends that history where the cut begins (`forkedFrom.atSeq`).
 */
export async function prepareEdit(
    services: Services,
    chatId: string,
    itemId: string,
    input: EditInput
): Promise<() => { chatId: string; runId: string }> {
    const { store, runs, driver, attachments } = services;
    const plan = planEdit(services, chatId, itemId, input);
    const busy = editing.get(store) ?? new Set<string>();

    if (busy.has(plan.chat.id)) {
        throw conflict('This chat is being edited already');
    }

    editing.set(store, busy);
    busy.add(plan.chat.id);

    let sessionId: string | undefined;

    try {
        if (plan.ref !== undefined) {
            sessionId = await driver.forkSession(plan.run.id, plan.ref);
        }
    } catch (error) {
        busy.delete(plan.chat.id);

        if (error instanceof EngineFailure) {
            throw unavailable(`Couldn't rewind the conversation: ${reasonOf(error)}`);
        }

        throw error;
    }

    return () => {
        try {
            // The chat may have changed while the agent copied the session: a message sent from the composer, another command, the chat deleted. The copy is then
            // left in the agent's own list, unused.
            const source = requireChat(store, plan.chat.id);
            const run = source.orchestratorRunId === plan.run.id ? runs.require(plan.run.id) : undefined;
            const item = run && streamItem(store, run, plan.item.id);

            if (!run || !item?.canEdit || !restsForEdit(run) || nextSeq(store.db, run.id) - 1 !== plan.lastSeq) {
                throw conflict('The chat changed while the message was edited. Try again.');
            }

            const first = firstUserItem(store.db, run.id);
            const unnamed =
                first?.id === item.id && first.body.kind === 'user' && source.title === firstWords(first.body);
            const dropped = cutStream(store, run, item.seq);
            const files = attachments.sentIn(source.id, filesOf(dropped)).map(file => file.id);
            const carried = new Set(input.attachmentIds ?? []);

            // What the new message carries on is given back to the project, to be claimed as an upload is; the rest of the dropped messages' files go.
            attachments.release(files.filter(id => carried.has(id)));
            attachments.discard(files.filter(id => !carried.has(id)));
            runs.rewind(run.id, sessionId);

            // A fork's divider follows the last item it inherited: a cut into that history ends it where the cut begins, so the divider does not land after new messages.
            if (source.forkedFrom && source.forkedFrom.atSeq >= item.seq) {
                setForkPoint(store.db, source.id, item.seq - 1);
            }

            // What the chat's latest turn changed (`Chat.lastRun`) is gone with the turn when the cut reaches it: the message that follows replaces it when its own turn ends.
            if ((getChatLastRun(store.db, source.id)?.seq ?? 0) >= item.seq) {
                setChatLastRun(store.db, source.id, undefined);
            }

            const sent = sendMessage(services, source.id, {
                text: input.text,
                attachmentIds: input.attachmentIds,
                fresh: sessionId === undefined,
            });

            if (unnamed) {
                const { body } = firstUserItem(store.db, run.id) as StreamItem;

                saveChat(store, {
                    ...requireChat(store, source.id),
                    title: body.kind === 'user' ? firstWords(body) : source.title,
                });
            }

            return { chatId: sent.chatId, runId: sent.runId };
        } finally {
            busy.delete(plan.chat.id);
        }
    };
}

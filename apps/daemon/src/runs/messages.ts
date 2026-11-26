import { messageWithFiles } from '../attachments/message';
import { toAttachment } from '../attachments/service';
import { getRunWork } from '../db/runs';
import { choiceOf, DEFAULT_CHAT_TITLE, firstWords, requireChat, saveChat } from '../domain/chats';
import { appendItem } from '../domain/items';
import { requireProject } from '../domain/projects';
import { assertChatAvailable } from '../domain/workspaces';
import { invalid, unavailable } from '../errors';
import { firstMessage } from './prompts';
import { isAtRest } from './queue';

import type { MessageSource, QueuedMessageMode, StreamItemBody, Task } from '@clowdy/protocol';
import type { AttachmentsService } from '../attachments/service';
import type { AgentRegistry } from '../engine/acp/registry';
import type { Store } from '../store';
import type { RunDriver } from './driver';
import type { ChatQueue } from './queue';
import type { RunService } from './service';

/** What a message to a chat needs: the person's `chat.send` and the threads' messages go the same way. */
export interface MessageDeps {
    store: Store;
    runs: RunService;
    driver: RunDriver;
    attachments: AttachmentsService;
    agents: AgentRegistry;
    queue: ChatQueue;
}

export interface MessageInput {
    /** What the stream's `user` item shows; trimmed. May be empty when files are attached. */
    text: string;
    /** What the agent is told instead of the text with where its files are (`messageWithFiles`), which it is told by default. */
    content?: string;
    /** Files uploaded to the chat's project. */
    attachmentIds?: readonly string[];
    /** How a message to a busy orchestrator reaches it; `queue` by default. */
    mode?: QueuedMessageMode;
    /** Who wrote it when the person did not: the stream's `user` item and the queued message carry it. */
    from?: MessageSource;
    /**
     * The message opens a session with no history behind it, though the chat's orchestrator exists already (an edit of the chat's first message cleared its
     * session): it gets the first message's prefix (`firstMessage`), as the session's first message does, since nothing else tells the agent the entry skill
     * and the mode. Only the path of an orchestrator at rest reads it: the first message of a chat has the prefix anyway, and a busy one has a session.
     */
    fresh?: boolean;
    /** For the first message of a chat: the folder its orchestrator works in and the tasks it is assigned to. A later message ignores it. */
    start?: { cwd?: string; assigned?: Task[] };
}

/** `started` when the orchestrator got the message at once (a turn began, or the first one is on its way), `queued` when it waits in the chat's queue. */
export type Delivery = 'started' | 'queued';

/** Says now, with the agent's name, that it is switched off: a run that failed on it later would only show a failed chat. */
export function requireEnabled(agents: AgentRegistry, engine: string): void {
    if (!agents.isEnabled(engine)) {
        throw unavailable(
            `${agents.nameOf(engine)} is switched off in Clowdy. Turn it on in Settings > Providers, or continue in a new chat with another provider.`
        );
    }
}

/**
 * Sends a message to a chat. The first message creates the chat's orchestrator run and names the chat after it (unless it was named). A message to a
 * finished chat starts a new turn of the same run: its stream keeps growing and its session is resumed; one to an orchestrator that waits for background
 * work goes into the session it keeps open. A message to a busy orchestrator waits in the chat's queue, as a steer of the running turn or for the next
 * turn (`mode`), and reaches the stream only when the agent gets it (`ChatQueue`). A message to an archived chat brings it back: nobody writes to a chat
 * they have put away.
 *
 * A message may carry files uploaded to the chat's project (`attachmentIds`), with no text at all. The stream shows the text and the files; the agent gets
 * the text and, after a blank line, the list of where the files are (`messageWithFiles`), unless `content` says what it gets. That one string goes down
 * every path below. Call it inside a transaction; it starts the turn once that commits.
 */
export function sendMessage(
    deps: MessageDeps,
    chatId: string,
    input: MessageInput
): { chatId: string; runId: string; delivery: Delivery } {
    const { store, runs, driver, attachments, agents, queue } = deps;
    const text = input.text.trim();
    const attachmentIds = input.attachmentIds ?? [];

    // A notice of threads that stopped has no words of its own: the stream draws it from `from`, and the agent reads `content`.
    if (!text && attachmentIds.length === 0 && input.from?.kind !== 'threadNotice') {
        throw invalid('The message is empty');
    }

    const { archivedAt: _, ...chat } = requireChat(store, chatId);
    assertChatAvailable(store, chatId);
    const project = requireProject(store, chat.projectId);
    const engine = runs.resolveEngine(project, chat.engine);

    requireEnabled(agents, engine);

    const files = attachments.claim(chat.projectId, attachmentIds);
    const content =
        input.content ??
        messageWithFiles(
            text,
            files.map(file => ({ path: attachments.pathOf(file), mediaType: file.mediaType, size: file.size }))
        );
    const attached = files.length > 0 ? files.map(toAttachment) : undefined;
    const body: StreamItemBody = {
        kind: 'user',
        text,
        ...(attached && { attachments: attached }),
        ...(input.from && { from: input.from }),
    };
    const now = Date.now();

    if (!chat.orchestratorRunId) {
        const title = chat.title === DEFAULT_CHAT_TITLE ? firstWords({ text, attachments: attached }) : chat.title;
        const run = runs.createRun({
            project,
            role: 'orchestrator',
            chatId,
            summary: title,
            engine: chat.engine,
            model: chat.model,
            effort: chat.effort,
            cwd: input.start?.cwd,
            assigned: input.start?.assigned,
            nextPrompt: firstMessage(chat.mode, content),
        });

        attachments.markSent(files, chatId, run.id);
        appendItem(store, run.id, body);
        saveChat(store, { ...chat, ...choiceOf(run), title, orchestratorRunId: run.id, updatedAt: now });
        driver.launch(run.id);

        return { chatId, runId: run.id, delivery: 'started' };
    }

    const run = runs.require(chat.orchestratorRunId);

    if (!isAtRest(run)) {
        queue.enqueue({ ...chat, updatedAt: now }, run, {
            mode: input.mode ?? 'queue',
            text,
            files,
            content,
            from: input.from,
        });

        return { chatId, runId: run.id, delivery: 'queued' };
    }

    // A paused queue stays paused: this message is its writer's own next turn, not one of those the person held back.
    attachments.markSent(files, chatId, run.id);
    appendItem(store, run.id, body);
    saveChat(store, { ...chat, updatedAt: now });
    // A turn that never reached an agent (its worktree could not be made, say) leaves what it was going to say unsent, and no session has it: it goes first, so a
    // thread told to try again still has its brief.
    const unsent = run.sessionId === undefined ? getRunWork(store.db, run.id).nextPrompt : undefined;

    runs.resume(run.id, unsent ? `${unsent}\n\n${content}` : input.fresh ? firstMessage(chat.mode, content) : content);
    driver.launch(run.id);

    return { chatId, runId: run.id, delivery: 'started' };
}

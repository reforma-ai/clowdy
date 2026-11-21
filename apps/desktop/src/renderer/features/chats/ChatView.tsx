import { Alert, AlertAction, AlertDescription, AlertIcon } from '@clowdy/components/Alert';
import { Button } from '@clowdy/components/Button';
import { ContentColumn } from '@clowdy/components/ContentColumn';
import { Loader } from '@clowdy/components/Loader';
import { Text } from '@clowdy/components/Text';
import { AttentionCircle, Split } from '@clowdy/icons/14';
import { useMemo, useRef } from 'react';

import { useAgents, useChatStream, useProjectState, useProjectUi, useRootStore } from '../../stores';
import { StreamView } from '../../stream';
import { openChat } from './archiveChat';
import { ChatDropZone } from './ChatDropZone';
import { canCompactChat, chatWritability } from './chatProvider';
import { isRunActive, liveLine, overflowed } from './chatRun';
import styles from './ChatView.module.css';
import { perform } from './commands';
import { Composer, type ComposerHandle } from './Composer';
import { chatProgress } from './progress';
import { ProgressCard } from './ProgressCard';
import { ReadOnlyNotice } from './ReadOnlyNotice';
import { RunningAgents } from './RunningAgents';
import { useCompact } from './useCompact';
import { useFork } from './useFork';

import type { Attachment, Chat } from '@clowdy/protocol';

/**
 * One chat: the orchestrator's stream with the progress card in it, and the composer. When the chat's provider cannot run
 * (switched off, not installed, signed out) the stream stays as it is and a notice stands in place of the composer. A thread is a chat like
 * any other, with a slim line over its stream that names the chat it belongs to and opens it.
 */
export function ChatView({ chat }: { chat: Chat }) {
    const root = useRootStore();
    const project = useProjectState();
    const ui = useProjectUi();
    // A task key in a message is a chip that opens the task; a thread's card opens that thread.
    const links = useMemo(() => ({
        taskOfKey: (key: string) => project.taskList.find(task => task.key === key),
        onOpenTask: (taskId: string) => ui.openTask(taskId),
        attachmentBlob: (attachment: Attachment) => root.transport.getAttachment(project.id, attachment.id),
        hasChat: (chatId: string) => project.chats.has(chatId),
        onOpenChat: (chatId: string) => void openChat(root, project, ui, chatId),
    }), [project, ui, root]);
    const parent = chat.parentChatId === undefined ? undefined : project.chats.get(chat.parentChatId);
    // A fork says where it came from. The source opens from there while it is listed: one in the archive is named only, since opening it would bring it back.
    const source = chat.forkedFrom && project.chats.get(chat.forkedFrom.chatId);
    const origin = chat.forkedFrom && { atSeq: chat.forkedFrom.atSeq, title: source?.title, onOpen: source && source.archivedAt === undefined ? () => links.onOpenChat(source.id) : undefined };
    const { fork, forking } = useFork(chat);
    const composer = useRef<ComposerHandle>(null);
    const stream = useChatStream(chat);
    const run = chat.orchestratorRunId ? project.runs.get(chat.orchestratorRunId) : undefined;
    const { agents, status: agentsStatus } = useAgents();
    const writability = chatWritability(chat, run, agents, agentsStatus);
    const progress = chatProgress(project.tasksOfChat(chat.id), project.statuses);
    const items = stream?.items ?? [];
    // The card follows the orchestrator's latest message, where the person is looking.
    const cardAfter = items.findLast(item => item.body.kind === 'assistant')?.id;
    // The conversation outgrew the model's window: the failure offers Compact, when the chat can still be written to and its agent can compact.
    const overflowAt = overflowed(run) && writability.writable && canCompactChat(chat, run, agents) ? items.findLast(item => item.body.kind === 'error')?.id : undefined;

    return (
        <ChatDropZone disabled={ !writability.writable } onFiles={ files => composer.current?.addFiles(files) }>
            { parent && <ThreadCrumb parent={ parent } onOpen={ () => links.onOpenChat(parent.id) } /> }

            { stream?.status === 'failed' && (
                <div className={ styles.center }>
                    <Alert color="danger" className={ styles.alert }>
                        <AlertIcon><AttentionCircle /></AlertIcon>
                        <AlertDescription>{ `The messages could not be loaded. ${ stream.error }` }</AlertDescription>
                        <AlertAction>
                            <Button size="sm" variant="bordered" onPress={ () => void stream.reload() }>Retry</Button>
                        </AlertAction>
                    </Alert>
                </div>
            ) }

            { stream && (stream.status === 'idle' || stream.status === 'loading') && (
                <div className={ styles.center }>
                    <Loader size="xxl" />
                    <Text color="secondary">Loading messages…</Text>
                </div>
            ) }

            { (!stream || stream.status === 'ready') && (
                <StreamView
                    items={ items }
                    active={ isRunActive(run) }
                    working={ isRunActive(run) && liveLine(run.status) }
                    links={ links }
                    // Reply quotes into the message box, and a fork is a conversation to go on in: a chat that is read only has neither.
                    messageActions={ writability.writable ? { onReply: text => composer.current?.quote(text), onFork: fork, forkingId: forking } : {} }
                    forkedFrom={ origin }
                    emptyState={ <EmptyChat /> }
                    decorate={ item => (progress && item.id === cardAfter ? <ProgressCard progress={ progress } /> : null) }
                    errorAction={ item => (item.id === overflowAt ? <CompactAction chatId={ chat.id } /> : null) }
                    // A question the orchestrator no longer waits on (stopped, interrupted) is shown but cannot be answered.
                    onAnswer={ run?.status === 'waiting_user'
                        ? async (questionId, answer) => {
                            await perform(root, { type: 'run.answer', runId: run.id, questionId, answer });
                        }
                        : undefined }
                />
            ) }

            <ContentColumn className={ styles.composer }>
                <RunningAgents chat={ chat } />
                { writability.writable
                    ? <Composer ref={ composer } chat={ chat } run={ run } />
                    : <ReadOnlyNotice chat={ chat } run={ run } message={ writability.message } /> }
            </ContentColumn>
        </ChatDropZone>
    );
}

/** The line over a thread's stream: whose thread it is, and the parent's title, which opens the parent. */
function ThreadCrumb({ parent, onOpen }: { parent: Chat; onOpen: () => void }) {
    return (
        <ContentColumn className={ styles.crumb }>
            <nav aria-label="Parent chat" className={ styles.crumbLine }>
                <Split aria-hidden className={ styles.crumbIcon } />
                <Text variant="xs" color="secondary">Thread of</Text>
                { /* Read as words; the flex gap draws the space. */ }
                { ' ' }
                <Button variant="inline" color="secondary" className={ styles.crumbLink } onPress={ onOpen }>{ parent.title }</Button>
            </nav>
        </ContentColumn>
    );
}

/** Compact on the failure of a turn whose conversation no longer fit the model's window: the next turn compacts it, and the chat goes on. */
function CompactAction({ chatId }: { chatId: string }) {
    const { compact, isPending } = useCompact(chatId);

    return <Button size="sm" variant="bordered" isPending={ isPending } onPress={ () => void compact() }>Compact</Button>;
}

function EmptyChat() {
    return (
        <div className={ styles.empty }>
            <Text variant="heading-4">What are we working on?</Text>
            <Text color="secondary">
                Describe what you want built, or ask a question. In Hands-off mode Clowdy plans and runs the work on its own; in Hands-on mode it stops to ask you at the big decisions.
            </Text>
        </div>
    );
}

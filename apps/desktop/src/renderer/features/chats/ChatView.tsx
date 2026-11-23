import { Alert, AlertAction, AlertDescription, AlertIcon } from '@clowdy/components/Alert';
import { Button } from '@clowdy/components/Button';
import { ContentColumn } from '@clowdy/components/ContentColumn';
import { Loader } from '@clowdy/components/Loader';
import { Text } from '@clowdy/components/Text';
import { AttentionCircle, Split } from '@clowdy/icons/14';
import { shownRunStatus } from '@clowdy/protocol';
import { useMemo, useRef } from 'react';

import { useAgents, useChatStream, useProjectState, useProjectUi, useRootStore } from '../../stores';
import { StreamView, type ForkAgent } from '../../stream';
import { ProviderIcon } from '../settings/providers/ProviderIcon';
import { openChat } from './archiveChat';
import { ChatControls } from './ChatControls';
import { ChatDropZone } from './ChatDropZone';
import { canCompactChat, chatWritability, handoffAgents } from './chatProvider';
import { isRunActive, liveLine, overflowed } from './chatRun';
import styles from './ChatView.module.css';
import { perform } from './commands';
import { Composer, type ComposerHandle } from './Composer';
import { GitStrip } from './GitStrip';
import { chatProgress } from './progress';
import { ProgressCard } from './ProgressCard';
import { ReadOnlyNotice } from './ReadOnlyNotice';
import { RunningAgents } from './RunningAgents';
import { swipeToReply } from './swipeReplyPreference';
import { useCompact } from './useCompact';
import { useEditMessage } from './useEditMessage';
import { useFork } from './useFork';
import { useHandoff } from './useHandoff';

import type { Attachment, Chat } from '@clowdy/protocol';
import type { ReactNode } from 'react';

/**
 * One chat: the orchestrator's stream with the progress card in it, and the composer. When the chat's provider cannot run
 * (switched off, not installed, signed out) the stream stays as it is and a notice stands in place of the composer. A thread is a chat like
 * any other, with a slim line over its stream that names the chat it belongs to and opens it. `controls` are what the line under the message box holds at its
 * start (where the chat works, read only), the line the new-chat page drew with controls that change; the composer adds the mode at the end of that line, so a chat
 * that can be written to always has the line, and a read only one has it only when the caller has `controls`.
 */
export function ChatView({ chat, controls }: { chat: Chat; controls?: ReactNode }) {
    const root = useRootStore();
    const project = useProjectState();
    const ui = useProjectUi();
    // A task key in a message is a chip that opens the task, an archived one the window knows too (`ProjectState.taskOfKey`); a thread's card opens that thread.
    const links = useMemo(() => ({
        taskOfKey: (key: string) => project.taskOfKey(key),
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
    const handOff = useHandoff(chat, run);
    const { agents, status: agentsStatus } = useAgents();
    // The agents an answer's Fork menu can hand the conversation to: the signed-in ones other than this chat's own.
    const handoffTargets = handoffAgents(agents, chat, run).map((agent): ForkAgent => ({ id: agent.id, name: agent.name, icon: <ProviderIcon agentId={ agent.id } size={ 14 } /> }));
    const writability = chatWritability(chat, run, agents, agentsStatus);
    const progress = chatProgress(project.tasksOfChat(chat.id), project.statuses);
    const items = stream?.items ?? [];
    const edit = useEditMessage({ chat, items, ready: stream?.status === 'ready', writable: writability.writable, attachmentBlob: links.attachmentBlob });
    // The card follows the orchestrator's latest message, where the person is looking.
    const cardAfter = items.findLast(item => item.body.kind === 'assistant')?.id;
    // The conversation outgrew the model's window: the failure offers Compact, when the chat can still be written to and its agent can compact.
    const overflowAt = overflowed(run) && writability.writable && canCompactChat(chat, run, agents) ? items.findLast(item => item.body.kind === 'error')?.id : undefined;

    return (
        <ChatDropZone disabled={ !writability.writable } onFiles={ files => composer.current?.addFiles(files) } onPasteFiles={ files => composer.current?.pasteFiles(files) }>
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
                    <Loader size="xs" />
                    <Text color="secondary">Loading messages…</Text>
                </div>
            ) }

            { (!stream || stream.status === 'ready') && (
                <StreamView
                    items={ items }
                    active={ isRunActive(run) }
                    working={ isRunActive(run) && liveLine(shownRunStatus(run)) }
                    links={ links }
                    // Reply puts a message in the message box as a card, or quotes selected words into the draft; a fork is a conversation to go on in, and an edit sends the
                    // message again: a chat that is read only has none of them. The chat is rewritten from a message only at rest, so while the agent works Edit is not drawn.
                    messageActions={ writability.writable
                        ? {
                            onReply: message => composer.current?.reply(message),
                            onQuote: text => composer.current?.quote(text),
                            swipeToReply: swipeToReply.enabled,
                            onFork: fork,
                            forkingId: forking,
                            onHandoff: (itemId, engine) => void handOff({ itemId, engine }),
                            handoffAgents: handoffTargets,
                            onEdit: edit.begin,
                            editBusy: isRunActive(run),
                        }
                        : {} }
                    editing={ edit.session && writability.writable
                        ? {
                            itemId: edit.session.itemId,
                            onCancel: edit.cancel,
                            editor: <Composer chat={ chat } run={ run } editMode={ { draftKey: edit.session.draftKey, onSubmit: edit.submit, onCancel: edit.cancel, isPending: edit.pending } } />,
                        }
                        : undefined }
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
                    // A request for permission is decided while its own item is open, whatever the run is doing, so the card gates itself and the handler only needs a run to name.
                    onDecide={ run
                        ? async (approvalId, decision) => {
                            await perform(root, { type: 'run.decide', runId: run.id, approvalId, decision });
                        }
                        : undefined }
                />
            ) }

            <ContentColumn className={ styles.composer }>
                <RunningAgents chat={ chat } />
                { /* Under the work in progress and over the message box, for a chat that is read only too: the pull request of the branch and how far it is from its base. */ }
                <GitStrip chat={ chat } run={ run } />
                { /* The composer draws the line under its box itself, with the mode at the end of it; a chat that is read only has no mode to show. */ }
                { writability.writable
                    ? <Composer ref={ composer } chat={ chat } run={ run } controls={ controls } />
                    : (
                        <>
                            <ReadOnlyNotice chat={ chat } run={ run } message={ writability.message } />

                            { controls && <ChatControls>{ controls }</ChatControls> }
                        </>
                    ) }
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

import { Alert, AlertAction, AlertDescription, AlertIcon } from '@clowdy/components/Alert';
import { Button } from '@clowdy/components/Button';
import { Spinner } from '@clowdy/components/Spinner';
import { Text } from '@clowdy/components/Text';
import { AttentionCircle } from '@clowdy/icons/14';
import { useMemo, useRef } from 'react';

import { useAgents, useChatStream, useProjectState, useProjectUi, useRootStore } from '../../stores';
import { StreamView } from '../../stream';
import { ChatDropZone } from './ChatDropZone';
import { chatWritability } from './chatProvider';
import { isRunActive, liveLine } from './chatRun';
import styles from './ChatView.module.css';
import { perform } from './commands';
import { Composer, type ComposerHandle } from './Composer';
import { chatProgress } from './progress';
import { ProgressCard } from './ProgressCard';
import { ReadOnlyNotice } from './ReadOnlyNotice';

import type { Attachment, Chat } from '@clowdy/protocol';

/**
 * One chat: the orchestrator's stream with the progress card in it, and the composer. When the chat's provider cannot run
 * (switched off, not installed, signed out) the stream stays as it is and a notice stands in place of the composer.
 */
export function ChatView({ chat }: { chat: Chat }) {
    const root = useRootStore();
    const project = useProjectState();
    const ui = useProjectUi();
    // A task key in a message is a chip that opens the task.
    const links = useMemo(() => ({
        taskOfKey: (key: string) => project.taskList.find(task => task.key === key),
        onOpenTask: (taskId: string) => ui.openTask(taskId),
        attachmentBlob: (attachment: Attachment) => root.transport.getAttachment(project.id, attachment.id),
    }), [project, ui, root]);
    const composer = useRef<ComposerHandle>(null);
    const stream = useChatStream(chat);
    const run = chat.orchestratorRunId ? project.runs.get(chat.orchestratorRunId) : undefined;
    const { agents, status: agentsStatus } = useAgents();
    const writability = chatWritability(chat, run, agents, agentsStatus);
    const progress = chatProgress(project.tasksOfChat(chat.id), project.statuses);
    const items = stream?.items ?? [];
    // The card follows the orchestrator's latest message, where the person is looking.
    const cardAfter = items.findLast(item => item.body.kind === 'assistant')?.id;

    return (
        <ChatDropZone disabled={ !writability.writable } onFiles={ files => composer.current?.addFiles(files) }>
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
                    <Spinner size="md" />
                    <Text color="secondary">Loading messages…</Text>
                </div>
            ) }

            { (!stream || stream.status === 'ready') && (
                <StreamView
                    items={ items }
                    active={ isRunActive(run) }
                    working={ isRunActive(run) && liveLine(run.status) }
                    links={ links }
                    emptyState={ <EmptyChat /> }
                    decorate={ item => (progress && item.id === cardAfter ? <ProgressCard progress={ progress } /> : null) }
                    // A question the orchestrator no longer waits on (stopped, interrupted) is shown but cannot be answered.
                    onAnswer={ run?.status === 'waiting_user'
                        ? async (questionId, answer) => {
                            await perform(root, { type: 'run.answer', runId: run.id, questionId, answer });
                        }
                        : undefined }
                />
            ) }

            <div className={ styles.composer }>
                { writability.writable
                    ? <Composer ref={ composer } chat={ chat } run={ run } />
                    : <ReadOnlyNotice chat={ chat } run={ run } message={ writability.message } /> }
            </div>
        </ChatDropZone>
    );
}

function EmptyChat() {
    return (
        <div className={ styles.empty }>
            <Text variant="heading-4">What are we working on?</Text>
            <Text color="secondary">
                Describe what you want built, or ask a question. Autopilot plans and runs the work on its own; Semi-manual stops to ask you at the big decisions.
            </Text>
        </div>
    );
}

import { Alert, AlertAction, AlertDescription, AlertIcon } from '@clowdy/components/Alert';
import { Button } from '@clowdy/components/Button';
import { Spinner } from '@clowdy/components/Spinner';
import { Text } from '@clowdy/components/Text';
import { AttentionCircle } from '@clowdy/icons/14';

import { useChatStream, useProjectState, useRootStore } from '../../stores';
import { StreamView } from '../../stream';
import { ChatHeader } from './ChatHeader';
import { isRunActive, liveLine } from './chatRun';
import styles from './ChatView.module.css';
import { perform } from './commands';
import { Composer } from './Composer';
import { chatProgress } from './progress';
import { ProgressCard } from './ProgressCard';

import type { Chat } from '@clowdy/protocol';

/** One chat: the header, the orchestrator's stream with the progress card in it, and the composer. */
export function ChatView({ chat }: { chat: Chat }) {
    const root = useRootStore();
    const project = useProjectState();
    const stream = useChatStream(chat);
    const run = chat.orchestratorRunId ? project.runs.get(chat.orchestratorRunId) : undefined;
    const progress = chatProgress(project.tasksOfChat(chat.id), project.statuses);
    const items = stream?.items ?? [];
    // The card follows the orchestrator's latest message, where the person is looking.
    const cardAfter = items.findLast(item => item.body.kind === 'assistant')?.id;

    return (
        <>
            <ChatHeader chat={ chat } run={ run } />

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
                    agentName="Orchestrator"
                    working={ isRunActive(run) && liveLine(run.status) }
                    emptyState={ <EmptyChat /> }
                    decorate={ item => (progress && item.id === cardAfter ? <ProgressCard progress={ progress } /> : null) }
                    onAnswer={ async (questionId, answer) => {
                        if (run) await perform(root, { type: 'run.answer', runId: run.id, questionId, answer });
                    } }
                />
            ) }

            <div className={ styles.composer }>
                <Composer chat={ chat } modeLocked={ isRunActive(run) } />
            </div>
        </>
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

import { Alert, AlertAction, AlertDescription, AlertIcon } from '@clowdy/components/Alert';
import { Button } from '@clowdy/components/Button';
import { Spinner } from '@clowdy/components/Spinner';
import { Text } from '@clowdy/components/Text';
import { toast } from '@clowdy/components/Toast';
import { AttentionCircle } from '@clowdy/icons/14';
import { StopBold } from '@clowdy/icons/16';
import { isTerminalRunStatus, type Run, type RunRole } from '@clowdy/protocol';
import { useState } from 'react';

import { AgentChip, RunStatusPill, TaskChip } from '../../shared';
import { useProjectState, useRootStore, useRunStream } from '../../stores';
import { AgentAvatar, StreamView } from '../../stream';
import styles from './RunDetail.module.css';

const ROLE_LABEL: Record<RunRole, string> = {
    orchestrator: 'Orchestrator',
    executor: 'Executor',
    verifier: 'Verifier',
};

/** The right side: who the selected run is, what it is linked to, and its stream. Nothing to type here. */
export function RunDetail({ run }: { run: Run }) {
    const project = useProjectState();
    const parent = run.parentRunId ? project.runs.get(run.parentRunId) : undefined;

    return (
        <section className={ styles.detail } aria-label={ run.name }>
            <RunHeader run={ run } parent={ parent } />
            <RunStream run={ run } parent={ parent } />
            <footer className={ styles.footer }>
                <Text variant="sm" color="secondary">Viewing agent work</Text>
            </footer>
        </section>
    );
}

function RunHeader({ run, parent }: { run: Run; parent: Run | undefined }) {
    const project = useProjectState();
    const root = useRootStore();
    const [isStopping, setIsStopping] = useState(false);
    const tasks = project.tasksOfRun(run.id);
    // A failed run's error is in its stream.
    const reason = run.status === 'failed' ? undefined : run.statusReason;

    const stop = async () => {
        setIsStopping(true);

        const result = await root.command({ type: 'run.cancel', runId: run.id });

        setIsStopping(false);

        if (!result.ok) toast.error({ message: `Could not stop ${ run.name }: ${ result.error.message }` });
    };

    return (
        <header className={ styles.header }>
            <div className={ styles.titleLine }>
                <AgentAvatar role={ run.role } size="md" />
                <div className={ styles.heading }>
                    <div className={ styles.nameLine }>
                        <Text variant="heading-5" truncate>{ run.name }</Text>
                        <RunStatusPill status={ run.status } reason={ run.statusReason } />
                    </div>
                    <Text color="secondary" truncate>{ run.summary ? `${ ROLE_LABEL[run.role] } · ${ run.summary }` : ROLE_LABEL[run.role] }</Text>
                </div>
                { !isTerminalRunStatus(run.status) && (run.origin === 'native'
                    // A sub-agent lives inside its parent's session: the daemon refuses to stop it alone.
                    ? <Text variant="sm" color="secondary">{ `Runs inside ${ parent?.name ?? 'its parent run' }` }</Text>
                    : (
                        <Button variant="bordered" size="sm" isPending={ isStopping } onPress={ () => void stop() }>
                            <StopBold aria-hidden />
                            Stop
                        </Button>
                    )) }
            </div>

            { reason && <Text variant="sm" color="secondary">{ reason }</Text> }

            { (tasks.length > 0 || run.parentRunId) && (
                <div className={ styles.links }>
                    { tasks.length > 0 && (
                        <div className={ styles.group }>
                            <Text variant="sm" color="secondary">{ tasks.length === 1 ? 'Task' : 'Tasks' }</Text>
                            { tasks.map(task => <TaskChip key={ task.id } task={ task } />) }
                        </div>
                    ) }
                    { run.parentRunId && (
                        <div className={ styles.group }>
                            <Text variant="sm" color="secondary">Parent</Text>
                            { parent ? <AgentChip run={ parent } /> : <Text variant="sm" color="secondary">not available</Text> }
                        </div>
                    ) }
                </div>
            ) }
        </header>
    );
}

function RunStream({ run, parent }: { run: Run; parent: Run | undefined }) {
    const root = useRootStore();
    const stream = useRunStream(run.id);

    if (!stream || stream.status === 'idle' || (stream.status === 'loading' && stream.items.length === 0)) {
        return (
            <div className={ styles.center }>
                <Spinner size="md" />
                <Text color="secondary">Loading the stream…</Text>
            </div>
        );
    }

    if (stream.status === 'failed' && stream.items.length === 0) {
        return (
            <div className={ styles.center }>
                <Alert color="danger" className={ styles.failure }>
                    <AlertIcon><AttentionCircle /></AlertIcon>
                    <AlertDescription>{ `Could not load what ${ run.name } did. ${ stream.error }` }</AlertDescription>
                    <AlertAction><Button size="sm" variant="bordered" onPress={ () => void stream.reload() }>Retry</Button></AlertAction>
                </Alert>
            </div>
        );
    }

    const answer = async (questionId: string, text: string) => {
        const result = await root.command({ type: 'run.answer', runId: run.id, questionId, answer: text });

        if (!result.ok) toast.error({ message: `Could not send the answer: ${ result.error.message }` });
    };

    return (
        <StreamView
            items={ stream.items }
            agentName={ run.name }
            avatar={ <AgentAvatar role={ run.role } /> }
            // A sub-agent's first message is its assignment, from the run that started it.
            sender={ run.parentRunId ? { name: parent?.name ?? 'Parent run', avatar: <AgentAvatar role={parent?.role ?? 'orchestrator'} /> } : undefined }
            working={ run.status === 'running' || (run.status === 'waiting_children' && 'Waiting for sub-agents…') }
            onAnswer={ run.status === 'waiting_user' ? answer : undefined }
            emptyState={ <Text color="secondary">This run has not written anything yet.</Text> }
        />
    );
}

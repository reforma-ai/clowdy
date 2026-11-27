import { Shimmer } from '@clowdy/components/Shimmer';
import { Text } from '@clowdy/components/Text';
import { Robot2, Terminal } from '@clowdy/icons/14';
import { shownRunStatus } from '@clowdy/protocol';
import { useEffect, useState } from 'react';

import { formatDuration } from '../../shared';
import { useProjectState, useProjectUi, useRootStore, useRunStream } from '../../stores';
import { ChatIcon } from '../agents/ChatIcon';
import { openChat } from './archiveChat';
import { ComposerBanner, ComposerBannerHeader, ComposerBannerStatus } from './ComposerBanner';
import styles from './ComposerBanner.module.css';
import { perform } from './commands';
import {
    agentRowLabel,
    backgroundItemText,
    canStopAlone,
    drawnRows,
    openBackground,
    runningAgents,
    type StripRow,
    stripRows,
    type ThreadAtWork,
    threadsAtWork,
    unlistedBackground,
} from './runningAgentRows';

import type { BackgroundItem, Chat, ChatId, Run, RunId } from '@clowdy/protocol';

function elapsedSince(startedAt: number | undefined, now: number): string | undefined {
    if (startedAt === undefined || !Number.isFinite(startedAt) || startedAt > now) return undefined;

    return formatDuration(Math.floor((now - startedAt) / 1000) * 1000);
}

function AgentRow({ run, now }: { run: Run; now: number }) {
    const root = useRootStore();
    const ui = useProjectUi();
    const stream = useRunStream(run.origin === 'native' ? run.id : undefined);
    const waiting = shownRunStatus(run) === 'waiting_user';
    const metrics: string[] = [];

    // Native runs are created for one invocation, so their first start is also the current start.
    const elapsed = elapsedSince(run.origin === 'native' ? run.startedAt : run.activeSince, now);
    if (elapsed) metrics.push(elapsed);
    if (stream?.status === 'ready') {
        const calls = stream.items.filter(item => item.body.kind === 'tool').length;
        if (calls > 0) metrics.push(`${calls} ${calls === 1 ? 'call' : 'calls'}`);
    }
    const detail = waiting ? 'Waiting for you' : undefined;
    const progress = metrics.join(', ');
    const name = agentRowLabel(run);
    const stoppable = canStopAlone(run);

    return (
        <ComposerBannerStatus
            icon={<Robot2 />}
            detail={detail}
            progress={progress}
            action={stoppable ? 'Stop' : undefined}
            onAction={stoppable ? () => void perform(root, { type: 'run.cancel', runId: run.id }) : undefined}
            onPress={() => ui.openRun(run.id)}
            pressLabel={`Open ${name}${detail ? `. ${detail}` : ''}${progress ? `. ${progress}` : ''}`}
        >
            {name}
        </ComposerBannerStatus>
    );
}

function threadStatus(run: Run): string | undefined {
    switch (shownRunStatus(run)) {
        case 'waiting_user':
            return 'Waiting for you';
        case 'waiting_background':
            return 'Waiting for background work';
        case 'queued':
            return 'Waiting for a free slot';
        case 'blocked':
            return run.statusReason ? `Blocked: ${run.statusReason}` : 'Blocked';
        default:
            return undefined;
    }
}

function ThreadRow({ chat, run, now }: ThreadAtWork & { now: number }) {
    const root = useRootStore();
    const project = useProjectState();
    const ui = useProjectUi();
    const detail = threadStatus(run);
    const stream = useRunStream(run.id);
    const calls =
        stream?.status === 'ready' ? stream.items.filter(item => item.body.kind === 'tool').length : undefined;
    const progress = [
        elapsedSince(run.activeSince, now),
        calls === undefined ? undefined : `${calls} ${calls === 1 ? 'call' : 'calls'} total`,
    ]
        .filter(Boolean)
        .join(', ');

    return (
        <ComposerBannerStatus
            // The thread's own mark, the provider's, as the chat list draws it; the strip says its state in words.
            icon={<ChatIcon chat={chat} run={run} showStatus={false} />}
            progress={progress}
            detail={detail}
            action="Stop"
            onAction={() => void perform(root, { type: 'run.cancel', runId: run.id })}
            onPress={() => void openChat(root, project, ui, chat.id)}
            pressLabel={`Open ${chat.title}${detail ? `. ${detail}` : ''}${progress ? `. ${progress}` : ''}`}
        >
            {chat.title}
        </ComposerBannerStatus>
    );
}

function AgentsHeader({ chatId, count }: { chatId: ChatId; count: number }) {
    const ui = useProjectUi();

    return (
        <ComposerBannerHeader
            expanded={!ui.agentsFolded(chatId)}
            onPress={() => ui.toggleAgentsFolded(chatId)}
            summary={
                <Text variant="xs" color="secondary">
                    {count} running
                </Text>
            }
        >
            Agents
        </ComposerBannerHeader>
    );
}

/**
 * A background command or task. Stop is offered only when the agent can cancel the item alone; it leaves the run and other work going.
 */
function BackgroundItemRow({ runId, item }: { runId: RunId; item: BackgroundItem }) {
    const root = useRootStore();
    const title = backgroundItemText(item);
    const stoppable = item.kind !== 'subagent' && item.canStopAlone === true;

    return (
        <ComposerBannerStatus
            icon={<Terminal />}
            action={stoppable ? 'Stop' : undefined}
            actionLabel={stoppable ? `Stop ${title.charAt(0).toLowerCase()}${title.slice(1)}` : undefined}
            onAction={
                stoppable ? () => void perform(root, { type: 'run.stopBackground', runId, itemId: item.id }) : undefined
            }
        >
            <Shimmer duration={1}>{title}</Shimmer>
        </ComposerBannerStatus>
    );
}

function Row({ row, now }: { row: StripRow; now: number }) {
    return row.kind === 'agent' ? (
        <AgentRow run={row.run} now={now} />
    ) : (
        <ThreadRow chat={row.chat} run={row.run} now={now} />
    );
}

/**
 * The work of the chat that goes on now, one row each above the message box (Reforma's `ChatComposerSubagents`): under the "Agents" header
 * the native sub-agents of the orchestrator and the threads of the chat that work, oldest
 * first, each with its name and available progress (a sub-agent's row opens its run, a thread's row opens the thread's chat; Stop ends that one alone), then
 * a row for each background command or task (its Stop, when available, ends that item only). A sub-agent with a child run is shown only under Agents. Nothing while there is
 * none of these. Agents and stoppable background work have independent disclosures.
 */
export function RunningAgents({ chat }: { chat: Chat }) {
    const project = useProjectState();
    const ui = useProjectUi();
    const [now, setNow] = useState(Date.now);
    const [commandsExpanded, setCommandsExpanded] = useState(false);
    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, []);
    const agents = runningAgents(project.runs.values(), chat.orchestratorRunId);
    const threads = threadsAtWork(project.threadsOf(chat.id), project.runs);
    const rows = stripRows(agents, threads);
    const orchestrator = chat.orchestratorRunId === undefined ? undefined : project.runs.get(chat.orchestratorRunId);
    // A sub-agent with a child run is shown above and is not counted again here.
    const background = unlistedBackground(openBackground(orchestrator), agents);
    const folded = ui.agentsFolded(chat.id) && rows.length > 0;
    // A fold hides what goes on, not what waits for the person.
    const drawn = drawnRows(rows, folded);

    if (rows.length === 0 && background.length === 0) return null;

    return (
        <ComposerBanner role="group" aria-label="Work in progress">
            {rows.length > 0 && <AgentsHeader chatId={chat.id} count={rows.length} />}
            {drawn.length > 0 && (
                <div className={styles.agentRows}>
                    {drawn.map(row => (
                        <Row key={row.id} row={row} now={now} />
                    ))}
                </div>
            )}
            {background.length > 0 && orchestrator && (
                <>
                    <ComposerBannerHeader
                        expanded={commandsExpanded}
                        onPress={() => setCommandsExpanded(open => !open)}
                        summary={
                            <Text
                                variant="xs"
                                color="secondary"
                            >{`${new Set(background.map(item => item.id)).size} running`}</Text>
                        }
                    >
                        Background work
                    </ComposerBannerHeader>
                    {commandsExpanded && (
                        <div className={styles.agentRows}>
                            {background.map(item => (
                                <BackgroundItemRow key={item.id} runId={orchestrator.id} item={item} />
                            ))}
                        </div>
                    )}
                </>
            )}
        </ComposerBanner>
    );
}

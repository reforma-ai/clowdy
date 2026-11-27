import { BoltBordered, Edit } from '@clowdy/icons/12';
import { Robot } from '@clowdy/icons/14';
import { shownRunStatus } from '@clowdy/protocol';

import { RUN_STATUS_VIEW, StatusDot } from '../../shared';
import { AgentMark } from './AgentMark';
import { chatDotTone, type ThreadsActivity } from './agentTree';
import styles from './ChatIcon.module.css';

import type { Chat, Run } from '@clowdy/protocol';

/**
 * The provider's mark once the chat has started, or a speech bubble. The status goes on the icon unless the row shows it separately.
 */
export function ChatIcon({
    chat,
    run,
    threads,
    showStatus = true,
    unread = false,
}: {
    chat: Chat;
    run: Run | undefined;
    threads?: ThreadsActivity;
    showStatus?: boolean;
    unread?: boolean;
}) {
    const icon = <AgentMark engine={chat.orchestratorRunId ? (chat.engine ?? run?.engine) : undefined} />;
    if (!showStatus || !chatDotTone(run, threads, false, unread)) return icon;

    return (
        <span className={styles.icon}>
            {icon}
            <ChatStatus run={run} threads={threads} unread={unread} className={styles.dot} />
        </span>
    );
}

export function ChatStatus({
    run,
    threads,
    className,
    draft = false,
    unread = false,
    agentsInside,
}: {
    run: Run | undefined;
    threads?: ThreadsActivity;
    /** How many agents work inside the chat, for the icon's label when `threads` says some do (`agentsWorkingInside`). */
    agentsInside?: number;
    className?: string;
    draft?: boolean;
    unread?: boolean;
}) {
    const tone = chatDotTone(run, threads, draft, unread);

    if (!tone) return null;

    // An agent working inside is told by its icon alone, in the place of the working dot and of a command's icon of the chat itself: two marks for what works would say
    // it twice. What the chat needs from the person (a failure, a question, a request) has its own dot, which is the tone here and keeps its place.
    const showAgents = threads === 'working' && tone === 'success';
    // A thread's question takes priority over a completed or working run.
    const own =
        run !== undefined && chatDotTone(run, undefined, false, unread) === tone && threads !== 'asking'
            ? run
            : undefined;
    const ownStatus = own && shownRunStatus(own);
    const showDraft = draft && tone === 'neutral' && ownStatus === undefined;
    const showBackground = ownStatus === 'waiting_background';
    const label = showAgents
        ? agentsInside
            ? `${agentsInside} ${agentsInside === 1 ? 'agent works' : 'agents work'} inside`
            : 'Agents work inside'
        : showBackground
          ? 'Waiting for background work'
          : ownStatus
            ? RUN_STATUS_VIEW[ownStatus].label
            : showDraft
              ? 'Unsent draft'
              : 'A thread is waiting for you';

    return (
        <span className={className} role="img" aria-label={label}>
            {showAgents ? (
                <Robot className={styles.agents} aria-hidden />
            ) : showDraft ? (
                <Edit className={styles.draft} aria-hidden />
            ) : showBackground ? (
                <BoltBordered className={styles.command} aria-hidden />
            ) : (
                <StatusDot status={ownStatus} tone={tone} />
            )}
        </span>
    );
}

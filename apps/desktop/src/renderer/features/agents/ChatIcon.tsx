import { Message } from '@clowdy/icons/14';
import { shownRunStatus } from '@clowdy/protocol';

import { RUN_STATUS_VIEW, StatusDot } from '../../shared';
import { ProviderIcon } from '../settings/providers/ProviderIcon';
import { PROVIDER_IDS } from '../settings/providers/providerView';
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
}: {
    chat: Chat;
    run: Run | undefined;
    threads?: ThreadsActivity;
    showStatus?: boolean;
}) {
    const engine = chat.engine ?? run?.engine;
    const icon =
        chat.orchestratorRunId && engine && (PROVIDER_IDS as readonly string[]).includes(engine) ? (
            <ProviderIcon agentId={engine} size={14} data-provider={engine} />
        ) : (
            <Message />
        );
    if (!showStatus || !chatDotTone(run, threads)) return icon;

    return (
        <span className={styles.icon}>
            {icon}
            <ChatStatus run={run} threads={threads} className={styles.dot} />
        </span>
    );
}

export function ChatStatus({
    run,
    threads,
    className,
}: {
    run: Run | undefined;
    threads?: ThreadsActivity;
    className?: string;
}) {
    const tone = chatDotTone(run, threads);

    if (!tone) return null;

    // The run's own state wins, unless a thread's wait for the person takes the dot over; only a chat whose run says nothing shows its threads.
    const own = run !== undefined && chatDotTone(run) === tone ? run : undefined;
    const ownStatus = own && shownRunStatus(own);
    const label = ownStatus
        ? RUN_STATUS_VIEW[ownStatus].label
        : threads === 'asking'
          ? 'A thread is waiting for you'
          : 'Threads working';

    return (
        <span className={className} role="img" aria-label={label}>
            <StatusDot status={ownStatus} tone={tone} />
        </span>
    );
}

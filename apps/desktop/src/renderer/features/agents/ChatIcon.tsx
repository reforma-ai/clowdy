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
    draft = false,
}: {
    run: Run | undefined;
    threads?: ThreadsActivity;
    className?: string;
    draft?: boolean;
}) {
    const tone = chatDotTone(run, threads, draft);

    if (!tone) return null;

    // A thread's question takes priority over a completed or working run.
    const own = run !== undefined && chatDotTone(run) === tone && threads !== 'asking' ? run : undefined;
    const ownStatus = own && shownRunStatus(own);
    const label = ownStatus
        ? RUN_STATUS_VIEW[ownStatus].label
        : draft && tone === 'neutral'
          ? 'Unsent draft'
          : threads === 'asking'
            ? 'A thread is waiting for you'
            : 'Threads working';

    return (
        <span className={className} role="img" aria-label={label}>
            <StatusDot status={ownStatus} tone={tone} />
        </span>
    );
}

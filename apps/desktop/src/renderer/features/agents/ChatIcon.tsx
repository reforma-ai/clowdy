import { Message } from '@clowdy/icons/14';
import { shownRunStatus } from '@clowdy/protocol';

import { RUN_STATUS_VIEW, StatusDot } from '../../shared';
import { ProviderIcon } from '../settings/providers/ProviderIcon';
import { PROVIDER_IDS } from '../settings/providers/providerView';
import { chatDotTone, type ThreadsActivity } from './agentTree';
import styles from './ChatIcon.module.css';

import type { Chat, Run } from '@clowdy/protocol';

/**
 * The icon of a chat's row, in the list and in the archive: the mark of the provider it runs on once it has started (the chat's own, else its
 * orchestrator's), a speech bubble before and for an agent that has no mark. What the orchestrator is doing is a dot on the icon's top right
 * corner (`chatDotTone`), so the row needs no room of its own for it. A chat at rest whose own threads work (`threads` `working`) has the green
 * dot without the pulse: the work is in its threads, not in it. A thread below it that waits for the person (`asking`) gives it the blue one.
 */
export function ChatIcon({ chat, run, threads }: { chat: Chat; run: Run | undefined; threads?: ThreadsActivity }) {
    const engine = chat.engine ?? run?.engine;
    const icon = chat.orchestratorRunId && engine && (PROVIDER_IDS as readonly string[]).includes(engine) ? <ProviderIcon agentId={ engine } size={ 14 } data-provider={ engine } /> : <Message />;
    const tone = chatDotTone(run, threads);
    // The run's own state wins, unless a thread's wait for the person takes the dot over; only a chat whose run says nothing shows its threads.
    const own = run !== undefined && chatDotTone(run) === tone ? run : undefined;
    const ownStatus = own && shownRunStatus(own);
    const label = ownStatus ? RUN_STATUS_VIEW[ownStatus].label : threads === 'asking' ? 'A thread is waiting for you' : 'Threads working';

    if (!tone) return icon;

    return (
        <span className={ styles.icon }>
            { icon }
            <span className={ styles.dot } role="img" aria-label={ label }>
                <StatusDot status={ ownStatus } tone={ tone } className={ styles.dotMark } />
            </span>
        </span>
    );
}

import { Message } from '@clowdy/icons/14';
import { shownRunStatus } from '@clowdy/protocol';

import { RUN_STATUS_VIEW, StatusDot } from '../../shared';
import { ProviderIcon } from '../settings/providers/ProviderIcon';
import { PROVIDER_IDS } from '../settings/providers/providerView';
import { chatDotTone } from './agentTree';
import styles from './ChatIcon.module.css';

import type { Chat, Run } from '@clowdy/protocol';

/**
 * The icon of a chat's row, in the list and in the archive: the mark of the provider it runs on once it has started (the chat's own, else its
 * orchestrator's), a speech bubble before and for an agent that has no mark. What the orchestrator is doing is a dot on the icon's top right
 * corner (`chatDotTone`), so the row needs no room of its own for it. A chat at rest whose own threads work (`threadsWorking`) has the green
 * dot without the pulse: the work is in its threads, not in it.
 */
export function ChatIcon({ chat, run, threadsWorking = false }: { chat: Chat; run: Run | undefined; threadsWorking?: boolean }) {
    const engine = chat.engine ?? run?.engine;
    const icon = chat.orchestratorRunId && engine && (PROVIDER_IDS as readonly string[]).includes(engine) ? <ProviderIcon agentId={ engine } size={ 14 } data-provider={ engine } /> : <Message />;
    const tone = chatDotTone(run, threadsWorking);
    // The run's own state wins; only a chat whose run says nothing shows its threads.
    const own = run !== undefined && chatDotTone(run) !== undefined ? run : undefined;
    const ownStatus = own && shownRunStatus(own);

    if (!tone) return icon;

    return (
        <span className={ styles.icon }>
            { icon }
            <span className={ styles.dot } role="img" aria-label={ ownStatus ? RUN_STATUS_VIEW[ownStatus].label : 'Threads working' }>
                <StatusDot status={ ownStatus } tone={ tone } className={ styles.dotMark } />
            </span>
        </span>
    );
}

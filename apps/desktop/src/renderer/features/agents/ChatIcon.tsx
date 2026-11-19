import { Message } from '@clowdy/icons/14';

import { RUN_STATUS_VIEW, StatusDot } from '../../shared';
import { ProviderIcon } from '../settings/providers/ProviderIcon';
import { PROVIDER_IDS } from '../settings/providers/providerView';
import { chatDotTone } from './agentTree';
import styles from './ChatIcon.module.css';

import type { Chat, Run } from '@clowdy/protocol';

/**
 * The icon of a chat's row, in the list and in the archive: the mark of the provider it runs on once it has started (the chat's own, else its
 * orchestrator's), a speech bubble before and for an agent that has no mark. What the orchestrator is doing is a dot on the icon's top right
 * corner (`chatDotTone`), so the row needs no room of its own for it.
 */
export function ChatIcon({ chat, run }: { chat: Chat; run: Run | undefined }) {
    const engine = chat.engine ?? run?.engine;
    const icon = chat.orchestratorRunId && engine && (PROVIDER_IDS as readonly string[]).includes(engine) ? <ProviderIcon agentId={ engine } size={ 14 } data-provider={ engine } /> : <Message />;
    const tone = chatDotTone(run);

    if (!run || !tone) return icon;

    return (
        <span className={ styles.icon }>
            { icon }
            <span className={ styles.dot } role="img" aria-label={ RUN_STATUS_VIEW[run.status].label }>
                <StatusDot status={ run.status } tone={ tone } className={ styles.dotMark } />
            </span>
        </span>
    );
}

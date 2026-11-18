import { PanelHeader } from '@clowdy/components/Panel';

import { RunStatusPill } from '../../shared';
import styles from './ChatHeader.module.css';

import type { Chat, Run } from '@clowdy/protocol';

export interface ChatHeaderProps {
    chat: Chat;
    /** The chat's orchestrator, once the first message started one. */
    run: Run | undefined;
}

/** The chat's title and what its orchestrator is doing, in the same header bar as the panels beside it. Stopping it is the composer's send button. */
export function ChatHeader({ chat, run }: ChatHeaderProps) {
    return (
        <PanelHeader>
            <span className={ styles.heading }>
                <span className={ styles.title }>{ chat.title }</span>
                { run && <RunStatusPill status={ run.status } reason={ run.statusReason } /> }
            </span>
        </PanelHeader>
    );
}

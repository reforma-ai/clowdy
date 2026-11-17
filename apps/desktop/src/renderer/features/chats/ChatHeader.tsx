import { Button } from '@clowdy/components/Button';
import { PanelHeader } from '@clowdy/components/Panel';
import { StopBold } from '@clowdy/icons/16';
import { useState } from 'react';

import { RunStatusPill } from '../../shared';
import { useRootStore } from '../../stores';
import styles from './ChatHeader.module.css';
import { isRunActive } from './chatRun';
import { perform } from './commands';

import type { Chat, Run } from '@clowdy/protocol';

export interface ChatHeaderProps {
    chat: Chat;
    /** The chat's orchestrator, once the first message started one. */
    run: Run | undefined;
}

/** The chat's title, what its orchestrator is doing, and Stop while it does it, in the same header bar as the panels beside it. */
export function ChatHeader({ chat, run }: ChatHeaderProps) {
    const root = useRootStore();
    const [isStopping, setIsStopping] = useState(false);

    const stop = async () => {
        if (!run) return;

        setIsStopping(true);
        await perform(root, { type: 'run.cancel', runId: run.id });
        setIsStopping(false);
    };

    return (
        <PanelHeader>
            <span className={ styles.heading }>
                <span className={ styles.title }>{ chat.title }</span>
                { run && <RunStatusPill status={ run.status } reason={ run.statusReason } /> }
            </span>
            { isRunActive(run) && (
                <PanelHeader.Actions>
                    <Button variant="bordered" size="sm" isPending={ isStopping } onPress={ () => void stop() }>
                        <StopBold size={ 14 } />
                        Stop
                    </Button>
                </PanelHeader.Actions>
            ) }
        </PanelHeader>
    );
}

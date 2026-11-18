import { Button } from '@clowdy/components/Button';
import { Text } from '@clowdy/components/Text';
import { Info } from '@clowdy/icons/14';
import { useEffect, useRef, useState } from 'react';

import { useProjectUi, useRootStore } from '../../stores';
import { isRunActive } from './chatRun';
import { perform } from './commands';
import { startHandoff } from './handoff';
import styles from './ReadOnlyNotice.module.css';

import type { Chat, Run } from '@clowdy/protocol';

export interface ReadOnlyNoticeProps {
    chat: Chat;
    run: Run | undefined;
    /** What is wrong, from `chatWritability`: `Claude Code is turned off in Clowdy`. */
    message: string;
}

/**
 * Stands where the message box would be in a chat whose provider cannot run. It says what is wrong and that the conversation stays
 * readable, and offers the ways on: continue the work in a new chat (the conversation goes along as a file), or fix the provider in
 * Settings. The message box has the Stop button, so while the orchestrator still works the notice carries one too.
 */
export function ReadOnlyNotice({ chat, run, message }: ReadOnlyNoticeProps) {
    const root = useRootStore();
    const ui = useProjectUi();
    const [isHandingOff, setIsHandingOff] = useState(false);
    const [isStopping, setIsStopping] = useState(false);
    const shown = useRef(false);

    useEffect(() => {
        shown.current = true;

        return () => {
            shown.current = false;
        };
    }, []);

    const handOff = async () => {
        setIsHandingOff(true);

        try {
            await startHandoff({ root, ui, chat, run, stillOpen: () => shown.current });
        }
        finally {
            setIsHandingOff(false);
        }
    };

    const stop = async () => {
        if (!isRunActive(run)) return;

        setIsStopping(true);

        try {
            await perform(root, { type: 'run.cancel', runId: run.id });
        }
        finally {
            setIsStopping(false);
        }
    };

    return (
        <section className={ styles.notice } aria-label="This chat is read only">
            <span aria-hidden className={ styles.icon }><Info /></span>

            <div className={ styles.body }>
                <div role="status" className={ styles.message }>
                    <Text variant="heading-5">{ message }</Text>
                    <Text variant="sm" color="secondary">
                        The conversation stays readable here. Continue the work in a new chat on another provider, or open Providers to get this one running again.
                    </Text>
                </div>

                <div className={ styles.actions }>
                    <Button color="primary" size="sm" isPending={ isHandingOff } onPress={ () => void handOff() }>Hand off to a new chat</Button>
                    <Button variant="bordered" size="sm" onPress={ () => root.ui.openSettings('providers') }>Open Providers</Button>
                    { isRunActive(run) && <Button variant="bordered" size="sm" isPending={ isStopping } onPress={ () => void stop() }>Stop</Button> }
                </div>
            </div>
        </section>
    );
}

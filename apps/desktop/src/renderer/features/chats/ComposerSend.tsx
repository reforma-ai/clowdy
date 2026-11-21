import { Button } from '@clowdy/components/Button';
import { tooltipWithHotkey } from '@clowdy/components/Hotkey';
import { Spinner } from '@clowdy/components/Spinner';
import { SendBold, StopBold } from '@clowdy/icons/16';

import styles from './ComposerSend.module.css';

import type { QueuedMessageMode } from '@clowdy/protocol';

/** What the button says it does with a message for a busy orchestrator. */
const WAITS: Record<QueuedMessageMode, string> = {
    steer: 'Steer the current turn',
    queue: 'Add to queue',
};

export interface ComposerSendProps {
    /** What the button is called, for a screen reader and its tooltip: `Send` unless the message box is an edit frame's. */
    label?: string;
    /** There is a message to send. */
    canSend: boolean;
    /** It cannot go yet (a file is still uploading, or failed): Send stays off. The caller says why. */
    blocked?: boolean;
    /** The message is on its way: the button spins and takes no press. */
    isPending?: boolean;
    /** The orchestrator is working: an empty field offers Stop where Send would be. */
    running: boolean;
    /** How a message waits for the busy orchestrator when it is sent the way Enter sends it; absent while the orchestrator takes it at once. */
    waits?: QueuedMessageMode;
    isStopping: boolean;
    onSend: () => void;
    onStop: () => void;
}

/** The round button at the end of the composer: Send, or Stop while the orchestrator works and nothing is typed. */
export function ComposerSend({ label = 'Send', canSend, blocked = false, isPending = false, running, waits, isStopping, onSend, onStop }: ComposerSendProps) {
    if (running && !canSend) {
        return (
            <Button
                color="primary"
                size="sm"
                iconOnly
                rounded
                isPending={ isStopping }
                aria-label="Stop"
                tooltip="Stop"
                onPress={ onStop }
            >
                <Spinner size="unset" className={ styles.stopRing } aria-hidden />
                <StopBold />
            </Button>
        );
    }

    return (
        <Button
            color="primary"
            size="sm"
            iconOnly
            rounded
            isDisabled={ !canSend || blocked }
            isPending={ isPending }
            aria-label={ label }
            tooltip={ tooltipWithHotkey(waits ? WAITS[waits] : label, 'enter') }
            onPress={ onSend }
        >
            <SendBold />
        </Button>
    );
}

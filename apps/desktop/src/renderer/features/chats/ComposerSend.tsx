import { Button } from '@clowdy/components/Button';
import { tooltipWithHotkey } from '@clowdy/components/Hotkey';
import { Spinner } from '@clowdy/components/Spinner';
import { SendBold, StopBold } from '@clowdy/icons/16';

import styles from './ComposerSend.module.css';

export interface ComposerSendProps {
    /** There is a message to send. */
    canSend: boolean;
    /** The orchestrator is working: an empty field offers Stop where Send would be. */
    running: boolean;
    isStopping: boolean;
    onSend: () => void;
    onStop: () => void;
}

/** The round button at the end of the composer: Send, or Stop while the orchestrator works and nothing is typed. */
export function ComposerSend({ canSend, running, isStopping, onSend, onStop }: ComposerSendProps) {
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
            isDisabled={ !canSend }
            aria-label="Send"
            tooltip={ tooltipWithHotkey('Send', 'enter') }
            onPress={ onSend }
        >
            <SendBold />
        </Button>
    );
}

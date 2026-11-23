import { Button } from '@clowdy/components/Button';
import { Text } from '@clowdy/components/Text';
import { Close, EditPen } from '@clowdy/icons/14';

import styles from './EditMessage.module.css';

import type { ReactNode } from 'react';

export interface EditMessageProps {
    /** The stream item that is being edited, so the turn rail can still scroll to where it stands. */
    turn: string;
    /** The X of the cap: stop editing, with nothing sent. */
    onCancel: () => void;
    /** The message box. The frame is only the place and the cap: the box (and what it does with Enter and Escape) is the caller's, since the stream knows nothing of composers. */
    children: ReactNode;
}

/**
 * What stands in the list in place of a message of the person's while it is edited: a cap with the pen, `Editing message` and an X, joined to the message
 * box below it, a little narrower than the box at the bottom of the page. The root takes the message's `data-turn`, so the rail scrolls to it; it is not a
 * `data-message`, so a selection inside it is never offered as a quote to reply with.
 */
export function EditMessage({ turn, onCancel, children }: EditMessageProps) {
    return (
        <div className={styles.root} role="group" aria-label="Editing message" data-turn={turn}>
            <div className={styles.cap}>
                <EditPen aria-hidden className={styles.icon} />
                <Text variant="xs" className={styles.title}>
                    Editing message
                </Text>
                <Button
                    size="xs"
                    variant="ghost"
                    color="secondary"
                    iconOnly
                    className={styles.close}
                    aria-label="Stop editing"
                    tooltip="Stop editing"
                    tooltipPlacement="bottom"
                    onPress={onCancel}
                >
                    <Close />
                </Button>
            </div>
            {children}
        </div>
    );
}

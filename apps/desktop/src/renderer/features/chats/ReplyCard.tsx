import { Button } from '@clowdy/components/Button';
import { Text } from '@clowdy/components/Text';
import { Close } from '@clowdy/icons/14';

import styles from './ReplyCard.module.css';

import type { ReplyMessage } from '../../stream/MessageActions';

export interface ReplyCardProps {
    /** The message that is replied to: its source Markdown is what the card shows and what is sent. */
    message: ReplyMessage;
    /** Whose message it is, as the person reads it: `You`, or the agent's name. */
    who: string;
    /** The X: reply to nothing. */
    onRemove: () => void;
    disabled?: boolean;
}

/**
 * The message the box replies to, as a card above the field, where the files of a message are: an accent bar on its start, who wrote it, the words clamped to
 * three lines and an X. It is sent as a quote in front of what is typed; the words themselves stay out of the field, so the draft holds only what the person writes.
 */
export function ReplyCard({ message, who, onRemove, disabled }: ReplyCardProps) {
    return (
        <div className={styles.card} role="group" aria-label={`Replying to ${who}`}>
            <div className={styles.text}>
                <Text variant="xs" weight="medium">
                    {who}
                </Text>
                <p className={styles.quote}>{message.text}</p>
            </div>
            <Button
                size="xs"
                variant="filling"
                color="secondary"
                iconOnly
                aria-label="Remove quote"
                tooltip="Remove quote"
                tooltipPlacement="bottom"
                isDisabled={disabled}
                onPress={onRemove}
            >
                <Close />
            </Button>
        </div>
    );
}

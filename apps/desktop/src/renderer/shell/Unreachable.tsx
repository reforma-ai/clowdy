import { Button } from '@clowdy/components/Button';
import { Text } from '@clowdy/components/Text';

import styles from './Message.module.css';

export interface UnreachableProps {
    /** What went wrong, as the transport put it. */
    message: string;
    onRetry: () => void;
}

/** Shown when the daemon cannot be reached for the first load. */
export function Unreachable({ message, onRetry }: UnreachableProps) {
    return (
        <div className={styles.message}>
            <Text variant="heading-2">Cannot reach the daemon</Text>
            <Text color="secondary">
                Clowdy keeps your spaces, chats and agents in a background daemon. Check that it is running, then try
                again.
            </Text>
            {message && (
                <Text variant="code" color="secondary">
                    {message}
                </Text>
            )}
            <Button color="contrast" onPress={onRetry}>
                Retry
            </Button>
        </div>
    );
}

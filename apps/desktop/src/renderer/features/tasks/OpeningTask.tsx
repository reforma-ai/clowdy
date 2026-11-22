import { Alert, AlertAction, AlertDescription, AlertIcon } from '@clowdy/components/Alert';
import { Button } from '@clowdy/components/Button';
import { Loader } from '@clowdy/components/Loader';
import { Text } from '@clowdy/components/Text';
import { AttentionCircle, Close } from '@clowdy/icons/14';
import { useEffect, useState } from 'react';

import panelStyles from './DetailPanel.module.css';
import styles from './OpeningTask.module.css';

/** How long a task may take to come before the panel of its waiting is drawn: a task the project is about to hold (the event of a task just made) or a stale one the daemon answers 404 for would only make the page jump. */
export const OPENING_DELAY_MS = 250;

export interface OpeningTaskProps {
    /** What the panel waits for: the task is being read, or the read failed. */
    reading: { status: 'loading' } | { status: 'failed'; message: string };
    onRetry: () => void;
    onClose: () => void;
}

/**
 * The panel's place while the open task is read from the daemon (a task the board does not hold, which is an archived one), or when that failed. The wait is drawn only if it
 * lasts a moment (`OPENING_DELAY_MS`), so a task that comes at once does not make the page jump; a failure is drawn at once. The panel of a task that comes in is the next thing
 * drawn here.
 */
export function OpeningTask({ reading, onRetry, onClose }: OpeningTaskProps) {
    const [isLate, setIsLate] = useState(false);

    useEffect(() => {
        const timer = setTimeout(() => setIsLate(true), OPENING_DELAY_MS);

        return () => clearTimeout(timer);
    }, []);

    if (reading.status === 'loading' && !isLate) return null;

    return (
        <aside className={ panelStyles.panel } aria-label="Task" aria-busy={ reading.status === 'loading' }>
            <div className={ panelStyles.head }>
                <span />
                <Button iconOnly size="sm" variant="filling" aria-label="Close" tooltip="Close" onPress={ onClose }>
                    <Close />
                </Button>
            </div>

            <div className={ styles.body }>
                { reading.status === 'loading'
                    ? (
                        <div className={ styles.waiting } role="status">
                            <Loader size="lg" />
                            <Text color="secondary">Loading the task…</Text>
                        </div>
                    )
                    : (
                        <Alert color="danger">
                            <AlertIcon><AttentionCircle /></AlertIcon>
                            <AlertDescription>{ `The task could not be loaded. ${ reading.message }` }</AlertDescription>
                            <AlertAction>
                                <Button size="sm" variant="bordered" onPress={ onRetry }>Retry</Button>
                            </AlertAction>
                        </Alert>
                    ) }
            </div>
        </aside>
    );
}

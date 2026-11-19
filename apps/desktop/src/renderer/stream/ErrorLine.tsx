import { Alert, AlertAction, AlertDescription, AlertIcon } from '@clowdy/components/Alert';
import { AttentionCircle } from '@clowdy/icons/14';

import type { ReactNode } from 'react';

/** An error in the run's stream, with a button for what fixes it when there is one. */
export function ErrorLine({ text, action }: { text: string; action?: ReactNode }) {
    return (
        <Alert color="danger">
            <AlertIcon><AttentionCircle /></AlertIcon>
            <AlertDescription>{ text }</AlertDescription>
            { action && <AlertAction>{ action }</AlertAction> }
        </Alert>
    );
}

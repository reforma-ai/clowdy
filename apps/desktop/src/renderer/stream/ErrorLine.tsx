import { Alert, AlertDescription, AlertIcon } from '@clowdy/components/Alert';
import { AttentionCircle } from '@clowdy/icons/14';

/** An error in the run's stream. */
export function ErrorLine({ text }: { text: string }) {
    return (
        <Alert color="danger">
            <AlertIcon><AttentionCircle /></AlertIcon>
            <AlertDescription>{ text }</AlertDescription>
        </Alert>
    );
}

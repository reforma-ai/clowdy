import { Alert, AlertAction, AlertDescription, AlertIcon } from '@clowdy/components/Alert';
import { Button } from '@clowdy/components/Button';
import { AttentionCircle } from '@clowdy/icons/14';

/** A Settings page's read that failed: what went wrong and a way to read again. */
export function ReadFailed({ message, onRetry }: { message: string; onRetry: () => void }) {
    return (
        <Alert color="danger">
            <AlertIcon>
                <AttentionCircle />
            </AlertIcon>
            <AlertDescription>{message}</AlertDescription>
            <AlertAction>
                <Button size="sm" variant="bordered" onPress={onRetry}>
                    Try again
                </Button>
            </AlertAction>
        </Alert>
    );
}

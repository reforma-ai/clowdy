import { Spinner } from '@clowdy/components/Spinner';
import { Text } from '@clowdy/components/Text';

import styles from './BranchPicker.module.css';

import type { BranchSwitch } from './BranchSwitch';

/** What the daemon said when a switch was not made, as the popover shows it: the reason, selectable, and under it the line the daemon adds (`3 files changed`). Nothing while there is nothing to say. */
export function SwitchReasons({ model }: { model: BranchSwitch }) {
    const { failure, warning, listFailure, running } = model;

    if (running !== undefined) {
        return (
            <div className={ styles.status } role="status">
                <Spinner size="xs" />
                <Text variant="xs" color="secondary" truncate>{ `Switching to ${ running }` }</Text>
            </div>
        );
    }

    if (failure) {
        return (
            <div className={ styles.reason } role="alert">
                <Text variant="xs" color="danger" select="text">{ failure.message }</Text>
                { failure.hint && <Text variant="xs" color="secondary" select="text">{ failure.hint }</Text> }
            </div>
        );
    }

    // A `post-checkout` hook that failed after the branch changed: the switch is made, and this is all that is left to say of it.
    if (warning) {
        return (
            <div className={ styles.reason } role="status">
                <Text variant="xs" color="secondary" select="text">{ `Switched to ${ warning.branch }` }</Text>
                <Text variant="xs" color="warning" select="text">{ warning.line }</Text>
            </div>
        );
    }

    if (listFailure) {
        return (
            <div className={ styles.reason } role="alert">
                <Text variant="xs" color="danger" select="text">{ listFailure }</Text>
            </div>
        );
    }

    return null;
}

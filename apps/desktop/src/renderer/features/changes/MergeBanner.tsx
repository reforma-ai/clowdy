import { Button } from '@clowdy/components/Button';
import { Text } from '@clowdy/components/Text';

import { useProjectUi } from '../../stores';
import { quoteIntoComposer } from '../chats/composerBridge';
import { mergeBanner } from './changesActions';
import { confirmAbortMerge } from './confirmAbortMerge';
import styles from './MergeBanner.module.css';
import { useRemoteActions } from './useRemoteActions';

import type { PlaceFacts } from './gitFacts';

/** The paths a merge still has conflicted, as the status lists them. */
function conflictedPaths(facts: PlaceFacts): string[] {
    const status = facts.status.value;

    if (status?.isRepository !== true) return [];

    return status.entries.filter(entry => entry.unstaged === 'conflicted').map(entry => entry.path);
}

/**
 * The banner while a merge is in progress: how many conflicts are left, Abort merge, and Ask the agent (a quote of the conflicted paths into the open chat) while any are left. Once they
 * are resolved the commit box finishes the merge.
 */
export function MergeBanner({ facts }: { facts: PlaceFacts }) {
    const banner = mergeBanner(facts.status.value);
    const remote = useRemoteActions(facts);
    const ui = useProjectUi();

    if (!banner) return null;

    const ask = () => {
        const paths = conflictedPaths(facts);
        const quote =
            paths.length === 0
                ? 'Resolve the merge conflicts'
                : `Resolve the merge conflicts in:\n${paths.map(path => `- \`${path}\``).join('\n')}`;

        if (quoteIntoComposer(quote)) ui.showChat();
    };

    return (
        <div className={styles.banner} role="status">
            <Text variant="xs" weight="medium">
                {banner.words}
            </Text>
            <div className={styles.actions}>
                <Button
                    variant="bordered"
                    size="sm"
                    isDisabled={remote.busy}
                    isPending={remote.running === 'abort'}
                    onPress={() =>
                        confirmAbortMerge(async () => {
                            await remote.run('abort');
                        })
                    }
                >
                    Abort merge
                </Button>
                {banner.ask && (
                    <Button variant="bordered" size="sm" onPress={ask}>
                        Ask the agent
                    </Button>
                )}
            </div>
        </div>
    );
}

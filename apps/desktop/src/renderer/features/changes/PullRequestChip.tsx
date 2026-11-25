import { Button } from '@clowdy/components/Button';
import { Text } from '@clowdy/components/Text';
import { CircleCheck, CircleWarning, Merge } from '@clowdy/icons/14';

import { openEffects } from '../openWith';
import { PULL_REQUEST_STATE_LABEL } from './gitSummary';
import styles from './PullRequestChip.module.css';

import type { GitChecks, GitPullRequestSummary } from '@clowdy/protocol';

export function PullRequestChip({
    pr,
    stale,
    showTitle = false,
}: {
    pr: GitPullRequestSummary & { checks?: GitChecks };
    stale: boolean;
    showTitle?: boolean;
}) {
    const state = PULL_REQUEST_STATE_LABEL[pr.state];
    const { failing, passing } = pr.checks ?? { failing: 0, passing: 0 };
    const counts = [failing > 0 && `${failing} failed`, passing > 0 && `${passing} passed`].filter(Boolean).join(', ');

    return (
        <Button
            size="sm"
            color="secondary"
            fullWidth
            className={styles.button}
            contentClassName={styles.content}
            data-stale={stale || undefined}
            aria-label={`Open pull request ${pr.number} on GitHub: ${state}, ${pr.title}${counts ? `, ${counts}` : ''}`}
            tooltip={pr.title}
            tooltipPlacement="bottom"
            onPress={() => openEffects.openUrl(pr.url)}
        >
            <Merge className={styles.prMark} data-state={pr.state} aria-hidden="true" />
            <Text truncate className={showTitle ? styles.prNumber : undefined}>{`PR #${pr.number}`}</Text>
            {showTitle && (
                <Text truncate variant="xs" color="secondary" className={styles.prTitle}>
                    {pr.title}
                </Text>
            )}
            {(pr.state === 'draft' || pr.state === 'closed') && (
                <Text variant="xs" color="secondary" truncate className={styles.prState}>
                    {state}
                </Text>
            )}
            {(failing > 0 || passing > 0) && (
                <span className={styles.checkCounts} aria-hidden="true">
                    {failing > 0 && (
                        <span className={styles.checkCount} data-check="failed">
                            <CircleWarning className={styles.failed} />
                            {failing}
                        </span>
                    )}
                    {passing > 0 && (
                        <span className={styles.checkCount} data-check="passed">
                            <CircleCheck className={styles.passed} />
                            {passing}
                        </span>
                    )}
                </span>
            )}
        </Button>
    );
}

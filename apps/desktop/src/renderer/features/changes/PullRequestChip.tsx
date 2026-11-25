import { GridListItem } from '@clowdy/components/List';
import { Text } from '@clowdy/components/Text';
import { CircleCheck, CircleWarning, Merge, MergeCancel } from '@clowdy/icons/14';

import { openEffects } from '../openWith';
import { PULL_REQUEST_STATE_LABEL } from './gitSummary';
import styles from './PullRequestChip.module.css';

import type { GitChecks, GitPullRequestSummary } from '@clowdy/protocol';
import type { ReactNode } from 'react';

export function PullRequestChip({
    pr,
    stale,
    action,
}: {
    pr: GitPullRequestSummary & { checks?: GitChecks };
    stale: boolean;
    action?: ReactNode;
}) {
    const state = PULL_REQUEST_STATE_LABEL[pr.state];
    const Mark = pr.state === 'closed' ? MergeCancel : Merge;
    const { failing, passing } = pr.checks ?? { failing: 0, passing: 0 };
    const counts = [failing > 0 && `${failing} failed`, passing > 0 && `${passing} passed`].filter(Boolean).join(', ');

    return (
        <GridListItem
            id={pr.url}
            textValue={`${pr.title} PR #${pr.number}`}
            className={styles.row}
            data-stale={stale || undefined}
            aria-label={`Open pull request ${pr.number} on GitHub: ${state}, ${pr.title}${counts ? `, ${counts}` : ''}`}
            icon={<Mark className={styles.prMark} data-state={pr.state} aria-hidden="true" />}
            onAction={() => openEffects.openUrl(pr.url)}
            endAffix={
                <>
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
                    {action}
                </>
            }
        >
            <Text slot="label" className={styles.copy}>
                <Text variant="sm" weight="medium" truncate title={pr.title}>
                    {pr.title || `PR #${pr.number}`}
                </Text>
                <Text variant="xs" color="secondary">{`PR #${pr.number}`}</Text>
            </Text>
        </GridListItem>
    );
}

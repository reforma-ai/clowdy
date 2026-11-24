import { Button } from '@clowdy/components/Button';
import { Scrollable } from '@clowdy/components/Scrollable';
import { Text } from '@clowdy/components/Text';
import { ArrowUpRight, CheckCircleSolid, Circle, Close, Oclock, Version } from '@clowdy/icons/14';

import { openEffects } from '../openWith';
import { CHECK_STATE_VIEW, PULL_REQUEST_STATE_LABEL, sortedChecks } from './gitSummary';
import styles from './PullRequestChip.module.css';

import type { GitPullRequest } from '@clowdy/protocol';

const CHECK_ICONS = { failing: Close, pending: Oclock, passing: CheckCircleSolid, skipped: Circle } as const;

function PullRequestChecks({ pr }: { pr: GitPullRequest }) {
    const { items, truncated } = pr.checks;

    if (items.length === 0 && !truncated) return null;

    const checksUrl = `${pr.url.replace(/\/$/, '')}/checks`;

    return (
        <Scrollable className={styles.checks}>
            <ul aria-label="Checks" className={styles.list}>
                {sortedChecks(items).map((check, index) => {
                    const view = CHECK_STATE_VIEW[check.state];
                    const Icon = CHECK_ICONS[check.state];
                    // The desktop app opens only HTTPS links in the browser.
                    const url = check.url && URL.parse(check.url)?.protocol === 'https:' ? check.url : checksUrl;

                    return (
                        <li key={`${index}:${check.name}`}>
                            <Button
                                href={url}
                                target="_blank"
                                rel="noopener"
                                size="xs"
                                variant="filling"
                                color="secondary"
                                className={styles.check}
                                aria-label={`${check.name}, ${view.label}`}
                            >
                                <Text color={view.color} className={styles.checkMark}>
                                    <Icon aria-hidden="true" />
                                </Text>
                                <Text variant="xs" truncate className={styles.checkName} title={check.name}>
                                    {check.name}
                                </Text>
                                <Text variant="xs" color="secondary" className={styles.checkState}>
                                    {view.label}
                                </Text>
                                <ArrowUpRight size={10} aria-hidden="true" className={styles.checkLink} />
                            </Button>
                        </li>
                    );
                })}
                {truncated && (
                    <li>
                        <Button href={checksUrl} target="_blank" rel="noopener" size="xs" variant="filling">
                            View all checks
                        </Button>
                    </li>
                )}
            </ul>
        </Scrollable>
    );
}

/**
 * The branch's pull request link and its checks. The icon marks open and merged pull requests.
 */
export function PullRequestChip({ pr, stale }: { pr: GitPullRequest; stale: boolean }) {
    const state = PULL_REQUEST_STATE_LABEL[pr.state];

    return (
        <div role="group" aria-label="Pull request" className={styles.chip} data-stale={stale || undefined}>
            <Button
                size="xs"
                variant="ghost"
                color="secondary"
                className={styles.pr}
                aria-label={`Open pull request ${pr.number} on GitHub: ${state}, ${pr.title}`}
                tooltip={pr.title}
                onPress={() => openEffects.openUrl(pr.url)}
            >
                <Version className={styles.prMark} data-state={pr.state} aria-hidden="true" />
                <Text variant="xs" weight="medium">{`PR #${pr.number}`}</Text>
                {(pr.state === 'draft' || pr.state === 'closed') && (
                    <Text variant="xs" color="secondary">
                        {state}
                    </Text>
                )}
            </Button>
            <PullRequestChecks pr={pr} />
        </div>
    );
}

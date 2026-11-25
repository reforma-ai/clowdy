import { Button } from '@clowdy/components/Button';
import { GridList } from '@clowdy/components/List';
import { ChevronDown, ChevronRight } from '@clowdy/icons/14';
import { useState } from 'react';

import styles from './BranchPullRequestList.module.css';
import { partitionPullRequests } from './branchPullRequests';
import { PullRequestChip } from './PullRequestChip';

import type { GitChecks, GitPullRequest, GitPullRequestSummary } from '@clowdy/protocol';

interface PullRequestRow extends GitPullRequestSummary {
    checks?: GitChecks;
    stale: boolean;
}

/** The current PR supplies its existing CI summary; history owns the other rows. */
export function pullRequestRows(
    history: readonly GitPullRequestSummary[],
    stale: boolean,
    current: GitPullRequest | undefined,
    currentStale: boolean
): PullRequestRow[] {
    const rows: PullRequestRow[] = history.map(pr => {
        const matches = current?.number === pr.number && current.url === pr.url;
        const latest = matches && current.updatedAt > pr.updatedAt ? current : pr;

        return {
            ...latest,
            ...(matches && { checks: current.checks }),
            stale: matches && !currentStale ? false : stale,
        };
    });

    // A PR can appear in the current branch read just before the history is refreshed.
    if (current && !rows.some(pr => pr.url === current.url)) {
        rows.push({ ...current, stale: currentStale });
    }

    return rows;
}

export function BranchPullRequestList({ rows }: { rows: readonly PullRequestRow[] }) {
    const [expanded, setExpanded] = useState(false);
    const { visible, archived } = partitionPullRequests(rows);
    if (!rows.length) return null;

    const row = (pr: PullRequestRow) => <PullRequestChip key={pr.url} pr={pr} stale={pr.stale} />;

    return (
        <div className={styles.list} role="group" aria-label="Branch pull requests">
            {visible.length > 0 && (
                <GridList size="sm" aria-label="Pull requests">
                    {visible.map(row)}
                </GridList>
            )}
            {archived.length > 0 && (
                <>
                    <Button
                        size="xs"
                        variant="filling"
                        color="secondary"
                        className={styles.archive}
                        aria-expanded={expanded}
                        onPress={() => setExpanded(value => !value)}
                    >
                        Archived PR
                        {expanded ? <ChevronDown /> : <ChevronRight />}
                    </Button>
                    {expanded && (
                        <GridList size="sm" aria-label="Archived pull requests">
                            {archived.map(row)}
                        </GridList>
                    )}
                </>
            )}
        </div>
    );
}

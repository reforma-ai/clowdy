import { Button } from '@clowdy/components/Button';
import { Archive, ArrowUp, ChevronDown, ChevronRight } from '@clowdy/icons/14';
import { useState } from 'react';

import styles from './BranchPullRequestList.module.css';
import { PullRequestChip } from './PullRequestChip';

import type { GitChecks, GitPullRequest, GitPullRequestSummary } from '@clowdy/protocol';

interface PullRequestRow extends GitPullRequestSummary {
    checks?: GitChecks;
    archivable: boolean;
    stale: boolean;
}

const terminal = ({ state }: GitPullRequestSummary) => state === 'merged' || state === 'closed';

/** The current PR supplies its existing CI summary; the history owns the other rows and archive state. */
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
            archived: terminal(latest) ? pr.archived : undefined,
            archivable: terminal(latest) && terminal(pr),
            stale: matches && !currentStale ? false : stale,
        };
    });

    // A PR can appear in the current branch read just before the history is refreshed.
    if (current && !rows.some(pr => pr.url === current.url)) {
        rows.push({ ...current, archivable: false, stale: currentStale });
    }

    return rows.sort((a, b) => b.number - a.number);
}

export function BranchPullRequestList({
    rows,
    archiving,
    onArchive,
}: {
    rows: readonly PullRequestRow[];
    archiving: boolean;
    onArchive: (number: number, archived: boolean) => Promise<boolean>;
}) {
    const [expanded, setExpanded] = useState(false);
    const visible = rows.filter(pr => !pr.archived);
    const archived = rows.filter(pr => pr.archived);
    const showTitle = rows.length > 1;

    if (!rows.length) return null;

    const row = (pr: PullRequestRow) => (
        <div key={pr.url} className={styles.row}>
            <PullRequestChip pr={pr} stale={pr.stale} showTitle={showTitle} />
            {pr.archivable && (
                <Button
                    size="sm"
                    color="secondary"
                    variant="filling"
                    iconOnly
                    aria-label={`${pr.archived ? 'Restore' : 'Archive'} PR #${pr.number}`}
                    tooltip={pr.archived ? 'Restore pull request' : 'Archive pull request'}
                    isDisabled={archiving}
                    onPress={() => void onArchive(pr.number, !pr.archived)}
                >
                    {pr.archived ? <ArrowUp /> : <Archive />}
                </Button>
            )}
        </div>
    );

    return (
        <div className={styles.list} role="group" aria-label="Branch pull requests">
            {visible.map(row)}
            {archived.length > 0 && (
                <>
                    <Button
                        size="xs"
                        variant="ghost"
                        color="secondary"
                        className={styles.archive}
                        aria-expanded={expanded}
                        onPress={() => setExpanded(value => !value)}
                    >
                        {expanded ? <ChevronDown /> : <ChevronRight />}
                        Archived ({archived.length})
                    </Button>
                    {expanded && archived.map(row)}
                </>
            )}
        </div>
    );
}

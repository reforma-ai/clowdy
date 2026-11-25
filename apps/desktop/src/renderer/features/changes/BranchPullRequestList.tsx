import { Button } from '@clowdy/components/Button';
import { GridList, listBoxItemDataShow } from '@clowdy/components/List';
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
    if (!rows.length) return null;

    const row = (pr: PullRequestRow) => (
        <PullRequestChip
            key={pr.url}
            pr={pr}
            stale={pr.stale}
            action={
                pr.archivable && (
                    <Button
                        size="xs"
                        color="secondary"
                        variant="filling"
                        iconOnly
                        data-show={listBoxItemDataShow.itemBoth}
                        aria-label={`${pr.archived ? 'Restore' : 'Archive'} PR #${pr.number}`}
                        tooltip={pr.archived ? 'Restore pull request' : 'Archive pull request'}
                        isDisabled={archiving}
                        onPress={() => void onArchive(pr.number, !pr.archived)}
                    >
                        {pr.archived ? <ArrowUp /> : <Archive />}
                    </Button>
                )
            }
        />
    );

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

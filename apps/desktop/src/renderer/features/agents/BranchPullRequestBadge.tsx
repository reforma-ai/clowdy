import { Tooltip } from '@clowdy/components/Tooltip';
import { Merge, WorktreeFolder } from '@clowdy/icons/14';

import { type BranchPullRequestKey, useBranchPullRequests } from '../changes/branchPullRequests';

/** A status, not another action: every chat observing the same branch shares the PR state. */
export function BranchPullRequestBadge({
    branchKey,
    visible,
    crossWorktree,
    hoverOnly = false,
    className,
}: {
    branchKey?: BranchPullRequestKey;
    visible: boolean;
    crossWorktree: boolean;
    /** Show alongside row actions when another status takes its idle position. */
    hoverOnly?: boolean;
    /** The room the row gives it, and the colours of its states (`data-pr-state`, `data-stale`). */
    className?: string;
}) {
    const fact = useBranchPullRequests(branchKey);
    const pullRequests = fact?.visiblePullRequests ?? [];
    if (!visible) return null;
    if (pullRequests.length === 0)
        return crossWorktree ? (
            <Tooltip content="Thread works in a different worktree">
                <span
                    className={className}
                    data-hover-only={hoverOnly || undefined}
                    role="img"
                    aria-label="Thread works in a different worktree"
                >
                    <WorktreeFolder aria-hidden="true" />
                </span>
            </Tooltip>
        ) : null;

    const state = pullRequests.some(pr => pr.state === 'open')
        ? 'open'
        : pullRequests.some(pr => pr.state === 'draft')
          ? 'draft'
          : 'merged';
    const detail = (['open', 'draft', 'merged'] as const)
        .flatMap(state => {
            const count = pullRequests.filter(pr => pr.state === state).length;
            return count ? [`${count} ${state}`] : [];
        })
        .join(', ');
    const first = pullRequests[0]!;
    const summary =
        pullRequests.length === 1
            ? `${first.state === 'open' ? 'Open' : first.state === 'draft' ? 'Draft' : 'Merged'} pull request #${first.number}`
            : detail;
    const prLabel = `${summary}${fact?.stale ? ' (last known)' : ''}`;
    const label = crossWorktree ? `Thread works in a different worktree\n${prLabel}` : prLabel;

    return (
        <Tooltip
            content={
                crossWorktree ? (
                    <>
                        Thread works in a different worktree
                        <br />
                        {prLabel}
                    </>
                ) : (
                    prLabel
                )
            }
        >
            <span
                className={className}
                data-hover-only={hoverOnly || undefined}
                data-pr-state={state}
                data-stale={fact?.stale || undefined}
                role="img"
                aria-label={label}
            >
                <Merge size={12} aria-hidden="true" />
            </span>
        </Tooltip>
    );
}

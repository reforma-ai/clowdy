import { Merge, Split } from '@clowdy/icons/14';

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
            <span
                className={className}
                data-hover-only={hoverOnly || undefined}
                role="img"
                aria-label="Thread works in a different worktree"
                title="Thread works in a different worktree"
            >
                <Split aria-hidden="true" />
            </span>
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
    const label = `${crossWorktree ? 'Thread works in a different worktree; ' : ''}${pullRequests.length} pull request${pullRequests.length === 1 ? '' : 's'}: ${detail}${fact?.stale ? ' (last known)' : ''}`;

    return (
        <span
            className={className}
            data-hover-only={hoverOnly || undefined}
            data-pr-state={state}
            data-stale={fact?.stale || undefined}
            role="img"
            aria-label={label}
            title={label}
        >
            <Merge size={12} aria-hidden="true" />
        </span>
    );
}

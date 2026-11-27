import { Button } from '@clowdy/components/Button';
import { Tooltip } from '@clowdy/components/Tooltip';
import { Merge, WorktreeFolder } from '@clowdy/icons/14';

import { type BranchPullRequestKey, useBranchPullRequests } from '../changes/branchPullRequests';
import { openEffects } from '../openWith';

/** Every chat observing the same branch shares its PR state and opens the latest open PR. */
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
    const target = pullRequests.find(pr => pr.state === 'open') ?? first;
    const label = crossWorktree ? `Thread works in a different worktree\n${prLabel}` : prLabel;
    const accessibleLabel = pullRequests.length > 1 ? `${label}, open pull request #${target.number}` : label;
    const tooltip = crossWorktree ? (
        <>
            Thread works in a different worktree
            <br />
            {prLabel}
        </>
    ) : (
        prLabel
    );

    return (
        <Button
            variant="filling"
            color="secondary"
            size="xs"
            iconOnly
            preventFocusOnPress
            className={className}
            data-hover-only={hoverOnly || undefined}
            data-pr-state={state}
            data-stale={fact?.stale || undefined}
            aria-label={accessibleLabel}
            tooltip={tooltip}
            onPress={() => openEffects.openUrl(target.url)}
        >
            <Merge size={12} aria-hidden="true" />
        </Button>
    );
}

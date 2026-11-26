import { MAX_GIT_STATUS_ENTRIES } from '@clowdy/protocol';

import type { GitPullRequest, GitStatus } from '@clowdy/protocol';

/** How far the work of a place is on its way to the base branch: nothing to land, commits waiting, a pull request open, or something that needs a person. */
export type ChangesStage = 'clean' | 'ahead' | 'pullRequest' | 'problem';

/** What the rail says of a place's changes while the Changes tab is shut: the stage (the tab's icon) and the uncommitted files (a dot), each with the line the tooltip adds under the label. */
export interface ChangesSummary {
    stage: ChangesStage;
    /** How many paths are uncommitted. */
    uncommitted: number;
    /** Why the stage is what it is; none while it is clean. */
    stageLine?: string;
    /** `4 uncommitted files`, with a `+` when git listed fewer than there are; none while the tree is clean. */
    uncommittedLine?: string;
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** The first thing wrong, as a line, or nothing: a merge or rebase stopped, or an open pull request that checks, a reviewer or its base block. */
function problemOf(status: Extract<GitStatus, { isRepository: true }>, pr: GitPullRequest | undefined) {
    if (status.merging && status.merging.conflicts > 0) return 'Merge has conflicts';
    if (status.rebasing) return 'Rebase is paused';
    if (!pr) return undefined;
    if (pr.checks.state === 'failing') return `Checks are failing on #${pr.number}`;
    if (pr.reviewDecision === 'changes_requested') return `Changes requested on #${pr.number}`;
    if (pr.mergeability === 'conflicts') return `Pull request #${pr.number} conflicts with ${pr.base}`;

    return undefined;
}

/**
 * The stage of a place from its git status and the pull request of its branch, with the lines that say why. Nothing until the status is read, and for a folder that is no repository.
 * A pull request counts only when it comes from the branch the status has checked out: the facts keep the last answer while the next is on its way, so after a switch of branch
 * (or a detached HEAD) the answer in hand can be the previous branch's.
 */
export function changesSummary(
    status: GitStatus | undefined,
    answer: GitPullRequest | undefined
): ChangesSummary | undefined {
    if (status?.isRepository !== true) return undefined;

    const pr = answer && status.head.kind === 'branch' && answer.head === status.head.name ? answer : undefined;
    const open = pr !== undefined && (pr.state === 'open' || pr.state === 'draft');
    const uncommitted = status.entries.length;
    const cut = status.truncated === true || uncommitted >= MAX_GIT_STATUS_ENTRIES;
    const problem = problemOf(status, open ? pr : undefined);
    const summary: ChangesSummary = { stage: 'clean', uncommitted };

    if (problem) {
        summary.stage = 'problem';
        summary.stageLine = problem;
    } else if (open) {
        const checks = pr.checks.state === 'pending' ? ', checks are running' : '';

        summary.stage = 'pullRequest';
        summary.stageLine = `${pr.state === 'draft' ? `Draft pull request #${pr.number}` : `Pull request #${pr.number} is open`}${checks}`;
    } else if (pr?.state !== 'merged' && status.base.state === 'ready' && status.base.ahead > 0) {
        summary.stage = 'ahead';
        summary.stageLine = `${plural(status.base.ahead, 'commit', 'commits')} not in ${status.base.name}`;
    }

    if (uncommitted > 0)
        summary.uncommittedLine = `${uncommitted}${cut ? '+' : ''} uncommitted ${uncommitted === 1 ? 'file' : 'files'}`;

    return summary;
}

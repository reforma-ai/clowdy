import { MAX_GIT_STATUS_ENTRIES } from '@clowdy/protocol';

import { syncButton } from './changesActions';

import type { GitPullRequest, GitStatus } from '@clowdy/protocol';

/** What the first tooltip line of the rail is about: nothing, commits that are not in the base yet, a pull request that is open or merged, or something that needs a person. */
export type ChangesStage = 'clean' | 'ahead' | 'pullRequest' | 'merged' | 'problem';

/** What the tooltip of the Changes tab says of a place's changes: the stage, the commits to send or take, and the uncommitted files, each as the line it adds under the label. */
export interface ChangesSummary {
    stage: ChangesStage;
    /** How many paths are uncommitted. */
    uncommitted: number;
    /** Why the stage is what it is; none while it is clean. */
    stageLine?: string;
    /**
     * What the sync button of Source Control says of the commits it counts (`syncButton`, its tooltip: `2 commits to pull and 3 commits to push`, `17 commits to merge from main`);
     * none while the button counts nothing (level with its upstream and its base, not published, blocked, no origin).
     */
    syncLine?: string;
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
    } else if (pr?.state === 'merged') {
        summary.stage = 'merged';
        summary.stageLine = `Pull request #${pr.number} is merged`;
    } else if (status.base.state === 'ready' && status.base.ahead > 0) {
        summary.stage = 'ahead';
        summary.stageLine = `${plural(status.base.ahead, 'commit', 'commits')} not in ${status.base.name}`;
    }

    // The words are the button's own, so the tab and the panel never say different things about what is to push, to pull or to merge from the base. No action is running in this view of
    // the button (the status does not say), and `now` only feeds its `Last fetched` line, which the rail does not use.
    const view = syncButton(status, undefined, 0);

    if (view?.title && (view.ahead || view.behind)) summary.syncLine = view.title;

    if (uncommitted > 0)
        summary.uncommittedLine = `${uncommitted}${cut ? '+' : ''} uncommitted ${uncommitted === 1 ? 'file' : 'files'}`;

    return summary;
}

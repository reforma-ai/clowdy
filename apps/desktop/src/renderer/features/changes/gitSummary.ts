import type { GitBase, GitCheck, GitChecks, GitCheckState, GitHubAccess, GitHubRepo, GitPullRequestState } from '@clowdy/protocol';
import type { StatusTone } from '../../shared/runStatus';
import type { BranchSummary } from './gitFacts';

/** How a pull request's state is worded. */
export const PULL_REQUEST_STATE_LABEL: Record<GitPullRequestState, string> = { open: 'Open', draft: 'Draft', merged: 'Merged', closed: 'Closed' };

/** How a check's state is worded, and the tone of its dot. A check that was left out on purpose has no colour. */
export const CHECK_STATE_VIEW: Record<GitCheckState, { label: string; tone: StatusTone }> = {
    failing: { label: 'Failing', tone: 'danger' },
    pending: { label: 'Pending', tone: 'warning' },
    passing: { label: 'Passing', tone: 'success' },
    skipped: { label: 'Skipped', tone: 'neutral' },
};

/** The order of a check list: failing, then pending, passing and skipped; within a state the daemon's order (by name) stays. */
const CHECK_ORDER: readonly GitCheckState[] = ['failing', 'pending', 'passing', 'skipped'];

/** The checks as the list shows them: failing first. The daemon sorts them already; this keeps the rule here too, so the list never depends on it. */
export const sortedChecks = (items: readonly GitCheck[]): GitCheck[] => [...items].sort((a, b) => CHECK_ORDER.indexOf(a.state) - CHECK_ORDER.indexOf(b.state));

/** What the dot of the checks says: `none` has no dot. The `skipped` checks do not count. */
export const checksTone = (checks: GitChecks): StatusTone | undefined => {
    switch (checks.state) {
        case 'failing':
            return 'danger';
        case 'pending':
            return 'warning';
        case 'passing':
            return 'success';
        default:
            return undefined;
    }
};

/** The checks in words, the ones that are not zero: `1 failing, 2 pending, 3 passing`. */
export function checksWords(checks: GitChecks): string {
    const parts = [[checks.failing, 'failing'], [checks.pending, 'pending'], [checks.passing, 'passing'], [checks.skipped, 'skipped']] as const;

    return parts.filter(([count]) => count > 0).map(([count, word]) => `${ count } ${ word }`).join(', ');
}

/** How far the branch is from its base, in words: `3 ahead, 1 behind origin/main`, `2 ahead of origin/main`, `1 behind origin/main`, `Even with origin/main`. Nothing when there is no base to compare with. */
export function aheadBehindWords(base: GitBase | undefined): string | undefined {
    if (base?.state !== 'ready') return undefined;

    const { ahead, behind, name } = base;

    if (ahead > 0 && behind > 0) return `${ ahead } ahead, ${ behind } behind ${ name }`;

    if (ahead > 0) return `${ ahead } ahead of ${ name }`;

    if (behind > 0) return `${ behind } behind ${ name }`;

    return `Even with ${ name }`;
}

/** Whether the branch has files to show against its base: there is a base to count from, and something changed. */
export const hasBranchFiles = (summary: BranchSummary | undefined): summary is BranchSummary => summary !== undefined && summary.baseState === 'ready' && summary.files > 0;

/** The branch's totals as the signs `+104 −38` write them (a real minus sign, as the tool cards have it). */
export const additionsWords = (summary: BranchSummary) => `+${ summary.additions }`;
export const deletionsWords = (summary: BranchSummary) => `−${ summary.deletions }`;

/** `13 files`, `1 file`. */
export const filesWords = (count: number) => `${ count } ${ count === 1 ? 'file' : 'files' }`;

/**
 * What the strip says when GitHub cannot be asked. `gh` is the person's own program, so the words name it: it is not signed in (for GitHub, the one thing to do; for another host,
 * which one), or it is not installed. Offline reads the same as not signed in for a few seconds, which is why it is a hint and not a button. A folder whose `origin` names no repository
 * has none.
 */
export function accessHint(access: GitHubAccess | undefined, repo: GitHubRepo | undefined): string | undefined {
    if (!repo) return undefined;

    if (access === 'no_gh') return 'Install gh to see pull requests';

    if (access === 'not_signed_in') return repo.host === 'github.com' ? 'Sign in with gh' : `gh isn't signed in to ${ repo.host }`;

    return undefined;
}

/** What the hint's tooltip tells the person to do, as the daemon's own words are not shown. */
export function accessHintTitle(access: GitHubAccess | undefined, repo: GitHubRepo | undefined): string | undefined {
    if (!repo) return undefined;

    if (access === 'no_gh') return 'Pull requests come from the GitHub command line tool, gh';

    if (access === 'not_signed_in') return `Run gh auth login --hostname ${ repo.host } in a terminal to see pull requests`;

    return undefined;
}

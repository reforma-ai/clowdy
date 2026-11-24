import type { TextColor } from '@clowdy/components/Text';
import type {
    GitBase,
    GitChangeKind,
    GitCheck,
    GitCheckState,
    GitHubAccess,
    GitHubRepo,
    GitPullRequestState,
} from '@clowdy/protocol';
import type { BranchSummary } from './gitFacts';

/** How a pull request's state is worded. */
export const PULL_REQUEST_STATE_LABEL: Record<GitPullRequestState, string> = {
    open: 'Open',
    draft: 'Draft',
    merged: 'Merged',
    closed: 'Closed',
};

/** How each check state is labelled and coloured. */
export const CHECK_STATE_VIEW: Record<GitCheckState, { label: string; color: TextColor }> = {
    failing: { label: 'Failing', color: 'danger' },
    pending: { label: 'Pending', color: 'warning' },
    passing: { label: 'Passing', color: 'success' },
    skipped: { label: 'Skipped', color: 'secondary' },
};

/** The order of a check list: failing, then pending, passing and skipped; within a state the daemon's order (by name) stays. */
const CHECK_ORDER: readonly GitCheckState[] = ['failing', 'pending', 'passing', 'skipped'];

/** The checks as the list shows them: failing first. The daemon sorts them already; this keeps the rule here too, so the list never depends on it. */
export const sortedChecks = (items: readonly GitCheck[]): GitCheck[] =>
    [...items].sort((a, b) => CHECK_ORDER.indexOf(a.state) - CHECK_ORDER.indexOf(b.state));

/** How far the branch is from its base, in words: `3 ahead, 1 behind origin/main`, `2 ahead of origin/main`, `1 behind origin/main`, `Even with origin/main`. Nothing when there is no base to compare with. */
export function aheadBehindWords(base: GitBase | undefined): string | undefined {
    if (base?.state !== 'ready') return undefined;

    const { ahead, behind, name } = base;

    if (ahead > 0 && behind > 0) return `${ahead} ahead, ${behind} behind ${name}`;

    if (ahead > 0) return `${ahead} ahead of ${name}`;

    if (behind > 0) return `${behind} behind ${name}`;

    return `Even with ${name}`;
}

/** How far the branch is from its base without naming it: `3 ahead, 1 behind`, `2 ahead`, `1 behind`, `Even`. Nothing when there is no base to compare with. */
export function aheadBehindCounts(base: GitBase | undefined): string | undefined {
    if (base?.state !== 'ready') return undefined;

    const { ahead, behind } = base;

    if (ahead > 0 && behind > 0) return `${ahead} ahead, ${behind} behind`;

    if (ahead > 0) return `${ahead} ahead`;

    if (behind > 0) return `${behind} behind`;

    return 'Even';
}

/** What a changed file is called and drawn as: the letter of its status in the colour that status has in the lists of a tool such as this, and its name for a tooltip and a screen reader. */
export const CHANGE_KIND_VIEW: Record<GitChangeKind, { glyph: string; label: string; color: TextColor }> = {
    added: { glyph: 'A', label: 'Added', color: 'success' },
    modified: { glyph: 'M', label: 'Modified', color: 'warning' },
    deleted: { glyph: 'D', label: 'Deleted', color: 'danger' },
    renamed: { glyph: 'R', label: 'Renamed', color: 'accent' },
    copied: { glyph: 'C', label: 'Copied', color: 'accent' },
    typechange: { glyph: 'T', label: 'Type changed', color: 'secondary' },
    conflicted: { glyph: 'U', label: 'Conflicted', color: 'danger' },
};

/** A file's path as a folder and a name: `src/booking/` and `price.ts`; the folder is empty for a file at the top. */
export function splitPath(path: string): { folder: string; name: string } {
    const cut = path.lastIndexOf('/') + 1;

    return { folder: path.slice(0, cut), name: path.slice(cut) };
}

/** Whether the branch has files to show against its base: there is a base to count from, and something changed. */
export const hasBranchFiles = (summary: BranchSummary | undefined): summary is BranchSummary =>
    summary !== undefined && summary.baseState === 'ready' && summary.files > 0;

/** The branch's totals as the signs `+104 −38` write them (a real minus sign, as the tool cards have it). */
export const additionsWords = (summary: BranchSummary) => `+${summary.additions}`;
export const deletionsWords = (summary: BranchSummary) => `−${summary.deletions}`;

/** `13 files`, `1 file`. */
export const filesWords = (count: number) => `${count} ${count === 1 ? 'file' : 'files'}`;

/**
 * What the sidebar says when GitHub cannot be asked. `gh` is the person's own program, so the words name it: it is not signed in (for GitHub, the one thing to do; for another host,
 * which one), or it is not installed. Offline reads the same as not signed in for a few seconds, which is why it is a hint and not a button. A folder whose `origin` names no repository
 * has none.
 */
export function accessHint(access: GitHubAccess | undefined, repo: GitHubRepo | undefined): string | undefined {
    if (!repo) return undefined;

    if (access === 'no_gh') return 'Install gh to see pull requests';

    if (access === 'not_signed_in')
        return repo.host === 'github.com' ? 'Sign in with gh' : `gh isn't signed in to ${repo.host}`;

    return undefined;
}

/** What the hint's tooltip tells the person to do, as the daemon's own words are not shown. */
export function accessHintTitle(access: GitHubAccess | undefined, repo: GitHubRepo | undefined): string | undefined {
    if (!repo) return undefined;

    if (access === 'no_gh') return 'Pull requests come from the GitHub command line tool, gh';

    if (access === 'not_signed_in')
        return `Run gh auth login --hostname ${repo.host} in a terminal to see pull requests`;

    return undefined;
}

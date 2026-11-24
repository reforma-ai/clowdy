import { commitScope, GIT_COMMIT_SCOPE_PREFIX, turnScopeTrees } from '@clowdy/protocol';

import type { GitBase, GitCommit, GitScope } from '@clowdy/protocol';

/** One entry of the scope menu: what it is called, and the scope the tab reads when it is chosen. */
export interface ScopeOption {
    /** The scope as the daemon takes it; also the key of the menu's item. */
    scope: GitScope;
    label: string;
    /** A commit of the branch, for the entries that are one. */
    commit?: GitCommit;
    /** A short line under the label in the menu. */
    note: string;
}

export const ALL_CHANGES_LABEL = 'All changes';

/**
 * The entry of what the open chat's latest run changed. Its files are the difference of two snapshots of the place, so a place that others edit shows their edits of that time too:
 * the menu says so under the label (`LAST_RUN_NOTE`) and the tooltip of the button that shows the choice says it in full (`LAST_RUN_TOOLTIP`).
 */
export const LAST_RUN_LABEL = 'Last run';
export const LAST_RUN_NOTE = 'Edits of others in the place are in it too';
export const LAST_RUN_TOOLTIP =
    'What the latest run of this chat changed. Edits that others made in the place meanwhile are in it too.';

const commitDate = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' });

function commitNote({ shortSha, committedAt }: GitCommit): string {
    const date = new Date(committedAt);

    return Number.isNaN(date.getTime()) ? shortSha : `${shortSha} · ${commitDate.format(date)}`;
}

/** The base the branch is compared with is there: the branch's own scope and its commits make sense. */
const hasBase = (base: GitBase | undefined): base is Extract<GitBase, { state: 'ready' }> => base?.state === 'ready';

/**
 * The entries of the scope menu: all changes, the branch against its base (only while the base is ready), what is not committed, the open chat's last run (`runScope`, while the
 * chat has one: the scope of its two snapshots), and one entry for each commit of the branch, newest first. The commits are the status's own list of the branch's work
 * (`GitBase.commits`), which the daemon cuts at `MAX_GIT_COMMITS`.
 */
export function scopeOptions(base: GitBase | undefined, runScope?: GitScope): ScopeOption[] {
    const comparison = hasBase(base) ? base : undefined;

    return [
        {
            scope: 'all',
            label: ALL_CHANGES_LABEL,
            note: comparison
                ? 'Branch commits and uncommitted changes'
                : 'Local changes until a comparison base is available',
        },
        ...(comparison
            ? [{ scope: 'branch' as const, label: 'Branch', note: 'Committed changes against the base' }]
            : []),
        { scope: 'uncommitted', label: 'Uncommitted', note: 'Staged, unstaged and untracked changes' },
        ...(runScope ? [{ scope: runScope, label: LAST_RUN_LABEL, note: LAST_RUN_NOTE }] : []),
        ...(comparison
            ? comparison.commits.map(commit => ({
                  scope: commitScope(commit.sha),
                  label: commit.subject || 'No commit message',
                  note: commitNote(commit),
                  commit,
              }))
            : []),
    ];
}

/** Whether a scope is the scope of one commit. */
export const isCommitScope = (scope: GitScope): boolean => scope.startsWith(GIT_COMMIT_SCOPE_PREFIX);

/** Whether a scope is the scope of one run of a chat (`turnScope`). */
export const isRunScope = (scope: GitScope): boolean => turnScopeTrees(scope) !== undefined;

/**
 * The scope that can be read now for a scope that was chosen: `branch` counts against a base and means nothing without one, so it reads as all changes until the base is ready. A
 * base that has not been read yet (`undefined`) leaves the choice as it is.
 */
export function usableScope(scope: GitScope, base: GitBase | undefined): GitScope {
    return scope === 'branch' && base !== undefined && !hasBase(base) ? 'all' : scope;
}

/** The commit of the branch that a scope is the scope of, when the branch has it. */
export function commitOfScope(scope: GitScope, base: GitBase | undefined): GitCommit | undefined {
    if (!isCommitScope(scope) || !hasBase(base)) return undefined;

    return base.commits.find(commit => commitScope(commit.sha) === scope);
}

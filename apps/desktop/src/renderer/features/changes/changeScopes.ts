import { commitScope, GIT_COMMIT_SCOPE_PREFIX } from '@clowdy/protocol';

import type { GitBase, GitCommit, GitScope } from '@clowdy/protocol';

/** One entry of the scope menu: what it is called, and the scope the tab reads when it is chosen. */
export interface ScopeOption {
    /** The scope as the daemon takes it; also the key of the menu's item. */
    scope: GitScope;
    label: string;
    /** A commit of the branch, for the entries that are one. */
    commit?: GitCommit;
}

export const ALL_CHANGES_LABEL = 'All changes';

/** How a commit is named in the menu: its short hash and the first line of its message. */
export const commitLabel = ({ shortSha, subject }: Pick<GitCommit, 'shortSha' | 'subject'>): string => `${ shortSha } ${ subject }`;

/** The base the branch is compared with is there: the branch's own scope and its commits make sense. */
const hasBase = (base: GitBase | undefined): base is Extract<GitBase, { state: 'ready' }> => base?.state === 'ready';

/**
 * The entries of the scope menu: all changes, the branch against its base (only while the base is ready), what is not committed, and one entry for each commit of the branch,
 * newest first. The commits are the status's own list of the branch's work (`GitBase.commits`), which the daemon cuts at `MAX_GIT_COMMITS`.
 */
export function scopeOptions(base: GitBase | undefined): ScopeOption[] {
    return [
        { scope: 'all', label: ALL_CHANGES_LABEL },
        ...(hasBase(base) ? [{ scope: 'branch' as const, label: 'Branch' }] : []),
        { scope: 'uncommitted', label: 'Uncommitted' },
        ...(hasBase(base) ? base.commits.map(commit => ({ scope: commitScope(commit.sha), label: commitLabel(commit), commit })) : []),
    ];
}

/** Whether a scope is the scope of one commit. */
export const isCommitScope = (scope: GitScope): boolean => scope.startsWith(GIT_COMMIT_SCOPE_PREFIX);

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

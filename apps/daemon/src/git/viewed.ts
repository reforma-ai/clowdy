import { GIT_COMMIT_SCOPE_PREFIX, MAX_GIT_REVISION_LENGTH, MAX_GIT_VIEWED_PATH_LENGTH, turnScopeTrees } from '@clowdy/protocol';

import { invalid, notFound } from '../errors';
import { checkPath } from './changes';
import { workingTreeRoot } from './state';
import { commitAt, mergeBaseOf } from './status';

import type { GitScope } from '@clowdy/protocol';
import type { Place } from '../domain/places';
import type { BaseOptions } from './status';

/** What a revision is written with: lower case letters (`stat-` stands in for an id git could not compute), digits, `:` and `-`. */
const REVISION = /^[0-9a-z:-]+$/;

/** A path as a mark may name it: one the file route takes, and not longer than `MAX_GIT_VIEWED_PATH_LENGTH`. */
export function checkViewedPath(path: string): void {
    checkPath(path);

    if (path.length > MAX_GIT_VIEWED_PATH_LENGTH) throw invalid('The path is too long');
}

/** A revision as the changes list gives it (`GitChangedFile.revision`): a bounded string of its alphabet, which is all a client can hand the table. */
export function checkRevision(revision: string): void {
    if (revision.length === 0 || revision.length > MAX_GIT_REVISION_LENGTH || !REVISION.test(revision)) throw invalid('The revision is not one of a changed file');
}

/**
 * The key the marks of a scope are kept under (`GitViewedMark` lists the shapes), made here and never taken from a client: `uncommitted`, `commit:<full hash>`, and for
 * `branch` and `all` the ref the place is compared with (`mergeBaseOf`, so the pull request's base, the worktree's and the folder's count as the changes read counts them), `branch:origin/main`.
 * A place with no base to name has an empty one (`all:`), which is the scope of a repository that has nothing to compare with. A commit is the whole hash, so a short one and a long
 * one share their marks, and a commit the repository does not have is `not_found`. A place that is not the root of a working tree is `invalid`, as the file route says it.
 */
export async function viewedScopeKey(place: Place, scope: GitScope, options: BaseOptions = {}): Promise<string> {
    const cwd = place.path;

    if (!await workingTreeRoot(cwd)) throw invalid('The folder is not the root of a git repository');

    if (scope === 'uncommitted') return scope;

    // A run's scope is two trees that no later change can alter, so its own text is its key and no git read is made for it (marks on a pruned run are marks nobody can see).
    if (turnScopeTrees(scope)) return scope;

    if (scope.startsWith(GIT_COMMIT_SCOPE_PREFIX)) {
        const sha = scope.slice(GIT_COMMIT_SCOPE_PREFIX.length);
        const commit = await commitAt(cwd, sha);

        if (!commit) throw notFound('Commit', sha);

        return `${ GIT_COMMIT_SCOPE_PREFIX }${ commit }`;
    }

    const merged = await mergeBaseOf(place, options);

    return `${ scope }:${ 'name' in merged && merged.name !== undefined ? merged.name : '' }`;
}

import { splitPath } from './gitSummary';

import type { GitChangedFile, GitChanges, GitScope } from '@clowdy/protocol';

/** The scopes that list what is uncommitted, and so the only ones a file's changes are discarded from: the others (the branch, one commit) list what is committed, which a discard does not touch. */
const DISCARD_SCOPES: readonly GitScope[] = ['all', 'uncommitted'];

/** The mode git records for a submodule, as the first and the third part of a revision say it. */
const SUBMODULE_MODE = '160000';

/**
 * The files of the place whose changes may be discarded from the scope that is shown, by path: the files of the uncommitted list (`GitChanges` of the `uncommitted` scope, whichever scope is
 * shown, since in `all` a file may be edited and committed both) in `all` and `uncommitted`, and none in the others. A file with merge conflicts and a submodule are left out: the daemon refuses both
 * (`Resolve the conflict first`, `A submodule can't be discarded here`), so offering them would only be an action that must fail. What is offered is always the uncommitted entry of the file, the
 * one the dialog speaks of, which is not always the entry of the shown scope (a file renamed on the branch and edited since is a rename in `all` and an edit in the uncommitted list).
 */
export function discardableFiles(
    scope: GitScope,
    uncommitted: Extract<GitChanges, { isRepository: true }> | undefined
): ReadonlyMap<string, GitChangedFile> {
    if (!uncommitted || !DISCARD_SCOPES.includes(scope)) return new Map();

    return new Map(
        uncommitted.files
            .filter(file => {
                const [oldMode, , newMode] = file.revision.split(':');

                return file.kind !== 'conflicted' && oldMode !== SUBMODULE_MODE && newMode !== SUBMODULE_MODE;
            })
            .map(file => [file.path, file])
    );
}

/** What the confirmation says of one file. */
export interface DiscardWords {
    /** `Discard changes to <name>?`, or `Delete <name>?` for a file that git does not have in its last commit. */
    title: string;
    /** What happens to the file. */
    body: string;
}

/** A tracked file returns to its last commit; a file the last commit does not contain is deleted. */
export function discardWords(file: Pick<GitChangedFile, 'path' | 'kind' | 'untracked'>): DiscardWords {
    const { name } = splitPath(file.path);

    if (file.untracked) return { title: `Delete ${name}?`, body: 'The file is not in git and will be deleted' };

    if (file.kind === 'added')
        return { title: `Delete ${name}?`, body: 'The file was never committed and will be deleted' };

    if (file.kind === 'deleted')
        return { title: `Discard changes to ${name}?`, body: 'The file comes back from the last commit' };

    if (file.kind === 'renamed')
        return {
            title: `Discard changes to ${name}?`,
            body: 'The rename is undone and the file goes back to the last commit',
        };

    return {
        title: `Discard changes to ${name}?`,
        body: 'The file goes back to the last commit',
    };
}

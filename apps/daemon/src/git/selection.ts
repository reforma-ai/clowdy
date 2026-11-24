import { MAX_GIT_COMMIT_PATHS } from '@clowdy/protocol';

import { invalid } from '../errors';
import { checkPath, placeChanges } from './changes';

import type { GitChangedFile } from '@clowdy/protocol';
import type { Place } from '../domain/places';

/** The files a client ticked, as the place's uncommitted changes list them. */
export interface Selection {
    /** In the order the client sent them, once each. */
    files: GitChangedFile[];
    /** What git is given for them: their paths, and the old path of each renamed one (the commit takes both sides of a rename). */
    gitPaths: string[];
}

/**
 * The paths a client sends for a commit or a message, judged against what git lists as changed in the place right now (`placeChanges` of `uncommitted`: the working tree against
 * HEAD, new files too, the same list the sidebar ticks from). The list is a body, not a promise: no paths, more than `MAX_GIT_COMMIT_PATHS`, a path that is not a path of the
 * repository (`checkPath`) and a path that is not a changed file are `invalid`, so nothing is ever added that the person was not shown. A renamed file brings its old path along.
 * `limit` is the most paths the caller takes: a commit's, or a discard's, which is smaller.
 */
export async function selectChanged(place: Place, paths: unknown, limit = MAX_GIT_COMMIT_PATHS): Promise<Selection> {
    if (!Array.isArray(paths) || paths.length === 0) throw invalid('Pick at least one file');

    if (paths.length > limit) throw invalid(`Pick at most ${limit} files`);

    const wanted = [...new Set(paths)];

    for (const path of wanted) {
        if (typeof path !== 'string') throw invalid('The paths are not text');

        checkPath(path);
    }

    const changes = await placeChanges(place, 'uncommitted');

    if (!changes.isRepository) throw invalid('The folder is not the root of a git repository');

    const listed = new Map(changes.files.map(file => [file.path, file]));
    const files = (wanted as string[]).map(path => {
        const file = listed.get(path);

        if (!file) throw invalid(`${path} is not a changed file`);

        return file;
    });
    const gitPaths = [
        ...new Set(
            files.flatMap(file =>
                file.kind === 'renamed' && file.oldPath !== undefined ? [file.path, file.oldPath] : [file.path]
            )
        ),
    ];

    return { files, gitPaths };
}

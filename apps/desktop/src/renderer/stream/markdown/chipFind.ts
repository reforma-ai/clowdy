import { useEffect, useState } from 'react';

import { placeKey, placeOf } from '../../features/sidePanel/currentPlace';
import { useRootStore } from '../../stores';

import type { ProjectId } from '@clowdy/protocol';
import type { OpenTarget } from '../../features/openWith';
import type { Place } from '../../features/sidePanel/currentPlace';
import type { RootStore } from '../../stores';

/** The most paths the daemon's search answers with. */
const SEARCH_LIMIT = 100;

/**
 * Where a file that is not at the path a message wrote could be: the files of the place's folder whose path ends with the written one, by whole names of folders (`FileChip.tsx`, or
 * `markdown/FileChip.tsx`, for `apps/desktop/src/renderer/stream/markdown/FileChip.tsx`). They come from the same search of the project's files as the palette's (git's tracked and
 * unignored files), the best match first. A path that has the written one at its very start is not here: the caller looked there already.
 */
export async function findChipFiles(
    root: RootStore,
    projectId: ProjectId,
    place: Place,
    relative: string
): Promise<string[]> {
    if (relative === '') return [];

    const matches = await root.transport.getProjectFiles(projectId, relative, SEARCH_LIMIT, place.workspace?.id);
    const tail = `/${relative.toLowerCase()}`;

    return matches
        .filter(match => match.folderId === place.folder.id && match.path.toLowerCase().endsWith(tail))
        .map(match => match.path);
}

/**
 * The files `findChipFiles` finds for a file that is not on the disk, read when the component is drawn and again for another path. `undefined` until the answer for this path comes
 * (never another path's), and nothing found when the search fails or when `isEnabled` is off (a path that is in a folder, or a worktree, that the window is not on cannot be opened here,
 * so it is not looked for). A folder is not looked for: the search lists files.
 */
export function useFoundFiles(target: OpenTarget, isEnabled: boolean): string[] | undefined {
    const root = useRootStore();
    const { projectId, folder, workspace, relative, kind } = target;
    const key = `${projectId}/${placeKey({ folder, workspace })}/${relative}`;
    const [read, setRead] = useState<{ key: string; paths: string[] }>();
    const isSearching = isEnabled && kind === 'file';

    useEffect(() => {
        if (!isSearching) return;

        let isCurrent = true;
        const settle = (paths: string[]) => {
            if (isCurrent) setRead({ key, paths });
        };

        findChipFiles(root, projectId, placeOf({ folder, workspace }), relative).then(settle, () => settle([]));

        return () => {
            isCurrent = false;
        };
    }, [root, projectId, folder, workspace, relative, key, isSearching]);

    if (!isSearching) return [];

    return read?.key === key ? read.paths : undefined;
}

import { useCallback, useEffect, useRef, useState } from 'react';

import { useRootStore } from '../../stores';

import type { FolderWorktrees, ProjectId } from '@clowdy/protocol';

interface Read {
    projectId: ProjectId;
    folders: FolderWorktrees[] | undefined;
    failed: boolean;
}

export interface ProjectWorktrees {
    /** The worktrees of every folder of the project, in the project's order: `undefined` until the first read answers (never another project's). */
    folders: FolderWorktrees[] | undefined;
    /** The last read failed: the folders, when there are any, are from an earlier read and may be out of date. */
    failed: boolean;
    /** Reads again, for what changes the worktrees (a removal) and for a retry. Settles once the answer is in; never rejects. */
    reload: () => Promise<void>;
}

/**
 * What the daemon says of the worktrees of a project's folders (`getProjectWorktrees`), read when the component is drawn, when the project changes and when the window
 * gets focus again, since worktrees change in a terminal or by an agent while the app is in the background. Not polled. The list of an earlier read stays on screen while the
 * next one runs and when it fails, which `failed` says; an answer that comes after a newer read was made, or after the component is gone, is dropped.
 */
export function useProjectWorktrees(projectId: ProjectId): ProjectWorktrees {
    const root = useRootStore();
    const [read, setRead] = useState<Read>();
    // The number of the latest read: an answer for an older one is out of date.
    const latest = useRef(0);

    const reload = useCallback(async () => {
        const request = ++latest.current;

        try {
            const folders = await root.transport.getProjectWorktrees(projectId);

            if (request === latest.current) setRead({ projectId, folders, failed: false });
        } catch {
            if (request === latest.current)
                setRead(current => ({
                    projectId,
                    folders: current?.projectId === projectId ? current.folders : undefined,
                    failed: true,
                }));
        }
    }, [root, projectId]);

    useEffect(() => {
        const onFocus = () => void reload();

        onFocus();
        window.addEventListener('focus', onFocus);

        return () => {
            latest.current++;
            window.removeEventListener('focus', onFocus);
        };
    }, [reload]);

    const current = read?.projectId === projectId ? read : undefined;

    return { folders: current?.folders, failed: current?.failed ?? false, reload };
}

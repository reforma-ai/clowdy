import { useEffect, useState } from 'react';

import { TransportError } from '../../daemon/transport';
import { useRootStore } from '../../stores';

import type { FolderGit, FolderId, ProjectId } from '@clowdy/protocol';

/** What the daemon said of a folder's repository, as far as the new-chat page has it. */
export type FolderRepository =
    /** No answer yet for this folder. */
    | { status: 'loading' }
    /** The daemon could not say: git is not installed or did not answer, or the folder is gone. `reason` is its own words (its `unavailable`), and nothing for any other failure, whose text is a route or the network's. */
    | { status: 'failed'; reason: string }
    | { status: 'ready'; git: FolderGit };

const LOADING: FolderRepository = { status: 'loading' };

/**
 * The branches and worktrees of one folder of a project (`Transport.getFolderGit`), for the chips of the new-chat page. Read when the page opens, when its folder
 * changes and when the window gets focus again, since a branch or a worktree comes and goes in a terminal or by an agent while the app is in the background. Nothing but
 * `loading` until the answer for this folder comes (never another folder's), and a later read that fails leaves what was known for the same folder, as `useFolderGit` does.
 */
export function useFolderRepository(projectId: ProjectId, folderId: FolderId): FolderRepository {
    const root = useRootStore();
    const key = `${ projectId }/${ folderId }`;
    const [read, setRead] = useState<{ key: string; repository: FolderRepository }>();

    useEffect(() => {
        // The number of the latest read: an answer that comes after a newer read was made, or after this effect ended, is out of date.
        let latest = 0;

        const readRepository = () => {
            const request = ++latest;

            root.transport.getFolderGit(projectId, folderId).then(
                (git) => {
                    if (request === latest) setRead({ key, repository: { status: 'ready', git } });
                },
                (error: unknown) => {
                    if (request !== latest) return;

                    // The daemon says why in a 503 (`unavailable`); any other failure has nothing a person should read.
                    const reason = error instanceof TransportError && error.status === 503 ? error.message : '';

                    setRead(known => (known?.key === key && known.repository.status === 'ready' ? known : { key, repository: { status: 'failed', reason } }));
                }
            );
        };

        readRepository();
        window.addEventListener('focus', readRepository);

        return () => {
            latest++;
            window.removeEventListener('focus', readRepository);
        };
    }, [root, projectId, folderId, key]);

    return read?.key === key ? read.repository : LOADING;
}

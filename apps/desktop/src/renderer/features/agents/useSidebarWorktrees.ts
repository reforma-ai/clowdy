import { useEffect, useState } from 'react';

import { useProjectState, useRootStore } from '../../stores';
import { onFolderGitRefresh } from '../openWith/useFolderGit';

import type { FolderWorktrees } from '@clowdy/protocol';

/** Read only while enabled, and refresh after folder Git changes, chat/workspace changes, and focus. */
export function useSidebarWorktrees(enabled: boolean): FolderWorktrees[] | undefined {
    const root = useRootStore();
    const project = useProjectState();
    const [read, setRead] = useState<{ projectId: string; folders: FolderWorktrees[] }>();
    const projectId = project.id;
    const links = enabled
        ? JSON.stringify(
              [...project.chats.values()]
                  .filter(chat => chat.workspace)
                  .map(chat => [
                      chat.id,
                      chat.archivedAt,
                      chat.workspace?.id,
                      chat.workspace?.ready,
                      chat.workspace?.path,
                  ])
          )
        : '';
    const folders = enabled ? JSON.stringify(project.project.folders.map(folder => [folder.id, folder.path])) : '';
    useEffect(() => {
        if (!enabled) return;
        let latest = 0;
        const reload = () => {
            const request = ++latest;
            root.transport.getProjectWorktrees(projectId).then(
                folders => {
                    if (request === latest) setRead({ projectId, folders });
                },
                () => undefined
            );
        };
        reload();
        window.addEventListener('focus', reload);
        const stop = onFolderGitRefresh(id => {
            if (id === projectId) reload();
        });
        return () => {
            latest++;
            stop();
            window.removeEventListener('focus', reload);
        };
    }, [enabled, root, projectId, links, folders]);
    return enabled && read?.projectId === projectId ? read.folders : undefined;
}

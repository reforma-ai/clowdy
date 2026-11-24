import { requireProject } from '../domain/projects';
import { removeWorktree } from '../domain/workspaceRemoval';
import { createStandaloneWorktree, openWorkspace } from '../domain/workspaces';

import type { AsyncHandlers, Handlers } from './context';

export const workspaceHandlers: Pick<Handlers, 'workspace.open'> = {
    /** The row of a worktree that exists, for a page that shows its places before a chat works there: `chat.create` with the same path shares it. */
    'workspace.open': ({ store }, command) => ({
        workspace: openWorkspace(store, requireProject(store, command.projectId), command.folderId, command.path),
    }),
};

export const workspaceAsyncHandlers: Pick<AsyncHandlers, 'workspace.create' | 'workspace.remove'> = {
    'workspace.create': async ({ store, config }, command) => {
        const created = await createStandaloneWorktree(
            store,
            config,
            requireProject(store, command.projectId),
            command
        );

        return () => created;
    },
    /** Waits for Git to remove the worktree and, when asked, its branch. The removal updates the store as it goes. */
    'workspace.remove': async ({ store, config }, command) => {
        const removed = await removeWorktree(store, config, requireProject(store, command.projectId), command);

        return () => removed;
    },
};

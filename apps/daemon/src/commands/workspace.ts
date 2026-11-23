import { requireProject } from '../domain/projects';
import { removeWorktree } from '../domain/workspaceRemoval';
import { openWorkspace } from '../domain/workspaces';

import type { AsyncHandlers, Handlers } from './context';

export const workspaceHandlers: Pick<Handlers, 'workspace.open'> = {
    /** The row of a worktree that exists, for a page that shows its places before a chat works there: `chat.create` with the same path shares it. */
    'workspace.open': ({ store }, command) => ({ workspace: openWorkspace(store, requireProject(store, command.projectId), command.folderId, command.path) }),
};

/**
 * `workspace.remove` waits for git to remove the worktree and, when asked, its branch (`removeWorktree`, which refuses with a `conflict` that says why when it must). It changes the
 * store as it goes, since a branch that cannot be deleted after the worktree went must not bring the worktree's row back; what it gives back is only the answer.
 */
export const workspaceAsyncHandlers: Pick<AsyncHandlers, 'workspace.remove'> = {
    'workspace.remove': async ({ store, config }, command) => {
        const removed = await removeWorktree(store, config, requireProject(store, command.projectId), command);

        return () => removed;
    },
};

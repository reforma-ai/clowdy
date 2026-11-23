import { requireProject } from '../domain/projects';
import { openWorkspace } from '../domain/workspaces';

import type { Handlers } from './context';

export const workspaceHandlers: Pick<Handlers, 'workspace.open'> = {
    /** The row of a worktree that exists, for a page that shows its places before a chat works there: `chat.create` with the same path shares it. */
    'workspace.open': ({ store }, command) => ({ workspace: openWorkspace(store, requireProject(store, command.projectId), command.folderId, command.path) }),
};

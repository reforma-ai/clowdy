import type { ChatWorkspace, ProjectWorkspaceInfo } from '@clowdy/protocol';

/** What of a chat's worktree the app may name: the branch it has checked out, and that the folder is gone. */
export interface WorkspaceHead {
    /** The branch, or on a detached HEAD the short hash of the commit. */
    branch?: string;
    detached?: boolean;
    /** The worktree was made and is no longer on the disk. */
    gone?: true;
}

/** What of a chat's worktree the head needs: its id, whether it was made yet, and the branch it will be made on. */
export type WorkspaceRef = Pick<ChatWorkspace, 'id' | 'branch' | 'ready'>;

/**
 * The branch a chat's worktree has now, from what the daemon last read of the project's workspaces (`ProjectInfo.workspaces`): the agent may have switched branches in it, so
 * the branch the chat was made with (`ChatWorkspace.branch`) is only the answer while the worktree is not made yet, when it is the branch it will be made on. Once it is made
 * the read is the only source: `undefined` while the read has not answered, or has no word on this worktree, never a name that may be out of date.
 */
export function workspaceHead(
    workspace: WorkspaceRef,
    read: readonly ProjectWorkspaceInfo[] | undefined
): WorkspaceHead | undefined {
    if (!workspace.ready) return workspace.branch === undefined ? {} : { branch: workspace.branch };

    const entry = read?.find(candidate => candidate.workspaceId === workspace.id);

    if (!entry) return undefined;

    if (!entry.exists) return { gone: true };

    return { ...(entry.branch !== undefined && { branch: entry.branch }), ...(entry.detached && { detached: true }) };
}

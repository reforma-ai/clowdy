import { listProjects } from '../db/projects';
import { listWorkspaceUses } from '../db/workspaces';
import { isBelow } from '../fs/paths';
import { pathKey, placeOf } from './workspaces';

import type { Store } from '../store';

/** Stored workspace paths with linked chats, including archived history. Resolve these before comparing them. */
export function workspacePathsWithChats(store: Store): { id: string; path: string }[] {
    return listProjects(store.db).flatMap(project =>
        listWorkspaceUses(store.db, project.id)
            .filter(use => use.inUse)
            .map(({ record }) => ({ id: record.id, path: record.path }))
    );
}

/** Another workspace at this physical path or inside it would lose files on removal. */
export function otherWorkspaceAt(
    path: string,
    workspaceId: string | undefined,
    uses: readonly { id: string; path: string }[]
): boolean {
    return uses.some(use => use.id !== workspaceId && isBelow(path, use.path, { allowSelf: true }));
}

export function otherWorkspaceChatUse(store: Store, path: string, workspaceId?: string): boolean {
    return otherWorkspaceAt(
        pathKey(placeOf(path)),
        workspaceId,
        workspacePathsWithChats(store).map(use => ({ id: use.id, path: pathKey(placeOf(use.path)) }))
    );
}

import { MAX_GIT_VIEWED_MARKS } from '@clowdy/protocol';

import type { GitViewedMark } from '@clowdy/protocol';
import type { Database } from 'bun:sqlite';

/** A place a mark belongs to: a folder of a project, and the worktree of it when the mark is of one (`workspaceId` is empty for the folder's own checkout, so the key can hold it). */
export interface ViewedPlace {
    projectId: string;
    folderId: string;
    workspaceId: string;
}

/** The marks of one scope of a place, in path order (by bytes, as the changes list is). */
export function listViewed(db: Database, place: ViewedPlace, scopeKey: string): GitViewedMark[] {
    return db.query(`
        SELECT path, revision FROM viewed_files WHERE project_id = ? AND folder_id = ? AND workspace_id = ? AND scope_key = ? ORDER BY path COLLATE BINARY
    `).all(place.projectId, place.folderId, place.workspaceId, scopeKey) as GitViewedMark[];
}

/**
 * Keeps a file as viewed at a revision, replacing the mark it had, and drops the oldest marks of the place (over all its scopes) past `limit`, so a place never holds more than
 * the newest `limit`. Two statements: the caller runs them in a transaction.
 */
export function setViewed(db: Database, place: ViewedPlace, scopeKey: string, mark: GitViewedMark, now: number, limit = MAX_GIT_VIEWED_MARKS): void {
    db.query(`
        INSERT INTO viewed_files (project_id, folder_id, workspace_id, scope_key, path, revision, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id, folder_id, workspace_id, scope_key, path) DO UPDATE SET revision = excluded.revision, updated_at = excluded.updated_at
    `).run(place.projectId, place.folderId, place.workspaceId, scopeKey, mark.path, mark.revision, now);
    // Marks made in the same millisecond are told apart by their row: the later one has the higher `rowid`, unless it replaced a mark (it keeps that row), which is rare and harmless.
    db.query(`
        DELETE FROM viewed_files WHERE project_id = ? AND folder_id = ? AND workspace_id = ? AND rowid NOT IN (
            SELECT rowid FROM viewed_files WHERE project_id = ? AND folder_id = ? AND workspace_id = ? ORDER BY updated_at DESC, rowid DESC LIMIT ?
        )
    `).run(place.projectId, place.folderId, place.workspaceId, place.projectId, place.folderId, place.workspaceId, limit);
}

/** Clears the mark of one file in a scope; a file with none is left as it is. */
export function clearViewed(db: Database, place: ViewedPlace, scopeKey: string, path: string): void {
    db.query('DELETE FROM viewed_files WHERE project_id = ? AND folder_id = ? AND workspace_id = ? AND scope_key = ? AND path = ?').run(place.projectId, place.folderId, place.workspaceId, scopeKey, path);
}

/** How many marks a place holds over all its scopes. */
export function countViewed(db: Database, place: ViewedPlace): number {
    return (db.query('SELECT COUNT(*) AS count FROM viewed_files WHERE project_id = ? AND folder_id = ? AND workspace_id = ?').get(place.projectId, place.folderId, place.workspaceId) as { count: number }).count;
}

/**
 * Drops every mark of a worktree: its row is gone, and so is the place they were of. The `<> ''` is what lets SQLite use the partial index `viewed_files_workspace` (a bound
 * parameter alone is not known to be non-empty, so it would scan the table), and it keeps the folders' own checkouts' marks, which have an empty `workspace_id`, out of reach.
 */
export function deleteViewedOfWorkspace(db: Database, workspaceId: string): void {
    db.query(`DELETE FROM viewed_files WHERE workspace_id = ? AND workspace_id <> ''`).run(workspaceId);
}

/** Drops every mark of a project, for the project's removal (no foreign key does it). */
export function deleteViewedOfProject(db: Database, projectId: string): void {
    db.query('DELETE FROM viewed_files WHERE project_id = ?').run(projectId);
}

/** Drops the marks of the project's folders that are not in `folderIds`: a folder that left the project took its places with it, worktrees included. */
export function deleteViewedOutsideFolders(db: Database, projectId: string, folderIds: readonly string[]): void {
    db.query('DELETE FROM viewed_files WHERE project_id = ? AND folder_id NOT IN (SELECT value FROM json_each(?))').run(projectId, JSON.stringify(folderIds));
}
